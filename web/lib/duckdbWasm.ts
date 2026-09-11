/**
 * DuckDB-WASM in the browser, reading the warehouse marts in place.
 *
 * The marts are one zstd Parquet file per table under `<origin>/marts/`, and
 * DuckDB reads them over HTTP range requests: the footer first, then only the
 * row groups a query touches. No server runs SQL for the reader; the browser
 * is the database.
 *
 * `@duckdb/duckdb-wasm` is imported lazily, inside `openDuckDB`, so it lives in
 * its own chunk and nothing from it reaches the map's bundle or the static HTML.
 */
import type * as duckdbTypes from "@duckdb/duckdb-wasm";
import { DATA_ROOT } from "./dataOrigin";

export type Connection = Awaited<ReturnType<duckdbTypes.AsyncDuckDB["connect"]>>;
export type ResultTable = Awaited<ReturnType<Connection["query"]>>;

export interface MartColumn {
  name: string;
  type: string;
}

export interface MartTable {
  path: string;
  rows: number;
  bytes: number;
  sort: string[];
  columns: MartColumn[];
}

export interface MartsMeta {
  newest_event_date: string;
  tables: Record<string, MartTable>;
}

export interface Warehouse {
  conn: Connection;
  meta: MartsMeta;
  bind: (sql: string) => Promise<void>;
}

const MARTS = `${DATA_ROOT}/marts`;

async function readMeta(): Promise<MartsMeta> {
  const response = await fetch(`${MARTS}/_meta.json`);
  if (!response.ok) {
    throw new Error(`${MARTS}/_meta.json answered ${response.status}`);
  }
  return (await response.json()) as MartsMeta;
}

async function instantiate(): Promise<Connection> {
  // @ts-expect-error TS7016: no declaration file is mapped for this path
  const duckdb = (await import("@duckdb/duckdb-wasm/dist/duckdb-browser")) as typeof duckdbTypes;
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  if (bundle.mainWorker === null) {
    throw new Error("no DuckDB worker bundle fits this browser");
  }
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }),
  );
  try {
    const worker = new Worker(workerUrl);
    const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    return await db.connect();
  } finally {
    URL.revokeObjectURL(workerUrl);
  }
}

const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const quoteString = (text: string): string => `'${text.replaceAll("'", "''")}'`;

function referencedTables(sql: string, known: Set<string>): string[] {
  const words = sql.match(/\b[a-z_][a-z0-9_]*\b/gi) ?? [];
  return [...new Set(words.map((w) => w.toLowerCase()).filter((w) => known.has(w)))];
}

function makeBinder(conn: Connection, meta: MartsMeta) {
  const bound = new Set<string>();
  const known = new Set(Object.keys(meta.tables));
  const inflight = new Map<string, Promise<void>>();

  return async function bind(sql: string): Promise<void> {
    const needed = referencedTables(sql, known).filter((n) => !bound.has(n));
    if (needed.length === 0) return;

    await Promise.all(
      needed.map((name) => {
        const existing = inflight.get(name);
        if (existing) return existing;
        const table = meta.tables[name];
        const url = `${MARTS}/${table.path}`;
        const p = conn
          .query(
            `create or replace view ${quoteIdent(name)} as ` +
              `select * from read_parquet(${quoteString(url)})`,
          )
          .then(() => {
            bound.add(name);
          })
          .catch((error: unknown) => {
            const msg = error instanceof Error ? error.message : String(error);
            throw new Error(`Could not reach ${name} at ${url}: ${msg}`);
          })
          .finally(() => {
            inflight.delete(name);
          });
        inflight.set(name, p);
        return p;
      }),
    );
  };
}

async function open(): Promise<Warehouse> {
  const [conn, meta] = await Promise.all([
    instantiate().catch((error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Loading DuckDB: ${msg}`);
    }),
    readMeta().catch((error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Reading ${MARTS}/_meta.json: ${msg}`);
    }),
  ]);
  return { conn, meta, bind: makeBinder(conn, meta) };
}

let warehouse: Promise<Warehouse> | null = null;

export function openDuckDB(): Promise<Warehouse> {
  if (warehouse === null) {
    warehouse = open().catch((error: unknown) => {
      warehouse = null;
      throw error;
    });
  }
  return warehouse;
}
