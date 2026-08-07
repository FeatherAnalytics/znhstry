/**
 * Which zones the readouts are about.
 *
 * One mask drives the map dimming, the stat panel and the zone counts, so they
 * can never disagree about what is being counted. Masks are exact - they test
 * every zone individually. The *chart* for a circle or a viewport aggregates
 * one-degree cells instead, because no precomputation can name an arbitrary
 * circle ahead of time; countries and regions are exact there too.
 */

import type { ZoneGeometry } from "./geometry";
import { haversineKm } from "./series";

export type ZoneFilter = Uint8Array | null;

/**
 * Mask of zones inside the current map bounds.
 *
 * Zones whose tile has not landed yet hold NaN coordinates, and every
 * comparison against NaN is false, so they fall out without a separate check.
 */
export function viewportFilter(
  geometry: ZoneGeometry,
  [west, south, east, north]: [number, number, number, number],
): ZoneFilter {
  const { latitude, longitude, size } = geometry;
  const mask = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    const lon = longitude[i];
    const lat = latitude[i];
    mask[i] = lon >= west && lon <= east && lat >= south && lat <= north ? 1 : 0;
  }
  return mask;
}

/** Mask of zones in one country, or in one region of it. */
export function areaFilter(
  geometry: ZoneGeometry,
  countryId: number,
  regionId: number | null,
): ZoneFilter {
  const { country, region, size } = geometry;
  const mask = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    // country_id decides. A zone whose region belongs to another country is an
    // upstream inconsistency, and the country is the side that matches the
    // coordinates, so a region filter still requires the country to agree.
    mask[i] = country[i] === countryId && (regionId === null || region[i] === regionId) ? 1 : 0;
  }
  return mask;
}

/** Mask of zones within `radiusKm` of a point, by great-circle distance. */
export function radiusFilter(
  geometry: ZoneGeometry,
  lat: number,
  lon: number,
  radiusKm: number,
): ZoneFilter {
  const mask = new Uint8Array(geometry.size);
  for (let i = 0; i < geometry.size; i++) {
    const zoneLat = geometry.latitude[i];
    if (Number.isNaN(zoneLat)) continue;
    mask[i] = haversineKm(lat, lon, zoneLat, geometry.longitude[i]) <= radiusKm ? 1 : 0;
  }
  return mask;
}

export function singleZoneFilter(zoneCount: number, idx: number): ZoneFilter {
  const mask = new Uint8Array(zoneCount);
  mask[idx] = 1;
  return mask;
}
