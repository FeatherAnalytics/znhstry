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

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BASE } from "@/lib/dataOrigin";
import { loadJson } from "@/lib/format";
import { dayToDate } from "@/lib/data";
import type { Meta } from "@/lib/data";
import { loadNames } from "@/lib/names";
import {
  appearancesByZone,
  biggestDays,
  biggestReports,
  countEqual,
  dailyTotals,
  loadMazStats,
  logBins,
  perReport,
  summarize,
  type MazStats,
} from "@/lib/mazStats";
import { Histogram } from "@/components/charts/Histogram";
import { TimeSeries } from "@/components/charts/TimeSeries";

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
    if (!stats) return null;

    const report = summarize(stats.launches);
    const daily = dailyTotals(stats, stats.launches);
    const dailySummary = summarize(daily.value);
    const rate = perReport(daily);
    const rateSummary = summarize(rate.value);
    const reportsPerDay = summarize(daily.reports);
    const appearances = appearancesByZone(stats);

    return {
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
  }, [stats]);

  // Names are off the load path everywhere else and stay off it here: one ~19 KB
  // block per outlier, fetched only once the reports are in hand. `names` is
  // keyed by idx, so a block landing late fills its rows in place and the state
  // bump redraws whatever arrived.
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    if (!meta || !derived) return;
    let cancelled = false;
    const into: string[] = [];
    const blocks = derived.bigReports.map((r) => loadNames(BASE, meta.names, r.idx, into));
    Promise.all(blocks)
      .then(() => {
        if (!cancelled) setNames([...into]);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [meta, derived]);

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
                head={["date", "zone", "launches", "players", "per player"]}
                rows={derived.bigReports.map((r) => [
                  labelOf(r.day),
                  names[r.idx] || `zone ${r.idx}`,
                  r.launches.toLocaleString(),
                  r.players.toLocaleString(),
                  r.players ? Math.round(r.launches / r.players).toLocaleString() : "—",
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
                payload, so somebody fighting two zones counts twice.
              </Note>
            </Card>

            <Card title="Next on the bench" status="open">
              <ul
                className="prose"
                style={{ color: "var(--text-dim)", lineHeight: 1.7, paddingLeft: 18, margin: 0 }}
              >
                <li>
                  Cluster spread per day, off <code>distance.spread</code> — needs zone
                  coordinates joined to the reports, which means the geometry tiles.
                </li>
                <li>
                  Which of the eleven biggest reports land near the 2017-04-26 range change, now
                  that <code>config.MISSILE_RANGE_INCREASED</code> pins the date.
                </li>
                <li>
                  Faction launch share (§7.3). <strong>Blocked:</strong> the export carries only
                  the totals. Per-faction launch columns exist upstream in{" "}
                  <code>stg_battlestats</code> and would need adding to{" "}
                  <code>maz_stats.bin.br</code>.
                </li>
                <li>Appearance and streak distributions (§7.4).</li>
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
}: {
  caption: string;
  head: string[];
  rows: string[][];
}) {
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
                    textAlign: i === 0 || i === 1 ? "left" : "right",
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
            {rows.map((row) => (
              <tr key={row.join("|")}>
                {row.map((cell, i) => (
                  <td
                    key={i}
                    style={{
                      textAlign: i === 0 || i === 1 ? "left" : "right",
                      padding: "5px 8px",
                      borderBottom: "1px solid var(--hairline)",
                      color: i === 1 ? "var(--text)" : "var(--text-dim)",
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
