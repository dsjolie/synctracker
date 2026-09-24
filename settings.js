// Everything that can be tuned, in one list: the page's settings panel, the VR menu and the
// saved settings are all generated from it. "main" entries are also on the streamlined Play
// tab. Defaults are the current best guesses.

import { LAYOUTS, SHAPES, VIEWS } from './scene.js'
import { BACKDROPS } from './backdrops.js'

const OFF_ON = ['Off', 'On']

export const SETTINGS = [
	{ key: 'layout', label: 'Layout', options: LAYOUTS.map(l => l.name), def: 0, main: true },
	{ key: 'backdrop', label: 'Backdrop', options: BACKDROPS.map(b => b.name), def: 0, main: true },
	{ key: 'shape', label: 'Notes', options: SHAPES, def: 0, main: true },
	{ key: 'view', label: 'View', options: VIEWS.map(v => v.name), def: 0, main: true },

	{ group: 'Score' },
	{ key: 'distance', label: 'Score distance', min: 0, max: 6, step: 0.25, def: 1.5, unit: ' m' },
	{ key: 'height', label: 'Score height', min: -1, max: 1.5, step: 0.05, def: 0.35, unit: ' m' },
	{ key: 'scale', label: 'Score scale', min: 0.1, max: 2, step: 0.05, def: 0.75, unit: '×' },
	{ key: 'ahead', label: 'Rows ahead', min: 16, max: 128, step: 8, def: 48 },
	{ key: 'spacing', label: 'Row spacing', min: 0.05, max: 0.4, step: 0.01, def: 0.14, unit: ' m' },
	{ key: 'noteWidth', label: 'Note width', min: 0.2, max: 1, step: 0.05, def: 0.62, unit: '×' },
	{ key: 'lift', label: 'Pitch lift', min: 0, max: 3, step: 0.25, def: 1, unit: '×' },
	{ key: 'rings', label: 'Hit rings', options: OFF_ON, def: 1 },
	{ key: 'beats', label: 'Beat strips', options: OFF_ON, def: 1 },

	{ group: 'Backdrop' },
	{ key: 'fade', label: 'Backdrop fade', min: 0, max: 12, step: 0.5, def: 3, unit: '' },
	{ key: 'brightness', label: 'Backdrop brightness', min: 0, max: 2, step: 0.1, def: 1, unit: '×' },
	{ key: 'spread', label: 'Backdrop spread', min: 30, max: 180, step: 15, def: 120, unit: '°' },
	{ key: 'speed', label: 'Backdrop speed', min: 0, max: 4, step: 0.25, def: 1, unit: '×' },
	{ key: 'pulse', label: 'Pulse', min: 0, max: 2, step: 0.25, def: 1, unit: '×' },

	{ group: 'Sync and performance' },
	{ key: 'offset', label: 'Audio offset', min: -300, max: 300, step: 10, def: 0, unit: ' ms' },
	{ key: 'foveation', label: 'Foveation', min: 0, max: 1, step: 0.25, def: 1 },
	{ key: 'fps', label: 'Show FPS', options: OFF_ON, def: 0 },

	{ group: 'Menu' },
	{ key: 'menuHeight', label: 'Menu height', min: 0.5, max: 1.6, step: 0.05, def: 0.95, unit: ' m' },
	{ key: 'menuDistance', label: 'Menu distance', min: 0.3, max: 1.2, step: 0.05, def: 0.55, unit: ' m' },
	{ key: 'menuTilt', label: 'Menu tilt', min: 0, max: 90, step: 5, def: 35, unit: '°' },
].map(s => ({ ...s, main: s.main ?? false }))

export const ENTRIES = SETTINGS.filter(s => s.key)
export const BY_KEY = Object.fromEntries(ENTRIES.map(s => [s.key, s]))

export function defaults() {
	return Object.fromEntries(ENTRIES.map(s => [s.key, s.def]))
}

// The value one step up or down: options wrap around, numbers stop at their range.
export function stepValue(s, value, dir) {
	if (s.options) return (value + dir + s.options.length) % s.options.length
	const v = Math.round((value + dir * s.step) / s.step) * s.step
	return Math.min(s.max, Math.max(s.min, Number(v.toFixed(4))))
}

export function formatValue(s, value) {
	if (s.options) return s.options[value]
	const decimals = s.step < 0.1 ? 2 : s.step < 1 ? 1 : 0
	return value.toFixed(decimals) + (s.unit ?? '')
}

const STORAGE_KEY = 'synctracker.settings.v2'

export function load() {
	const values = defaults()
	try {
		const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
		for (const s of ENTRIES) {
			const v = saved[s.key]
			if (typeof v !== 'number') continue
			if (s.options ? Number.isInteger(v) && v >= 0 && v < s.options.length : v >= s.min && v <= s.max) values[s.key] = v
		}
	} catch { /* no storage (private window etc.): defaults */ }
	return values
}

export function save(values) {
	try { localStorage.setItem(STORAGE_KEY, JSON.stringify(values)) } catch { /* not remembered */ }
}
