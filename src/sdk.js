/*
# Copyright 2026 OpenC3, Inc.
# All Rights Reserved.
#
# Licensed under the MIT license. See LICENSE.md.
*/

// The Dashboards panel SDK, handed to index.js's default export when the
// Dashboards tool loads this plugin. Components read it in setup, which runs
// after that, so a module level binding is all they need.
export let sdk = null

export function setSdk(value) {
  sdk = value
}
