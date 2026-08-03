"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MapViewState, PickingInfo } from "@deck.gl/core";
import { ZoneMap } from "@/components/ZoneMap";
import { StatsPanel, type Totals } from "@/components/StatsPanel";
import { StrataScrubber, type SeriesPoint } from "@/components/StrataScrubber";
import {
  dayToDate,
  loadJsonGz,
  loadMeta,
  loadShard,
  sortByDay,
  upperBound,
  ZoneState,
  type Columns,
  type Meta,
} from "@/lib/data";
import { loadBoundaries, type BoundaryLayer } from "@/lib/boundaries";

const DATA_ROOT = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/data`;

const SCOPES = {
  "dallas-1000mi": {
    label: "Dallas 1000mi",
    view: { longitude: -96.8, latitude: 34.5, zoom: 4.1 },
  },
  global: {
    label: "Global",
    view: { longitude: 8, latitude: 26, zoom: 1.35 },
  },
} as const;

type ScopeName = keyof typeof SCOPES;

// Upstream lost most of 2019: 337,859 events against 627,035 in 2018 and
// 1,438,855 in 2020. It is missing data, not a quiet year, so the scrubber
// marks it rather than letting the dip read as history.
const COLLECTION_GAP_YEAR = 2019;

interface SparseSeries {
  columns: string[];
  rows: number[][];
}

/** Step lookup over a sparse series: carry the last known value forward. */
function valueAt(rows: number[][], day: number): number[] | null {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (rows[mid][0] <= day) low = mid + 1;
    else high = mid;
  }
  return low === 0 ? null : rows[low - 1];
}

export default function Page() {
  const [scope, setScope] = useState<ScopeName>("dallas-1000mi");
  const [boundaries, setBoundaries] = useState<BoundaryLayer[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [zones, setZones] = useState<Columns | null>(null);
  const [names, setNames] = useState<string[]>([]);
  const [series, setSeries] = useState<SparseSeries | null>(null);
  const [day, setDay] = useState<number | null>(null);
  const [version, setVersion] = useState(0);
  const [totals, setTotals] = useState<Totals>({ legion: 0, swarm: 0, faceless: 0, held: 0 });
  const [hovered, setHovered] = useState<{ name: string; total: number; faction: number } | null>(
    null,
  );
  const [palette, setPalette] = useState<"canon" | "accessible">("canon");
  const [status, setStatus] = useState("Loading zones");

  const [viewState, setViewState] = useState<MapViewState>({
    longitude: -96.8,
    latitude: 34.5,
    zoom: 4.1,
    pitch: 0,
    bearing: 0,
  });

  const stateRef = useRef<ZoneState | null>(null);
  const shardCache = useRef(new Map<string, { columns: Columns; days: Uint16Array }>());
  const checkpointCache = useRef(new Map<number, Columns>());
  const loadToken = useRef(0);

  // Boundaries are scope-independent, so they load once and survive switching.
  useEffect(() => {
    loadBoundaries(DATA_ROOT).then(setBoundaries).catch(() => setBoundaries([]));
  }, []);

  useEffect(() => {
    const base = `${DATA_ROOT}/${scope}`;
    let cancelled = false;

    // Everything downstream is indexed by the scope's own zone index, so a
    // switch has to drop all of it rather than reuse a single cached shard.
    setMeta(null);
    setZones(null);
    setSeries(null);
    setDay(null);
    setNames([]);
    shardCache.current.clear();
    checkpointCache.current.clear();
    loadToken.current++;
    setStatus("Loading zones");
    setViewState((current) => ({ ...current, ...SCOPES[scope].view }));

    (async () => {
      const m = await loadMeta(base);
      if (cancelled) return;
      const z = await loadShard(base, m.zones);
      if (cancelled) return;
      stateRef.current = new ZoneState(m.zones.rows);
      setMeta(m);
      setZones(z);
      setStatus("Loading history");
      const s = await loadJsonGz<SparseSeries>(base, m.series.scope_daily.path);
      if (cancelled) return;
      setSeries(s);
      setDay(s.rows[s.rows.length - 1][0]);
      loadJsonGz<string[]>(base, m.zones.names.path).then((n) => !cancelled && setNames(n));
    })().catch((error) => !cancelled && setStatus(`Could not load data: ${error.message}`));

    return () => {
      cancelled = true;
    };
  }, [scope]);

  const bounds = useMemo(() => {
    if (!series?.rows.length) return null;
    return { min: series.rows[0][0], max: series.rows[series.rows.length - 1][0] };
  }, [series]);

  const strata: SeriesPoint[] = useMemo(() => {
    if (!series) return [];
    return series.rows.map(([d, legion, swarm, faceless]) => ({ day: d, legion, swarm, faceless }));
  }, [series]);

  /** Rebuild zone state at `day` from the nearest checkpoint plus that year's events. */
  useEffect(() => {
    if (!meta || !zones || day === null || !stateRef.current) return;
    // `scope` updates a render before the matching meta/zones do, so without
    // this the first run after a switch pairs the new scope's shard paths with
    // the old scope's index -- writing global indices into a state array sized
    // for Dallas, where everything past its length is silently dropped.
    if (meta.scope.name !== scope) return;
    const token = ++loadToken.current;

    (async () => {
      const target = dayToDate(meta.day_epoch, day);
      const year = target.getUTCFullYear();
      const month = target.getUTCMonth() + 1;

      const checkpointYear = meta.checkpoints
        .map((c) => c.year!)
        .filter((y) => y <= year)
        .pop();

      let checkpoint: Columns | undefined;
      if (checkpointYear !== undefined) {
        checkpoint = checkpointCache.current.get(checkpointYear);
        if (!checkpoint) {
          const entry = meta.checkpoints.find((c) => c.year === checkpointYear)!;
          checkpoint = await loadShard(`${DATA_ROOT}/${scope}/checkpoints`, entry);
          checkpointCache.current.set(checkpointYear, checkpoint);
        }
      }

      // Replay every shard between the checkpoint and the target date. Months
      // are already in order, so applying them in sequence is chronological.
      const from = checkpointYear ?? 0;
      const shards = meta.events.filter(
        (e) => e.year! >= from && (e.year! < year || (e.year === year && e.month! <= month)),
      );

      const ready: { columns: Columns; cutoff: number }[] = [];
      for (const entry of shards) {
        const key = entry.path;
        let loaded = shardCache.current.get(key);
        if (!loaded) {
          loaded = sortByDay(await loadShard(`${DATA_ROOT}/${scope}/events`, entry));
          shardCache.current.set(key, loaded);
        }
        ready.push({
          columns: loaded.columns,
          cutoff:
            entry.year === year && entry.month === month
              ? upperBound(loaded.days, day)
              : loaded.days.length,
        });
      }

      // Every await is done. Only now touch the shared ZoneState, and do it
      // synchronously: this effect re-runs as meta, zones and day arrive
      // separately, and an aborted run that had already zeroed the state would
      // otherwise wipe a completed one. Fast scopes hid this; global did not.
      if (token !== loadToken.current) return;

      const state = stateRef.current!;
      state.faction.fill(0);
      state.legion.fill(0);
      state.swarm.fill(0);
      state.faceless.fill(0);
      state.total.fill(0);

      if (checkpoint) state.applyRange(checkpoint, 0, checkpoint.idx.length);
      for (const { columns, cutoff } of ready) state.applyRange(columns, 0, cutoff);

      setTotals(state.totals());
      setVersion((v) => v + 1);
      setStatus("");
    })().catch((error) => setStatus(`Could not load history: ${error.message}`));
  }, [meta, zones, day, scope]);

  const previous: Totals | null = useMemo(() => {
    if (!series || day === null) return null;
    const row = valueAt(series.rows, day - 365);
    if (!row) return null;
    return { legion: row[1], swarm: row[2], faceless: row[3], held: 0 };
  }, [series, day]);

  const handleHover = useCallback(
    (info: PickingInfo) => {
      const index = info.index;
      const state = stateRef.current;
      if (index === undefined || index < 0 || !state) return setHovered(null);
      setHovered({
        name: names[index] ?? "",
        total: state.total[index],
        faction: state.faction[index],
      });
    },
    [names],
  );

  useEffect(() => {
    document.documentElement.dataset.palette = palette;
  }, [palette]);

  const ready = meta && zones && series && day !== null && bounds;

  return (
    <main style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
      <header
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 16,
          padding: "12px 18px",
          borderBottom: "1px solid var(--hairline)",
        }}
      >
        <span className="display" style={{ fontSize: 16 }}>
          Zone History
        </span>
        <nav style={{ display: "flex", gap: 2, flex: 1 }} aria-label="Scope">
          {(Object.keys(SCOPES) as ScopeName[]).map((name) => (
            <button
              key={name}
              className="eyebrow"
              onClick={() => setScope(name)}
              aria-current={scope === name}
              style={{
                padding: "3px 9px",
                color: scope === name ? "var(--text)" : "var(--text-dim)",
                border: `1px solid ${scope === name ? "var(--hairline-bright)" : "transparent"}`,
              }}
            >
              {SCOPES[name].label}
            </button>
          ))}
        </nav>
        <button
          className="eyebrow"
          onClick={() => setPalette((p) => (p === "canon" ? "accessible" : "canon"))}
          aria-pressed={palette === "accessible"}
          title="Canon faction colours are red/green/violet, the hardest pairing to tell apart with deuteranopia."
        >
          {palette === "canon" ? "Colour-safe palette" : "Canon palette"}
        </button>
      </header>

      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        {ready && (
          <ZoneMap
            zones={zones}
            state={stateRef.current!}
            version={version}
            boundaries={boundaries}
            viewState={viewState}
            onViewStateChange={setViewState}
            onHover={handleHover}
            paletteKey={palette}
          />
        )}
        {ready && (
          <StatsPanel
            date={dayToDate(meta.day_epoch, day)}
            totals={totals}
            previous={previous}
            zoneCount={meta.scope.zone_count}
            scopeLabel={meta.scope.label}
            hovered={hovered}
          />
        )}
        {status && (
          <div
            className="eyebrow"
            style={{ position: "absolute", left: 18, top: 16, zIndex: 10 }}
            role="status"
          >
            {status}
          </div>
        )}
      </div>

      {ready && (
        <StrataScrubber
          series={strata}
          day={day}
          minDay={bounds.min}
          maxDay={bounds.max}
          onScrub={setDay}
          epoch={meta.day_epoch}
          gapYear={COLLECTION_GAP_YEAR}
        />
      )}
    </main>
  );
}
