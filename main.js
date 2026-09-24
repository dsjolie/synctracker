import { ChiptuneJsPlayer } from './vendor/chiptune3/chiptune3.js'
import { buildTimeline, collectNotes, NOTE, INSTRUMENT } from './timeline.js'
import { ScoreScene, LAYOUTS, BACKDROPS, VIEWS } from './scene.js'
import { Library } from './library.js'
import { VRPanel } from './vr-panel.js'

const NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-']

const fileInput = document.getElementById('file')
const playButton = document.getElementById('play')
const pauseButton = document.getElementById('pause')
const titleEl = document.getElementById('title')
const statusEl = document.getElementById('status')
const rowEl = document.getElementById('row')
const libraryEl = document.getElementById('library')

const scene = new ScoreScene(document.getElementById('stage'))
const panel = new VRPanel(scene.renderer, scene.scene, onPanelButton)

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

// Visualization choices, shared by the page's selects and the VR panel, and remembered in
// this browser.
const OPTIONS = { layout: LAYOUTS, backdrop: BACKDROPS, view: VIEWS }
const SETTINGS_KEY = 'synctracker.settings'
const settings = { layout: 0, backdrop: 0, view: 0 }
try {
	const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}')
	for (const kind in OPTIONS) {
		if (Number.isInteger(saved[kind]) && OPTIONS[kind][saved[kind]]) settings[kind] = saved[kind]
	}
} catch { /* no storage (private window etc.): defaults */ }

const selects = {}
for (const kind in OPTIONS) {
	const select = document.getElementById(kind)
	OPTIONS[kind].forEach((option, i) => select.add(new Option(option.name, i)))
	select.addEventListener('change', () => choose(kind, Number(select.value)))
	selects[kind] = select
}
applySettings()

function choose(kind, index) {
	settings[kind] = index
	applySettings()
	try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)) } catch { /* not remembered */ }
}

function applySettings() {
	scene.setLayout(settings.layout)
	scene.setBackdrop(settings.backdrop)
	scene.setView(settings.view)
	for (const kind in OPTIONS) {
		selects[kind].value = settings[kind]
		panel.set({ [kind]: OPTIONS[kind][settings[kind]].name })
	}
}

function onPanelButton(id) {
	if (id === 'prev') library.prev()
	else if (id === 'next') library.next()
	else if (id === 'play') playPause()
	else {
		const [, kind, dir] = /^(\w+)([+-]1)$/.exec(id)
		const n = OPTIONS[kind].length
		choose(kind, (settings[kind] + Number(dir) + n) % n)
	}
}

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

document.getElementById('prev').addEventListener('click', () => library.prev())
document.getElementById('next').addEventListener('click', () => library.next())

function setSource(value, name) {
	source = value
	sourceName = name
	panel.set({ track: name, title: '', position: 'Ready', progress: 0 })
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

// In VR the trigger presses the panel button it points at; pointed anywhere else it plays,
// pauses and resumes, and replays after the end. The grip shows or hides the panel. A WebXR
// select counts as a user gesture, so it may also create the AudioContext.
scene.onSelect = controller => {
	if (!panel.select(controller)) playPause()
}
scene.onSqueeze = () => panel.toggle()

function playPause() {
	if (!source) library.next()	// nothing chosen yet: start with the first library track
	else if (!player) playButton.click()
	else if (ended) start()
	else togglePause()
}
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
	panel.set({ playing: !paused })
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
	panel.set({ playing: true, position: 'Loading…', progress: 0 })
	if (typeof source === 'string') player.load(source)
	else player.play(source.slice(0))	// the buffer is transferred to the worklet, keep ours for replay
}

function onMetadata(meta) {
	song = meta.song
	timeline = buildTimeline(song)
	const notes = collectNotes(song, timeline)
	scene.setSong(timeline, notes, song.channels.length)
	titleEl.textContent = meta.title || sourceName
	panel.set({ title: meta.title || sourceName })
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
	panel.set({ playing: false, position: 'Ended', progress: 1 })
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
	panel.update(scene.controllers)
	if (!player || !timeline) return
	const now = playhead()
	scene.update(now)

	const step = Math.floor(now)
	if (step !== shownStep && step >= 0 && step < timeline.steps.length) {
		shownStep = step
		const { order, pattern, row } = timeline.steps[step]
		if (!ended) statusEl.textContent = `order ${order}  pattern ${pattern}  row ${String(row).padStart(2, '0')}`
		// The panel shows the order, not the row: it redraws a few times a minute, not per row.
		if (!ended) panel.set({
			position: `order ${order + 1} / ${song.orders.length}  ·  pattern ${pattern}`,
			progress: step / timeline.steps.length,
		})
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
