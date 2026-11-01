"use client";

import { useMemo, type ReactNode } from "react";
import { linePath } from "@/components/charts/MultiSeries";
import {
  factionColor,
  factionHex,
  holderOf,
  compact,
  FACTION_ORDER,
  type MonthPayload,
  type ZoneData,
} from "./lib";

interface Props {
  month: MonthPayload;
  obsTimestamps: number[];
  onZoneClick: (key: string) => void;
}

const GROUPS: [string, string[]][] = [
  ["Prime", ["Prime"]],
  ["Legion", ["Legion 1", "Legion 2", "Legion 3", "Legion 4", "Legion 5", "Legion 6"]],
  ["Swarm", ["Swarm 1", "Swarm 2", "Swarm 3", "Swarm 4", "Swarm 5", "Swarm 6"]],
  ["Faceless", ["Faceless 1", "Faceless 2", "Faceless 3", "Faceless 4", "Faceless 5", "Faceless 6"]],
];

const SPARK_WIDTH = 640;
const SPARK_HEIGHT = 40;
const SPARK_INSET = 3;

const botsOf = (zone: ZoneData, faction: string) =>
  zone[faction.toLowerCase() as "legion" | "swarm" | "faceless"];

function peakBots(zones: ZoneData[]): number {
  let peak = 1;
  for (const zone of zones) {
    for (const faction of FACTION_ORDER) {
      for (const bots of botsOf(zone, faction)) {
        if (bots !== null && bots > peak) peak = bots;
      }
    }
  }
  return peak;
}

function Sparkline({ zoneKey, zone, obsTs, peak }: { zoneKey: string; zone: ZoneData; obsTs: number[]; peak: number }) {
  const n = obsTs.length;
  const xMin = n ? obsTs[0] : 0;
  const xSpan = Math.max(1, (n ? obsTs[n - 1] : 1) - xMin);
  const px = (i: number) => SPARK_INSET + ((obsTs[i] - xMin) / xSpan) * (SPARK_WIDTH - 2 * SPARK_INSET);
  const py = (v: number) => SPARK_HEIGHT - SPARK_INSET - (v / peak) * (SPARK_HEIGHT - 2 * SPARK_INSET);

  return (
    // The cell's width decides the x scale, so the drawing stretches freely and
    // non-scaling strokes keep the lines even. A circle would stretch with it, so
    // a lone point is a zero-length line that its round cap turns into a dot.
    <svg
      className="zone-spark"
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${zoneKey} bots by faction over the tournament`}
    >
      <line
        x1={0}
        x2={SPARK_WIDTH}
        y1={py(0)}
        y2={py(0)}
        stroke="var(--hairline-bright)"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
      {FACTION_ORDER.map((faction) => {
        const { d, dots } = linePath(botsOf(zone, faction), px, py);
        const points = dots.map((p) => `M${p.x.toFixed(1)} ${p.y.toFixed(1)}h0`).join("");
        return (
          <path
            key={faction}
            d={d + points}
            fill="none"
            stroke={factionHex(faction)}
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
    </svg>
  );
}

function ZoneRow({ zoneKey, zone, lastIdx, onClick, children }: {
  zoneKey: string;
  zone: ZoneData;
  lastIdx: number;
  onClick: () => void;
  children: ReactNode;
}) {
  const holder = holderOf(zone, lastIdx);
  const holderLabel = (
    <span style={{ color: holder ? factionColor(holder) : "var(--text-dim)" }}>{holder ?? "Empty"}</span>
  );

  return (
    <tr onClick={onClick}>
      <td>
        <div className="zone-id">
          {/* No handler of its own: Enter fires a click that bubbles to the row. */}
          <button type="button" className="eyebrow zone-key">{zoneKey}</button>
          <span className="zone-holder-inline">{holderLabel}</span>
          <span className="zone-name">
            {zone.name}
            {zone.cubes_allowed ? <span style={{ marginLeft: 6, fontSize: 10 }}>cubes</span> : null}
          </span>
        </div>
      </td>
      {FACTION_ORDER.map((faction) => (
        <td key={faction} className="tabular zone-count">{compact(botsOf(zone, faction)[lastIdx] ?? 0)}</td>
      ))}
      <td className="zone-holder">{holderLabel}</td>
      {children ? <td className="zone-trend">{children}</td> : null}
    </tr>
  );
}

export default function ZoneTables({ month, obsTimestamps, onZoneClick }: Props) {
  const lastIdx = month.observations.length - 1;
  // Most past tournaments hold a single snapshot, and one point has no trend to show.
  const hasTrend = month.observations.length > 1;
  const peak = useMemo(() => peakBots(Object.values(month.zones)), [month.zones]);

  return (
    <div>
      <div className="display" style={{ fontSize: 13, marginBottom: 4 }}>Zones</div>
      {hasTrend ? (
        <div style={{ color: "var(--text-dim)", fontSize: 11, marginBottom: 14 }}>
          Trend shows each faction&apos;s bots over the tournament. Every row shares one scale, 0 to {compact(peak)}.
        </div>
      ) : null}
      {GROUPS.map(([group, keys]) => {
        const present = keys.filter((k) => month.zones[k]);
        if (present.length === 0) return null;
        return (
          <table key={group} className={hasTrend ? "zone-table" : "zone-table zone-table-snapshot"}>
            <caption className="eyebrow" style={{ color: factionColor(group) }}>{group}</caption>
            <thead>
              <tr>
                <th scope="col" className="eyebrow">Zone</th>
                {FACTION_ORDER.map((faction) => (
                  <th key={faction} scope="col" className="eyebrow zone-count" style={{ color: factionColor(faction) }}>
                    <abbr title={faction}>{faction}</abbr>
                  </th>
                ))}
                <th scope="col" className="eyebrow zone-holder">Holder</th>
                {hasTrend ? <th scope="col" className="eyebrow zone-trend">Trend</th> : null}
              </tr>
            </thead>
            <tbody>
              {present.map((k) => (
                <ZoneRow
                  key={k}
                  zoneKey={k}
                  zone={month.zones[k]}
                  lastIdx={lastIdx}
                  onClick={() => onZoneClick(k)}
                >
                  {hasTrend ? <Sparkline zoneKey={k} zone={month.zones[k]} obsTs={obsTimestamps} peak={peak} /> : null}
                </ZoneRow>
              ))}
            </tbody>
          </table>
        );
      })}
    </div>
  );
}
