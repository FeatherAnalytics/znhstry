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
 *   node tools/serve-data.mjs [port]
 *
 * Point the app at it with NEXT_PUBLIC_DATA_ORIGIN=http://localhost:3002.
 */
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const ROOT = resolve(process.argv[3] ?? "dist/data");
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
};

const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  // normalize() collapses any ".." before it can climb out of ROOT.
  const path = join(ROOT, normalize(decodeURIComponent(url.pathname)));
  if (!path.startsWith(ROOT + sep) && path !== ROOT) {
    response.writeHead(403).end("outside the data root");
    return;
  }

  // isFile(), not merely "stat did not throw". A directory stats perfectly
  // happily and then `createReadStream` throws EISDIR asynchronously, which
  // nothing was catching - so a single request for a directory path killed the
  // whole server and every tile in flight with it.
  let size;
  let etag;
  let modified;
  try {
    const info = statSync(path);
    if (!info.isFile()) throw new Error("not a file");
    size = info.size;
    etag = etagFor(info);
    modified = new Date(info.mtimeMs).toUTCString();
  } catch {
    response.writeHead(404).end("not found");
    return;
  }

  const brotli = extname(path) === ".br";
  // "a.bin.br" is a brotli stream over a .bin, so the content type is the
  // inner one; the encoding header carries the rest.
  const inner = brotli ? extname(path.slice(0, -3)) : extname(path);

  const headers = {
    "content-type": TYPES[inner] ?? "application/octet-stream",
    ...(brotli ? { "content-encoding": "br" } : {}),
    "cache-control": path.endsWith("meta.json")
      ? MANIFEST
      : immutable
        ? IMMUTABLE
        : REVALIDATE,
    // What makes `no-cache` mean anything. Without these the browser has
    // nothing to revalidate with and keeps whatever it already had.
    etag,
    "last-modified": modified,
    "access-control-allow-origin": "*",
    // Both are needed for a cross-origin conditional request: the browser will
    // not send If-None-Match unless the header is allowed, and cannot read the
    // ETag off the response unless it is exposed.
    "access-control-allow-headers": "if-none-match,if-modified-since",
    "access-control-expose-headers": "etag,last-modified,content-encoding",
    // Without this, cross-origin resource timings come back with zeroed sizes
    // and every load measurement reads 0 MB.
    "timing-allow-origin": "*",
  };

  if (request.method === "OPTIONS") {
    response.writeHead(204, headers).end();
    return;
  }

  // A 304 carries no body, so the cost of being right is a header exchange.
  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304, headers).end();
    return;
  }

  response.writeHead(200, { ...headers, "content-length": size });
  // A read that fails after the headers are out cannot become a status code,
  // but it must not take the process with it either. Belt and braces: this is a
  // dev server whose whole job is to stay up while the export is rewritten
  // underneath it.
  createReadStream(path)
    .on("error", () => response.destroy())
    .pipe(response);
});

server.on("clientError", (_error, socket) => socket.destroy());
process.on("uncaughtException", (error) => {
  console.error(`serve-data: ${error.message}`);
});

server.listen(PORT, () => {
  console.log(
    `data: ${ROOT}\nserving on http://localhost:${PORT}` +
      `\ncache-control: ${immutable ? IMMUTABLE : REVALIDATE}` +
      (immutable ? "" : "  (SERVE_IMMUTABLE=1 to pin shards in cache for a year)"),
  );
});
