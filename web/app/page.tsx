"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MapViewState } from "@deck.gl/core";
import { ZoneMap } from "@/components/ZoneMap";
import {
  StatsPanel,
  exactNumber,
  type HoveredZone,
  type Totals,
} from "@/components/StatsPanel";
import { AreaPicker, type Area } from "@/components/AreaPicker";
import { LoadStatus } from "@/components/LoadStatus";
import { dayToDate, zoneIdentity } from "@/lib/data";
import { dateToDay } from "@/lib/format";
import { loadBoundaries, type BoundaryLayer } from "@/lib/boundaries";
import { HistoryBar, type HistoryMode } from "@/components/HistoryBar";
import {
  areaFilter,
  inArea,
  radiusFilter,
  singleZoneFilter,
  viewportFilter,
  type ZoneFilter,
} from "@/lib/filters";
import {
  cellsInBounds,
  cellsInCircle,
  densifyScope,
  haversineKm,
  loadAreaSeries,
  seriesForArea,
  seriesForCells,
  type HistorySeries,
} from "@/lib/series";
import { zoneBlock, zoneCountsAt, zoneSeries } from "@/lib/zoneHistory";
import { loadNames } from "@/lib/names";
import { useZoneData } from "@/lib/useZoneData";
import { useCompact } from "@/lib/useCompact";
import { BottomSheet, type SheetStop } from "@/components/BottomSheet";
import { chartSpanOf, readModeOf, windowPhrase, type ReadMode, type ViewKey } from "@/lib/windows";
import { WindowPicker } from "@/components/WindowPicker";
import { FlashpointImpact } from "@/components/FlashpointImpact";
import { RegionBreakdown } from "@/components/RegionBreakdown";
import { TimelapseBar, PERIODS, type Period } from "@/components/TimelapseBar";
import { loadMaz, type MazData } from "@/lib/maz";
import {
  boardLayers,
  framing,
  loadImpact,
  readFlashpoints,
  FLASHPOINT_DAYS_PER_SECOND,
  FLASHPOINT_BOARD_DAYS_PER_SECOND,
  type Flashpoint,
  type ImpactSeries,
} from "@/lib/flashpoints";
import { BASE, DATA_ROOT } from "@/lib/dataOrigin";
import { EMPHASIS_ALL, toggleEmphasis } from "@/lib/emphasis";
import {
  useFlipStream,
  useMazOverlays,
  PLAY_DAYS_PER_SECOND as LAPSE_DAYS_PER_SECOND,
  type Backdrop,
} from "@/lib/timelapse";

const INITIAL_VIEW = { longitude: 8, latitude: 26, zoom: 1.35 };

// 1000 statute miles, the radius the game itself talks in.
const NEAR_ME_KM = 1609.344;

// Playback pacing. Fourteen years is about 5,300 days, so 260 days a second
// walks the whole record in roughly twenty seconds - long enough to watch a
// front move across a continent, short enough to sit through twice.
const PLAY_DAYS_PER_SECOND = 260;
const PLAY_HZ = 8;

// Upstream lost most of 2019: 337,859 events against 627,035 in 2018 and
// 1,438,855 in 2020. It is missing data, not a quiet year, so the scrubber
// marks it rather than letting the dip read as history.
const COLLECTION_GAP_YEAR = 2019;

/** Zoom that fits a span of degrees into the viewport, roughly. */
function zoomFor(spanLon: number, spanLat: number): number {
  const width = typeof window === "undefined" ? 1280 : window.innerWidth;
  const height = typeof window === "undefined" ? 720 : window.innerHeight;
  const zoomLon = Math.log2((width / 512) * (360 / Math.max(spanLon, 0.05)));
  const zoomLat = Math.log2((height / 512) * (180 / Math.max(spanLat, 0.05)));
  return Math.max(1, Math.min(11, Math.min(zoomLon, zoomLat) - 0.3));
}

type GeoStatus = "idle" | "asking" | "denied" | "unavailable";

export default function Page() {
  // One control. `current` is "where things stand"; a window is "what moved".
  //
  // Current, and the reason is load time as much as framing. It is the only
  // view that needs no display stream at all - `paint/` already answers it - so
  // the map is complete and correctly coloured after the first tile pass. Day
  // is a change window, so it forces an anchor plus a year of `display/`, up to
  // 3.16 MB, before the map is right, on every cold visit.
  const [view, setView] = useState<ViewKey>("current");
  // Empty zones are always drawn; this asks for *only* them.
  const [emptyOnly, setEmptyOnly] = useState(false);

  const compact = useCompact();
  const [sheetStop, setSheetStop] = useState<SheetStop>("peek");

  const span = chartSpanOf(view);
  const timelapse = view === "timelapse";

  // --- timelapse mode ------------------------------------------------------
  //
  // Its own date range, its own backdrop, and its own playback. None of it is
  // wired into the windows: they are a different question and reconciling the
  // two time models would mean rebuilding the stat panel around ranges.
  const [backdrop, setBackdrop] = useState<Backdrop>("daily");
  const [rangeStart, setRangeStart] = useState<number | null>(null);
  const [rangeEnd, setRangeEnd] = useState<number | null>(null);
  const [activePeriod, setActivePeriod] = useState<string | null>("Whole record");
  const [maz, setMaz] = useState<MazData | null>(null);
  const [flashpoint, setFlashpoint] = useState<Flashpoint | null>(null);
  const [impact, setImpact] = useState<Map<string, ImpactSeries> | null>(null);

  // Daily reads what moved; the other two read levels and restrict what is
  // drawn afterwards.
  const readMode: ReadMode = timelapse
    ? backdrop === "daily"
      ? "change"
      : "state"
    : readModeOf(view);

  const [boundaries, setBoundaries] = useState<BoundaryLayer[]>([]);
  const [hovered, setHovered] = useState<HoveredZone | null>(null);
  /**
   * Which of the five categories the map lights, driven by the panel's rows.
   *
   * A highlight, not a selection: it never reaches `filter`, so every count in the
   * panel keeps describing the same zones while the map answers "where are these".
   */
  const [emphasis, setEmphasis] = useState(EMPHASIS_ALL);
  const [historyMode, setHistoryMode] = useState<HistoryMode>("scope");
  const [selectedZone, setSelectedZone] = useState<number | null>(null);
  const [area, setArea] = useState<Area | null>(null);
  const [home, setHome] = useState<{ lat: number; lon: number } | null>(null);
  const [geoStatus, setGeoStatus] = useState<GeoStatus>("idle");
  const [history, setHistory] = useState<HistorySeries | null>(null);
  const [historyStatus, setHistoryStatus] = useState<string | null>(null);
  const [approximate, setApproximate] = useState(false);
  const [playing, setPlaying] = useState(false);

  const [viewState, setViewState] = useState<MapViewState>({
    ...INITIAL_VIEW,
    pitch: 0,
    bearing: 0,
  });

  // Bounds are read when a series is built rather than tracked in state, so
  // panning does not rebuild a series on every frame.
  const viewportBounds = useRef<[number, number, number, number]>([-180, -85, 180, 85]);
  const historyToken = useRef(0);

  // `absorb` has to exist before `useZoneData` runs, but the zone count only
  // arrives with the manifest that hook fetches. Held separately and filled in
  // once, rather than reordering the two.
  const [zoneCount, setZoneCount] = useState<number | null>(null);
  const stream = useFlipStream(zoneCount, backdrop, rangeStart);

  // In the timelapse the change window is the run's own range rather than a span
  // from the picker: "net change over all time" is a fact about the record, and
  // what the reader is watching is a period they chose.
  const data = useZoneData(
    BASE,
    span,
    readMode,
    timelapse,
    timelapse ? rangeStart : null,
    stream.absorb,
  );
  const { meta, geometry, display, lookups, zoneIds, series, day, dayBounds, changeStart, progress } =
    data;
  // Pulled out because the playback loops below own a timer each and must key
  // on it rather than on `data`, whose identity changes on every frame.
  const { setDay } = data;

  useEffect(() => {
    if (meta) setZoneCount(meta.scope.zone_count);
  }, [meta]);

  /** Curated flashpoints, straight out of the manifest. */
  const flashpoints = useMemo(
    () => (meta?.flashpoints ? readFlashpoints(meta.flashpoints) : []),
    [meta],
  );

  // One 1 KB shard for every flashpoint's series, fetched when the mode opens
  // rather than when one is picked - the whole payload is smaller than a single
  // tile, so splitting it would cost a request to save nothing.
  useEffect(() => {
    if (!timelapse || impact || !meta?.flashpoints || flashpoints.length === 0) return;
    loadImpact(BASE, meta.flashpoints, flashpoints)
      .then(setImpact)
      .catch(() => undefined);
  }, [timelapse, impact, meta, flashpoints]);

  // MAZ is only ever needed by the timelapse, so it is not on the load path.
  useEffect(() => {
    if (!timelapse || maz || !meta?.maz) return;
    loadMaz(BASE, meta.maz)
      .then(setMaz)
      .catch(() => undefined);
  }, [timelapse, maz, meta]);

  /** The furthest the period controls may reach: the whole display record. */
  const outer = useMemo(
    () => (dayBounds ? { min: dayBounds.min, max: dayBounds.max } : null),
    [dayBounds],
  );

  /** What playback and the timelapse scrubber actually run between. */
  const lapseBounds = useMemo(() => {
    if (!outer) return null;
    const min = Math.max(outer.min, rangeStart ?? outer.min);
    const max = Math.min(outer.max, rangeEnd ?? outer.max);
    return max > min ? { min, max } : { min, max: min + 1 };
  }, [outer, rangeStart, rangeEnd]);

  const gotoFlashpoint = useCallback(
    (next: Flashpoint | null) => {
      setFlashpoint(next);
      if (!next) return;
      setActivePeriod(null);
      // Opens on the standings, not on the day's events. A flashpoint frames a few
      // hundred zones, and the Daily backdrop draws only the ones with an event on
      // the date - which on the first frame of the baseline is often none of them,
      // so the reader arrives at an empty rectangle. Playback then shows the fight
      // arriving over a neighborhood that is visible from the start.
      setBackdrop("all");
      setRangeStart(next.runStart);
      setRangeEnd(next.runEnd);
      data.setDay(next.runStart);
      // A flashpoint is a third kind of focus; two of them at once means neither.
      setArea(null);
      setHome(null);
      setSelectedZone(null);
      setHistoryMode("viewport");
      // Bring the tile queue to the flashpoint, so whatever has not arrived yet
      // arrives nearest-first around it.
      data.setFocus(next.anchor.lat, next.anchor.lon);
      setViewState((v) => ({ ...v, ...framing(next, zoomFor) }));
    },
    [data],
  );

  const applyPeriod = useCallback(
    (period: Period) => {
      if (!meta) return;
      const toDay = (value: string | null) =>
        value === null ? null : dateToDay(meta.day_epoch, new Date(`${value}T00:00:00Z`));
      setRangeStart(toDay(period.start));
      setRangeEnd(toDay(period.end));
      setActivePeriod(period.label);
      setFlashpoint(null);
      // A preset about something global opens on the globe. Leaving a region
      // selected would show a worldwide change through a keyhole.
      if (period.world) {
        setArea(null);
        setHome(null);
        setSelectedZone(null);
      }
    },
    [meta],
  );

  // Keep the playhead inside the chosen period, and only when it falls out, so
  // narrowing a range around where the reader is looking leaves them there.
  useEffect(() => {
    if (!timelapse || !lapseBounds || day === null) return;
    if (day < lapseBounds.min) data.setDay(lapseBounds.min);
    else if (day > lapseBounds.max) data.setDay(lapseBounds.max);
  }, [timelapse, lapseBounds, day, data]);

  // Boundaries are independent of everything else, so they load on their own.
  useEffect(() => {
    loadBoundaries(DATA_ROOT).then(setBoundaries).catch(() => setBoundaries([]));
  }, []);

  // --- where the reader is ------------------------------------------------

  /**
   * Geolocation is asked for on a click, never on load.
   *
   * A permission prompt that appears before the reader has seen the page is
   * the kind of thing browsers now penalise and readers reflexively deny, and
   * a denial is sticky. Behind a button the ask has a reason attached.
   */
  const locate = useCallback(() => {
    if (!navigator.geolocation) return setGeoStatus("unavailable");
    setGeoStatus("asking");

    // The `timeout` option below does not cover the permission prompt: the
    // spec starts its clock only once permission is granted, so a reader who
    // ignores the dialog leaves the button saying "Locating..." forever. This
    // one covers the whole interaction.
    let settled = false;
    const giveUp = setTimeout(() => {
      if (!settled) setGeoStatus("idle");
    }, 20_000);

    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        settled = true;
        clearTimeout(giveUp);
        const here = { lat: coords.latitude, lon: coords.longitude };
        setGeoStatus("idle");
        setHome(here);
        setArea(null);
        setSelectedZone(null);
        setHistoryMode("viewport");
        // Tell the tile queue to come home first; whatever has not arrived yet
        // now arrives nearest-first around the reader.
        data.setFocus(here.lat, here.lon);
        const spanLat = (NEAR_ME_KM / 111.32) * 2;
        setViewState((v) => ({
          ...v,
          latitude: here.lat,
          longitude: here.lon,
          zoom: zoomFor(spanLat / Math.max(0.2, Math.cos((here.lat * Math.PI) / 180)), spanLat),
        }));
      },
      () => setGeoStatus("denied"),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 600_000 },
    );
  }, [data]);

  /** Fly to a picked area and pull its tiles forward in the queue. */
  const gotoArea = useCallback(
    (next: Area | null) => {
      setArea(next);
      setSelectedZone(null);
      setHistoryMode(next ? "area" : "scope");
      if (!next || !geometry) return;
      setHome(null);

      let west = 180;
      let east = -180;
      let south = 90;
      let north = -90;
      for (let slot = 0; slot < geometry.count; slot++) {
        const idx = geometry.slotToIdx[slot];
        if (!inArea(geometry, idx, next.countryId, next.regionId)) continue;
        const lat = geometry.latitude[idx];
        const lon = geometry.longitude[idx];
        if (lon < west) west = lon;
        if (lon > east) east = lon;
        if (lat < south) south = lat;
        if (lat > north) north = lat;
      }
      if (west > east) return;

      const centerLat = (south + north) / 2;
      const centerLon = (west + east) / 2;
      data.setFocus(centerLat, centerLon);
      setViewState((v) => ({
        ...v,
        latitude: centerLat,
        longitude: centerLon,
        zoom: zoomFor(east - west, north - south),
      }));
    },
    [geometry, data],
  );

  // --- which zones the readouts are about ---------------------------------

  /**
   * One filter drives the map dimming and every zone count, so they can never
   * disagree about what is on screen. Most specific wins.
   */
  /**
   * What the *map* dims by: a picked area, or near-me. Never a clicked zone.
   *
   * Clicking a dot is a request to read about it, not to empty the map. Folding
   * the selection in here dimmed all 2.68M other zones to alpha 26, which at
   * world zoom is indistinguishable from them disappearing - you lost the whole
   * picture to look at one point of it.
   */
  const selectionFilter: ZoneFilter = useMemo(() => {
    if (!geometry || !meta) return null;
    if (area) return areaFilter(geometry, area.countryId, area.regionId);
    if (home) return radiusFilter(geometry, home.lat, home.lon, NEAR_ME_KM);
    return null;
    // progress.zones so the mask grows as tiles land rather than freezing at
    // whatever had loaded when the area was picked.
  }, [geometry, meta, area, home, progress.zones]);

  /**
   * A flashpoint dims the map to its own radius, so the circle the impact figures
   * describe is the circle the reader sees lit. It wins outright because
   * `gotoFlashpoint` clears the other two - a flashpoint is a third kind of focus.
   *
   * It stops at the map. The panel's bot counts come from a precomputed series and
   * the coarsest one available for a circle is a one-degree cell - 111 km against a
   * 48 km ring - so scoping the panel here would put an approximation next to the
   * exact figures the impact readout takes from the flashpoint's own payload.
   */
  const mapFilter: ZoneFilter = useMemo(() => {
    if (!geometry || !flashpoint) return selectionFilter;
    return radiusFilter(
      geometry,
      flashpoint.anchor.lat,
      flashpoint.anchor.lon,
      flashpoint.radiusKm,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry, flashpoint, selectionFilter, progress.zones]);

  /**
   * What the readouts count. The selection, plus the clicked zone when there is
   * one - most specific wins: zone > area > near-me.
   */
  const filter: ZoneFilter = useMemo(() => {
    if (!geometry || selectedZone === null) return selectionFilter;
    return singleZoneFilter(geometry.size, selectedZone);
  }, [geometry, selectedZone, selectionFilter]);

  // The timelapse's own layers. `mapFilter` rather than `filter`, so clicking a
  // zone to read about it does not empty the map of marks.
  const overlays = useMazOverlays({
    maz,
    geometry,
    display,
    version: data.version,
    day: timelapse ? day : null,
    zoom: viewState.zoom ?? 0,
    focus: timelapse ? mapFilter : null,
    stream,
  });

  /**
   * The board zones' rings, drawn over the MAZ marks.
   *
   * After the recurrence rings in the layer list so they sit on top: a flashpoint
   * names at most ten zones against a hundred amber ones, and it is the stronger
   * claim on screen.
   */
  // The ring the map draws comes from the flashpoint's own radius, so the circle
  // on screen and the circle the impact figures describe are one circle.
  const flashpointLayers = useMemo(() => {
    if (!flashpoint || !geometry || day === null) return [];
    return boardLayers({
      flashpoint,
      geometry,
      day,
      zoom: viewState.zoom ?? 0,
      nameOf: (idx) => geometry.names[idx] ?? null,
    });
  }, [flashpoint, geometry, day, viewState.zoom]);

  // --- the chart, which is also where every bot count comes from -----------

  /**
   * Build the series for whatever is selected.
   *
   * The panel reads its figures off this same series rather than summing the
   * map, which is what makes the two agree by construction. Three precomputed
   * grains answer it; the only approximate one is a circle or a viewport, which
   * no export can name in advance. Computing a chart over an arbitrary subset
   * on the client instead is what would require all 9.88M events in memory.
   */
  useEffect(() => {
    if (!meta || !geometry || !series || !dayBounds) return;
    const token = ++historyToken.current;
    const maxDay = dayBounds.max;
    const settle = (built: HistorySeries, isApproximate: boolean) => {
      if (token !== historyToken.current) return;
      setHistory(built);
      setApproximate(isApproximate);
      setHistoryStatus(null);
    };

    (async () => {
      if (selectedZone !== null) {
        const block = zoneBlock(BASE, meta.zone_history, selectedZone);
        if (!block) return settle(densifyScope([], maxDay), false);
        setHistoryStatus("Reading zone history");
        return settle(zoneSeries(await block, selectedZone, maxDay), false);
      }

      if (area) {
        const entry = area.regionId !== null ? meta.area_series.region : meta.area_series.country;
        const id = area.regionId ?? area.countryId;
        setHistoryStatus("Reading area history");
        return settle(seriesForArea(await loadAreaSeries(BASE, entry), id, maxDay), false);
      }

      const cells = meta.area_series.cells;
      if (home) {
        setHistoryStatus("Reading nearby history");
        const selection = cellsInCircle(cells, home.lat, home.lon, NEAR_ME_KM);
        return settle(await seriesForCells(BASE, cells, selection, maxDay), true);
      }

      if (historyMode === "viewport") {
        setHistoryStatus("Reading history in view");
        const selection = cellsInBounds(cells, viewportBounds.current);
        return settle(await seriesForCells(BASE, cells, selection, maxDay), true);
      }

      settle(densifyScope(series.rows, maxDay), false);
    })().catch((error) => {
      if (token === historyToken.current) {
        setHistoryStatus(`Could not build series: ${error.message ?? error}`);
      }
    });
  }, [meta, geometry, series, dayBounds, selectedZone, area, home, historyMode]);

  /**
   * The figures in the panel.
   *
   * Bots come from the series - exact for the scope, a country, a region or a
   * single zone, cell-aggregated for a circle or a viewport. Zone counts come
   * from the map's own bytes, so they are exact for every selection. Nothing
   * here sums per-zone counts; the client holds none.
   */
  const changing = readMode === "change" && changeStart !== null;

  const shown = useMemo(() => {
    if (!display || day === null) {
      return {
        totals: { legion: 0, swarm: 0, faceless: 0, held: 0 },
        zones: null,
        count: null,
        pending: true,
      };
    }

    // Three different counts, and mixing them up is how the panel starts lying.
    //   count  zones in the selection - the denominator. Deliberately *not*
    //          "zones drawn": with empty zones toggled off that would make the
    //          panel read "1.6M of 1.6M occupied", a number that never moves.
    //   held   zones with bots on the ground. Not the control flag, which keeps
    //          naming a faction long after its last bot has gone.
    //   drawn  zones the window is showing, which is what "moved" means.
    //
    // Without an area selection none of the three needs a pass over 2.68M zones
    // on this thread: the worker counts `held` in the sequential pass it already
    // makes, `drawn` is the `shown` it already reports, and `count` is only ever
    // rendered when there is a selection to be a denominator of. Walking them
    // here read `pk` and `visible` through the slot indirection - a cache miss
    // per zone, on the frame path, and 10.8% of all CPU during playback.
    //
    // The selection case still counts, because the mask is the page's own and
    // the worker has never seen it. The first-load case does too: `paint/` fills
    // `display.pk` straight off the tiles before any worker answer has landed.
    let held: number;
    let drawn: number;
    let count = 0;
    // [empty, legion, swarm, faceless] by leading faction, plus the part of empty
    // that has never held a bot in the whole record.
    let byFaction: [number, number, number, number] = [0, 0, 0, 0];
    let neverPlayed = 0;

    if (!filter && data.held !== null) {
      held = data.held;
      drawn = data.shown ?? display.size;
      byFaction = data.byFaction ?? [0, 0, 0, 0];
      // A constant, not a count. A zone with no bot in the record is empty in every
      // frame - which is why terrain is built when tiles land and never per date -
      // so the manifest already knows this and the main thread walks nothing.
      neverPlayed = meta ? meta.scope.zone_count - meta.scope.active_count : 0;
      count = display.size;
    } else {
      // By slot, because that is the order `pk` and `visible` are held in. The
      // mask is the page's own and stays in idx order, so it is the one thing
      // reached through `slotToIdx` here. Bounded by the slots actually loaded,
      // so a count taken mid-load describes the zones on the map rather than
      // the whole world.
      held = 0;
      drawn = 0;
      const slots = geometry?.count ?? 0;
      const toIdx = geometry?.slotToIdx;
      const everActive = geometry?.everActiveBySlot;
      for (let slot = 0; slot < slots; slot++) {
        if (filter && !filter[toIdx![slot]]) continue;
        count++;
        const packed = display.pk[slot];
        byFaction[packed >> 6]++;
        if (packed !== 0) held++;
        // Slot-keyed like `pk`, so the two shades of grey the map already draws
        // cost no extra indirection here.
        else if (everActive && everActive[slot] === 0) neverPlayed++;
        if (display.visible[slot] !== 0) drawn++;
      }
    }

    const at = (d: number) =>
      history && d >= 0 && d < history.legion.length
        ? { legion: history.legion[d], swarm: history.swarm[d], faceless: history.faceless[d] }
        : null;

    const now = at(day);
    if (!now) {
      return {
        totals: { legion: 0, swarm: 0, faceless: 0, held },
        zones: null,
        count: filter ? count : null,
        pending: true,
      };
    }

    if (changing) {
      const before = at(changeStart!) ?? { legion: 0, swarm: 0, faceless: 0 };
      return {
        totals: {
          legion: now.legion - before.legion,
          swarm: now.swarm - before.swarm,
          faceless: now.faceless - before.faceless,
          // The panel labels this "zones moved", so it is every zone the window
          // is drawing, whether or not it still holds anything. A zone fought
          // down to nothing moved as much as one that was taken.
          held: drawn,
        } as Totals,
        // A per-faction zone count is a level and there is no honest delta for it:
        // "which faction gained most zones" is the very thing the map refuses to
        // colour by, because it makes one vocabulary mean two things.
        zones: null,
        count: filter ? count : null,
        pending: false,
      };
    }

    return {
      totals: { ...now, held } as Totals,
      zones: {
        legion: byFaction[1],
        swarm: byFaction[2],
        faceless: byFaction[3],
        neverPlayed,
        // Held something once, holds nothing now. Derived so the four categories
        // sum to `count` by construction rather than by a second count.
        emptied: Math.max(0, count - held - neverPlayed),
      },
      count: filter ? count : null,
      pending: false,
    };
    // data.version so the counts follow the map as tiles land and dates change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, display, geometry, history, day, changing, changeStart, data.version, data.held, data.shown]);

  /** A year earlier on the same series, for the growth figure. */
  const previous: Totals | null = useMemo(() => {
    if (!history || day === null || changing) return null;
    const then = day - 365;
    if (then < 0) return null;
    return {
      legion: history.legion[then],
      swarm: history.swarm[then],
      faceless: history.faceless[then],
      held: 0,
    };
  }, [history, day, changing]);

  /**
   * Net bots across the run so far, for the timelapse.
   *
   * The panel's own figures follow the backdrop - standings on two of the three -
   * so the movement since the period opened would otherwise not be on screen at
   * all, which is the one number a run is about. Read off the same series the
   * panel and the chart use, so it cannot disagree with either.
   */
  const sinceRange: { label: string; value: number } | null = useMemo(() => {
    if (!timelapse || !history || day === null || rangeStart === null || changing) return null;
    const from = Math.max(0, Math.min(rangeStart, day));
    if (from >= day) return null;
    const net = (key: "legion" | "swarm" | "faceless") => history[key][day] - history[key][from];
    return {
      label: `Since ${dayToDate(meta!.day_epoch, from).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      })}`,
      value: net("legion") + net("swarm") + net("faceless"),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timelapse, history, day, rangeStart, changing, meta]);

  // --- hover: the map's bucket now, the record a moment later ---------------

  const hoveredIdx = useRef<number | null>(null);

  /**
   * Hover: render from what is in hand, then sharpen.
   *
   * Neither the zone's name nor its exact counts are on the load path any more
   * — they are two ~15-50 KB blocks fetched the moment the pointer settles. So
   * the readout paints immediately from the map's own byte, with the count
   * marked approximate and the name possibly missing, and fills in when the
   * blocks land. A tooltip that waits on a fetch reads as broken; one that
   * sharpens does not.
   */
  const handleHover = useCallback(
    (idx: number | null) => {
      hoveredIdx.current = idx;
      if (idx === null || !display || !geometry || !meta || day === null) return setHovered(null);

      // `pk` is held by slot; a hover arrives as an idx.
      const slot = geometry.idxToSlot[idx];
      const pk = slot < 0 ? 0 : display.pk[slot];
      const describe = (over: Partial<HoveredZone> = {}): HoveredZone => {
        const identity = zoneIdentity(geometry, lookups, zoneIds, idx);
        return {
          name: identity.name ?? "",
          faction: pk >> 6,
          total: display.approximateTotal(pk & 63),
          approximate: true,
          everActive: geometry.everActive[idx] === 1,
          zoneId: identity.zoneId ?? undefined,
          region: identity.region,
          country: identity.country,
          ...over,
        };
      };

      setHovered(describe());

      const fresh = () => hoveredIdx.current === idx;

      // Re-describe rather than patching the name in: `describe` re-reads the
      // identity, which now has one. Only the counts are carried over, because
      // the history block may already have sharpened them.
      loadNames(BASE, meta.names, idx, geometry.names)
        ?.then(
          () =>
            fresh() &&
            setHovered((h) =>
              h
                ? describe({ faction: h.faction, total: h.total, approximate: h.approximate })
                : h,
            ),
        )
        .catch(() => undefined);

      zoneBlock(BASE, meta.zone_history, idx)
        ?.then((columns) => {
          const counts = zoneCountsAt(columns, idx, day);
          if (!fresh() || !counts) return;
          setHovered(
            describe({ faction: counts.faction, total: counts.total, approximate: false }),
          );
        })
        .catch(() => undefined);
    },
    [display, geometry, lookups, zoneIds, meta, day],
  );

  const focusLabel = useMemo(() => {
    if (selectedZone !== null && geometry) {
      const { region, country, zoneId } = zoneIdentity(geometry, lookups, zoneIds, selectedZone);
      return [region, country, zoneId !== null ? `#${zoneId}` : null].filter(Boolean).join(" · ");
    }
    if (area) return `${area.label} · ${area.detail}`;
    if (home) return "Within 1000 miles of you";
    return null;
  }, [selectedZone, area, home, geometry, lookups, zoneIds]);

  /**
   * Playback, paced by the clock rather than by frames.
   *
   * How long a step takes depends on the machine and on 2.7M dots being
   * re-coloured, so a fixed days-per-tick would make the whole run last
   * anywhere from twenty seconds to a minute. Reading the real elapsed time
   * keeps the run the same length everywhere.
   *
   * The worker carries state forward across a gap for the cost of one day, so
   * the playhead never waits for the map; it leads and the map catches up.
   */
  useEffect(() => {
    // Timelapse runs the loop below instead, and the two must never both be
    // live: this one scales its step by real elapsed time at 260 days a second,
    // so a single long frame turns into a two-month jump on a view that
    // promises every day in order. `playing` is shared between the two modes,
    // so the guard has to be here rather than in whoever sets it.
    if (!playing || timelapse || !dayBounds) return;
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      const advance = Math.max(1, Math.round(((now - last) / 1000) * PLAY_DAYS_PER_SECOND));
      last = now;
      setDay((current) => {
        if (current === null) return current;
        if (current + advance >= dayBounds.max) {
          setPlaying(false);
          return dayBounds.max;
        }
        return current + advance;
      });
    }, 1000 / PLAY_HZ);
    return () => clearInterval(id);
  }, [playing, timelapse, dayBounds, setDay]);

  /**
   * Timelapse playback: one day per frame, never more.
   *
   * Separate from the loop above because it is a different promise. That one
   * covers the record in a fixed twenty seconds and skips whatever it must; this
   * one shows every single day and slows down instead, so a run is as long as
   * the period is. The readout is the date itself.
   */
  const dayRef = useRef<number | null>(null);
  dayRef.current = day;
  // Read inside the loop rather than keyed on, so picking a flashpoint mid-run
  // changes the pace without tearing down the timer and resetting its debt.
  const flashpointRef = useRef<Flashpoint | null>(null);
  flashpointRef.current = flashpoint;

  useEffect(() => {
    if (!playing || !timelapse || !lapseBounds) return;
    let frame = 0;
    let last = performance.now();
    let debt = 0;

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      // A flashpoint is a few days in one neighborhood, so the run is short
      // enough to afford being slow and being slow is the entire point: at the
      // record-crossing rate a Marquette run ends in under two seconds and the
      // day the fight happened is a single frame.
      const chosen = flashpointRef.current;
      const current0 = dayRef.current;
      // Slower still while the playhead is standing on the flashpoint's own days.
      // The whole run exists to show one or three days, and at the run's ordinary
      // pace they go by in the same fraction of a second as the fifty-six days of
      // context around them.
      const onTheDay =
        chosen !== null &&
        current0 !== null &&
        current0 >= chosen.boardStart &&
        current0 <= chosen.boardEnd;
      debt +=
        ((now - last) / 1000) *
        (onTheDay
          ? FLASHPOINT_BOARD_DAYS_PER_SECOND
          : chosen
            ? FLASHPOINT_DAYS_PER_SECOND
            : LAPSE_DAYS_PER_SECOND);
      last = now;
      if (debt > 1) debt = 1;
      if (debt < 1) return;
      debt = 0;

      const current = dayRef.current;
      if (current === null) return;
      const next = current + 1 > lapseBounds.max ? lapseBounds.min : current + 1;
      dayRef.current = next;
      setDay(next);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // `setDay` and not `data`: keyed on the whole object this effect tore down
    // and rebuilt on every render, which reset `last` and `debt` each time and
    // left the run advancing at a fraction of the rate asked for.
  }, [playing, timelapse, lapseBounds, setDay]);

  const clearFocus = useCallback(() => {
    setSelectedZone(null);
    setArea(null);
    setHome(null);
    setHistoryMode("scope");
  }, []);

  /**
   * Switch view, and move the playhead if the new view wants a different date.
   *
   * `Current` means now, so it goes to the newest date even when that day is
   * still running - a level is correct at any moment, it is only a *window*
   * ending mid-day that undercounts. Every window therefore does the reverse
   * and pulls back off the partial day if that is where the playhead was left.
   */
  const changeView = useCallback(
    (next: ViewKey) => {
      setView(next);
      // A flashpoint belongs to the timelapse: it owns a range, a camera and a
      // dimming mask, none of which the windows have a way to express. Leaving it
      // set behind a window keeps the map framed on one neighborhood and the panel
      // reading a viewport aggregate under a heading that says Global.
      if (next !== "timelapse") {
        setFlashpoint(null);
        setHistoryMode("scope");
      }
      if (!dayBounds) return;
      if (next === "current") data.setDay(dayBounds.max);
      else data.setDay((d) => (d === null || d > dayBounds.lastComplete ? dayBounds.lastComplete : d));
    },
    [dayBounds, data],
  );

  const ready = meta && geometry && display && day !== null && dayBounds;

  const locateButton = (
    <button
      className="eyebrow"
      onClick={home ? clearFocus : locate}
      disabled={geoStatus === "asking"}
      style={{
        border: "1px solid var(--hairline-bright)",
        background: home ? "var(--hairline)" : "rgba(14,18,24,0.82)",
        padding: "6px 10px",
        color: geoStatus === "denied" ? "var(--text-dim)" : "var(--text)",
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
      title={
        geoStatus === "denied"
          ? "Location permission was declined. Enable it in the address bar to use this."
          : "Centre the map on you and ring 1000 miles"
      }
    >
      {geoStatus === "asking"
        ? "Locating…"
        : geoStatus === "denied"
          ? "Location blocked"
          : home
            ? "Clear location"
            : "Near me"}
    </button>
  );

  const areaPicker = (
    <AreaPicker
      lookups={lookups}
      geometry={geometry}
      version={data.version}
      selected={area}
      onSelect={gotoArea}
    />
  );

  const timelapseBar = meta ? (
    <TimelapseBar
      epoch={meta.day_epoch}
      outer={outer}
      bounds={lapseBounds}
      day={day}
      onDay={data.setDay}
      rangeStart={rangeStart}
      rangeEnd={rangeEnd}
      onRange={(start, end) => {
        setRangeStart(start);
        setRangeEnd(end);
        setActivePeriod(null);
      }}
      activePeriod={activePeriod}
      onPeriod={applyPeriod}
      backdrop={backdrop}
      onBackdrop={setBackdrop}
      playing={playing}
      onTogglePlay={() => setPlaying((p) => !p)}
      marks={overlays.marks}
      flips={overlays.flips}
      flashpoints={flashpoints}
      activeFlashpoint={flashpoint?.id ?? null}
      onFlashpoint={gotoFlashpoint}
      claimed={stream.claimed}
    />
  ) : null;

  const togglePlay = () => {
    // Pressing play at the end of the record replays it rather than doing
    // nothing, which is what a play button at the end should do.
    if (!playing && day !== null && dayBounds && day >= dayBounds.max) data.setDay(dayBounds.min);
    setPlaying((p) => !p);
  };

  /* A country selection asks where inside it anything is happening, which the
     panel's own totals cannot say. Only for a whole country: picking one region
     already answers it.

     Absent while the panel is reporting movement, for the same reason the zone
     column is: every figure in these rows is a level, and sitting them under a
     heading that says "net change" makes them read as deltas. */
  const regionBreakdown =
    ready && !changing && area && area.regionId === null && geometry && display && lookups ? (
      <RegionBreakdown
        geometry={geometry}
        display={display}
        lookups={lookups}
        countryId={area.countryId}
        countryLabel={area.label}
        version={data.version}
      />
    ) : null;

  const statsPanel = ready ? (
    <StatsPanel
      date={dayToDate(meta.day_epoch, day)}
      totals={shown.totals}
      zones={shown.zones}
      previous={previous}
      zoneCount={shown.count ?? meta.scope.zone_count}
      activeCount={meta.scope.active_count}
      scopeLabel={focusLabel ?? meta.scope.label}
      hovered={hovered}
      stateReady={!shown.pending}
      changeLabel={
        changing
          ? // Named by its own first day in the timelapse, where the window is the
            // run's range: "over all time" would describe the record instead of
            // the period the reader picked.
            changeStart !== null && timelapse
              ? `Net change since ${dayToDate(meta.day_epoch, changeStart).toLocaleDateString(
                  "en-GB",
                  { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" },
                )}`
              : `Net change ${windowPhrase(span)}`
          : null
      }
      pending={shown.pending}
      compact={compact}
      since={sinceRange}
      emphasis={emphasis}
      onEmphasis={(key) => setEmphasis((current) => toggleEmphasis(current, key))}
    >
      {regionBreakdown}
    </StatsPanel>
  ) : null;

  const impactPanel =
    timelapse && flashpoint ? (
      <FlashpointImpact
        flashpoint={flashpoint}
        series={impact?.get(flashpoint.id) ?? null}
        compact={compact}
      />
    ) : null;

  const historyBar = ready ? (
    <HistoryBar
      series={history}
      mode={historyMode}
      onModeChange={(m) => {
        clearFocus();
        setHistoryMode(m);
      }}
      span={span}
      onSpan={changeView}
      day={day}
      minDay={dayBounds.min}
      maxDay={dayBounds.max}
      onScrub={data.setDay}
      epoch={meta.day_epoch}
      title={
        selectedZone !== null
          ? geometry.names[selectedZone] || `Zone ${selectedZone}`
          : area
            ? area.label
            : home
              ? "Bots near you"
              : historyMode === "viewport"
                ? "Bots in view"
                : "Bots"
      }
      subtitle={
        approximate
          ? `${focusLabel ?? "Current map bounds"} · to the nearest degree`
          : (focusLabel ?? `${(meta.scope.active_count / 1e6).toFixed(1)}M played zones`)
      }
      status={historyStatus}
      onClearFocus={clearFocus}
      gapYear={COLLECTION_GAP_YEAR}
      playing={playing}
      onTogglePlay={togglePlay}
      compact={compact}
    />
  ) : null;

  /** The line the sheet always shows, at every stop. */
  const sheetSummary = ready ? (
    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
      {/* Playback lives here, not only in the chart. The chart is inside the
          sheet and only rendered at its tallest stop, which buried the one
          control worth having over a full-screen map two drags deep. */}
      <button
        onClick={togglePlay}
        aria-label={playing ? "Pause playback" : "Play the history forward"}
        aria-pressed={playing}
        style={{
          width: 30,
          height: 30,
          flexShrink: 0,
          border: "1px solid var(--hairline-bright)",
          background: playing ? "var(--hairline)" : "transparent",
          color: "var(--text)",
          fontSize: 12,
          lineHeight: 1,
        }}
      >
        {playing ? "❙❙" : "▶"}
      </button>
      <span className="display tabular" style={{ fontSize: 17, whiteSpace: "nowrap" }}>
        {dayToDate(meta.day_epoch, day).toLocaleDateString("en-GB", {
          day: "2-digit",
          month: "short",
          year: "numeric",
          timeZone: "UTC",
        })}
      </span>
      <span
        className="eyebrow"
        style={{
          color: "var(--text-dim)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {/* One figure, exact. Two of them at 390 px truncate mid-number, and half a
            count is worse than a rounded one - the panel a tap away has both. */}
        {changing
          ? `${exactNumber(shown.totals.held)} moved`
          : `${exactNumber(
              shown.totals.legion + shown.totals.swarm + shown.totals.faceless,
            )} bots`}
      </span>
    </div>
  ) : null;

  return (
    <main style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: compact ? 8 : 14,
          padding: compact ? "8px 0 8px" : "10px 18px",
          borderBottom: "1px solid var(--hairline)",
          flexWrap: compact ? "wrap" : "nowrap",
          flexShrink: 0,
        }}
      >
        {compact ? (
          <>
            {/* Title row, then the controls get the full width to scroll in. */}
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 8,
                width: "100%",
                padding: "0 12px",
              }}
            >
              <span
                className="display"
                style={{ fontSize: 15, whiteSpace: "nowrap", flexShrink: 0 }}
              >
                Zone History
              </span>
              <div style={{ flex: 1, minWidth: 8 }} />
              {areaPicker}
              {locateButton}
            </div>
            <WindowPicker
              view={view}
              onView={changeView}
              emptyOnly={emptyOnly}
              onEmptyOnly={setEmptyOnly}
              pending={changing && data.shown === null}
              scrollable
            />
          </>
        ) : (
          <>
            <span className="display" style={{ fontSize: 16 }}>
              Zone History
            </span>
            <span className="eyebrow">{meta?.scope.label ?? " "}</span>
            <div style={{ flex: 1 }} />
            <WindowPicker
              view={view}
              onView={changeView}
              emptyOnly={emptyOnly}
              onEmptyOnly={setEmptyOnly}
              pending={changing && data.shown === null}
            />
            {areaPicker}
            {locateButton}
          </>
        )}
      </header>

      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        {geometry && display && (
          <ZoneMap
            geometry={geometry}
            display={display}
            version={data.version}
            boundaries={boundaries}
            viewState={viewState}
            filter={mapFilter}
            draw={emptyOnly ? "empty" : "all"}
            emphasis={emphasis}
            only={timelapse && backdrop === "cumulative" ? stream.mask : null}
            onlyVersion={stream.version}
            overlays={timelapse ? [...overlays.layers, ...flashpointLayers] : undefined}
            ring={
              flashpoint
                ? {
                    lat: flashpoint.anchor.lat,
                    lon: flashpoint.anchor.lon,
                    radiusKm: flashpoint.radiusKm,
                  }
                : home
                  ? { lat: home.lat, lon: home.lon, radiusKm: NEAR_ME_KM }
                  : null
            }
            onViewStateChange={setViewState}
            onHover={handleHover}
            onClickZone={(idx) => {
              // A touch screen has no hover, so the tap has to do both jobs:
              // name the zone and select it. On a pointer device the readout is
              // already showing, and setting it again costs nothing.
              handleHover(idx);
              setSelectedZone(idx);
              setHistoryMode(idx !== null ? "zone" : area ? "area" : "scope");
              if (compact && idx !== null) setSheetStop("half");
            }}
            onBounds={(b) => {
              viewportBounds.current = b;
            }}
          />
        )}

        {/* Wide: the panel floats over the map and the chart is the page's
            footer. Compact: both live in a sheet the reader drags up, so the
            map keeps the screen until they ask for numbers. */}
        {!compact && statsPanel}
        <LoadStatus progress={progress} totalZones={meta?.scope.zone_count ?? 0} />

        {compact && ready && (
          <BottomSheet stop={sheetStop} onStop={setSheetStop} summary={sheetSummary}>
            {/* Inside the sheet on a narrow screen, where the chart it stands in
                for also lives. In the page's own flow it would be laid out under a
                sheet that is fixed over the map, and the two would collide. */}
            {timelapse && flashpoint ? impactPanel : statsPanel}
            {sheetStop === "full" && historyBar}
          </BottomSheet>
        )}
      </div>

      {/* The timelapse replaces the chart rather than sitting beside it: it runs
          on a date range, and a chart drawn for a window would be describing a
          different span from the one playing. */}
      {/* The impact readout sits above the bar, where the chart would be: it
          describes the same span the bar is playing. */}
      {!compact && impactPanel}
      {timelapse ? timelapseBar : !compact && historyBar}
    </main>
  );
}
