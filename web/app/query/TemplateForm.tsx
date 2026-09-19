"use client";

import { useEffect, useState, type CSSProperties } from "react";
import {
  TEMPLATES,
  contextFrom,
  costMb,
  countryAtSql,
  daysBefore,
  initialValues,
  missingScope,
  nearbyZonesSql,
  RADIUS_ZONE_CAP,
  type Param,
  type Template,
  type Values,
} from "@/lib/queryTemplates";
import type { MartsMeta, Warehouse } from "@/lib/duckdbWasm";

interface Country {
  id: number;
  name: string;
}

const control: CSSProperties = {
  font: "inherit",
  color: "var(--text)",
  background: "var(--ink-raised)",
  border: "1px solid var(--hairline)",
  borderRadius: 3,
  padding: "5px 7px",
  minWidth: 0,
};

/** Neighbours, or a continent. Nothing useful sits between the two. */
const RADII_MILES = [10, 20, 30, 40, 1000, 3000, 6000];

const KM_PER_MILE = 1.609344;

const fieldLabel: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 11,
  color: "var(--text-dim)",
  minWidth: 0,
};

/** Reads the permission state without prompting; only getCurrentPosition prompts. */
function useGeolocationState(): PermissionState | "unsupported" | "unknown" {
  const [state, setState] = useState<PermissionState | "unsupported" | "unknown">("unknown");
  useEffect(() => {
    if (!navigator.geolocation) return setState("unsupported");
    if (!navigator.permissions?.query) return;
    let live = true;
    navigator.permissions
      .query({ name: "geolocation" })
      .then((status) => {
        if (live) setState(status.state);
      })
      .catch(() => {
        /* Firefox rejects the query for some names; the button still works. */
      });
    return () => {
      live = false;
    };
  }, []);
  return state;
}

/** Arrow returns DATE as epoch ms. UTC, because every date here is a UTC date. */
const isoDay = (value: unknown): string | null => {
  const ms = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
};

function Field({
  param,
  value,
  countries,
  months,
  onChange,
}: {
  param: Param;
  value: string | number;
  countries: Country[];
  months: string[];
  onChange: (next: string | number) => void;
}) {
  const id = `tpl-${param.id}`;
  if (param.kind === "country") {
    return (
      <label htmlFor={id} style={fieldLabel}>
        {param.label}
        <select
          id={id}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          style={{ ...control, maxWidth: 220 }}
        >
          <option value="">Pick a country…</option>
          {countries.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (param.kind === "month") {
    return (
      <label htmlFor={id} style={fieldLabel}>
        {param.label}
        <select
          id={id}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          style={{ ...control, width: 150 }}
        >
          <option value="">Every month</option>
          {months.map((m) => (
            <option key={m} value={m}>
              {m.slice(0, 7)}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (param.kind === "choice") {
    return (
      <label htmlFor={id} style={fieldLabel}>
        {param.label}
        <select id={id} value={String(value)} onChange={(e) => onChange(e.target.value)} style={control}>
          {param.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (param.kind === "number") {
    return (
      <label htmlFor={id} style={fieldLabel}>
        {param.label}
        <input
          id={id}
          type="number"
          value={String(value)}
          min={param.min}
          max={param.max}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{ ...control, width: 110 }}
        />
      </label>
    );
  }
  return (
    <label htmlFor={id} style={fieldLabel}>
      {param.label}
      <input
        id={id}
        type={param.kind === "date" ? "date" : "text"}
        value={String(value)}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...control, width: param.kind === "date" ? 150 : 170 }}
      />
    </label>
  );
}

export default function TemplateForm({
  meta,
  warehouse,
  onGenerate,
}: {
  meta: MartsMeta | null;
  warehouse: Warehouse | null;
  onGenerate: (sql: string) => void;
}) {
  const ctx = contextFrom(meta);
  const [templateId, setTemplateId] = useState(TEMPLATES[0].id);
  const template = TEMPLATES.find((t) => t.id === templateId) as Template;
  const [values, setValues] = useState<Values>(() => initialValues(TEMPLATES[0], ctx));
  const [countries, setCountries] = useState<Country[]>([]);
  const [months, setMonths] = useState<string[]>([]);
  const [radiusMiles, setRadiusMiles] = useState(30);
  const [locating, setLocating] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const permission = useGeolocationState();

  // One dictionary-encoded column: 0.1 MB, not the file's 64.
  useEffect(() => {
    if (warehouse === null || countries.length > 0) return;
    let live = true;
    void (async () => {
      try {
        await warehouse.bind("dim_zone");
        const table = await warehouse.conn.query(
          "select distinct country_id, country_name from dim_zone " +
            "where country_id is not null and country_name is not null order by country_name",
        );
        const ids = table.getChildAt(0);
        const names = table.getChildAt(1);
        const rows: Country[] = [];
        for (let i = 0; i < table.numRows; i++) {
          rows.push({ id: Number(ids?.get(i)), name: String(names?.get(i)) });
        }
        if (live) setCountries(rows);
      } catch {
        /* The picker falls back to an empty list; the console still takes typed SQL. */
      }
    })();
    return () => {
      live = false;
    };
  }, [warehouse, countries.length]);

  // From the table the template reads: stg_atlantis_tournaments has 30 months, the
  // player fact 148, and sourcing the list there hid 118 months behind a full-looking list.
  useEffect(() => {
    if (warehouse === null || !template.params.some((p) => p.kind === "month")) return;
    const source = template.table;
    let live = true;
    void (async () => {
      try {
        await warehouse.bind(source);
        const table = await warehouse.conn.query(
          `select distinct tournament_month from ${source} ` +
            "where tournament_month is not null order by tournament_month desc",
        );
        const column = table.getChildAt(0);
        const rows: string[] = [];
        for (let i = 0; i < table.numRows; i++) {
          const day = isoDay(column?.get(i));
          if (day) rows.push(day);
        }
        if (live) setMonths(rows);
      } catch {
        /* The picker falls back to "Every month"; the query is still valid without one. */
      }
    })();
    return () => {
      live = false;
    };
  }, [warehouse, template]);

  // The form mounts before the manifest, so relative defaults resolve to "" and the
  // predicate is dropped: zone-flips over all history is 39.7 MB against 4.7.
  useEffect(() => {
    if (!ctx.newestDay) return;
    setValues((current) => {
      const filled = { ...current };
      let changed = false;
      for (const param of template.params) {
        if (param.kind === "date" && param.daysBack !== undefined && current[param.id] === "") {
          filled[param.id] = daysBefore(ctx.newestDay, param.daysBack);
          changed = true;
        }
      }
      return changed ? filled : current;
    });
  }, [ctx.newestDay, template]);

  const pick = (id: string) => {
    const next = TEMPLATES.find((t) => t.id === id);
    if (!next) return;
    setTemplateId(id);
    setValues(initialValues(next, ctx));
    setNote(null);
  };

  const set = (key: string, value: string | number) => {
    // Same filter as a resolved radius; stale ids would narrow the new country.
    setValues((v) => ({ ...v, [key]: value, ...(key === "country" ? { zones: "" } : {}) }));
    if (key === "country") setNote(null);
  };

  const useMyLocation = () => {
    if (warehouse === null) return;
    setLocating(true);
    setNote(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        void (async () => {
          const { latitude, longitude } = position.coords;
          try {
            await warehouse.bind("dim_zone");
            const where = await warehouse.conn.query(countryAtSql(latitude, longitude));
            const countryId = Number(where.getChildAt(0)?.get(0));
            const countryName = String(where.getChildAt(1)?.get(0));
            const near = await warehouse.conn.query(
              nearbyZonesSql(countryId, latitude, longitude, radiusMiles * KM_PER_MILE),
            );
            const column = near.getChildAt(0);
            const ids: number[] = [];
            for (let i = 0; i < near.numRows; i++) ids.push(Number(column?.get(i)));
            setValues((v) => ({ ...v, country: String(countryId), zones: ids.join(", ") }));
            setNote(
              ids.length >= RADIUS_ZONE_CAP
                ? `${countryName}: more than ${RADIUS_ZONE_CAP.toLocaleString("en-US")} zones within ${radiusMiles} miles. Narrow the radius, or drop it and use the country.`
                : `${ids.length.toLocaleString("en-US")} zones within ${radiusMiles} miles, in ${countryName}.`,
            );
          } catch {
            setNote("Could not match your location to a country. Pick one instead.");
          } finally {
            setLocating(false);
          }
        })();
      },
      (error) => {
        setLocating(false);
        setNote(
          error.code === error.PERMISSION_DENIED
            ? "Location permission denied. Pick a country instead."
            : "Could not read your location. Pick a country instead.",
        );
      },
      { timeout: 10_000 },
    );
  };

  const blocked = missingScope(template, values);
  const hasRadius = String(values.zones ?? "") !== "";
  const estimate = costMb(template, values, meta);

  return (
    <div style={{ borderBottom: "1px solid var(--hairline)", padding: "12px 16px" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 12 }}>
        <label htmlFor="tpl-template" style={{ ...fieldLabel, flex: "1 1 260px" }}>
          Ask a question
          <select
            id="tpl-template"
            value={templateId}
            onChange={(e) => pick(e.target.value)}
            style={{ ...control, width: "100%" }}
          >
            {TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>

        {template.params.map((param) => (
          <Field
            key={param.id}
            param={param}
            value={values[param.id] ?? ""}
            countries={countries}
            months={months}
            onChange={(next) => set(param.id, next)}
          />
        ))}

        {template.requiredScope && (
          <label htmlFor="tpl-radius" style={fieldLabel}>
            Near me
            <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <select
                id="tpl-radius"
                value={radiusMiles}
                onChange={(e) => setRadiusMiles(Number(e.target.value))}
                style={{ ...control, width: 104 }}
              >
                {RADII_MILES.map((miles) => (
                  <option key={miles} value={miles}>
                    {miles.toLocaleString("en-US")} miles
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={useMyLocation}
                disabled={warehouse === null || locating || permission === "unsupported"}
                style={{ ...control, cursor: "pointer", whiteSpace: "nowrap" }}
              >
                {locating
                  ? "Locating…"
                  : permission === "denied"
                    ? "Location blocked"
                    : "Use my location"}
              </button>
            </span>
          </label>
        )}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 12,
          marginTop: 10,
        }}
      >
        <button
          type="button"
          onClick={() => onGenerate(template.sql(values, ctx))}
          disabled={blocked !== null}
          style={{ ...control, cursor: blocked ? "not-allowed" : "pointer" }}
        >
          Write the query
        </button>
        <span style={{ color: "var(--text-dim)", fontSize: 12 }}>{note ?? template.blurb}</span>
        <span
          className="tabular"
          style={{ color: "var(--text-dim)", fontSize: 12 }}
          title="Measured bytes over the wire for this template's defaults. A guide, not a promise."
        >
          ~{estimate < 1 ? "<1" : Math.round(estimate)} MB
        </span>
        {hasRadius && (
          <button
            type="button"
            onClick={() => {
              setValues((v) => ({ ...v, zones: "" }));
              setNote(null);
            }}
            style={{ ...control, cursor: "pointer", fontSize: 12 }}
          >
            Clear radius
          </button>
        )}
      </div>
    </div>
  );
}
