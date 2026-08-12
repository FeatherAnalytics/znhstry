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

/**
 * Mask of zones in one country, or in one region.
 *
 * The two are separate questions and the game answers them from separate fields:
 * its own site counts a country by `country_id` and a region by `region_id`, so
 * Poland is 44,080 zones while West Pomeranian Voivodeship is 1,890 — and 155 of
 * that region's zones are not in Poland at all. Matching that is what lets a
 * number here be checked against the one a player is looking at.
 *
 * So a region ignores the country entirely. Selecting Northwest Territories draws
 * 198 zones across Canada and the DRC, which is strange to look at and is what the
 * game says. It also means regions do not sum to their country: Poland's total
 * 44,235 against a country of 44,080.
 */
export function areaFilter(
  geometry: ZoneGeometry,
  countryId: number,
  regionId: number | null,
): ZoneFilter {
  const { country, region, size } = geometry;
  const mask = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    mask[i] = (regionId === null ? country[i] === countryId : region[i] === regionId) ? 1 : 0;
  }
  return mask;
}

/**
 * Mask of zones within `radiusKm` of a point, by great-circle distance.
 *
 * A latitude band runs in front of the haversine, and it is worth the two lines: this
 * walks all 2,682,442 zones on every selection, and a 30-mile circle rejects
 * essentially all of them. One subtraction and a comparison per zone turns the trig
 * from 2.68M calls into a few thousand.
 *
 * Safe because a degree of latitude is never shorter than 110.574 km, so a band of
 * `radiusKm / 110.574` is always at least as wide as the circle and cannot exclude a
 * zone the haversine would have kept. Longitude gets no such band - a degree of it
 * shrinks to nothing at the poles, so the bound would have to be latitude-dependent
 * and the band already does the work.
 */
export function radiusFilter(
  geometry: ZoneGeometry,
  lat: number,
  lon: number,
  radiusKm: number,
): ZoneFilter {
  const mask = new Uint8Array(geometry.size);
  const band = radiusKm / 110.574;
  for (let i = 0; i < geometry.size; i++) {
    const zoneLat = geometry.latitude[i];
    // NaN fails every comparison, so a zone whose tile has not landed falls out here.
    if (!(Math.abs(zoneLat - lat) <= band)) continue;
    mask[i] = haversineKm(lat, lon, zoneLat, geometry.longitude[i]) <= radiusKm ? 1 : 0;
  }
  return mask;
}

export function singleZoneFilter(zoneCount: number, idx: number): ZoneFilter {
  const mask = new Uint8Array(zoneCount);
  mask[idx] = 1;
  return mask;
}
