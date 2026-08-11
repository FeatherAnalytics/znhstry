"use client";

/**
 * The bench.
 *
 * Charts and analyses get built here, looked at, and then take one of three
 * exits: promoted into the main page, deleted with the line of work closed, or
 * left standing so it can be shared with other players for feedback. Nothing
 * lives here permanently by accident - an entry with no exit chosen is an entry
 * nobody has decided about, which is what the status on each card is for.
 *
 * **The rule that keeps promotion cheap: nothing on this page holds logic.**
 * Every number comes from a pure function in `lib/`, and every mark comes from a
 * component in `components/charts/`. This file is composition and prose. Moving
 * a chart to the main page is then an import, not a rewrite, and the two pages
 * can never drift into computing the same statistic two ways.
 *
 * It is deliberately outside the map. A map page is a single full-viewport
 * surface with a fixed bottom bar; a bench is a scrolling column. Trying to be
 * both is what would make this hard to throw away.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BASE } from "@/lib/dataOrigin";
import { dateToDay, loadJson } from "@/lib/format";
import { dayToDate } from "@/lib/data";
import type { Meta } from "@/lib/data";
import { loadNames } from "@/lib/names";
import {
  appearancesByZone,
  biggestDays,
  biggestReports,
  countEqual,
  dailyTotals,
  factionDaily,
  fightShape,
  linearBins,
  loadMazStats,
  logBins,
  longestStreaks,
  perReport,
  portalReportUrl,
  summarize,
  FACTION_SPLIT_BROKEN,
  type MazStats,
} from "@/lib/mazStats";

import {
  clusterRecord,
  loadZoneCoords,
  NEIGHBORHOOD_KM,
  type Coord,
  type DayCluster,
} from "@/lib/mazClusters";

import { FACTIONS, MAZ_AMBER } from "@/components/charts/palette";
import { Histogram } from "@/components/charts/Histogram";
import { TimeSeries } from "@/components/charts/TimeSeries";
import { StackedShare } from "@/components/charts/StackedShare";
import { Scatter } from "@/components/charts/Scatter";

type Status = "open" | "keep" | "promote" | "cut";

// Both thresholds are chosen so the list is short enough to name every entry on
// the page, which is what makes an outlier worth calling out rather than leaving
// in a tail. At these values that is 11 reports and 3 days.
const BIG_REPORT = 10_000;
const BIG_DAY = 30_000;

const STATUS_LABEL: Record<Status, string> = {
  open: "undecided",
  keep: "keep — for feedback",
  promote: "promote to the map",
  cut: "cut",
};

export default function PrototypePage() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [stats, setStats] = useState<MazStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadJson<Meta>(`${BASE}/meta.json`)
      .then(async (m) => {
        if (cancelled) return;
        setMeta(m);
        if (!m.maz?.stats) throw new Error("this export has no maz_stats shard");
        const loaded = await loadMazStats(BASE, m.maz);
        if (!cancelled) setStats(loaded);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const epoch = meta?.day_epoch ?? "2010-01-01";
  const labelOf = useMemo(
    () => (day: number) => dayToDate(epoch, day).toISOString().slice(0, 10),
    [epoch],
  );

  const derived = useMemo(() => {
    if (!stats || !meta) return null;

    // The window where the per-faction split is partial, in day numbers. Held
    // here rather than inside the functions because only the page knows the
    // epoch the shard was written against.
    const brokenFrom = dateToDay(meta.day_epoch, new Date(`${FACTION_SPLIT_BROKEN.from}T00:00:00Z`));
    const brokenTo = dateToDay(meta.day_epoch, new Date(`${FACTION_SPLIT_BROKEN.to}T00:00:00Z`));

    const report = summarize(stats.launches);
    const daily = dailyTotals(stats, stats.launches);
    const dailySummary = summarize(daily.value);
    const rate = perReport(daily);
    const rateSummary = summarize(rate.value);
    const reportsPerDay = summarize(daily.reports);
    const appearances = appearancesByZone(stats);
    const factions = factionDaily(stats, brokenFrom, brokenTo);
    const shape = fightShape(stats, brokenFrom, brokenTo);
    const streaks = longestStreaks(stats);

    const appearanceValues = Float64Array.from(appearances.values());
    const streakValues = Float64Array.from(streaks.values());

    return {
      factions,
      shape,
      dominanceBins: linearBins(shape.dominance, 20),
      appearanceBins: logBins(appearanceValues, 8),
      // Log, not linear: streaks run 1 to 152 with almost everything at 1, so
      // linear bins put 95% of zones in the first bar and draw nothing else.
      streakBins: logBins(streakValues, 8),
      appearOnce: countEqual(appearanceValues, 1),
      longestStreak: Math.max(...streakValues),
      streakOverOne: streakValues.length - countEqual(streakValues, 1),
      streakZones: streakValues.length,
      perReport: report,
      daily,
      dailySummary,
      rate,
      rateSummary,
      reportsPerDay,
      tenReportDays: countEqual(daily.reports, 10),
      perReportBins: logBins(stats.launches),
      dailyBins: logBins(daily.value),
      rateBins: logBins(rate.value),
      bigReports: biggestReports(stats, BIG_REPORT),
      bigDays: biggestDays(stats, BIG_DAY),
      zones: appearances.size,
      topAppearances: Math.max(...appearances.values()),
      days: daily.day.length,
    };
  }, [stats, meta]);

  // Coordinates, and the clusters built from them.
  //
  // Behind a button on purpose. This is the 9.27 MB of geometry the map loads,
  // and it is the only place coordinates live - `CLAUDE.md` keeps them out of the
  // MAZ payload precisely so there is one copy. Every other card on this page
  // costs half a megabyte, so making the whole bench pay for one section would
  // be the wrong default.
  const [coords, setCoords] = useState<Map<number, Coord> | null>(null);
  const [tileProgress, setTileProgress] = useState<{ done: number; total: number } | null>(null);

  const loadGeometry = useCallback(() => {
    if (!meta || !stats || tileProgress) return;
    const wanted = new Set<number>();
    for (let r = 0; r < stats.reports.reportCount; r++) wanted.add(stats.reports.reportIdx[r]);

    setTileProgress({ done: 0, total: meta.geometry.tiles.length });
    loadZoneCoords(BASE, meta.geometry, wanted, (done, total) =>
      setTileProgress({ done, total }),
    )
      .then(setCoords)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [meta, stats, tileProgress]);

  const clusters = useMemo(() => {
    if (!stats || !coords) return null;
    const { reportIdx, reportDay, dayMin, dayMax, dayOffset } = stats.reports;
    return clusterRecord(
      reportIdx,
      reportDay,
      stats.launches,
      dayMin,
      dayMax,
      dayOffset,
      coords,
    );
  }, [stats, coords]);

  /** The clusters worth naming: four or more zones, biggest then tightest. */
  const topClusters: DayCluster[] | null = useMemo(() => {
    if (!clusters) return null;
    return clusters.clusters
      .filter((c) => c.spread.count >= 4)
      .sort((a, b) => b.spread.count - a.spread.count || a.spread.diameterKm - b.spread.diameterKm);
  }, [clusters]);

  // Names are off the load path everywhere else and stay off it here: one ~19 KB
  // block per outlier, fetched only once the reports are in hand. `names` is
  // keyed by idx, so a block landing late fills its rows in place and the state
  // bump redraws whatever arrived.
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    if (!meta || !derived) return;
    let cancelled = false;
    const into: string[] = [];
    const wanted = [
      ...derived.bigReports.map((r) => r.idx),
      // The named clusters, once they exist. Same blocks in many cases, and
      // `loadNames` dedupes by block, so asking twice costs nothing.
      ...(topClusters ?? []).flatMap((c) => c.members.map((m) => m.idx)),
    ];
    Promise.all(wanted.map((idx) => loadNames(BASE, meta.names, idx, into)))
      .then(() => {
        if (!cancelled) setNames([...into]);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [meta, derived, topClusters]);

  return (
    <main
      style={{
        height: "100vh",
        overflowY: "auto",
        background: "var(--ink)",
        padding: "28px 24px 80px",
      }}
    >
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        <header style={{ marginBottom: 28 }}>
          <div className="eyebrow">Prototype bench</div>
          <h1 className="display" style={{ fontSize: 26, margin: "6px 0 10px" }}>
            MAZ statistics
          </h1>
          <p className="prose" style={{ color: "var(--text-dim)", lineHeight: 1.6, margin: 0 }}>
            Working surface for <code>thoughts/future-features.md</code> §7. Everything here
            reads the same export the map does. Each card carries a status: promote it, cut it,
            or keep it standing to share with other players.{" "}
            <Link href="/" style={{ color: "var(--text)" }}>
              Back to the map
            </Link>
          </p>
        </header>

        {error ? (
          <Card title="Nothing loaded" status="open">
            <p className="prose" style={{ color: "var(--text-dim)", lineHeight: 1.6 }}>
              {error}. The bench reads the same origin the map does — if this is local, check{" "}
              <code>npm run data</code> is serving on :3002 and that{" "}
              <code>znhstry export</code> has run.
            </p>
          </Card>
        ) : null}

        {!error && !derived ? (
          <p style={{ color: "var(--text-dim)" }}>Loading MAZ reports…</p>
        ) : null}

        {derived && stats ? (
          <>
            <section style={{ marginBottom: 26 }}>
              <Tiles
                items={[
                  { label: "reports", value: stats.reports.reportCount.toLocaleString() },
                  { label: "zones", value: derived.zones.toLocaleString() },
                  { label: "days covered", value: derived.days.toLocaleString() },
                  {
                    label: "median launches / report",
                    value: Math.round(derived.perReport.median).toLocaleString(),
                  },
                  {
                    label: "p99 launches / report",
                    value: Math.round(derived.perReport.p99).toLocaleString(),
                  },
                  {
                    label: "busiest single report",
                    value: Math.round(derived.perReport.max).toLocaleString(),
                  },
                ]}
              />
              <Note>
                Mapped MAZ only. The 15,837 tournament reports have no coordinates, so the
                export leaves them out of <code>maz.bin.br</code> — and they carry the heaviest
                fighting in the game, a median 36 active players against 6. Every figure on this
                page describes the mapped world.
              </Note>
            </section>

            <Card
              title="Launches on one zone, on one day"
              status="open"
              note="§7.2.1 — the base unit. Everything else on this page is an aggregate of it."
            >
              <Histogram
                bins={derived.perReportBins}
                title="Launches per MAZ report"
                subtitle="Log bins, six per decade. Mapped reports only."
                xLabel="launches"
                markers={[
                  { at: derived.perReport.median, label: "median" },
                  { at: derived.perReport.mean, label: "mean" },
                ]}
              />
              <Note>
                Median {Math.round(derived.perReport.median).toLocaleString()} against a mean of{" "}
                {Math.round(derived.perReport.mean).toLocaleString()} — the gap between the two
                rules is the tail, and it is why nothing here should ever be quoted as an
                average. p90 is {Math.round(derived.perReport.p90).toLocaleString()}, p99 is{" "}
                {Math.round(derived.perReport.p99).toLocaleString()}.
              </Note>
            </Card>

            <Card
              title="Launches across a whole MAZ day"
              status="open"
              note="§7.2.2 — the day's total as the top ten sees it."
            >
              <Histogram
                bins={derived.dailyBins}
                title="Total launches per MAZ day"
                subtitle="Summed over that day's reports. Log bins, six per decade."
                xLabel="launches"
                markers={[{ at: derived.dailySummary.median, label: "median" }]}
              />
              <Note>
                Do not compare days on this chart. The top ten is exactly ten reports on{" "}
                {derived.tenReportDays.toLocaleString()} of {derived.days.toLocaleString()} days
                but runs from {derived.reportsPerDay.min} to {derived.reportsPerDay.max}, so a
                raw sum lets a day out-total another by being bigger rather than busier. The
                next card divides it out.
              </Note>
            </Card>

            <Card
              title="Launches per report, day by day"
              status="open"
              note="§7.2.2 — the same days, normalized by how many reports each carried. This is the series to compare across the record."
            >
              <TimeSeries
                day={derived.rate.day}
                value={derived.rate.value}
                title="Launches per MAZ report"
                subtitle="Daily total divided by that day's report count, behind a 30-day trailing mean."
                labelOf={labelOf}
              />
              <Histogram
                bins={derived.rateBins}
                title="Distribution of the daily rate"
                subtitle="Log bins, six per decade. One sample per covered day."
                xLabel="launches per report"
                markers={[{ at: derived.rateSummary.median, label: "median" }]}
              />
              <Note>
                Median {Math.round(derived.rateSummary.median).toLocaleString()} launches per
                report on a typical day, p90 {Math.round(derived.rateSummary.p90).toLocaleString()}
                , busiest day {Math.round(derived.rateSummary.max).toLocaleString()}. Tighter than
                the per-report distribution two cards up (median{" "}
                {Math.round(derived.perReport.median).toLocaleString()}, p90{" "}
                {Math.round(derived.perReport.p90).toLocaleString()}) because averaging ten zones
                pulls each day toward the middle — the spread that survives is between days, not
                within them, and that is the quantity §7.2.3 regresses cluster size against.
              </Note>
            </Card>

            <Card
              title="Daily launches over the record"
              status="open"
              note="Context for §7.2.3's regression: the game's overall activity moves by orders of magnitude, so cluster size cannot be regressed against launches without controlling for the date."
            >
              <TimeSeries
                day={derived.daily.day}
                value={derived.daily.value}
                title="Total launches per MAZ day"
                subtitle="Raw daily behind a 30-day trailing mean. Mapped reports only."
                labelOf={labelOf}
              />
              <Note>
                No 2019 hole here, and that is the point worth remembering: battle reports run
                flat through the year the changelog lost. The two sources disagree about 2019
                because one of them stopped collecting, not because the game went quiet.
              </Note>
            </Card>

            <Card
              title="The outliers, by name"
              status="open"
              note="§7.2 — both lists are short enough to name every entry, which is the point of calling them out rather than leaving them in a tail."
            >
              <Table
                caption={`Single reports at ${BIG_REPORT.toLocaleString()}+ launches`}
                head={["date", "zone", "launches", "players", "per player", ""]}
                align={["left", "left"]}
                rows={derived.bigReports.map((r) => [
                  labelOf(r.day),
                  names[r.idx] || `zone ${r.idx}`,
                  r.launches.toLocaleString(),
                  r.players.toLocaleString(),
                  r.players ? Math.round(r.launches / r.players).toLocaleString() : "—",
                  <PortalLink key="link" report={r.report} />,
                ])}
              />
              <Note>
                {derived.bigReports.length} reports, against a median of{" "}
                {Math.round(derived.perReport.median).toLocaleString()} launches — roughly
                eighteen times a normal day&rsquo;s fighting on one zone.{" "}
                <strong>Read the last column before the third.</strong> The largest report in the
                record came from two active players and the second largest from two hundred;
                ranked on launches alone they sit next to each other and the table says they are
                the same event. One is a battle, the other is a grind.
              </Note>

              <div style={{ height: 22 }} />

              <Table
                caption={`Whole MAZ days at ${BIG_DAY.toLocaleString()}+ total launches`}
                head={["date", "launches", "reports", "players"]}
                align={["left"]}
                subject={0}
                rows={derived.bigDays.map((d) => [
                  labelOf(d.day),
                  d.launches.toLocaleString(),
                  String(d.reports),
                  d.players.toLocaleString(),
                ])}
              />
              <Note>
                {derived.bigDays.length} days out of {derived.days.toLocaleString()}, against a
                median day of {Math.round(derived.dailySummary.median).toLocaleString()}. Players
                are summed across the day&rsquo;s reports — there is no player key in this
                payload, so somebody fighting two zones counts twice. No link column here: the
                portal has a page per report and none for a day, and pointing at the day&rsquo;s
                biggest report would put one zone behind a link that claims to be all ten.
              </Note>
            </Card>

            <Card
              title="When the top ten collapsed onto one place"
              status="open"
              note="§7.1 — the day's zones grouped by distance rather than by region name, single linkage at thirty miles. The deliverable of the section."
            >
              {!coords ? (
                <div>
                  <p
                    className="prose"
                    style={{ color: "var(--text-dim)", lineHeight: 1.6, fontSize: 13, margin: 0 }}
                  >
                    This one needs coordinates, and coordinates mean the 9.27 MB of geometry
                    tiles the map loads — the only place they live, kept out of the MAZ payload
                    on purpose so there is one copy. Every other card here costs half a
                    megabyte, so it is a button rather than the default.
                  </p>
                  <button
                    onClick={loadGeometry}
                    disabled={tileProgress !== null}
                    style={{
                      marginTop: 12,
                      border: "1px solid var(--hairline-bright)",
                      background: "transparent",
                      color: "var(--text)",
                      padding: "8px 14px",
                      fontSize: 12,
                      cursor: tileProgress ? "default" : "pointer",
                    }}
                  >
                    {tileProgress
                      ? `Loading tiles… ${tileProgress.done} / ${tileProgress.total}`
                      : "Load geometry and cluster the record"}
                  </button>
                </div>
              ) : clusters && topClusters ? (
                <>
                  <Scatter
                    points={clusters.largestByDay
                      .filter((c) => c.spread.diameterKm > 0)
                      .map((c) => ({
                        day: c.day,
                        km: c.spread.diameterKm,
                        count: c.spread.count,
                        label: c.spread.count >= 5 ? labelOf(c.day).slice(0, 7) : "",
                      }))}
                    title="How tight the day's tightest group was"
                    subtitle={`One dot per day that had two zones within ${Math.round(NEIGHBORHOOD_KM)} km of each other. Dot area is the zone count; the axis is logarithmic.`}
                    labelOf={labelOf}
                  />
                  <Note>
                    <strong>
                      {(
                        100 *
                        (1 - clusters.largestByDay.length / derived.days)
                      ).toFixed(1)}
                      % of days have no two of the world&rsquo;s most active zones within thirty
                      miles of each other
                    </strong>{" "}
                    — {(derived.days - clusters.largestByDay.length).toLocaleString()} of{" "}
                    {derived.days.toLocaleString()}. Concentration is the exception, and that is
                    the honest headline for this section: a MAZ day is normally ten unrelated
                    fights.
                  </Note>

                  <div style={{ height: 22 }} />

                  <Table
                    caption={`Every cluster of four or more zones (${topClusters.length})`}
                    head={["date", "zones", "across", "mean pair", "regions", ""]}
                    align={["left", "right", "right", "right", "right"]}
                    subject={0}
                    rows={topClusters.slice(0, 14).map((c) => [
                      labelOf(c.day),
                      String(c.spread.count),
                      `${c.spread.diameterKm.toFixed(1)} km`,
                      `${c.spread.meanPairKm.toFixed(1)} km`,
                      c.regions.length > 1 ? `${c.regions.length} ⚑` : "1",
                      c.members
                        .map((m) => names[m.idx])
                        .filter(Boolean)
                        .slice(0, 3)
                        .join(", ") || "…",
                    ])}
                  />
                  <Note>
                    Ranked by zone count, then by tightness within a count — both matter and they
                    matter differently: the count is how much of the world&rsquo;s daily top ten
                    one place captured, and the spread is whether that place is a neighborhood or
                    a state. A ⚑ marks a cluster spanning more than one region, which the old
                    grouping-by-region-name could only ever have seen as two smaller ones.
                    {clusters.missing > 0
                      ? ` ${clusters.missing.toLocaleString()} reports had no coordinate loaded and were skipped.`
                      : ""}
                  </Note>
                </>
              ) : (
                <p style={{ color: "var(--text-dim)" }}>Clustering…</p>
              )}
            </Card>

            <Card
              title="Who was doing the launching"
              status="open"
              note="§7.3 — faction share of every launch on the day's most active zones. The one chart on this page that wears the faction colors, because it is the one subject that is a faction fact."
            >
              <StackedShare
                day={derived.factions.day}
                bands={FACTIONS.map((f) => ({
                  label: f.label,
                  color: f.token,
                  value: derived.factions[f.key],
                }))}
                title="Share of MAZ launches by faction"
                subtitle="Shares, not counts — the game's overall activity moves by orders of magnitude and would swamp the composition. 30-day trailing mean."
                labelOf={labelOf}
              />
              <Note>
                {derived.factions.dropped} days are missing from this chart on purpose:
                2019-07-01 to 2019-09-11, where the per-faction columns are short of their own
                total on 861 reports. The faction <em>player</em> columns fail on the same rows,
                so it is the whole breakdown arriving partial rather than anything about
                launches. A share taken across it divides by an incomplete denominator and would
                read as a faction going quiet.
              </Note>
            </Card>

            <Card
              title="Is a MAZ actually a battle?"
              status="open"
              note="§7.3 — the leading faction's share of the launches on one zone, one day. A report at 100% is one faction launching into a zone nobody contested."
            >
              <Histogram
                bins={derived.dominanceBins}
                title="Leading faction's share of a report"
                subtitle="Linear bins of 5 points. Mapped reports only, the 2019 window dropped."
                xLabel="share held by the top faction"
                scale="linear"
                format={(v) => `${Math.round(v * 100)}%`}
                markers={[{ at: 1 / 3, label: "even three-way" }]}
              />
              <Note>
                <strong>
                  {((100 * derived.shape.oneSided) / derived.shape.total).toFixed(1)}% of reports
                  are one-sided
                </strong>{" "}
                — a single faction launching everything, {derived.shape.oneSided.toLocaleString()}{" "}
                of {derived.shape.total.toLocaleString()}. Only{" "}
                {((100 * derived.shape.threeWay) / derived.shape.total).toFixed(1)}% have all
                three factions launching at all. &ldquo;Most active zone&rdquo; means most
                <em> activity</em>, and a garrison being built alone counts.
              </Note>
            </Card>

            <Card
              title="How often a zone comes back"
              status="open"
              note="§7.4 — appearances per zone across the whole record, and the longest consecutive run each one managed."
            >
              <Histogram
                bins={derived.appearanceBins}
                title="Appearances per zone"
                subtitle="Log bins, eight per decade. One sample per zone that has ever appeared."
                xLabel="days on the board"
              />
              <Note>
                {derived.appearOnce.toLocaleString()} of {derived.zones.toLocaleString()} zones
                appear exactly once —{" "}
                {((100 * derived.appearOnce) / derived.zones).toFixed(1)}% — while the leader
                takes {derived.topAppearances.toLocaleString()} of{" "}
                {derived.days.toLocaleString()} covered days. The mean of{" "}
                {(stats.reports.reportCount / derived.zones).toFixed(1)} describes neither end.
              </Note>

              <div style={{ height: 22 }} />

              <Histogram
                bins={derived.streakBins}
                title="Longest consecutive run per zone"
                subtitle="Consecutive days on the board, log bins. The stricter cousin of the map's rolling appearance count."
                xLabel="consecutive days"
              />
              <Note>
                {derived.streakOverOne.toLocaleString()} zones (
                {((100 * derived.streakOverOne) / derived.streakZones).toFixed(1)}%) ever managed
                two days in a row; the record is {derived.longestStreak.toLocaleString()}. Streaks
                were built as a ring encoding for the timelapse and rejected for flickering —
                that says nothing about their value as a statistic, which is this.
              </Note>
            </Card>

            <Card title="Next on the bench" status="open">
              <ul
                className="prose"
                style={{ color: "var(--text-dim)", lineHeight: 1.7, paddingLeft: 18, margin: 0 }}
              >
                <li>
                  <strong>The zoomed map per cluster (§7.1).</strong> The scatter and the table
                  above are the overview; the thing worth actually looking at is each cluster on
                  a basemap, framed at its own bounding box plus thirty miles, so the reader sees
                  the fight sits on Canterbury rather than on an unlabeled patch of coast. That
                  needs deck.gl and the CARTO tiles, which is the map&rsquo;s machinery rather
                  than a chart.
                </li>
                <li>
                  Which of the eleven biggest reports land near the 2017-04-26 range change, now
                  that <code>config.MISSILE_RANGE_INCREASED</code> pins the date.
                </li>
                <li>
                  Faction share against the map&rsquo;s own share of zones held — does launching
                  lead holding, or follow it? Needs the scope series the main page already has.
                </li>
              </ul>
              <Note>
                Top zone appears on {derived.topAppearances.toLocaleString()} of{" "}
                {derived.days.toLocaleString()} covered days.
              </Note>
            </Card>
          </>
        ) : null}
      </div>
    </main>
  );
}

function Card({
  title,
  status,
  note,
  children,
}: {
  title: string;
  status: Status;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        background: "var(--ink-raised)",
        border: "1px solid var(--hairline)",
        borderRadius: 6,
        padding: 18,
        marginBottom: 20,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 12,
          marginBottom: note ? 6 : 14,
        }}
      >
        <h2 className="display" style={{ fontSize: 15, margin: 0 }}>
          {title}
        </h2>
        <span className="eyebrow" style={{ whiteSpace: "nowrap" }}>
          {STATUS_LABEL[status]}
        </span>
      </div>
      {note ? (
        <p
          className="prose"
          style={{ color: "var(--text-dim)", fontSize: 12, lineHeight: 1.6, margin: "0 0 14px" }}
        >
          {note}
        </p>
      ) : null}
      {children}
    </section>
  );
}

function Tiles({ items }: { items: { label: string; value: string }[] }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
        gap: 1,
        background: "var(--hairline)",
        border: "1px solid var(--hairline)",
        borderRadius: 6,
        overflow: "hidden",
      }}
    >
      {items.map((item) => (
        <div key={item.label} style={{ background: "var(--ink-raised)", padding: "12px 14px" }}>
          <div className="eyebrow">{item.label}</div>
          <div className="tabular" style={{ fontSize: 19, marginTop: 4 }}>
            {item.value}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * A link out to the report page this row was read from.
 *
 * `rel="noreferrer"` and a new tab: the portal is the game's own live web server
 * rendering one page per report, not an API, and the bench is a scrolling column
 * somebody is working through - taking the tab away loses their place.
 *
 * Only reports get one. A MAZ *day* has no page: the Most Active Zones index
 * names today's ten and nothing else, so there is no URL that means "the whole
 * of 2017-05-22" and inventing one out of that day's biggest report would put a
 * single zone behind a link that claims to be the day.
 */
function PortalLink({ report }: { report: number }) {
  return (
    <a
      href={portalReportUrl(report)}
      target="_blank"
      rel="noreferrer"
      title={`Battle report ${report.toLocaleString()} on portal.qonqr.com`}
      style={{ color: MAZ_AMBER, textDecoration: "none", whiteSpace: "nowrap" }}
    >
      report ↗
    </a>
  );
}

/**
 * A short list of named rows.
 *
 * Deliberately a table and not a chart. These lists are eleven and three rows
 * long, and the whole reason they are worth showing is that each row has a name,
 * a date and two numbers that have to be read against each other - which is a
 * table. A bar chart of eleven bars would hide the players column, which is the
 * column that matters.
 *
 * Scrolls inside itself rather than widening the column on a narrow screen.
 */
function Table({
  caption,
  head,
  rows,
  /** Per-column alignment. Anything past the end falls back to right. */
  align = [],
  /** Which column carries the row's subject, and so gets full-strength text. */
  subject = 1,
}: {
  caption: string;
  head: string[];
  rows: React.ReactNode[][];
  align?: ("left" | "right")[];
  subject?: number;
}) {
  const alignOf = (i: number) => align[i] ?? "right";

  return (
    <figure style={{ margin: 0 }}>
      <figcaption className="display" style={{ fontSize: 13, marginBottom: 6 }}>
        {caption}
      </figcaption>
      <div style={{ overflowX: "auto" }}>
        <table
          className="tabular"
          style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}
        >
          <thead>
            <tr>
              {head.map((cell, i) => (
                <th
                  key={cell}
                  className="eyebrow"
                  style={{
                    textAlign: alignOf(i),
                    padding: "4px 8px 6px",
                    borderBottom: "1px solid var(--hairline-bright)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, i) => (
                  <td
                    key={i}
                    style={{
                      textAlign: alignOf(i),
                      padding: "5px 8px",
                      borderBottom: "1px solid var(--hairline)",
                      color: i === subject ? "var(--text)" : "var(--text-dim)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="prose"
      style={{
        color: "var(--text-dim)",
        fontSize: 12,
        lineHeight: 1.6,
        margin: "12px 0 0",
        borderLeft: "2px solid var(--hairline-bright)",
        paddingLeft: 10,
      }}
    >
      {children}
    </p>
  );
}
