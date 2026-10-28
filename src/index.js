/*
# Copyright 2026 OpenC3, Inc.
# All Rights Reserved.
#
# Licensed under the MIT license. See LICENSE.md.
*/

// The MAP panel type. COSMOS Dashboards imports this module and calls the
// default export with its panel SDK; the returned object is a panel type
// definition, the same shape as the built-in ones (see panels/registry.js in
// the Dashboards tool):
//
//   PANEL MAP 0 0 6 8 "Orbit"
//     ITEM INST ADCS POSX
//     ITEM INST ADCS POSY
//     ITEM INST ADCS POSZ
//     SETTING COORDINATES ECEF
//   END

import MapPanel from './MapPanel.vue'
import { setSdk } from './sdk'
import { MAX_LOCATIONS, trackSize } from './geo'

// Fixed locations 1 to 6: a name, latitude and longitude each, one row in
// the panel dialog. A location's row shows once the one before it has
// anything in it. Incomplete locations just aren't drawn.
function locationOptions() {
  const options = []
  for (let n = 1; n <= MAX_LOCATIONS; n++) {
    const previous = `LOCATION_${n - 1}`
    const when =
      n === 1
        ? undefined
        : (get) =>
            Boolean(
              get(previous) || get(`${previous}_LAT`) || get(`${previous}_LON`),
            )
    options.push(
      {
        name: `LOCATION_${n}`,
        type: 'text',
        label: `Fixed location ${n}`,
        default: '',
        help:
          n === 1
            ? 'A ground station, site or landmark. Optional name shown on the map'
            : undefined,
        when,
      },
      {
        // Text rather than number so a location can be cleared
        name: `LOCATION_${n}_LAT`,
        type: 'text',
        label: 'Latitude (°)',
        default: '',
        help: n === 1 ? 'Degrees, north positive (-90 to 90)' : undefined,
        when,
      },
      {
        name: `LOCATION_${n}_LON`,
        type: 'text',
        label: 'Longitude (°)',
        default: '',
        help: n === 1 ? 'Degrees, east positive (-180 to 180)' : undefined,
        when,
      },
    )
  }
  return options
}

export default (sdk) => {
  // Older Dashboards have no composables. Throwing here makes Dashboards
  // report the panel as failed to load, rather than the panel breaking the
  // dashboard when it renders.
  if (
    typeof sdk?.useTlmPanel !== 'function' ||
    typeof sdk?.useTlmSeries !== 'function'
  ) {
    throw new Error(
      'needs a newer COSMOS Dashboards (panel SDK with useTlmPanel and useTlmSeries)',
    )
  }
  // The panel component reads it for its composables and helpers
  setSdk(sdk)
  return definition(sdk)
}

const definition = (sdk) => ({
  category: 'Telemetry',
  label: 'Map',
  description:
    'Positions on a 2D map with trails, from lat / lon or ECEF items',
  icon: 'mdi-map-marker-path',
  component: MapPanel,
  // Pick items with the built-in item picker
  content: 'items',
  defaults: { w: 6, h: 8 },
  keywords: ['ITEM', 'ITEM_SETTING', 'SETTING'],
  maxItems: null,
  itemOptions: [
    {
      name: 'COLOR',
      type: 'color',
      label: 'Color',
      default: null,
      help: 'Marker and trail color, set on the first item of a position',
    },
  ],
  options: [
    {
      name: 'COORDINATES',
      type: 'select',
      label: 'Items are',
      default: 'LATLON',
      items: [
        { title: 'Latitude, longitude (degrees)', value: 'LATLON' },
        { title: 'ECEF X, Y, Z (meters)', value: 'ECEF' },
      ],
      help: 'Each position is the next 2 (lat, lon) or 3 (x, y, z) items',
    },
    {
      name: 'TRAIL',
      type: 'boolean',
      label: 'Show trails',
      default: true,
      help: "History over the dashboard's time range",
    },
    {
      name: 'FOLLOW',
      type: 'boolean',
      label: 'Keep positions in view',
      default: true,
    },
    {
      name: 'ZOOM',
      type: 'number',
      label: 'Starting zoom',
      default: 3,
      min: 1,
      max: 18,
    },
    {
      name: 'TILES',
      type: 'text',
      label: 'Map tiles URL',
      default: '',
      help: 'Blank for OpenStreetMap, NONE for a plain grid (no network), or a {z}/{x}/{y} URL for your own tile server',
    },
    {
      name: 'DARK_TILES',
      type: 'boolean',
      label: 'Darken map tiles',
      default: true,
      when: (get) => get('TILES') !== 'NONE',
    },
    ...locationOptions(),
  ],
  validate: (panel) => {
    const size = trackSize(sdk.option(panel, 'COORDINATES'))
    if (!panel.items.length) return 'Add position items'
    if (panel.items.length % size) {
      return size === 2
        ? 'Add items in pairs: latitude then longitude'
        : 'Add items in threes: ECEF X, Y then Z'
    }
    return null
  },
})
