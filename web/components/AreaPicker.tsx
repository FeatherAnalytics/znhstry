"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Lookups } from "@/lib/data";
import type { ZoneGeometry } from "@/lib/geometry";

export interface Area {
  countryId: number;
  /** null for a whole country. */
  regionId: number | null;
  label: string;
  detail: string;
  zones: number;
}

interface Props {
  lookups: Lookups | null;
  geometry: ZoneGeometry | null;
  /** Bumped as tiles land, so the counts refresh while the world loads. */
  version: number;
  selected: Area | null;
  onSelect: (area: Area | null) => void;
}

/**
 * Countries and regions, counted from the geometry that has actually loaded.
 *
 * A region is listed under the country its own `countryid` claims, except that
 * zones are counted by their `country_id`, which is the authoritative one. The
 * two disagree for 447 zones and the coordinates side with the country every
 * time, so a region whose country is contradicted simply comes up empty rather
 * than being quietly reassigned. The upstream database is the source of truth;
 * this only declines to print a contradiction.
 */
function buildIndex(lookups: Lookups, geometry: ZoneGeometry): Area[] {
  const countryZones = new Map<number, number>();
  const regionZones = new Map<number, number>();

  for (let slot = 0; slot < geometry.count; slot++) {
    const idx = geometry.slotToIdx[slot];
    const country = geometry.country[idx];
    const region = geometry.region[idx];
    countryZones.set(country, (countryZones.get(country) ?? 0) + 1);
    // Key on the pair so a region only counts zones whose country agrees.
    // Both ids fit well inside 1e6, and a JS number holds the product exactly.
    const key = region * 1e6 + country;
    regionZones.set(key, (regionZones.get(key) ?? 0) + 1);
  }

  const areas: Area[] = [];

  for (const [id, [, name]] of Object.entries(lookups.countries)) {
    const countryId = Number(id);
    const zones = countryZones.get(countryId) ?? 0;
    if (zones > 0) {
      areas.push({ countryId, regionId: null, label: name, detail: "Country", zones });
    }
  }

  for (const [id, [name, countryId]] of Object.entries(lookups.regions)) {
    const regionId = Number(id);
    const zones = regionZones.get(regionId * 1e6 + countryId) ?? 0;
    if (zones > 0) {
      areas.push({
        countryId,
        regionId,
        label: name,
        detail: lookups.countries[String(countryId)]?.[1] ?? "Region",
        zones,
      });
    }
  }

  return areas.sort((a, b) => b.zones - a.zones);
}

const control: React.CSSProperties = {
  background: "rgba(14,18,24,0.82)",
  border: "1px solid var(--hairline-bright)",
  color: "var(--text)",
  font: "inherit",
  fontSize: 12,
  padding: "5px 9px",
  width: 190,
};

export function AreaPicker({ lookups, geometry, version, selected, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  // Recount only while the picker is open. Walking 2.7M zones on every tile
  // that lands would spend the whole load doing it.
  const areas = useMemo(
    () => (open && lookups && geometry ? buildIndex(lookups, geometry) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, lookups, geometry, version],
  );

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const pool = needle
      ? areas.filter(
          (a) =>
            a.label.toLowerCase().includes(needle) || a.detail.toLowerCase().includes(needle),
        )
      : areas;
    return pool.slice(0, 40);
  }, [areas, query]);

  useEffect(() => setHighlight(0), [query]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [open]);

  const choose = (area: Area) => {
    onSelect(area);
    setQuery("");
    setOpen(false);
  };

  return (
    <div ref={boxRef} style={{ position: "relative" }}>
      {selected ? (
        <button
          className="eyebrow"
          onClick={() => onSelect(null)}
          style={{ ...control, textAlign: "left", cursor: "pointer" }}
          title="Clear the area filter"
        >
          <span style={{ color: "var(--text)" }}>{selected.label}</span>
          <span style={{ float: "right", opacity: 0.7 }}>&times;</span>
        </button>
      ) : (
        <input
          value={query}
          placeholder="Filter by country or region"
          aria-label="Filter by country or region"
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setHighlight((h) => Math.min(matches.length - 1, h + 1));
            if (e.key === "ArrowUp") setHighlight((h) => Math.max(0, h - 1));
            if (e.key === "Enter" && matches[highlight]) choose(matches[highlight]);
            if (e.key === "Escape") setOpen(false);
          }}
          style={control}
        />
      )}

      {open && !selected && (
        <div
          role="listbox"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            width: 280,
            maxHeight: 320,
            overflowY: "auto",
            background: "rgba(10,13,19,0.96)",
            backdropFilter: "var(--panel-blur)",
            WebkitBackdropFilter: "var(--panel-blur)",
            border: "1px solid var(--hairline-bright)",
            zIndex: 40,
          }}
        >
          {matches.length === 0 && (
            <div className="eyebrow" style={{ padding: "10px 10px" }}>
              {areas.length === 0 ? "Still loading zones" : "No match"}
            </div>
          )}
          {matches.map((area, i) => (
            <button
              key={`${area.countryId}:${area.regionId ?? "all"}`}
              role="option"
              aria-selected={i === highlight}
              onPointerEnter={() => setHighlight(i)}
              onClick={() => choose(area)}
              style={{
                display: "flex",
                gap: 8,
                alignItems: "baseline",
                width: "100%",
                padding: "6px 10px",
                textAlign: "left",
                background: i === highlight ? "var(--hairline)" : "transparent",
              }}
            >
              <span style={{ flex: 1, fontSize: 12 }}>{area.label}</span>
              <span className="eyebrow" style={{ fontSize: 9 }}>
                {area.detail}
              </span>
              <span className="tabular" style={{ fontSize: 11, color: "var(--text-dim)" }}>
                {area.zones.toLocaleString()}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
