# OpenC3 COSMOS Map Panel

A 2D map panel for the COSMOS **Dashboards** tool (beta), and the sample to copy
when building your own dashboard panels as plugins.

Positions come from telemetry as latitude / longitude or as ECEF X, Y, Z, with
a trail for each. Items from several targets can share one map.

## Using it

Install the plugin, then add a **Map** panel from a dashboard's edit mode, or
write it in the dashboard file:

```
# Latitude / longitude items, one position per pair
PANEL MAP 0 0 6 8 "Rovers"
  ITEM ROVER1 GPS LATITUDE
  ITEM ROVER1 GPS LONGITUDE
  ITEM ROVER2 GPS LATITUDE
  ITEM ROVER2 GPS LONGITUDE
    ITEM_SETTING COLOR "#938bdb"
  SETTING LOCATION_1 "Mission control"
  SETTING LOCATION_1_LAT 39.75
  SETTING LOCATION_1_LON -104.99
END

# ECEF items (meters), one position per X, Y, Z; works with the COSMOS demo
PANEL MAP 0 8 8 8 "INST orbit"
  ITEM INST ADCS POSX
  ITEM INST ADCS POSY
  ITEM INST ADCS POSZ
  SETTING COORDINATES ECEF
  SETTING ZOOM 2
END
```

| Setting | Default | |
| --- | --- | --- |
| `COORDINATES` | `LATLON` | `LATLON`: items in pairs (lat, lon degrees). `ECEF`: items in threes (x, y, z meters) |
| `TRAIL` | `TRUE` | Show a trail behind each position covering the dashboard's time range (the header's **Last 15 minutes** and so on). The history is loaded when the dashboard opens or the range changes, then streamed live; during playback it's the range before the playback time |
| `FOLLOW` | `TRUE` | Keep positions in view. Dragging the map pauses it; **Follow** resumes |
| `ZOOM` | `3` | Starting zoom, 1 to 18 |
| `TILES` | blank | Blank for OpenStreetMap, `NONE` for a plain lat/lon grid (no network, for air-gapped sites), or your own `https://…/{z}/{x}/{y}.png` tile server |
| `DARK_TILES` | `TRUE` | Darken the tiles to match the COSMOS theme |
| `LOCATION_1` to `_6` | none | A fixed location's name: a ground station, site or landmark (optional, defaults to "Location 1" and so on) |
| `LOCATION_1_LAT` to `_6_LAT` | none | Its latitude in degrees, north positive |
| `LOCATION_1_LON` to `_6_LON` | none | Its longitude in degrees, east positive |

`ITEM_SETTING COLOR` on the first item of a position sets its marker and trail
color. Fixed locations are drawn once they have a latitude and a longitude,
as glowing green dots with their names; the orbit panel takes the same
settings. Clicking a marker or its legend entry opens the item details.

## Building

```
pnpm install
rake build VERSION=1.0.0
```

`rake build` runs `pnpm build` (which writes `tools/panels/MAP/MAP.js`) and
then builds `openc3-cosmos-map-panel-1.0.0.gem`. Install the gem from
Admin → Plugins.

While developing, `pnpm watch` rebuilds the bundle on every change. To try it
without reinstalling, upload `tools/panels/MAP/MAP.js` over the installed copy
in the tools bucket, or reinstall the gem.

## How a custom panel works

Use this plugin as a starting point. A panel plugin has three parts.

**1. `plugin.txt`** registers the panel type:

```
PANEL MAP
```

On install, COSMOS copies `tools/panels/MAP/MAP.js` (and its `.map`) to the
tools bucket. The Dashboards tool lists installed panels from
`/openc3-api/panels` and imports each bundle before it opens a dashboard.

**2. A SystemJS bundle** (`vite.config.js`) with `vue` and `vuetify` left
external, since COSMOS provides them. Its default export is a function that
takes the panel SDK and returns the panel type definition (`src/index.js`).
It keeps the SDK in a small module (`src/sdk.js`) for the component to use:

```js
export default (sdk) => {
  setSdk(sdk)
  return {
    category: 'Telemetry',
    label: 'Map',
    icon: 'mdi-map-marker-path',
    component: MapPanel,
    content: 'items',             // built-in editor: 'items', 'targets' or 'command'
    defaults: { w: 6, h: 8 },
    keywords: ['ITEM', 'ITEM_SETTING', 'SETTING'],
    options: [ /* SETTINGs: shown in the panel dialog, parsed and saved for you */ ],
    itemOptions: [ /* ITEM_SETTINGs */ ],
    validate: (panel) => null,    // message when the panel is incomplete
  }
}
```

Declaring an option is all it takes for it to be validated in dashboard files,
written back only when changed, and shown in the panel dialog. Option types are
`boolean`, `select`, `number`, `text`, `color` and `item`.

**3. The panel component** (`src/MapPanel.vue`), written with
`<script setup>` and the SDK's composables:

```js
import { sdk } from './sdk'

const props = defineProps({ panel: { type: Object, required: true } })
const panel = sdk.useTlmPanel(props)
const { series, duration } = sdk.useTlmSeries(props, panel, {
  seriesUpdated: () => draw(),
})
```

`sdk.useTlmPanel(props)` polls the panel's items and returns:

- `itemStates`: per item `{ item, label, number, text, units, level, stale, limits }`,
  from one shared poller (about 1 s)
- `poller.clock.tick`: increments after every poll, for sampling over time
- `showDetails(item)`: opens the item details sheet
- `isLive`: `false` while the dashboard is being edited. Telemetry keeps
  flowing, but don't send commands or run anything then
- `isPlayback` / `playbackTime`: `true` and the `Date` being shown while the
  dashboard plays back history. Polled values follow the playback time on
  their own
- the panel's status ring and header symbol, worked out from its items' limits

`sdk.useTlmSeries(props, panel, options)` keeps the items' history over the
dashboard's time range (the header's **Last 15 minutes** and so on): it loads
the range when the dashboard opens or the range changes, then streams live,
and during playback loads the range before the playback time. `series` is
`[times in seconds, then one array of values per item]`, oldest first, updated
in place; `seriesUpdated()` is called about once a second and `seriesReset()`
whenever it starts over. `seriesItems()` picks what to stream (the map streams
nothing while trails are off). The map draws its trails from it.

The SDK (`sdk.version` is `1`) also provides `option`, `itemOption`,
`seriesColor`, `formatTelemetry`, `itemKey`, `stateToLevel`, `clock`, `formatTime`, and the
components `LimitsBar`, `Sparkline` and `StatusSymbol` so custom panels match
the built-in ones.

A dashboard that uses a panel type whose plugin isn't installed still opens:
the panel shows as "not installed" and its lines are kept unchanged when the
dashboard is saved.

## License

See [LICENSE.md](LICENSE.md).
