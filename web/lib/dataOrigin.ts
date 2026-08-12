/**
 * Where the payloads come from.
 *
 * The export lives in object storage rather than the site bundle because it
 * needs response headers a static host cannot set - `Content-Encoding: br`
 * above all. Locally, `npm run data` stands in for the bucket on port 3002.
 *
 * One module rather than a constant per page: a second page reading a different
 * origin than the first is the kind of bug that only shows up in production,
 * where the two are actually different.
 */

export const DATA_ROOT = process.env.NEXT_PUBLIC_DATA_ORIGIN ?? "http://localhost:3002";

export const BASE = `${DATA_ROOT}/${process.env.NEXT_PUBLIC_DATA_SCOPE ?? "global"}`;
