import { ChiptuneJsPlayer } from './vendor/chiptune3/chiptune3.js'
import { buildTimeline, collectNotes, NOTE, INSTRUMENT } from './timeline.js'
import { ScoreScene } from './scene.js'
import { Library } from './library.js'

const NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-']

const fileInput = document.getElementById('file')
const playButton = document.getElementById('play')
const pauseButton = document.getElementById('pause')
const titleEl = document.getElementById('title')
const statusEl = document.getElementById('status')
const rowEl = document.getElementById('row')
const libraryEl = document.getElementById('library')

const scene = new ScoreScene(document.getElementById('stage'))

let player = null
let source = null	// ArrayBuffer from a file, or a URL string from ?mod=
let sourceName = ''
let song = null
let timeline = null
let paused = false
let ended = false

// Play-position clock. libopenmpt reports where it is rendering; the listener hears that
// later by the output latency. Row changes are kept with their render time so the play head
// can be interpolated between them.
let lastPos = 0		// seconds, latest render position
let lastArrival = 0	// performance.now() when it arrived
let lastKey = ''
let rowEvents = []	// {t: render seconds when the row started, step}
let rowDuration = 0.125
let shownStep = -1

const params = new URLSearchParams(location.search)

// Clicking a track is a user gesture, so it may also create the player.
const library = new Library(document.getElementById('tree'), document.getElementById('filter'), (url, name) => {
	setSource(url, name)
	if (!player) playButton.click()
})
const libraryUrl = params.get('library') ?? '../synctracker-mods/index.json'
library.load(libraryUrl).then(n => {
	libraryEl.hidden = false
	document.getElementById('library-count').textContent = `${n} modules`
}).catch(e => console.warn('No library:', e.message))

const modParam = params.get('mod')
if (modParam) setSource(modParam, decodeURIComponent(modParam.split('/').pop()))

fileInput.addEventListener('change', async () => {
	const file = fileInput.files[0]
	if (file) setSource(await file.arrayBuffer(), file.name)
})

addEventListener('dragover', e => e.preventDefault())
addEventListener('drop', async e => {
	e.preventDefault()
	const file = e.dataTransfer.files[0]
	if (file) setSource(await file.arrayBuffer(), file.name)
})

function setSource(value, name) {
	source = value
	sourceName = name
	library.setCurrent(typeof value === 'string' ? new URL(value, location.href).href : null)
	playButton.disabled = false
	statusEl.textContent = `Ready: ${name}`
	if (player) start()	// already past the first user gesture
}

// The AudioContext must be created from a user gesture, so the player is built on first Play.
playButton.addEventListener('click', () => {
	if (player) {
		start()
		return
	}
	player = new ChiptuneJsPlayer({ repeatCount: 0 })
	player.onInitialized(start)
	player.onMetadata(onMetadata)
	player.onProgress(onProgress)
	player.onEnded(onEnded)
	player.onError(e => {
		statusEl.textContent = `Error: ${e.type}`
		console.error('chiptune3 error', e)
	})
})

pauseButton.addEventListener('click', togglePause)

// In VR the page is out of sight: the trigger plays, pauses and resumes, and replays after the
// end. A WebXR select counts as a user gesture, so it may also create the AudioContext.
scene.onSelect = () => {
	if (!source) return
	if (!player) playButton.click()
	else if (ended) start()
	else togglePause()
}
scene.onSqueeze = () => library.next()
addEventListener('keydown', e => {
	if (e.code === 'Space' && player && e.target.tagName !== 'INPUT') {
		e.preventDefault()
		togglePause()
	}
})

function togglePause() {
	if (ended) return
	paused = !paused
	player.togglePause()
	pauseButton.textContent = paused ? 'Resume' : 'Pause'
}

function start() {
	song = timeline = null
	paused = ended = false
	lastKey = ''
	rowEvents = []
	shownStep = -1
	pauseButton.textContent = 'Pause'
	pauseButton.disabled = false
	statusEl.textContent = `Loading ${sourceName}…`
	if (typeof source === 'string') player.load(source)
	else player.play(source.slice(0))	// the buffer is transferred to the worklet, keep ours for replay
}

function onMetadata(meta) {
	song = meta.song
	timeline = buildTimeline(song)
	const notes = collectNotes(song, timeline)
	scene.setSong(timeline, notes, song.channels.length)
	titleEl.textContent = meta.title || sourceName
	console.log('meta', meta)
	console.log(`"${meta.title}" — ${song.channels.length} channels, ${song.orders.length} orders, ` +
		`${song.patterns.length} patterns, ${timeline.steps.length} rows played, ` +
		`${notes.length} notes, ${meta.dur.toFixed(1)} s`)
}

function onProgress({ pos, order, row }) {
	lastPos = pos
	lastArrival = performance.now()
	const key = `${order}:${row}`
	if (key === lastKey || !timeline) return
	lastKey = key

	const steps = timeline.index.get(key)
	if (steps === undefined) {
		console.warn(`row ${key} is not in the timeline`)
		return
	}
	// A row inside a pattern loop occurs at several steps: take the first one ahead.
	const prev = rowEvents[rowEvents.length - 1]
	const step = prev ? steps.find(s => s > prev.step) : steps[0]
	// None ahead means the song looping back at its end: hold the play head there.
	if (step === undefined) return
	if (prev) {
		if (step === prev.step + 1) rowDuration = pos - prev.t
		else console.warn(`timeline jump: step ${prev.step} -> ${step} (order:row ${key})`)
	}
	rowEvents.push({ t: pos, step })
	if (rowEvents.length > 32) rowEvents.shift()
}

function onEnded() {
	if (ended) return
	ended = true
	// The worklet reports the end on every audio block until the module is dropped; left
	// running, those messages would also land after a replay and end it again.
	player.stop()
	pauseButton.disabled = true
	statusEl.textContent = `Ended — ${sourceName}`
}

// The fractional timeline step the listener is hearing now.
function playhead() {
	if (!rowEvents.length) return -1000
	const context = player.context
	const latency = (context.outputLatency || 0) + (context.baseLatency || 0)
	// Extrapolate between progress messages (they arrive every audio block while playing);
	// cap it so a pause or the end of the song freezes the play head.
	const sinceArrival = Math.min((performance.now() - lastArrival) / 1000, 0.05)
	const t = lastPos + (paused ? 0 : sinceArrival) - latency

	let i = rowEvents.length - 1
	while (i > 0 && rowEvents[i].t > t) i--
	const e = rowEvents[i]
	if (t < e.t) return e.step - (e.t - t) / rowDuration	// before the first known row
	const next = rowEvents[i + 1]
	const frac = next && next.step === e.step + 1
		? (t - e.t) / (next.t - e.t)
		: Math.min((t - e.t) / rowDuration, 0.999)
	return e.step + frac
}

scene.start(() => {
	if (!player || !timeline) return
	const now = playhead()
	scene.update(now)

	const step = Math.floor(now)
	if (step !== shownStep && step >= 0 && step < timeline.steps.length) {
		shownStep = step
		const { order, pattern, row } = timeline.steps[step]
		if (!ended) statusEl.textContent = `order ${order}  pattern ${pattern}  row ${String(row).padStart(2, '0')}`
		rowEl.textContent = song.patterns[pattern].rows[row].map(formatCell).join('  ')
	}
})

function formatCell(cell) {
	const instrument = cell[INSTRUMENT]
	return `${formatNote(cell[NOTE])} ${instrument ? String(instrument).padStart(2, '0') : '..'}`
}

// libopenmpt note values: 0 none, 1..120 C-0..B-9, 253 fade, 254 cut, 255 key off.
function formatNote(n) {
	if (n === 0) return '...'
	if (n === 255) return '==='
	if (n === 254) return '^^^'
	if (n === 253) return '~~~'
	return NOTE_NAMES[(n - 1) % 12] + Math.floor((n - 1) / 12)
}
