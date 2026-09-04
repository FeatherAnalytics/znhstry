/**
 * Local stand-in for the bucket the export is served from in production.
 *
 * The payloads are stored brotli-compressed and served with
 * `Content-Encoding: br`, so the browser decompresses them and the client
 * carries no decoding code at all. Nothing in Next can set that header for a
 * static export, and the data does not belong in the site bundle anyway, so
 * dev talks to this the same way production talks to R2: a separate origin,
 * CORS, identical headers.
 *
 *   node tools/serve-data.mjs [port] [data root]
 *
 * Point the app at it with NEXT_PUBLIC_DATA_ORIGIN=http://localhost:3002.
 *
 * The warehouse marts beside the export, `dist/marts`, are mounted under
 * `/marts/` with HTTP Range support: DuckDB-WASM on the `/query` page reads
 * the Parquet files in place, footer first, one row group at a time.
 */
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const ROOT = resolve(process.argv[3] ?? "dist/data");
const MARTS = resolve(ROOT, "..", "marts");
const PORT = Number(process.argv[2] ?? 3002);

// Revalidation, matching the bucket: `upload.py` serves `public, no-cache` on
// every object, so a reader asks before reusing anything. Here it matters twice
// over, because a re-export rewrites the same names with different bytes - a
// changed column layout, say - and a browser holding the old body has no way to
// notice. That cost real debugging time: a paint shard that had gained a column
// still decoded as the old one and painted the whole world dormant grey.
//
// `no-cache` alone does not achieve that. It means "revalidate before reusing",
// and revalidation needs a validator to send in `If-None-Match`; with no ETag
// and no Last-Modified there is nothing to ask about, so the browser reuses the
// stale body and the header accomplishes nothing. That is not theoretical - it
// served a four-day-old scope_daily and a stale meta.json listing an older tile
// set, so the loader never requested the tiles missing from it and whole squares
// of the map silently never appeared. R2 sends a real ETag; so does this.
//
// SERVE_IMMUTABLE=1 pins shards in the browser cache for a year instead. Nothing
// is served that way anywhere - it exists to watch the viewer hold a stale shard
// on purpose, which is the failure the bucket's policy is there to prevent.
const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "no-cache";
const MANIFEST = "public, max-age=60";
const immutable = process.env.SERVE_IMMUTABLE === "1";

/** Cheap and sufficient: the export rewrites files, it never edits them in place. */
const etagFor = (info) => `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;

const TYPES = {
  ".json": "application/json; charset=utf-8",
  ".bin": "application/octet-stream",
  ".parquet": "application/vnd.apache.parquet",
};

/** The file a URL names, or null when it would climb out of its root. */
const locate = (pathname) => {
  const marts = pathname.startsWith("/marts/");
  const root = marts ? MARTS : ROOT;
  const relative = marts ? pathname.slice("/marts".length) : pathname;
  // normalize() collapses any ".." before it can climb out of the root.
  const path = join(root, normalize(decodeURIComponent(relative)));
  return path.startsWith(root + sep) || path === root ? path : null;
};

/**
 * isFile(), not merely "stat did not throw". A directory stats perfectly
 * happily and then `createReadStream` throws EISDIR asynchronously, which
 * nothing was catching - so a single request for a directory path killed the
 * whole server and every tile in flight with it.
 */
const inspect = (path) => {
  try {
    const info = statSync(path);
    return info.isFile() ? info : null;
  } catch {
    return null;
  }
};

const cacheControlFor = (path) => {
  if (path.endsWith("meta.json")) return MANIFEST;
  return immutable ? IMMUTABLE : REVALIDATE;
};

const headersFor = (path, info) => {
  const brotli = extname(path) === ".br";
  // "a.bin.br" is a brotli stream over a .bin, so the content type is the
  // inner one; the encoding header carries the rest.
  const inner = brotli ? extname(path.slice(0, -3)) : extname(path);
  return {
    "content-type": TYPES[inner] ?? "application/octet-stream",
    ...(brotli ? { "content-encoding": "br" } : {}),
    "cache-control": cacheControlFor(path),
    // What makes `no-cache` mean anything. Without these the browser has
    // nothing to revalidate with and keeps whatever it already had.
    etag: etagFor(info),
    "last-modified": new Date(info.mtimeMs).toUTCString(),
    "access-control-allow-origin": "*",
    // Both are needed for a cross-origin conditional request: the browser will
    // not send If-None-Match unless the header is allowed, and cannot read the
    // ETag off the response unless it is exposed. Range is what lets DuckDB-WASM
    // read a Parquet footer without the file; it needs to send the header and
    // read the answer's extent back.
    "access-control-allow-headers": "if-none-match,if-modified-since,range",
    "access-control-expose-headers":
      "etag,last-modified,content-encoding,content-range,accept-ranges,content-length",
    // Without this, cross-origin resource timings come back with zeroed sizes
    // and every load measurement reads 0 MB.
    "timing-allow-origin": "*",
    "accept-ranges": "bytes",
  };
};

/**
 * Only the single form `bytes=start-end` or `bytes=start-`. That is all a
 * Parquet reader sends; a suffix or multipart range gets the whole file. A byte
 * range of a brotli stream is meaningless, and the viewer never asks for one,
 * so a Range on a .br gets the whole file too.
 */
const parseRange = (request, path, size) => {
  if (path.endsWith(".br")) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (start >= size || start > end) return { unsatisfiable: true };
  return { start, end };
};

const sendBody = (request, response, path, size, headers) => {
  const range = parseRange(request, path, size);
  if (range?.unsatisfiable) {
    response.writeHead(416, { ...headers, "content-range": `bytes */${size}` }).end();
    return;
  }

  const { start, end } = range ?? { start: 0, end: size - 1 };
  response.writeHead(range ? 206 : 200, {
    ...headers,
    "content-length": end - start + 1,
    ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
  });

  // Node drops a HEAD body on its own, but opening a stream for it would still
  // read the file to no purpose.
  if (request.method === "HEAD") {
    response.end();
    return;
  }

  // A read that fails after the headers are out cannot become a status code,
  // but it must not take the process with it either. Belt and braces: this is a
  // dev server whose whole job is to stay up while the export is rewritten
  // underneath it.
  createReadStream(path, { start, end })
    .on("error", () => response.destroy())
    .pipe(response);
};

const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  const path = locate(url.pathname);
  if (path === null) {
    response.writeHead(403).end("outside the data root");
    return;
  }

  const info = inspect(path);
  if (info === null) {
    response.writeHead(404).end("not found");
    return;
  }

  const headers = headersFor(path, info);
  if (request.method === "OPTIONS") {
    response.writeHead(204, headers).end();
    return;
  }

  // A 304 carries no body, so the cost of being right is a header exchange.
  if (request.headers["if-none-match"] === headers.etag) {
    response.writeHead(304, headers).end();
    return;
  }

  sendBody(request, response, path, info.size, headers);
});

server.on("clientError", (_error, socket) => socket.destroy());
process.on("uncaughtException", (error) => {
  console.error(`serve-data: ${error.message}`);
});

server.listen(PORT, () => {
  console.log(
    `data: ${ROOT}\nmarts: ${MARTS} under /marts/\nserving on http://localhost:${PORT}` +
      `\ncache-control: ${immutable ? IMMUTABLE : REVALIDATE}` +
      (immutable ? "" : "  (SERVE_IMMUTABLE=1 to pin shards in cache for a year)"),
  );
});
