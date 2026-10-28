/*
# Copyright 2026 OpenC3, Inc.
# All Rights Reserved.
#
# Licensed under the MIT license. See LICENSE.md.
*/

// WGS84
const A = 6378137.0
const F = 1 / 298.257223563
const E2 = F * (2 - F)
const B = A * (1 - F)
const EP2 = (A * A - B * B) / (B * B)

const DEG = 180 / Math.PI

// How many fixed locations a panel can have (LOCATION_1 and up)
export const MAX_LOCATIONS = 6

// Items per position for a COORDINATES setting
export function trackSize(coordinates) {
  return coordinates === 'ECEF' ? 3 : 2
}

// ECEF meters to geodetic { lat, lon, alt } (degrees, meters), Bowring's
// method: accurate to well under a meter near the Earth and in orbit
export function ecefToGeodetic(x, y, z) {
  const p = Math.hypot(x, y)
  const theta = Math.atan2(z * A, p * B)
  const sin = Math.sin(theta)
  const cos = Math.cos(theta)
  const lat = Math.atan2(z + EP2 * B * sin ** 3, p - E2 * A * cos ** 3)
  const lon = Math.atan2(y, x)
  const n = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2)
  const alt = p / Math.cos(lat) - n
  return { lat: lat * DEG, lon: lon * DEG, alt }
}

// Lat / lon degrees from one position's item values: (lat, lon) or ECEF
// (x, y, z meters)
export function toLatLon(values) {
  return values.length === 3
    ? ecefToGeodetic(...values)
    : { lat: values[0], lon: values[1], alt: null }
}

// Group a panel's item values into positions: every 2 items (lat, lon) or 3
// items (ECEF x, y, z). Returns [{ index, items, lat, lon, alt }] with lat
// null when any value is missing.
export function positions(states, coordinates) {
  const size = trackSize(coordinates)
  const result = []
  for (let i = 0; i + size <= states.length; i += size) {
    const group = states.slice(i, i + size)
    const numbers = group.map((state) => state.number)
    let point = { lat: null, lon: null, alt: null }
    if (numbers.every((n) => typeof n === 'number')) point = toLatLon(numbers)
    result.push({ index: i / size, items: group.map((s) => s.item), ...point })
  }
  return result
}

// Most points drawn in one trail, however long the time range
export const MAX_TRAIL_POINTS = 2000

// Each position's history from a useTlmSeries series ([times in seconds,
// then one array of values per item], oldest first), grouped every `size`
// items: [[{ time, values }]] oldest first. Items that update apart (lat and
// lon from different packets) carry their last value forward. Long histories
// keep the first sample in each of MAX_TRAIL_POINTS slices of `seconds`; the
// slices are fixed in time, so kept points stay put as the trail moves on.
export function history(series, size, seconds) {
  const [times, ...columns] = series
  const slice = seconds / MAX_TRAIL_POINTS
  const result = []
  for (let i = 0; i + size <= columns.length; i += size) {
    const group = columns.slice(i, i + size)
    const values = new Array(size).fill(null)
    const track = []
    let newest = null
    let lastSlice = null
    times.forEach((time, row) => {
      let changed = false
      group.forEach((column, j) => {
        if (typeof column[row] === 'number') {
          values[j] = column[row]
          changed = true
        }
      })
      if (!changed || values.includes(null)) return
      newest = { time, values: [...values] }
      const timeSlice = Math.floor(time / slice)
      if (timeSlice !== lastSlice) {
        lastSlice = timeSlice
        track.push(newest)
      }
    })
    // Always end on the newest, so the trail reaches the position
    if (newest && track.at(-1) !== newest) track.push(newest)
    result.push(track)
  }
  return result
}

// The fixed locations a panel has: LOCATION_<n> (name), LOCATION_<n>_LAT and
// LOCATION_<n>_LON (degrees). `read` reads a panel option. Locations without a
// valid latitude and longitude aren't drawn. Returns [{ key, name, lat, lon }].
export function locationList(read) {
  const locations = []
  // Blank is missing, not 0
  const number = (name) => {
    const text = String(read(name) ?? '').trim()
    return text ? Number(text) : NaN
  }
  for (let n = 1; n <= MAX_LOCATIONS; n++) {
    const lat = number(`LOCATION_${n}_LAT`)
    const lon = number(`LOCATION_${n}_LON`)
    const valid =
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lon) <= 360
    if (!valid) continue
    locations.push({
      key: `location-${n}`,
      name: read(`LOCATION_${n}`) || `Location ${n}`,
      lat,
      lon,
    })
  }
  return locations
}
