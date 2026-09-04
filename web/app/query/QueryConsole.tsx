"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type CSSProperties, type KeyboardEvent } from "react";
import { openDuckDB, type MartsMeta, type ResultTable, type Warehouse } from "@/lib/duckdbWasm";

const DISPLAY_CAP = 1_000;
const CSV_CAP = 100_000;

const STARTER_SQL = `-- Bots on the ground per faction, by country, on the newest day in the record
select country_name, legion_bots, swarm_bots, faceless_bots, total_bots
from fct_country_daily
where activity_date = (select max(activity_date) from fct_country_daily)
order by total_bots desc
limit 25`;

const count = (n: number): string => n.toLocaleString("en-US");
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// Arrow's DataType.toString(): "Timestamp<MICROSECOND>", "Date32<DAY>", "Int64",
// "Uint8", "Float64", "Decimal[...]". Dates and timestamps both arrive as
// epoch-millisecond numbers, and a decimal arrives as its unscaled integer, so
// only the declared type tells them from a count.
type Kind = "timestamp" | "date" | "number" | "decimal" | "other";
const kindOf = (type: string): Kind => {
  if (type.startsWith("Timestamp")) return "timestamp";
  if (type.startsWith("Date")) return "date";
  if (type.startsWith("Decimal")) return "decimal";
  if (/^(U?Int|Float)/.test(type)) return "number";
  return "other";
};
const numeric = (kind: Kind): boolean => kind === "number" || kind === "decimal";

interface Column {
  name: string;
  kind: Kind;
  scale: number;
  get: (row: number) => unknown;
}

const columnsOf = (table: ResultTable): Column[] =>
  table.schema.fields.map((field, i) => {
    const vector = table.getChildAt(i);
    return {
      name: field.name,
      kind: kindOf(String(field.type)),
      scale: (field.type as { scale?: number }).scale ?? 0,
      get: (row: number) => vector?.get(row) as unknown,
    };
  });

const bigintSafe = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? String(value) : value;

/** "-15" at scale 1 is "-1.5"; the digits are padded so scale 3 gives "0.015". */
const placeDecimalPoint = (unscaled: string, scale: number): string => {
  if (scale <= 0) return unscaled;
  const negative = unscaled.startsWith("-");
  const digits = (negative ? unscaled.slice(1) : unscaled).padStart(scale + 1, "0");
  const point = digits.length - scale;
  return `${negative ? "-" : ""}${digits.slice(0, point)}.${digits.slice(point)}`;
};

/** null stays null so the grid and the CSV can each render it their own way. */
const formatCell = (value: unknown, column: Column): string | null => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const { kind } = column;
  if (kind === "timestamp" && typeof value === "number") return new Date(value).toISOString();
  if (kind === "date" && typeof value === "number") return new Date(value).toISOString().slice(0, 10);
  if (kind === "decimal") return placeDecimalPoint(String(value), column.scale);
  if (typeof value === "object") return JSON.stringify(value, bigintSafe);
  return String(value);
};

/** RFC 4180: quote when the field holds a comma, a quote, or a line break. */
const csvField = (text: string | null): string => {
  if (text === null) return "";
  const quote = String.fromCharCode(34);
  const risky = text.includes(",") || text.includes(quote) || text.includes("\n") || text.includes("\r");
  return risky ? `${quote}${text.replaceAll(quote, quote + quote)}${quote}` : text;
};

const buildCsv = (table: ResultTable): string => {
  const columns = columnsOf(table);
  const rows = Math.min(table.numRows, CSV_CAP);
  const lines = [columns.map((c) => csvField(c.name)).join(",")];
  for (let r = 0; r < rows; r++) {
    lines.push(columns.map((c) => csvField(formatCell(c.get(r), c))).join(","));
  }
  return lines.join("\n") + "\n";
};

const downloadCsv = (table: ResultTable): void => {
  const url = URL.createObjectURL(new Blob([buildCsv(table)], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "query.csv";
  anchor.click();
  URL.revokeObjectURL(url);
};

interface QueryResult {
  table: ResultTable;
  elapsedMs: number;
}

function useWarehouse(): { warehouse: Warehouse | null; bootError: string | null } {
  const [warehouse, setWarehouse] = useState<Warehouse | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    openDuckDB().then(
      (w) => live && setWarehouse(w),
      (error: unknown) => live && setBootError(errorText(error)),
    );
    return () => {
      live = false;
    };
  }, []);
  return { warehouse, bootError };
}

function useQuery(warehouse: Warehouse | null) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (sql: string) => {
      if (warehouse === null || running) return;
      setRunning(true);
      const started = performance.now();
      try {
        const table = await warehouse.conn.query(sql);
        setResult({ table, elapsedMs: performance.now() - started });
        setError(null);
      } catch (failure: unknown) {
        // A stale grid under an error reads as the failed query's output.
        setResult(null);
        setError(errorText(failure));
      } finally {
        setRunning(false);
      }
    },
    [warehouse, running],
  );

  return { run, running, result, error };
}

const panel: CSSProperties = { borderBottom: "1px solid var(--hairline)", padding: "12px 16px" };
const buttonStyle: CSSProperties = {
  border: "1px solid var(--hairline-bright)",
  background: "var(--ink-raised)",
  padding: "6px 14px",
  borderRadius: 3,
  whiteSpace: "nowrap",
};

function Header({ meta, loading }: { meta: MartsMeta | null; loading: boolean }) {
  const line = meta
    ? `Zone History · data through ${meta.newest_event_date} · ${Object.keys(meta.tables).length} tables`
    : loading
      ? "Zone History · Loading DuckDB…"
      : "Zone History";
  return (
    <header style={{ ...panel, display: "flex", alignItems: "baseline", gap: 16 }}>
      <h1 className="display" style={{ margin: 0, fontSize: 18 }}>
        Query
      </h1>
      <span style={{ color: "var(--text-dim)" }}>{line}</span>
      <Link href="/" style={{ marginLeft: "auto", color: "var(--text)" }}>
        Back to the map
      </Link>
    </header>
  );
}

function TableList({ meta, onPick }: { meta: MartsMeta | null; onPick: (name: string) => void }) {
  if (meta === null) return null;
  return (
    <aside
      style={{
        width: 280,
        flexShrink: 0,
        overflowY: "auto",
        borderRight: "1px solid var(--hairline)",
        padding: "12px 16px",
      }}
    >
      <div className="eyebrow" style={{ marginBottom: 10 }}>
        Tables
      </div>
      {Object.entries(meta.tables).map(([name, table]) => (
        <details key={name} style={{ marginBottom: 8 }}>
          <summary style={{ cursor: "pointer", listStyle: "none" }}>
            <button
              type="button"
              onClick={() => onPick(name)}
              title={`select * from ${name} limit 100`}
              style={{ padding: 0, color: "var(--text)" }}
            >
              {name}
            </button>
            <span className="tabular" style={{ color: "var(--text-dim)", marginLeft: 8 }}>
              {count(table.rows)}
            </span>
          </summary>
          <div style={{ color: "var(--text-dim)", paddingLeft: 12, fontSize: 12, lineHeight: 1.5 }}>
            {table.columns.map((c) => (
              <div key={c.name}>
                {c.name} {c.type}
              </div>
            ))}
          </div>
        </details>
      ))}
    </aside>
  );
}

interface EditorProps {
  sql: string;
  onChange: (sql: string) => void;
  onRun: () => void;
  onDownload: () => void;
  ready: boolean;
  running: boolean;
  status: string | null;
  hasResult: boolean;
}

function Editor(props: EditorProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      props.onRun();
    }
  };
  return (
    <div style={panel}>
      <textarea
        value={props.sql}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={onKeyDown}
        spellCheck={false}
        rows={8}
        aria-label="SQL"
        style={{
          width: "100%",
          resize: "vertical",
          font: "inherit",
          color: "var(--text)",
          background: "var(--ink-raised)",
          border: "1px solid var(--hairline)",
          borderRadius: 3,
          padding: 10,
          lineHeight: 1.5,
        }}
      />
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 12, marginTop: 8 }}>
        <button type="button" onClick={props.onRun} disabled={!props.ready || props.running} style={buttonStyle}>
          {props.running ? "Running…" : "Run"}
        </button>
        <button type="button" onClick={props.onDownload} disabled={!props.hasResult} style={buttonStyle}>
          Download CSV
        </button>
        <span className="tabular" style={{ color: "var(--text-dim)" }}>
          {props.ready ? props.status : "Loading DuckDB…"}
        </span>
      </div>
    </div>
  );
}

function ErrorPanel({ message, hint }: { message: string; hint?: string }) {
  return (
    <pre
      style={{
        margin: 0,
        padding: "12px 16px",
        whiteSpace: "pre-wrap",
        color: "var(--legion)",
        background: "var(--ink-raised)",
        borderBottom: "1px solid var(--hairline)",
      }}
    >
      {message}
      {hint ? `\n\n${hint}` : ""}
    </pre>
  );
}

const cellStyle: CSSProperties = {
  padding: "4px 12px",
  borderBottom: "1px solid var(--hairline)",
  whiteSpace: "nowrap",
  textAlign: "left",
};

function ResultsGrid({ table }: { table: ResultTable }) {
  const columns = columnsOf(table);
  const rows = Math.min(table.numRows, DISPLAY_CAP);
  const indices = Array.from({ length: rows }, (_, i) => i);
  return (
    <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
      <thead>
        <tr>
          {columns.map((c) => (
            <th
              key={c.name}
              className={numeric(c.kind) ? "eyebrow tabular" : "eyebrow"}
              style={{
                ...cellStyle,
                position: "sticky",
                top: 0,
                background: "var(--ink-raised)",
                textAlign: numeric(c.kind) ? "right" : "left",
              }}
            >
              {c.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {indices.map((r) => (
          <tr key={r}>
            {columns.map((c) => {
              const text = formatCell(c.get(r), c);
              return (
                <td
                  key={c.name}
                  className={numeric(c.kind) ? "tabular" : undefined}
                  style={{
                    ...cellStyle,
                    textAlign: numeric(c.kind) ? "right" : "left",
                    color: text === null ? "var(--text-dim)" : undefined,
                  }}
                >
                  {text ?? "∅"}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const statusFor = (result: QueryResult | null, csvNote: string | null): string | null => {
  if (result === null) return null;
  const n = result.table.numRows;
  const parts = [`${count(n)} rows · ${Math.round(result.elapsedMs)} ms`];
  if (n > DISPLAY_CAP) parts.push(`showing first ${count(DISPLAY_CAP)} of ${count(n)} rows`);
  if (csvNote) parts.push(csvNote);
  return parts.join(" · ");
};

const csvNoteFor = (rows: number): string | null =>
  rows > CSV_CAP ? `CSV holds the first ${count(CSV_CAP)} of ${count(rows)} rows` : null;

const BOOT_HINT =
  "Locally, `npm run data` must be running in web/ so dist/marts is served on :3002. Reload once it is.";

function Errors({ bootError, error }: { bootError: string | null; error: string | null }) {
  return (
    <>
      {bootError && <ErrorPanel message={bootError} hint={BOOT_HINT} />}
      {error && <ErrorPanel message={error} />}
    </>
  );
}

export default function QueryConsole() {
  const { warehouse, bootError } = useWarehouse();
  const { run, running, result, error } = useQuery(warehouse);
  const [sql, setSql] = useState(STARTER_SQL);
  const [csvNote, setCsvNote] = useState<string | null>(null);
  const meta = warehouse?.meta ?? null;

  const onRun = () => {
    setCsvNote(null);
    void run(sql);
  };
  const onDownload = () => {
    if (result === null) return;
    downloadCsv(result.table);
    setCsvNote(csvNoteFor(result.table.numRows));
  };

  return (
    <main style={{ height: "100dvh", display: "flex", flexDirection: "column", background: "var(--ink)" }}>
      <Header meta={meta} loading={meta === null && bootError === null} />
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <TableList meta={meta} onPick={(name) => setSql(`select * from ${name} limit 100`)} />
        <section style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <Editor
            sql={sql}
            onChange={setSql}
            onRun={onRun}
            onDownload={onDownload}
            ready={meta !== null}
            running={running}
            status={statusFor(result, csvNote)}
            hasResult={result !== null}
          />
          <Errors bootError={bootError} error={error} />
          <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
            {result && <ResultsGrid table={result.table} />}
          </div>
        </section>
      </div>
    </main>
  );
}
