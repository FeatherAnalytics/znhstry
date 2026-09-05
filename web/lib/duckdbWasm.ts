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
  // The browser entry by path: the bare package name resolves to the Node
  // build in Next's server pass, whose dynamic requires make webpack warn on
  // every build even though this import only ever runs in the browser. The
  // package's exports map carries no types entry for the path, hence the cast.
  // @ts-expect-error TS7016: no declaration file is mapped for this path
  const duckdb = (await import("@duckdb/duckdb-wasm/dist/duckdb-browser")) as typeof duckdbTypes;
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  if (bundle.mainWorker === null) {
    throw new Error("no DuckDB worker bundle fits this browser");
  }
  // A Worker cannot be constructed from a cross-origin script URL, so a
  // same-origin blob pulls the CDN script in instead.
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

async function open(): Promise<Warehouse> {
  const [conn, meta] = await Promise.all([instantiate(), readMeta()]);
  for (const [name, table] of Object.entries(meta.tables)) {
    await conn.query(
      `create or replace view ${quoteIdent(name)} as ` +
        `select * from read_parquet(${quoteString(`${MARTS}/${table.path}`)})`,
    );
  }
  return { conn, meta };
}

let warehouse: Promise<Warehouse> | null = null;

/** One database per page. A re-render must not instantiate a second one. */
export function openDuckDB(): Promise<Warehouse> {
  if (warehouse === null) {
    warehouse = open().catch((error: unknown) => {
      // A failed bootstrap is retried on the next call rather than cached for
      // the life of the page.
      warehouse = null;
      throw error;
    });
  }
  return warehouse;
}
