"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MapViewState, PickingInfo } from "@deck.gl/core";
import { ZoneMap, type OverviewTile } from "@/components/ZoneMap";
import { StatsPanel, type Totals } from "@/components/StatsPanel";
import {
  checkpointUrl,
  dayToDate,
  eventUrl,
  loadJsonGz,
  loadMeta,
  loadShard,
  loadZones,
  periodOf,
  tileOf,
  tilesInBounds,
  ZoneState,
  type Bounds,
  type Columns,
  type Meta,
} from "@/lib/data";
import { loadBoundaries, type BoundaryLayer } from "@/lib/boundaries";
import { HistoryBar, type HistoryMode, type RangeKey } from "@/components/HistoryBar";
import {
  buildSeries,
  densify,
  loadTileEvents,
  loadTileSeries,
  singleZoneFilter,
  sumTileSeries,
  valueAt,
  type HistorySeries,
  type TileSeries,
} from "@/lib/history";

const DATA_ROOT = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/data`;
const BASE = `${DATA_ROOT}/global`;

const INITIAL_VIEW = { longitude: 8, latitude: 26, zoom: 1.35 };

/**
 * Below this zoom the map draws one cell per tile from the pre-aggregated
 * series and fetches no per-zone data at all: no `zones.bin.gz`, no
 * checkpoints, no event shards. Four is where a z4 tile stops being a
 * meaningful unit on screen - a viewport there spans roughly six tiles, which
 * is a manageable number of shards to pull.
 */
const DETAIL_ZOOM = 4;

// Upstream lost most of 2019: 337,859 events against 627,035 in 2018 and
// 1,438,855 in 2020. It is missing data, not a quiet year, so the scrubber
// marks it rather than letting the dip read as history.
const COLLECTION_GAP_YEAR = 2019;

interface SparseSeries {
  columns: string[];
  rows: number[][];
}

function leadingFaction(legion: number, swarm: number, faceless: number): number {
  if (legion + swarm + faceless <= 0) return 0;
  if (legion >= swarm && legion >= faceless) return 1;
  return swarm >= faceless ? 2 : 3;
}

export default function Page() {
  const [boundaries, setBoundaries] = useState<BoundaryLayer[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [scopeSeries, setScopeSeries] = useState<SparseSeries | null>(null);
  const [tileSeries, setTileSeries] = useState<TileSeries | null>(null);
  const [zones, setZones] = useState<Columns | null>(null);
  const [names, setNames] = useState<string[]>([]);
  const [day, setDay] = useState<number | null>(null);
  const [version, setVersion] = useState(0);
  const [heldInView, setHeldInView] = useState<number | null>(null);
  const [hovered, setHovered] = useState<{ name: string; total: number; faction: number } | null>(
    null,
  );
  const [historyMode, setHistoryMode] = useState<HistoryMode>("scope");
  const [range, setRange] = useState<RangeKey>("1y");
  const [selectedZone, setSelectedZone] = useState<number | null>(null);
  const [history, setHistory] = useState<HistorySeries | null>(null);
  const [historyStatus, setHistoryStatus] = useState<string | null>(null);
  const [status, setStatus] = useState("Loading");
  const [visibleTiles, setVisibleTiles] = useState<string[]>([]);

  const [viewState, setViewState] = useState<MapViewState>({
    longitude: INITIAL_VIEW.longitude,
    latitude: INITIAL_VIEW.latitude,
    zoom: INITIAL_VIEW.zoom,
    pitch: 0,
    bearing: 0,
  });

  const detail = viewState.zoom >= DETAIL_ZOOM;

  const stateRef = useRef<ZoneState | null>(null);
  const shardCache = useRef(new Map<string, Columns>());
  const loadedTiles = useRef(new Set<string>());
  const zonesRequest = useRef<Promise<Columns> | null>(null);
  const loadToken = useRef(0);
  const historyToken = useRef(0);
  const maxDayRef = useRef(0);
  // Bounds are read when a series is built rather than tracked in state, so
  // panning does not rebuild anything on every frame. The derived tile list
  // *is* state, but only changes when the set of tiles does.
  const viewportBounds = useRef<Bounds>([-180, -85, 180, 85]);

  // Boundaries are scope-independent and small, so they load once up front.
  useEffect(() => {
    loadBoundaries(DATA_ROOT).then(setBoundaries).catch(() => setBoundaries([]));
  }, []);

  /**
   * Zone positions, on demand.
   *
   * 9.87 MB that only the detail view needs, so the world view never waits for
   * it. Kicked off in the background once the cheap payloads are in, which
   * usually means it has already arrived by the time anyone zooms in.
   */
  const ensureZones = useCallback((m: Meta): Promise<Columns> => {
    if (!zonesRequest.current) {
      zonesRequest.current = loadZones(BASE, m).then((loaded) => {
        stateRef.current = new ZoneState(m.zones.rows);
        setZones(loaded);
        return loaded;
      });
    }
    return zonesRequest.current;
  }, []);

  // Startup: the manifest, the whole-scope series, and every tile's daily
  // series. About 1.9 MB, and enough for a scrubable world map on its own.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const m = await loadMeta(BASE);
      if (cancelled) return;
      setMeta(m);
      setVisibleTiles(Object.keys(m.tiles));

      const s = await loadJsonGz<SparseSeries>(BASE, m.series.scope_daily.path);
      if (cancelled) return;
      setScopeSeries(s);
      maxDayRef.current = s.rows[s.rows.length - 1][0];
      setDay(maxDayRef.current);

      setStatus("Loading overview");
      const tiles = await loadTileSeries(BASE, m);
      if (cancelled) return;
      setTileSeries(tiles);
      setStatus("");

      // Warm zone positions in the background so the first zoom-in does not
      // stall on 9.87 MB. Failures are not fatal: the detail effect retries
      // through the same promise. Names are 8 MB and only ever used for a
      // hover readout in the detail view, so they wait until there is one.
      ensureZones(m).catch(() => {
        zonesRequest.current = null;
      });
    })().catch((error) => !cancelled && setStatus(`Could not load data: ${error.message}`));

    return () => {
      cancelled = true;
    };
  }, [ensureZones]);

  const dayBounds = useMemo(() => {
    if (!scopeSeries?.rows.length) return null;
    return { min: scopeSeries.rows[0][0], max: scopeSeries.rows[scopeSeries.rows.length - 1][0] };
  }, [scopeSeries]);

  /**
   * Detail view: rebuild per-zone state at `day` for the visible tiles only.
   *
   * Each tile is the nearest year checkpoint plus that year's event shards up
   * to the target month. Tiles are applied one at a time and the map is
   * repainted after each *new* one, so a fresh viewport fills in progressively
   * rather than staying blank until the last shard lands. Repaints are skipped
   * for tiles already fetched, which is the scrubbing case - there the work is
   * pure replay over cached shards and one repaint at the end.
   */
  useEffect(() => {
    if (!meta || !detail || day === null) return;
    const token = ++loadToken.current;

    (async () => {
      if (!zones) setStatus("Loading zone positions");
      await ensureZones(meta);
      if (token !== loadToken.current) return;

      const period = periodOf(meta.day_epoch, day);
      const year = period.slice(0, 4);
      const checkpointYear = Object.keys(meta.checkpoints)
        .filter((y) => y <= year)
        .sort()
        .pop();
      // Period keys are "YYYY-MM", so a lexical compare is a chronological one.
      const from = `${checkpointYear ?? "0000"}-01`;
      const periods = Object.keys(meta.events)
        .filter((p) => p >= from && p <= period)
        .sort();

      const state = stateRef.current!;
      state.clear();
      setStatus(visibleTiles.length > 8 ? `Loading ${visibleTiles.length} tiles` : "");

      for (const tile of visibleTiles) {
        const fresh = !loadedTiles.current.has(tile);

        const checkpoint = checkpointYear && meta.checkpoints[checkpointYear][tile];
        if (checkpoint) {
          const key = `c${checkpointYear}/${tile}`;
          let columns = shardCache.current.get(key);
          if (!columns) {
            columns = await loadShard(
              checkpointUrl(BASE, checkpointYear, tile),
              meta.schemas.checkpoint,
              checkpoint[0],
            );
            shardCache.current.set(key, columns);
          }
          if (token !== loadToken.current) return;
          state.applyAll(columns);
        }

        for (const p of periods) {
          const shard = meta.events[p][tile];
          if (!shard) continue;
          const key = `${p}/${tile}`;
          let columns = shardCache.current.get(key);
          if (!columns) {
            columns = await loadShard(eventUrl(BASE, p, tile), meta.schemas.event, shard[0]);
            shardCache.current.set(key, columns);
          }
          if (token !== loadToken.current) return;
          state.applyUpToDay(columns, day);
        }

        loadedTiles.current.add(tile);
        if (fresh) setVersion((v) => v + 1);
      }

      if (token !== loadToken.current) return;
      setHeldInView(state.heldCount());
      setVersion((v) => v + 1);
      setStatus("");
    })().catch((error) => {
      if (token === loadToken.current) setStatus(`Could not load detail: ${error.message}`);
    });
  }, [meta, detail, day, visibleTiles, zones, ensureZones]);

  useEffect(() => {
    if (!detail) setHeldInView(null);
  }, [detail]);

  // Zone names, 8 MB, fetched the first time a detail view could show one.
  const namesRequested = useRef(false);
  useEffect(() => {
    if (!meta || !detail || namesRequested.current) return;
    namesRequested.current = true;
    loadJsonGz<string[]>(BASE, meta.zones.names.path)
      .then(setNames)
      .catch(() => (namesRequested.current = false));
  }, [meta, detail]);

  /**
   * The chart.
   *
   * Whole-scope and viewport modes read pre-aggregated tile totals, so both
   * are instant and neither touches an event shard. Only a single selected
   * zone needs per-event deltas, and then only over its own tile.
   */
  useEffect(() => {
    if (!meta || day === null || !dayBounds) return;
    const token = ++historyToken.current;
    const span = maxDayRef.current + 1;

    (async () => {
      if (selectedZone !== null) {
        if (!zones) return;
        const tile = tileOf(
          meta,
          (zones.latitude as Float32Array)[selectedZone],
          (zones.longitude as Float32Array)[selectedZone],
        );
        setHistoryStatus("Reading zone history");
        const shards = await loadTileEvents(
          BASE,
          meta,
          tile,
          shardCache.current,
          (done, total) =>
            token === historyToken.current &&
            setHistoryStatus(`Reading zone history ${Math.round((done / total) * 100)}%`),
        );
        if (token !== historyToken.current) return;
        setHistory(
          buildSeries(shards, meta.zones.rows, singleZoneFilter(meta.zones.rows, selectedZone), maxDayRef.current),
        );
        setHistoryStatus(null);
        return;
      }

      if (historyMode === "viewport") {
        if (!tileSeries) return;
        setHistory(sumTileSeries(tileSeries, visibleTiles, span));
        setHistoryStatus(null);
        return;
      }

      if (!scopeSeries) return;
      setHistory(densify(scopeSeries.rows, span));
      setHistoryStatus(null);
    })().catch((error) => setHistoryStatus(`Could not build series: ${error.message}`));
  }, [meta, dayBounds, scopeSeries, tileSeries, historyMode, selectedZone, visibleTiles, zones, day]);

  /** One aggregated cell per tile at the current day, for the low-zoom map. */
  const overview = useMemo<OverviewTile[]>(() => {
    if (!meta || !tileSeries || day === null) return [];
    return Object.entries(meta.tiles).map(([key, info]) => {
      const row = valueAt(tileSeries[key] ?? [], day);
      return {
        key,
        bbox: info.bbox,
        legion: row?.[1] ?? 0,
        swarm: row?.[2] ?? 0,
        faceless: row?.[3] ?? 0,
      };
    });
  }, [meta, tileSeries, day]);

  // Panel totals are the exact whole-scope figures at `day`, not a sum over
  // whatever tiles happen to be loaded. They are instant and never wrong
  // mid-load; the chart's Viewport mode is where in-view numbers live.
  const totals = useMemo<Totals>(() => {
    const row = scopeSeries && day !== null ? valueAt(scopeSeries.rows, day) : null;
    return { legion: row?.[1] ?? 0, swarm: row?.[2] ?? 0, faceless: row?.[3] ?? 0 };
  }, [scopeSeries, day]);

  const previous = useMemo<Totals | null>(() => {
    if (!scopeSeries || day === null) return null;
    const row = valueAt(scopeSeries.rows, day - 365);
    if (!row) return null;
    return { legion: row[1], swarm: row[2], faceless: row[3] };
  }, [scopeSeries, day]);

  const handleBounds = useCallback(
    (b: Bounds) => {
      viewportBounds.current = b;
      if (!meta) return;
      const next = tilesInBounds(meta, b);
      setVisibleTiles((prev) =>
        prev.length === next.length && prev.every((tile, i) => tile === next[i]) ? prev : next,
      );
    },
    [meta],
  );

  const handleHover = useCallback(
    (info: PickingInfo) => {
      if (info.layer?.id === "overview" && info.object) {
        const tile = info.object as OverviewTile;
        const total = tile.legion + tile.swarm + tile.faceless;
        setHovered({
          name: `Tile ${tile.key}`,
          total,
          faction: leadingFaction(tile.legion, tile.swarm, tile.faceless),
        });
        return;
      }
      const state = stateRef.current;
      if (info.layer?.id === "zones" && info.index >= 0 && state) {
        setHovered({
          name: names[info.index] ?? "",
          total: state.total[info.index],
          faction: state.faction[info.index],
        });
        return;
      }
      setHovered(null);
    },
    [names],
  );

  const ready = meta && scopeSeries && tileSeries && day !== null && dayBounds;

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
            state={stateRef.current}
            version={version}
            detail={detail}
            overview={overview}
            boundaries={boundaries}
            viewState={viewState}
            onViewStateChange={setViewState}
            onHover={handleHover}
            onClickZone={(index) => {
              setSelectedZone(index);
              setHistoryMode(index !== null ? "zone" : "scope");
            }}
            onBounds={handleBounds}
          />
        )}
        {ready && (
          <StatsPanel
            date={dayToDate(meta.day_epoch, day)}
            totals={totals}
            previous={previous}
            zoneCount={meta.scope.zone_count}
            scopeLabel={meta.scope.label}
            held={detail ? heldInView : null}
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
        <HistoryBar
          series={history}
          mode={selectedZone !== null ? "zone" : historyMode}
          onModeChange={(m) => {
            setSelectedZone(null);
            setHistoryMode(m);
          }}
          range={range}
          onRangeChange={setRange}
          day={day}
          minDay={dayBounds.min}
          maxDay={dayBounds.max}
          onScrub={setDay}
          epoch={meta.day_epoch}
          title={
            selectedZone !== null
              ? names[selectedZone] || `Zone ${selectedZone}`
              : historyMode === "viewport"
                ? "Bots in view"
                : "Bots"
          }
          subtitle={
            selectedZone !== null
              ? "Single zone"
              : historyMode === "viewport"
                ? `${visibleTiles.length} of ${Object.keys(meta.tiles).length} tiles`
                : `${(meta.scope.zone_count / 1e6).toFixed(1)}M zones`
          }
          status={historyStatus}
          onClearZone={() => {
            setSelectedZone(null);
            setHistoryMode("scope");
          }}
          gapYear={COLLECTION_GAP_YEAR}
        />
      )}
    </main>
  );
}
