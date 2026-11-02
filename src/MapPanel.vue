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
// The one world everything is drawn on
const WORLD = [
  [-90, -180],
  [90, 180],
]

// Trail widths in CSS pixels at the marker: a bright line over a soft glow
const TRAIL_PX = 2.5
const TRAIL_GLOW_PX = 7
const TRAIL_GLOW_OPACITY = 0.25
// How dim the oldest end of a trail gets (0 to 1)
const TRAIL_TAIL = 0.15
// How thin the oldest end gets, as a share of the width at the marker
const TRAIL_TAIL_WIDTH = 0.2
// Steps of the fade: each is one stroke on the canvas
const TRAIL_BANDS = 24
// Points closer than this on screen to the last one drawn are skipped, so a
// long or dense trail costs what its on-screen length does
const TRAIL_STEP_PX = 1.5

// Leaflet's stylesheet travels inside this bundle; add it once per page
function addLeafletCss() {
  if (document.getElementById('openc3-map-panel-leaflet')) return
  const style = document.createElement('style')
  style.id = 'openc3-map-panel-leaflet'
  style.textContent = leafletCss
  document.head.appendChild(style)
}

// Keep a track continuous across the antimeridian (179° -> -179° becomes
// 179° -> 181°) so it can be split cleanly where it crosses (wrapRuns)
function unwrap(previous, lon) {
  if (previous === undefined) return lon
  while (lon - previous > 180) lon -= 360
  while (lon - previous < -180) lon += 360
  return lon
}

// Any longitude to -180..180
function wrapLon(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180
}

// Which copy of the world a continuous longitude is on (0 is -180..180)
function worldOf(lon) {
  return Math.floor((lon + 180) / 360)
}

// Points [lat, lon] with continuous longitudes (unwrap) and an age each, as
// runs of [lat, lon, age] on the one world: a run ends at the edge where the
// track crosses the antimeridian and the next starts at the other edge.
function wrapRuns(points, ages) {
  const runs = []
  let run = null
  let previousWorld = null
  points.forEach(([lat, lon], i) => {
    const world = worldOf(lon)
    if (run && world !== previousWorld) {
      const [lat0, lon0] = points[i - 1]
      const edge = -180 + 360 * Math.max(world, previousWorld)
      const t = (edge - lon0) / (lon - lon0)
      const edgeLat = lat0 + (lat - lat0) * t
      const edgeAge = ages[i - 1] + (ages[i] - ages[i - 1]) * t
      run.push([edgeLat, edge - 360 * previousWorld, edgeAge])
      run = [[edgeLat, edge - 360 * world, edgeAge]]
      runs.push(run)
    }
    if (!run) {
      run = []
      runs.push(run)
    }
    run.push([lat, lon - 360 * world, ages[i]])
    previousWorld = world
  })
  return runs
}

// One run of a trail, fading and thinning toward its oldest end. Each band
// of age is one path, so a trail is at most TRAIL_BANDS strokes.
function strokeRun(context, run, project, width, opacity) {
  let last = null
  let band = -1
  const stroke = () => {
    const age = (band + 1) / TRAIL_BANDS
    context.lineWidth =
      width * (TRAIL_TAIL_WIDTH + (1 - TRAIL_TAIL_WIDTH) * age)
    context.globalAlpha =
      opacity * (TRAIL_TAIL + (1 - TRAIL_TAIL) * Math.pow(age, 0.8))
    context.stroke()
  }
  context.beginPath()
  run.forEach(([lat, lon, age], i) => {
    const point = project(lat, lon)
    if (
      last &&
      i < run.length - 1 &&
      Math.abs(point.x - last.x) + Math.abs(point.y - last.y) < TRAIL_STEP_PX
    ) {
      return
    }
    const next = Math.min(TRAIL_BANDS - 1, Math.floor(age * TRAIL_BANDS))
    if (!last) {
      context.moveTo(point.x, point.y)
    } else {
      if (next !== band && band >= 0) {
        stroke()
        context.beginPath()
        context.moveTo(last.x, last.y)
      }
      context.lineTo(point.x, point.y)
    }
    band = next
    last = point
  })
  if (last && band >= 0) stroke()
}

// Every trail on one canvas over the map: thousands of points stay quick
// to move, pan and zoom, where a Leaflet polyline per segment wouldn't.
// `draw(context, project)` paints them; render() at most once a frame.
const TrailCanvas = L.Layer.extend({
  initialize(draw, options) {
    L.setOptions(this, options)
    this.draw = draw
    this.frame = null
  },
  onAdd(map) {
    // Hidden while Leaflet animates a zoom, then redrawn at the new zoom
    this.canvas = L.DomUtil.create('canvas', 'map-trails leaflet-zoom-hide')
    this.getPane().appendChild(this.canvas)
    map.on('move zoomend viewreset resize', this.redraw, this)
    this.render()
  },
  onRemove(map) {
    map.off('move zoomend viewreset resize', this.redraw, this)
    cancelAnimationFrame(this.frame)
    this.frame = null
    this.canvas.remove()
  },
  redraw() {
    this.frame ??= requestAnimationFrame(() => this.render())
  },
  render() {
    cancelAnimationFrame(this.frame)
    this.frame = null
    const map = this._map
    if (!map) return
    const size = map.getSize()
    const ratio = window.devicePixelRatio || 1
    const canvas = this.canvas
    const width = Math.round(size.x * ratio)
    const height = Math.round(size.y * ratio)
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
      canvas.style.width = `${size.x}px`
      canvas.style.height = `${size.y}px`
    }
    // The pane moves with the map; keep the canvas over the view
    L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]))
    const context = canvas.getContext('2d')
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, size.x, size.y)
    context.lineCap = 'round'
    context.lineJoin = 'round'
    this.draw(context, (lat, lon) => map.latLngToContainerPoint([lat, lon]))
  },
})

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
let trailCanvas = null
let resizeObserver = null
let frame = null
// position index => circle marker
let markers = {}
// position index => [[lat, lon], ...] oldest first, from the series, with
// continuous longitudes (unwrap) lined up with the marker's
let trails = {}
// position index => the trail but its newest point as runs on the one world
// (wrapRuns), ready to draw every frame
let trailRuns = {}
// Where each marker is drawn while it glides to its newest point,
// { from, to, at, start, duration } per position index, with continuous
// longitudes like the trails
let motion = {}
let lastMove = null

watch(positions, () => {
  move()
  draw()
})
watch(showTrail, () => trailCanvas?.redraw())
watch(tiles, () => setTiles())
watch(locations, () => drawLocations())
// Re-measure after anything that can change the map's box
watch(darkTiles, () => nextTick(() => map?.invalidateSize()))

onMounted(() => {
  addLeafletCss()
  map = L.map(mapEl.value, {
    center: [0, 0],
    zoom: sdk.option(props.panel, 'ZOOM'),
    // One world: no copies to either side for a track to run onto
    maxBounds: WORLD,
    maxBoundsViscosity: 1,
    attributionControl: true,
  })
  map.on('dragstart', () => {
    following.value = false
  })
  setTiles()
  // Under the markers and locations (overlayPane is 400)
  map.createPane('trails').style.zIndex = 390
  trailCanvas = new TrailCanvas(drawTrails, { pane: 'trails' }).addTo(map)
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
  trailCanvas = null
})

function setTiles() {
  if (!map) return
  base?.remove()
  if (tiles.value === 'NONE') {
    base = graticule()
  } else {
    base = L.tileLayer(tiles.value || OSM_TILES, {
      maxZoom: 19,
      noWrap: true,
      bounds: WORLD,
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
          [lat, -180],
          [lat, 180],
        ],
        style,
      ),
    )
  }
  for (let lon = -180; lon <= 180; lon += 30) {
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
    L.circleMarker([location.lat, wrapLon(location.lon)], {
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
// head segment meets the marker without a jump
function updateTrails() {
  const size = trackSize(coordinates.value)
  trails = {}
  trailRuns = {}
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
        Math.round(((motion[index]?.to[1] ?? last[1]) - last[1]) / 360) * 360
      if (shift) for (const point of points) point[1] += shift
    }
    trails[index] = points
    // Age 0 at the oldest point, 1 at the newest (where the marker heads)
    const n = points.length
    const shown = points.slice(0, -1)
    trailRuns[index] = wrapRuns(
      shown,
      shown.map((_, i) => i / (n - 1)),
    )
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
    const to = [point[0], unwrap(current?.to[1], point[1])]
    if (current && current.to[0] === to[0] && current.to[1] === to[1]) {
      continue
    }
    const from = current ? current.at : to
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
// Where a marker is drawn: its gliding position on the one world
function markerPoint(index) {
  const at = motion[index]?.at
  return at ? [at[0], wrapLon(at[1])] : null
}
// Each trail, then its last segment out to the gliding marker
function drawTrails(context, project) {
  if (!showTrail.value) return
  for (const position of positions.value) {
    const index = position.index
    const trail = trails[index]
    if (!trail) continue
    const runs = [...(trailRuns[index] || [])]
    const previous = trail.at(-2)
    const at = motion[index]?.at
    if (previous && at) {
      runs.push(
        ...wrapRuns(
          [previous, at],
          [(trail.length - 2) / (trail.length - 1), 1],
        ),
      )
    }
    context.strokeStyle = position.color
    for (const run of runs) {
      strokeRun(context, run, project, TRAIL_GLOW_PX, TRAIL_GLOW_OPACITY)
      strokeRun(context, run, project, TRAIL_PX, 1)
    }
  }
}
// Markers and the trails' last segments at their gliding positions
function placeMarkers() {
  if (!map) return
  const points = []
  for (const [index, marker] of Object.entries(markers)) {
    const point = markerPoint(index)
    if (!point || !map.hasLayer(marker)) continue
    marker.setLatLng(point)
    points.push(point)
  }
  // One position is kept centered as it moves; several are kept in view
  // when drawn (fitting them every frame would keep zooming)
  if (follow.value && following.value && points.length === 1) {
    map.panTo(points[0], { animate: false })
  }
  // Now, not next frame, so the head stays on the marker
  trailCanvas?.render()
}
function draw() {
  if (!map) return
  const shown = []
  const indexes = new Set(positions.value.map((p) => String(p.index)))
  for (const index of Object.keys(markers)) {
    if (!indexes.has(index)) {
      markers[index].remove()
      delete markers[index]
    }
  }
  for (const position of positions.value) {
    const index = position.index
    const marker = (markers[index] ??= L.circleMarker([0, 0], {
      radius: 7,
      weight: 2,
      fillOpacity: 0.9,
    })
      .bindTooltip('', { direction: 'top', offset: [0, -8] })
      // Looked up on click, so it follows the panel's current items
      .on('click', () => details(positions.value[index])))
    const point = markerPoint(index)
    if (!point) {
      marker.remove()
      continue
    }
    marker
      .setLatLng(point)
      .setStyle({ color: '#ffffff', fillColor: position.color })
      .setTooltipContent(`${position.label}<br>${formatPosition(position)}`)
    if (!map.hasLayer(marker)) marker.addTo(map)
    shown.push(point)
  }
  if (follow.value && following.value && shown.length) keepInView(shown)
  trailCanvas?.redraw()
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
.map :deep(.map-trails) {
  pointer-events: none;
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
