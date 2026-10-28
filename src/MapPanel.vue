<!--
# Copyright 2026 OpenC3, Inc.
# All Rights Reserved.
#
# Licensed under the MIT license. See LICENSE.md.
-->

<template>
  <div class="map-panel d-flex flex-column flex-grow-1">
    <!-- The map fills this box absolutely, so Leaflet's own size can never
         push the panel larger than its grid cell -->
    <div class="map-box">
      <div
        ref="mapView"
        :class="['map', { 'dark-tiles': darkTiles }]"
        data-test="map-panel"
      />
    </div>
    <div
      class="d-flex flex-wrap align-center ga-3 px-3 py-1 text-caption"
      style="min-height: 28px"
    >
      <button
        v-for="position in legend"
        :key="position.index"
        type="button"
        class="legend-entry d-inline-flex align-center ga-1"
        :title="`${position.label}: details`"
        @click="details(position)"
      >
        <span class="dot" :style="{ background: position.color }" />
        <span class="text-high-emphasis">{{ position.label }}</span>
        <span class="num text-medium-emphasis">{{ position.text }}</span>
      </button>
      <span class="flex-grow-1" />
      <v-btn
        v-if="follow && !following"
        size="x-small"
        variant="text"
        prepend-icon="mdi-crosshairs-gps"
        data-test="map-follow"
        @click="resumeFollow"
      >
        Follow
      </v-btn>
    </div>
  </div>
</template>

<script setup>
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  useTemplateRef,
  watch,
} from 'vue'
import L from 'leaflet'
import leafletCss from 'leaflet/dist/leaflet.css?inline'
import { sdk } from './sdk'
import {
  history,
  locationList,
  positions as positionsOf,
  toLatLon,
  trackSize,
} from './geo'

const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'

// Leaflet's stylesheet travels inside this bundle; add it once per page
function addLeafletCss() {
  if (document.getElementById('openc3-map-panel-leaflet')) return
  const style = document.createElement('style')
  style.id = 'openc3-map-panel-leaflet'
  style.textContent = leafletCss
  document.head.appendChild(style)
}

// Keep a trail continuous across the antimeridian (179° -> -179° becomes
// 179° -> 181°) so it doesn't draw a line across the whole map
function unwrap(previous, lon) {
  if (previous === undefined) return lon
  while (lon - previous > 180) lon -= 360
  while (lon - previous < -180) lon += 360
  return lon
}

function formatPosition(position) {
  if (position.lat === null) return '--'
  const text = `${position.lat.toFixed(4)}°, ${position.lon.toFixed(4)}°`
  return position.alt === null
    ? text
    : `${text}, ${(position.alt / 1000).toFixed(1)} km`
}

// A 2D map of positions from telemetry, with trails. The current positions
// come from the shared poller (useTlmPanel); the trails are the dashboard's
// time range of history (useTlmSeries), backfilled when the dashboard opens
// or the range changes, then streamed live, or loaded up to the playback
// time during playback.
const props = defineProps({ panel: { type: Object, required: true } })
const panel = sdk.useTlmPanel(props)
const { itemStates, showDetails } = panel
const { series, duration } = sdk.useTlmSeries(props, panel, {
  // Only streamed while trails are shown
  seriesItems: () => (showTrail.value ? props.panel.items : []),
  seriesUpdated: () => {
    updateTrails()
    move()
    draw()
  },
  // Start over: markers jump to where they are now instead of gliding
  seriesReset: () => {
    motion = {}
    lastMove = null
    updateTrails()
    move()
    draw()
  },
})
const mapEl = useTemplateRef('mapView')
const following = ref(true)

const coordinates = computed(() => sdk.option(props.panel, 'COORDINATES'))
const follow = computed(() => sdk.option(props.panel, 'FOLLOW'))
const showTrail = computed(() => sdk.option(props.panel, 'TRAIL'))
const tiles = computed(() => (sdk.option(props.panel, 'TILES') || '').trim())
const darkTiles = computed(
  () => tiles.value !== 'NONE' && sdk.option(props.panel, 'DARK_TILES'),
)
const positions = computed(() =>
  positionsOf(itemStates.value, coordinates.value).map((position) => ({
    ...position,
    color: sdk.seriesColor(props.panel, position.items[0], position.index),
    label:
      position.items[0].targetName +
      (coordinates.value === 'ECEF' ? '' : ` ${position.items[0].packetName}`),
  })),
)
const locations = computed(() =>
  locationList((name) => sdk.option(props.panel, name)),
)
const legend = computed(() =>
  positions.value.map((position) => ({
    ...position,
    text: formatPosition(position),
  })),
)

// Leaflet and drawing state; none of it is rendered by Vue
let map = null
let base = null
let locationLayer = null
let resizeObserver = null
let frame = null
// position index => { marker, trail, head } Leaflet layers
let layers = {}
// position index => [[lat, lon], ...] oldest first, from the series
let trails = {}
// Where each marker is drawn while it glides to its newest point,
// { from, to, at, start, duration } per position index
let motion = {}
let lastMove = null

watch(positions, () => {
  move()
  draw()
})
watch(tiles, () => setTiles())
watch(locations, () => drawLocations())
// Re-measure after anything that can change the map's box
watch(darkTiles, () => nextTick(() => map?.invalidateSize()))

onMounted(() => {
  addLeafletCss()
  map = L.map(mapEl.value, {
    center: [0, 0],
    zoom: sdk.option(props.panel, 'ZOOM'),
    worldCopyJump: true,
    attributionControl: true,
  })
  map.on('dragstart', () => {
    following.value = false
  })
  setTiles()
  locationLayer = L.layerGroup().addTo(map)
  drawLocations()
  resizeObserver = new ResizeObserver(() => map.invalidateSize())
  resizeObserver.observe(mapEl.value.parentElement)
  move()
  draw()
})
onUnmounted(() => {
  cancelAnimationFrame(frame)
  resizeObserver?.disconnect()
  map?.remove()
  map = null
})

function setTiles() {
  if (!map) return
  base?.remove()
  if (tiles.value === 'NONE') {
    base = graticule()
  } else {
    base = L.tileLayer(tiles.value || OSM_TILES, {
      maxZoom: 19,
      attribution: tiles.value ? '' : OSM_ATTRIBUTION,
    })
  }
  base.addTo(map)
}
// Lat / lon lines every 30° for maps without tiles (no network needed)
function graticule() {
  const style = { color: 'rgba(160, 170, 180, 0.35)', weight: 1 }
  const lines = []
  for (let lat = -60; lat <= 60; lat += 30) {
    lines.push(
      L.polyline(
        [
          [lat, -540],
          [lat, 540],
        ],
        style,
      ),
    )
  }
  for (let lon = -540; lon <= 540; lon += 30) {
    lines.push(
      L.polyline(
        [
          [-85, lon],
          [85, lon],
        ],
        style,
      ),
    )
  }
  return L.layerGroup(lines)
}
// Fixed locations: a glowing dot with its name beside it
function drawLocations() {
  if (!locationLayer) return
  locationLayer.clearLayers()
  for (const location of locations.value) {
    L.circleMarker([location.lat, location.lon], {
      radius: 4,
      weight: 2,
      color: '#b8ffd6',
      fillColor: '#4dd88a',
      fillOpacity: 1,
      className: 'fixed-location',
      interactive: false,
    })
      .bindTooltip(location.name, {
        permanent: true,
        direction: 'right',
        offset: [6, 0],
        className: 'fixed-location-label',
      })
      .addTo(locationLayer)
  }
}
// Trails from the series, each lined up with its marker's longitude so the
// two meet on the same copy of the world
function updateTrails() {
  const size = trackSize(coordinates.value)
  trails = {}
  history(series, size, duration.value).forEach((track, index) => {
    let previous
    const points = track.map(({ values }) => {
      const { lat, lon } = toLatLon(values)
      previous = unwrap(previous, lon)
      return [lat, previous]
    })
    const last = points.at(-1)
    if (last) {
      const shift =
        Math.round(((motion[index]?.to[1] ?? 0) - last[1]) / 360) * 360
      if (shift) for (const point of points) point[1] += shift
    }
    trails[index] = points
  })
}
// Glide each marker to its newest point: the end of its trail, or the
// polled position when it has no trail (trails off, or nothing in range)
function move() {
  const now = performance.now()
  // Markers glide over about the time between moves
  const duration = lastMove ? Math.min(Math.max(now - lastMove, 200), 3000) : 0
  let moved = false
  for (const position of positions.value) {
    const index = position.index
    const point =
      trails[index]?.at(-1) ??
      (position.lat === null ? null : [position.lat, position.lon])
    // Nothing to show (e.g. playback before the data starts)
    if (!point) {
      delete motion[index]
      continue
    }
    const current = motion[index]
    const lon = unwrap(current?.to[1], point[1])
    if (current && current.to[0] === point[0] && current.to[1] === lon) {
      continue
    }
    // Keep longitudes within a turn of the map: after many orbits they
    // would drift into far world copies and the view would jump
    const shift = lon > 180 ? -360 : lon < -180 ? 360 : 0
    if (shift) for (const p of trails[index] || []) p[1] += shift
    const to = [point[0], lon + shift]
    const from = current ? [current.at[0], current.at[1] + shift] : to
    motion[index] = {
      from,
      to,
      at: from,
      start: now,
      duration: current ? duration : 0,
    }
    moved = true
  }
  if (!moved) return
  lastMove = now
  frame ??= requestAnimationFrame(animate)
}
function animate() {
  frame = null
  const now = performance.now()
  let moving = false
  for (const m of Object.values(motion)) {
    const t = m.duration ? Math.min(1, (now - m.start) / m.duration) : 1
    m.at = m.from.map((value, i) => value + (m.to[i] - value) * t)
    moving ||= t < 1
  }
  placeMarkers()
  if (moving) frame = requestAnimationFrame(animate)
}
// The trail up to the newest point but one; the head draws the last
// segment, out to the gliding marker
function trailLine(index) {
  return showTrail.value ? (trails[index] || []).slice(0, -1) : []
}
function headLine(index, at) {
  const previous = trails[index]?.at(-2)
  return previous && showTrail.value ? [previous, at] : []
}
// Markers and the last trail segment at their gliding positions
function placeMarkers() {
  if (!map) return
  const points = []
  for (const [index, layer] of Object.entries(layers)) {
    const at = motion[index]?.at
    if (!at || !map.hasLayer(layer.marker)) continue
    layer.marker.setLatLng(at)
    layer.head.setLatLngs(headLine(index, at))
    points.push(at)
  }
  // One position is kept centered as it moves; several are kept in view
  // when drawn (fitting them every frame would keep zooming)
  if (follow.value && following.value && points.length === 1) {
    map.panTo(points[0], { animate: false })
  }
}
function removeLayer(index) {
  const layer = layers[index]
  layer.marker.remove()
  layer.trail.remove()
  layer.head.remove()
  delete layers[index]
}
function draw() {
  if (!map) return
  const shown = []
  const indexes = new Set(positions.value.map((p) => String(p.index)))
  for (const index of Object.keys(layers)) {
    if (!indexes.has(index)) removeLayer(index)
  }
  for (const position of positions.value) {
    const index = position.index
    let layer = layers[index]
    if (!layer) {
      layer = {
        trail: L.polyline([], { weight: 2, opacity: 0.8 }).addTo(map),
        // From the newest point but one to the gliding marker
        head: L.polyline([], { weight: 2, opacity: 0.8 }).addTo(map),
        marker: L.circleMarker([0, 0], {
          radius: 7,
          weight: 2,
          fillOpacity: 0.9,
        })
          .bindTooltip('', { direction: 'top', offset: [0, -8] })
          // Looked up on click, so it follows the panel's current items
          .on('click', () => details(positions.value[index])),
      }
      layers[index] = layer
    }
    layer.trail.setStyle({ color: position.color })
    layer.head.setStyle({ color: position.color })
    layer.trail.setLatLngs(trailLine(index))
    const point = motion[index]?.at
    if (!point) {
      layer.marker.remove()
      layer.head.setLatLngs([])
      continue
    }
    layer.head.setLatLngs(headLine(index, point))
    layer.marker
      .setLatLng(point)
      .setStyle({ color: '#ffffff', fillColor: position.color })
      .setTooltipContent(`${position.label}<br>${formatPosition(position)}`)
    if (!map.hasLayer(layer.marker)) layer.marker.addTo(map)
    shown.push(point)
  }
  if (follow.value && following.value && shown.length) keepInView(shown)
}
// Center on a single position; fit several when any leaves the view
function keepInView(points) {
  if (points.length === 1) {
    map.panTo(points[0], { animate: false })
    return
  }
  const bounds = L.latLngBounds(points)
  if (!map.getBounds().contains(bounds)) {
    map.fitBounds(bounds, { padding: [24, 24], animate: false })
  }
}
function resumeFollow() {
  following.value = true
  draw()
}
function details(position) {
  if (position) showDetails(position.items[0])
}
</script>

<style scoped>
.map-panel {
  min-height: 0;
}
.map-box {
  position: relative;
  flex: 1 1 0;
  min-height: 0;
  overflow: hidden;
}
.map {
  position: absolute;
  inset: 0;
  background: rgb(var(--v-theme-surface));
  /* Leaflet panes use z-indexes up to 1000; keep them under COSMOS menus */
  isolation: isolate;
}
.dark-tiles :deep(.leaflet-tile-pane) {
  filter: invert(1) hue-rotate(180deg) brightness(0.9) contrast(0.9);
}
.map :deep(.leaflet-control-attribution) {
  background: rgba(var(--v-theme-surface), 0.7);
  color: rgba(var(--v-theme-on-surface), 0.6);
  font-size: 10px;
}
.map :deep(.leaflet-control-attribution a) {
  color: inherit;
}
.map :deep(.fixed-location) {
  filter: drop-shadow(0 0 3px #4dd88a)
    drop-shadow(0 0 8px rgba(77, 216, 138, 0.7));
}
.map :deep(.fixed-location-label) {
  background: rgba(0, 0, 0, 0.55);
  border: none;
  box-shadow: none;
  color: #b8ffd6;
  font-size: 11px;
  padding: 1px 4px;
}
.map :deep(.fixed-location-label::before) {
  display: none;
}
.legend-entry {
  color: inherit;
  cursor: pointer;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
}
</style>
