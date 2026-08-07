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

// In the bucket every shard but the manifest is immutable: its contents only
// change when a nightly run genuinely changes that shard, and a reader who
// visits twice re-downloads nothing.
//
// Locally that is a trap, because a re-export *does* rewrite the same names
// with different bytes - a changed column layout, say - and the browser will
// keep serving the old body with no way to notice. That cost real debugging
// time: a paint shard that had gained a column still decoded as the old one
// and painted the whole world dormant grey. So dev revalidates by default and
// the production headers are opt-in, for when they are what is being tested.
const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "no-cache";
const MANIFEST = "public, max-age=60";
const immutable = process.env.SERVE_IMMUTABLE === "1";

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
  try {
    const info = statSync(path);
    if (!info.isFile()) throw new Error("not a file");
    size = info.size;
  } catch {
    response.writeHead(404).end("not found");
    return;
  }

  const brotli = extname(path) === ".br";
  // "a.bin.br" is a brotli stream over a .bin, so the content type is the
  // inner one; the encoding header carries the rest.
  const inner = brotli ? extname(path.slice(0, -3)) : extname(path);

  response.writeHead(200, {
    "content-type": TYPES[inner] ?? "application/octet-stream",
    "content-length": size,
    ...(brotli ? { "content-encoding": "br" } : {}),
    "cache-control": path.endsWith("meta.json")
      ? MANIFEST
      : immutable
        ? IMMUTABLE
        : REVALIDATE,
    "access-control-allow-origin": "*",
    // Without this, cross-origin resource timings come back with zeroed sizes
    // and every load measurement reads 0 MB.
    "timing-allow-origin": "*",
  });
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
      (immutable ? "" : "  (SERVE_IMMUTABLE=1 for the production headers)"),
  );
});
