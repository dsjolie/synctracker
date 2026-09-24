// The song as played: the sequence of (order, pattern, row) steps, following position jumps,
// pattern breaks and pattern loops, so the score can be laid out ahead of the play head.

// Indices into a pattern cell (libopenmpt command order).
export const NOTE = 0, INSTRUMENT = 1, VOLUME_EFFECT = 2, EFFECT = 3, VOLUME = 4, PARAMETER = 5

// OpenMPT's internal effect and volume-command numbers (soundlib/modcommand.h), which is what
// libopenmpt reports regardless of the module format.
const CMD_POSITIONJUMP = 12, CMD_PATTERNBREAK = 14, CMD_MODCMDEX = 19, CMD_S3MCMDEX = 20
export const VOLCMD_VOLUME = 1

// Order-list markers: "+++" (skip) and "---" (end of song).
const PATTERN_SKIP = 0xFFFE

const MAX_STEPS = 200000	// guard against loops that never end

export function buildTimeline(song) {
	const steps = []	// {order, pattern, row}
	const index = new Map()	// "order:row" -> step indices, ascending (rows repeat in loops)
	const seen = new Set()	// rows played outside pattern loops; meeting one again = song loop
	const orders = song.orders
	const loops = Array.from(song.channels, () => ({ start: 0, count: 0 }))	// per-channel pattern loop

	let order = 0, row = 0
	while (order < orders.length && steps.length < MAX_STEPS) {
		const pattern = orders[order].pat
		if (pattern === PATTERN_SKIP) { order++; row = 0; continue }
		if (pattern >= song.patterns.length) break	// end marker or invalid pattern

		const rows = song.patterns[pattern].rows
		let next = null
		for (; row < rows.length; row++) {
			const key = `${order}:${row}`
			if (!loops.some(l => l.count > 0)) {
				if (seen.has(key)) return { steps, index }	// the song loops back here
				seen.add(key)
			}
			if (!index.has(key)) index.set(key, [])
			index.get(key).push(steps.length)
			steps.push({ order, pattern, row })

			next = rowJump(rows[row], order, row, loops)
			if (next) break
		}
		if (next && next.order === order) {
			row = next.row	// a pattern loop, or a break into the same order
			continue
		}
		if (next) ({ order, row } = next)
		else { order++; row = 0 }
		for (const l of loops) l.start = l.count = 0	// loop state does not carry across patterns
	}
	return { steps, index }
}

// Where a row sends playback next, or null to carry on. A pattern loop (E6x / SBx: x=0 marks
// the start, x>0 repeats back to it x times) wins; otherwise a pattern break alone goes to the
// next order, a position jump picks the order, and a break on the same row picks the row.
function rowJump(cells, order, row, loops) {
	let jumpOrder = null, breakRow = null, loopRow = null
	cells.forEach((cell, channel) => {
		const effect = cell[EFFECT], param = cell[PARAMETER]
		if (effect === CMD_POSITIONJUMP) jumpOrder = param
		else if (effect === CMD_PATTERNBREAK) breakRow = param
		else if ((effect === CMD_MODCMDEX && param >> 4 === 0x6) || (effect === CMD_S3MCMDEX && param >> 4 === 0xB)) {
			const times = param & 0xF, loop = loops[channel]
			if (times === 0) loop.start = row
			else if (loop.count === 0) { loop.count = times; loopRow = loop.start }
			else if (--loop.count > 0) loopRow = loop.start
		}
	})
	if (loopRow !== null) return { order, row: loopRow }
	if (jumpOrder === null && breakRow === null) return null
	return { order: jumpOrder ?? order + 1, row: breakRow ?? 0 }
}

// Every note in the timeline, sorted by step: {step, channel, note, instrument, volume 0..1}.
export function collectNotes(song, timeline) {
	const notes = []
	timeline.steps.forEach(({ pattern, row }, step) => {
		song.patterns[pattern].rows[row].forEach((cell, channel) => {
			const note = cell[NOTE]
			if (note < 1 || note > 120) return	// empty, or note off / cut / fade
			const volume = cell[VOLUME_EFFECT] === VOLCMD_VOLUME ? cell[VOLUME] / 64 : 1
			notes.push({ step, channel, note, instrument: cell[INSTRUMENT], volume })
		})
	})
	return notes
}
