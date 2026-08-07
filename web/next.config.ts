import { resolve } from "node:path";
import type { NextConfig } from "next";

/**
 * Load the repo-root `.env`, if there is one.
 *
 * Next only looks inside `web/`, but the same values are wanted by
 * `tools/upload-data.sh` at the root, and keeping one file beats keeping two in
 * sync. Anything already in the environment wins, so CI - which passes these as
 * workflow variables and never writes a file - is unaffected.
 *
 * `process.loadEnvFile` is built into Node 20.12+ and throws when the file is
 * absent, which is the normal case in CI.
 */
const shell = { ...process.env };
try {
  // loadEnvFile overwrites, so the file would otherwise beat both CI's workflow
  // variables and a one-off `NEXT_PUBLIC_DATA_SCOPE=... npm run dev`. Snapshot
  // what was already set and put it back on top.
  process.loadEnvFile?.(resolve(process.cwd(), "..", ".env"));
  Object.assign(process.env, shell);
} catch {
  // No root .env. Next still reads web/.env.local if one exists.
}

/**
 * Where the browser fetches payloads from.
 *
 * `.env` names the *bucket*, because that is what a production build and
 * `upload.py` both need. `next dev` wants the opposite: the local server that
 * `npm run data` starts, holding the export you just rebuilt. Pointing dev at
 * the bucket means editing data locally and seeing none of it - and it is why
 * `npm run data` && `npm run dev`, the documented workflow, silently loaded
 * nothing at all.
 *
 * So in dev the local server wins unless the shell explicitly says otherwise.
 * The shell still beats everything, which is what makes
 * `NEXT_PUBLIC_DATA_ORIGIN=https://... npm run dev` work when you do want to
 * check the real bucket.
 */
const isDev = process.env.NODE_ENV !== "production";
const fromShell = shell.NEXT_PUBLIC_DATA_ORIGIN ?? shell.NEXT_PUBLIC_R2_URL;
const configured = process.env.NEXT_PUBLIC_DATA_ORIGIN ?? process.env.NEXT_PUBLIC_R2_URL;
const dataOrigin = fromShell ?? (isDev ? "http://localhost:3002" : configured) ?? "http://localhost:3002";

// Written back, not just handed to `env:` below. Next inlines any NEXT_PUBLIC_*
// it finds in process.env, and loadEnvFile had already put the bucket URL
// there, so the `env:` block lost and dev kept talking to R2.
process.env.NEXT_PUBLIC_DATA_ORIGIN = dataOrigin;
delete process.env.NEXT_PUBLIC_R2_URL;

const nextConfig: NextConfig = {
  // Static export for GitHub Pages. The payloads are not part of it - they are
  // served from object storage, which is why NEXT_PUBLIC_DATA_ORIGIN exists.
  output: "export",
  basePath: process.env.NEXT_PUBLIC_BASE_PATH ?? "",
  images: { unoptimized: true },
  trailingSlash: true,
  env: {
    // Resolved above. `NEXT_PUBLIC_R2_URL` is accepted as an alias because the
    // other projects in this account call it that. Inlined at build time.
    NEXT_PUBLIC_DATA_ORIGIN: dataOrigin,
    // Which export under that origin to read. Only `global` exists.
    NEXT_PUBLIC_DATA_SCOPE: process.env.NEXT_PUBLIC_DATA_SCOPE ?? "global",
  },
};

export default nextConfig;
