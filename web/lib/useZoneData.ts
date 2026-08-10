"use client";

/**
 * The whole data load, in one hook.
 *
 * The rule everything here follows: **nothing waits for everything**.
 *
 * What arrives, in order, and what each unlocks:
 *
 *   played tiles   positions + paint together, nearest first. The map is
 *                  complete and correctly coloured for today after this, with
 *                  nothing else fetched at all.
 *   terrain        the 1.09M zones never played. Always grey.
 *   display        one anchor and one year of the display stream, ≤ 3.16 MB,
 *                  which is everything needed to draw any date in the record.
 *                  Not fetched until a date `paint/` cannot answer is asked for.
 *
 * Nothing here carries exact per-faction counts. Those would be 71.5 MB to
 * rebuild for 2.68M zones, of which the map keeps only a colour and a radius;
 * they come from `zone_history/` instead, one ~35 KB block at a time, for the
 * single zone a reader is pointing at.
 *
 * The replay itself runs in a worker, so a scrub never blocks a frame.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { loadJson, loadMeta, loadZoneIds, type Lookups, type Meta, type SparseSeries } from "./data";
import { lastCompleteDay } from "./format";
import { loadGeometry, ZoneDisplay, ZoneGeometry, type LoaderHandle, type LoadStage } from "./geometry";
import { windowStart, type ReadMode, type WindowKey } from "./windows";
import type { StateMessage, WorkerResponse } from "./displayProtocol";

export interface LoadProgress {
  stage: LoadStage | "meta" | "done";
  /** Zones whose position is on screen. */
  zones: number;
  /** True once every played zone is drawn in its faction colour. */
  playedReady: boolean;
  /** True once the display stream has answered for a date at least once. */
  historyReady: boolean;
  /**
   * A date is being fetched.
   *
   * Not a percentage any more. History is no longer a background download that
   * completes - the worker holds one anchor and one year, and reaches for
   * another only when the reader scrubs past a boundary.
   */
  scrubbing: boolean;
  error: string | null;
}

/**
 * Repaints are batched to about five a second.
 *
 * deck.gl re-uploads the position buffer whenever the row count changes, and
 * there are 475 tiles. Repainting per tile would push a growing 21 MB buffer
 * to the GPU 475 times; at five a second the load looks continuous and costs a
 * fraction of that.
 */
const REPAINT_INTERVAL_MS = 200;

/** Zones that changed hands on one day, in the worker's own idx space. */
export interface DayFlips {
  day: number;
  idx: Uint32Array;
  from: Uint8Array;
  to: Uint8Array;
}

export interface ZoneData {
  meta: Meta | null;
  geometry: ZoneGeometry | null;
  display: ZoneDisplay | null;
  lookups: Lookups | null;
  zoneIds: Int32Array | null;
  series: SparseSeries | null;
  day: number | null;
  dayBounds: { min: number; max: number; lastComplete: number } | null;
  /** First day of the open change window, or null in standings. */
  changeStart: number | null;
  /** Zones drawn after a change window has hidden the ones that stood still. */
  shown: number | null;
  /** Bumped whenever the map needs to redraw: new tiles, or a new date. */
  version: number;
  /** The latest answered day's changes of hands, or null unless asked for. */
  flips: DayFlips | null;
  /**
   * True while a date is outstanding, readable without a re-render.
   *
   * `progress.scrubbing` cannot be used for pacing: it is deliberately delayed
   * so a fast answer never flickers the loading state, which means it reads
   * false while a request is genuinely in flight. Anything deciding whether to
   * ask for the next date wants this.
   */
  pending: { readonly current: boolean };
  progress: LoadProgress;
  setDay: Dispatch<SetStateAction<number | null>>;
  /** Tell the tile queue where the reader is looking. */
  setFocus: (lat: number, lon: number) => void;
}

/**
 * @param span how far back the change window reaches from the playhead.
 * @param mode `state` draws every zone on the playhead's date; `change` hides
 *   every zone with no event in the window. The worker answers that without
 *   building a second state, because "did this zone move" is a question about
 *   whether rows exist, not a comparison of two snapshots.
 *
 * The window is resolved in here rather than by the caller because it depends
 * on the day bounds, which this hook is what discovers.
 */
export function useZoneData(
  base: string,
  span: WindowKey = "year",
  mode: ReadMode = "state",
  wantFlips = false,
  /**
   * Called from the worker's message handler as each answer lands.
   *
   * Exists so a caller can accumulate flips without doing it in an effect. An
   * effect that sets state on every answer makes React count a nested passive
   * update every frame of playback, and once fifty of those stack up without a
   * quiet commit in between it logs "Maximum update depth exceeded". Handling
   * it here keeps the update rooted in the message handler, where it is an
   * ordinary update rather than a nested one.
   */
  onFlips?: (flips: DayFlips) => void,
): ZoneData {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [geometry, setGeometry] = useState<ZoneGeometry | null>(null);
  const [display, setDisplay] = useState<ZoneDisplay | null>(null);
  const [lookups, setLookups] = useState<Lookups | null>(null);
  const [zoneIds, setZoneIds] = useState<Int32Array | null>(null);
  const [series, setSeries] = useState<SparseSeries | null>(null);
  const [day, setDay] = useState<number | null>(null);
  const [shown, setShown] = useState<number | null>(null);
  const [flips, setFlips] = useState<DayFlips | null>(null);
  const [version, setVersion] = useState(0);
  const [progress, setProgress] = useState<LoadProgress>({
    stage: "meta",
    zones: 0,
    playedReady: false,
    historyReady: false,
    scrubbing: false,
    error: null,
  });

  const loaderRef = useRef<LoaderHandle | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const displayRef = useRef<ZoneDisplay | null>(null);
  // Buffers the worker fills are lent back to it rather than reallocated:
  // playback asks eight times a second and each pair is 5.4 MB.
  const spare = useRef<{ pk: Uint8Array; visible: Uint8Array } | null>(null);
  const requested = useRef(0);
  const answered = useRef(-1);
  const repaintAt = useRef(0);
  const pending = useRef(false);
  /** Delays the visible loading state; see `pending`. */
  const scrubTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onFlipsRef = useRef(onFlips);
  onFlipsRef.current = onFlips;

  const settle = useCallback(() => {
    pending.current = false;
    if (scrubTimer.current !== null) {
      clearTimeout(scrubTimer.current);
      scrubTimer.current = null;
    }
  }, []);

  const dayBounds = useMemo(() => {
    if (!series?.rows.length || !meta) return null;
    const max = series.rows[series.rows.length - 1][0];
    return {
      min: series.rows[0][0],
      max,
      /** The newest finished day. Equals `max` unless today is still running. */
      lastComplete: lastCompleteDay(meta.day_epoch, max),
    };
  }, [series, meta]);

  // Null in standings, so the worker never scans for movement there.
  const changeStart =
    mode === "change" && day !== null && dayBounds ? windowStart(span, day, dayBounds.min) : null;

  // --- geometry, paint, lookups, ids, series: all racing ------------------

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const m = await loadMeta(base);
      if (cancelled) return;

      const geo = new ZoneGeometry(m.scope.zone_count);
      const disp = new ZoneDisplay(m.scope.zone_count, m.display.magnitude_steps);
      displayRef.current = disp;
      setMeta(m);
      setGeometry(geo);
      setDisplay(disp);
      setProgress((p) => ({ ...p, stage: "zones" }));

      loadJson<Lookups>(base, m.lookups.path)
        .then((l) => !cancelled && setLookups(l))
        .catch(() => undefined);
      loadZoneIds(base, m.zone_ids)
        .then((ids) => !cancelled && setZoneIds(ids))
        .catch(() => undefined);
      loadJson<SparseSeries>(base, m.series.scope_daily.path)
        .then((s) => {
          if (cancelled || !s.rows.length) return;
          setSeries(s);
          // Opens on the last *finished* day, not the newest one. The day still
          // in progress holds only the hours elapsed so far, and a window
          // ending on it undercounts for a reason that is nothing to do with
          // the game. `Current` is the view that deliberately wants the newest
          // date, and it asks for it.
          setDay((current) => current ?? lastCompleteDay(m.day_epoch, s.rows[s.rows.length - 1][0]));
        })
        .catch(() => undefined);

      loaderRef.current = loadGeometry({
        base,
        meta: m.geometry,
        geometry: geo,
        display: disp,
        // The opening view is the whole world, so the middle of it is as good
        // a guess as any until the reader pans or shares their location.
        focus: { lat: 26, lon: 8 },
        onTile: (stage, remaining) => {
          if (cancelled) return;
          const now = performance.now();
          const last = remaining === 0;
          if (last || now - repaintAt.current > REPAINT_INTERVAL_MS) {
            repaintAt.current = now;
            setVersion((v) => v + 1);
            setProgress((p) => ({
              ...p,
              zones: geo.count,
              // One pass, and names load on hover, so the world is whole when
              // it drains.
              stage: last ? "done" : stage,
              playedReady: p.playedReady || last,
            }));
          }
        },
      });
    })().catch(
      (error) => !cancelled && setProgress((p) => ({ ...p, error: String(error.message ?? error) })),
    );

    return () => {
      cancelled = true;
      loaderRef.current?.cancel();
    };
  }, [base]);

  // --- the display worker -------------------------------------------------

  useEffect(() => {
    if (!meta) return;

    const worker = new Worker(new URL("./displayWorker.ts", import.meta.url));
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;

      if (message.type === "error") {
        settle();
        setProgress((p) => ({ ...p, scrubbing: false, error: `display: ${message.message}` }));
        return;
      }

      // An answer for a request already superseded by a newer scrub still
      // carries buffers worth keeping - lend them straight back rather than
      // letting them fall on the floor and allocating a fresh pair.
      const state = message as StateMessage;
      if (state.token < answered.current) {
        spare.current = { pk: state.pk, visible: state.visible };
        return;
      }
      answered.current = state.token;

      const current = displayRef.current;
      if (!current) return;
      spare.current = { pk: current.pk, visible: current.visible };
      current.pk = state.pk;
      current.visible = state.visible;

      settle();
      setShown(state.shown);
      if (state.flips) {
        const answer = { day: state.day, ...state.flips };
        setFlips(answer);
        onFlipsRef.current?.(answer);
      }
      setVersion((v) => v + 1);
      setProgress((p) =>
        p.historyReady && !p.scrubbing ? p : { ...p, historyReady: true, scrubbing: false },
      );
    };

    worker.postMessage({
      type: "init",
      base,
      epoch: meta.day_epoch,
      zoneCount: meta.scope.zone_count,
      display: meta.display,
    });

    return () => {
      worker.terminate();
      workerRef.current = null;
      // The buffers on loan are gone with the worker; the next one allocates.
      spare.current = null;
      answered.current = -1;
      // No answer is coming for whatever was outstanding, so the delayed
      // loading state must be cancelled with it or it fires into a torn-down
      // worker and leaves "Reading…" on for good.
      settle();
    };
  }, [base, meta, settle]);

  // --- ask for a date -----------------------------------------------------

  // Paint already draws today correctly, so the display stream is not fetched
  // until the reader needs a date it cannot answer: an earlier day, or a change
  // window. Asking sooner would put 2.5 MB in front of the tiles the reader is
  // watching arrive.
  const latest = dayBounds?.max ?? null;
  const wanted = day !== null && (changeStart !== null || day !== latest || answered.current >= 0);

  useEffect(() => {
    const worker = workerRef.current;
    if (!worker || day === null || !wanted) return;

    const token = ++requested.current;
    const lent = spare.current;
    spare.current = null;

    // The loading state is delayed rather than set now. During playback a date
    // is answered in tens of milliseconds, and flipping a state flag on and off
    // every frame both flickers the indicator and makes every commit schedule
    // another update from a passive effect - which is what React counts toward
    // "Maximum update depth exceeded". A request that outlives the delay is a
    // genuine wait and says so.
    pending.current = true;
    if (scrubTimer.current === null) {
      scrubTimer.current = setTimeout(() => {
        scrubTimer.current = null;
        if (pending.current) setProgress((p) => (p.scrubbing ? p : { ...p, scrubbing: true }));
      }, 200);
    }

    worker.postMessage(
      {
        type: "show",
        token,
        day,
        windowStart: changeStart,
        pk: lent?.pk ?? null,
        visible: lent?.visible ?? null,
        flips: wantFlips,
      },
      lent ? [lent.pk.buffer, lent.visible.buffer] : [],
    );
  }, [day, changeStart, wanted, wantFlips]);

  const setFocus = useCallback((lat: number, lon: number) => {
    loaderRef.current?.focus(lat, lon);
  }, []);

  return {
    meta,
    geometry,
    display,
    lookups,
    zoneIds,
    series,
    day,
    dayBounds,
    changeStart,
    shown: changeStart === null ? null : shown,
    version,
    flips,
    pending,
    progress,
    setDay,
    setFocus,
  };
}
