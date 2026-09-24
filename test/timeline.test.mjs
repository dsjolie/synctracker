// Checks buildTimeline against what libopenmpt actually plays: renders each module at full
// speed and compares the sequence of (order, row) positions with the predicted timeline.
//
//   node test/timeline.test.mjs ../mods/*.s3m ../mods/*.xm ...
//
// Modules are not in the repo (see .gitignore); pass paths to local copies.

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import libopenmptPromise from '../vendor/chiptune3/libopenmpt.worklet.js'
import { buildTimeline } from '../timeline.js'

const lib = await libopenmptPromise()

// The song structure as chiptune3's worklet reports it (getSong), minus names.
function readSong(mod) {
	const channels = lib._openmpt_module_get_num_channels(mod)
	const orders = []
	for (let i = 0, n = lib._openmpt_module_get_num_orders(mod); i < n; i++) {
		orders.push({ pat: lib._openmpt_module_get_order_pattern(mod, i) })
	}
	const patterns = []
	for (let p = 0, n = lib._openmpt_module_get_num_patterns(mod); p < n; p++) {
		const rows = []
		for (let r = 0, rn = lib._openmpt_module_get_pattern_num_rows(mod, p); r < rn; r++) {
			const row = []
			for (let c = 0; c < channels; c++) {
				const cell = []
				for (let k = 0; k < 6; k++) cell.push(lib._openmpt_module_get_pattern_row_channel_command(mod, p, r, c, k))
				row.push(cell)
			}
			rows.push(row)
		}
		patterns.push({ rows })
	}
	return { channels: new Array(channels), orders, patterns }
}

// Every distinct (order, row) libopenmpt passes through, rendering once through the song.
function playedRows(mod) {
	const frames = 64	// small, so even the shortest rows are seen
	const left = lib._malloc(4 * frames), right = lib._malloc(4 * frames)
	lib._openmpt_module_set_repeat_count(mod, 0)
	const keys = []
	let last = ''
	while (lib._openmpt_module_read_float_stereo(mod, 48000, frames, left, right) > 0) {
		const key = `${lib._openmpt_module_get_current_order(mod)}:${lib._openmpt_module_get_current_row(mod)}`
		if (key !== last) keys.push(key)
		last = key
	}
	lib._free(left)
	lib._free(right)
	return keys
}

let failures = 0
for (const path of process.argv.slice(2)) {
	const bytes = readFileSync(path)
	const ptr = lib._malloc(bytes.length)
	lib.HEAPU8.set(bytes, ptr)
	const mod = lib._openmpt_module_create_from_memory(ptr, bytes.length, 0, 0, 0)
	lib._free(ptr)
	if (!mod) {
		console.log(`FAIL ${basename(path)}: libopenmpt could not load it`)
		failures++
		continue
	}

	const timeline = buildTimeline(readSong(mod))
	const predicted = timeline.steps.map(s => `${s.order}:${s.row}`)
	const played = playedRows(mod)
	lib._openmpt_module_destroy(mod)
	// At the end libopenmpt steps to where the song would loop back to, which is the row the
	// timeline stopped at.
	if (timeline.index.has(played.at(-1)) && played.length === predicted.length + 1) played.pop()

	const mismatch = played.findIndex((key, i) => key !== predicted[i])
	const name = basename(path)
	if (mismatch === -1 && played.length === predicted.length) {
		console.log(`ok   ${name}: ${played.length} rows`)
	} else {
		failures++
		const at = mismatch === -1 ? Math.min(played.length, predicted.length) : mismatch
		console.log(`FAIL ${name}: diverges at step ${at} of ${played.length} played / ${predicted.length} predicted`)
		console.log(`     played    ${played.slice(Math.max(0, at - 3), at + 4).join(' ')}`)
		console.log(`     predicted ${predicted.slice(Math.max(0, at - 3), at + 4).join(' ')}`)
	}
}
process.exit(failures ? 1 : 0)
