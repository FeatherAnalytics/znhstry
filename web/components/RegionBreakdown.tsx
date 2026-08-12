"use client";

/**
 * A country's regions, each with the zones it holds and who leads them.
 *
 * Selecting a country asks two questions at once — how is the country doing, and
 * where inside it is anything happening. The panel answers the first; these rows
 * answer the second.
 *
 * **Regions are not a partition of the country and the summary line says so.**
 * The game counts a country by `CountryId` and a region by `RegionId`,
 * independently, so Poland's regions total 44,235 zones against a country of
 * 44,080 — the gap is the 155 zones filed under a Polish voivodeship while
 * sitting in the Solomon Islands. Presenting these as slices of the country above
 * them would be a claim the data does not make.
 *
 * Ranked and capped, and the cap is spoken. The median country has 10 regions but
 * Slovenia has 174 and Latvia 118, so a raw list is unusable for a third of the
 * world; a silent truncation reads as "that is all of them".
 */

import { useMemo } from "react";
import type { ZoneGeometry, ZoneDisplay } from "@/lib/geometry";
import type { Lookups } from "@/lib/data";
import { compactNumber } from "./StatsPanel";

const FACTION_COLORS = ["var(--dormant)", "var(--legion)", "var(--swarm)", "var(--faceless)"];

const SHOWN = 10;

interface RegionRow {
  regionId: number;
  name: string;
  zones: number;
  held: number;
  byFaction: [number, number, number, number];
}

export function RegionBreakdown({
  geometry,
  display,
  lookups,
  countryId,
  countryLabel,
  /** Bumped when `display` is refilled in place, which identity cannot show. */
  version,
}: {
  geometry: ZoneGeometry;
  display: ZoneDisplay;
  lookups: Lookups;
  countryId: number;
  countryLabel: string;
  version: number;
}) {
  const rows = useMemo(() => {
    // One pass over the loaded slots, bucketing by the zone's own region. Bounded
    // by what has landed, so an early list describes the zones on the map.
    const byRegion = new Map<number, RegionRow>();
    for (let slot = 0; slot < geometry.count; slot++) {
      const idx = geometry.slotToIdx[slot];
      if (geometry.country[idx] !== countryId) continue;
      const regionId = geometry.region[idx];
      let row = byRegion.get(regionId);
      if (!row) {
        row = {
          regionId,
          name: lookups.regions[String(regionId)]?.[0] ?? "Region not identified",
          zones: 0,
          held: 0,
          byFaction: [0, 0, 0, 0],
        };
        byRegion.set(regionId, row);
      }
      const faction = display.pk[slot] >> 6;
      row.zones++;
      row.byFaction[faction]++;
      if (faction !== 0) row.held++;
    }

    // By zones held, then by size: a region with nothing standing in it is the
    // answer to a different question and belongs in the summary, not the list.
    return [...byRegion.values()].sort((a, b) => b.held - a.held || b.zones - a.zones);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry, display, lookups, countryId, version]);

  const listed = rows.filter((r) => r.held > 0).slice(0, SHOWN);
  const quiet = rows.filter((r) => r.held === 0);
  const rest = rows.filter((r) => r.held > 0).length - listed.length;

  if (rows.length === 0) return null;

  return (
    <div>
      <div style={{ height: 1, background: "var(--hairline)", margin: "12px 0 10px" }} />
      <div style={{ color: "var(--text-dim)", fontSize: 11, marginBottom: 8 }}>
        {listed.length} of {rows.length} regions in {countryLabel}
        {rest > 0 ? `, ${rest} more holding bots` : ""}
        {quiet.length > 0 ? ` · ${quiet.length} holding nothing` : ""}
      </div>

      {listed.map((row) => {
        const lead = row.byFaction.indexOf(Math.max(...row.byFaction.slice(1)), 1);
        return (
          <div key={row.regionId} style={{ marginBottom: 7 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span
                aria-hidden
                style={{
                  width: 7,
                  height: 7,
                  background: FACTION_COLORS[lead] ?? FACTION_COLORS[0],
                  flexShrink: 0,
                }}
              />
              <span
                style={{
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={row.name}
              >
                {row.name}
              </span>
              <span className="tabular" style={{ fontSize: 11, color: "var(--text-dim)" }}>
                {compactNumber(row.held)} / {compactNumber(row.zones)}
              </span>
            </div>
            {/* Shares of the region's own held zones, so a small region reads as
                clearly as a large one. */}
            <div style={{ display: "flex", height: 3, marginTop: 4, marginLeft: 15 }}>
              {([1, 2, 3] as const).map((faction) => (
                <div
                  key={faction}
                  style={{
                    width: `${(row.byFaction[faction] / Math.max(1, row.held)) * 100}%`,
                    background: FACTION_COLORS[faction],
                  }}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
