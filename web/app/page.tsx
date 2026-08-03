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
import { HistoryPanel, type HistoryMode, type RangeKey } from "@/components/HistoryPanel";
import { buildSeries, loadFullHistory, viewportFilter, type HistorySeries } from "@/lib/history";

const DATA_ROOT = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/data`;

const SCOPE = "global";
const INITIAL_VIEW = { longitude: 8, latitude: 26, zoom: 1.35 };

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
  const [historyMode, setHistoryMode] = useState<HistoryMode>("scope");
  const [range, setRange] = useState<RangeKey>("1y");
  const [selectedZone, setSelectedZone] = useState<number | null>(null);
  const [history, setHistory] = useState<HistorySeries | null>(null);
  const [historyStatus, setHistoryStatus] = useState<string | null>(null);
  const [status, setStatus] = useState("Loading zones");

  const [viewState, setViewState] = useState<MapViewState>({
    longitude: INITIAL_VIEW.longitude,
    latitude: INITIAL_VIEW.latitude,
    zoom: INITIAL_VIEW.zoom,
    pitch: 0,
    bearing: 0,
  });

  const stateRef = useRef<ZoneState | null>(null);
  const shardCache = useRef(new Map<string, { columns: Columns; days: Uint16Array }>());
  const checkpointCache = useRef(new Map<number, Columns>());
  const loadToken = useRef(0);
  const fullShards = useRef<Columns[] | null>(null);
  const historyToken = useRef(0);
  // Bounds are read when a series is built rather than tracked in state, so
  // panning does not rebuild 9.87M events on every frame.
  const viewportBounds = useRef<[number, number, number, number]>([-180, -85, 180, 85]);

  // Boundaries are scope-independent, so they load once and survive switching.
  useEffect(() => {
    loadBoundaries(DATA_ROOT).then(setBoundaries).catch(() => setBoundaries([]));
  }, []);

  useEffect(() => {
    const base = `${DATA_ROOT}/global`;
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
    fullShards.current = null;
    setHistory(null);
    setSelectedZone(null);
    setHistoryMode("scope");
    loadToken.current++;
    setStatus("Loading zones");
    setViewState((current) => ({ ...current, ...INITIAL_VIEW }));

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
  }, []);

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
    if (meta.scope.name !== SCOPE) return;
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
          checkpoint = await loadShard(`${DATA_ROOT}/global/checkpoints`, entry);
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
          loaded = sortByDay(await loadShard(`${DATA_ROOT}/global/events`, entry));
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
  }, [meta, zones, day]);


  // Series for the panel. Scope mode reuses the precomputed sparse series, so
  // it is instant; viewport and single-zone modes need per-event deltas across
  // all time, which means every shard. They are cached, so the cost is paid
  // once per scope.
  useEffect(() => {
    if (!meta || !zones || day === null || meta.scope.name !== SCOPE) return;
    const token = ++historyToken.current;
    const needsFull = historyMode === "viewport" || selectedZone !== null;

    (async () => {
      if (!needsFull) {
        if (!series) return;
        // Widen the sparse scope series into a dense one the chart can index.
        const span = series.rows[series.rows.length - 1][0] + 1;
        const out: HistorySeries = {
          days: new Int32Array(span),
          legion: new Float64Array(span),
          swarm: new Float64Array(span),
          faceless: new Float64Array(span),
        };
        let r = 0;
        let l = 0, sw = 0, f = 0;
        for (let d = 0; d < span; d++) {
          while (r < series.rows.length && series.rows[r][0] <= d) {
            [, l, sw, f] = series.rows[r];
            r++;
          }
          out.days[d] = d;
          out.legion[d] = l;
          out.swarm[d] = sw;
          out.faceless[d] = f;
        }
        setHistory(out);
        setHistoryStatus(null);
        return;
      }

      if (!fullShards.current) {
        setHistoryStatus("Reading full history");
        fullShards.current = await loadFullHistory(
          `${DATA_ROOT}/global`,
          meta,
          shardCache.current,
          (done, total) =>
            token === historyToken.current &&
            setHistoryStatus(`Reading full history ${Math.round((done / total) * 100)}%`),
        );
      }
      if (token !== historyToken.current) return;

      const filter =
        selectedZone !== null
          ? (idx: number) => idx === selectedZone
          : viewportFilter(zones, viewportBounds.current);

      setHistory(buildSeries(fullShards.current, meta.zones.rows, filter, day));
      setHistoryStatus(null);
    })().catch((error) => setHistoryStatus(`Could not build series: ${error.message}`));
  }, [meta, zones, day, series, historyMode, selectedZone]);

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
        <span className="eyebrow" style={{ flex: 1 }}>
          {meta?.scope.label ?? " "}
        </span>
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
            onClickZone={(index) => {
              setSelectedZone(index);
              if (index !== null) setHistoryMode("zone");
              else setHistoryMode("scope");
            }}
            onBounds={(b) => {
              viewportBounds.current = b;
            }}
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
        {ready && (
          <HistoryPanel
            series={history}
            mode={selectedZone !== null ? "zone" : historyMode}
            onModeChange={(m) => {
              setSelectedZone(null);
              setHistoryMode(m);
            }}
            range={range}
            onRangeChange={setRange}
            day={day}
            epoch={meta.day_epoch}
            title={
              selectedZone !== null
                ? names[selectedZone] || `Zone ${selectedZone}`
                : historyMode === "viewport"
                  ? "Bots in view"
                  : `Bots · ${meta.scope.label}`
            }
            subtitle={
              selectedZone !== null
                ? "Single zone"
                : historyMode === "viewport"
                  ? "Current map bounds"
                  : `${meta.scope.zone_count >= 1e6 ? `${(meta.scope.zone_count / 1e6).toFixed(1)}M` : `${(meta.scope.zone_count / 1e3).toFixed(0)}K`} zones`
            }
            status={historyStatus}
            onClose={() => {
              setSelectedZone(null);
              setHistoryMode("scope");
            }}
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
