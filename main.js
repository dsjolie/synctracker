import { ChiptuneJsPlayer } from './vendor/chiptune3/chiptune3.js'
import { buildTimeline, collectNotes, NOTE, INSTRUMENT } from './timeline.js'
import { ScoreScene, VIEWS } from './scene.js'
import { Library } from './library.js'
import { VRPanel } from './vr-panel.js'
import { SETTINGS, BY_KEY, defaults, stepValue, formatValue, load, save } from './settings.js'

const NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-']

const fileInput = document.getElementById('file')
const playButton = document.getElementById('play')
const pauseButton = document.getElementById('pause')
const titleEl = document.getElementById('title')
const statusEl = document.getElementById('status')
const rowEl = document.getElementById('row')
const libraryEl = document.getElementById('library')

const scene = new ScoreScene(document.getElementById('stage'))
const values = load()
const panel = new VRPanel(scene.renderer, scene.scene, values, onPanelAction)

let player = null
let source = null	// ArrayBuffer from a file, or a URL string
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

// --- Settings --------------------------------------------------------------------------------

// What each setting does when it changes.
const APPLY = {
	layout: v => scene.setLayout(v),
	backdrop: v => scene.setBackdrop(v),
	shape: v => scene.setShape(v),
	view: v => {
		// A view is a preset for the three stage settings.
		const preset = VIEWS[v]
		for (const key of ['distance', 'height', 'scale']) setValue(key, preset[key], false)
	},
	distance: stage, height: stage, scale: stage,
	ahead: v => scene.setAhead(v),
	spacing: v => { scene.uniforms.uSpacing.value = v },
	noteWidth: v => { scene.uniforms.uNoteWidth.value = v },
	lift: v => scene.setLiftScale(v),
	rings: v => scene.setVisible('rings', v === 1),
	beats: v => scene.setVisible('beats', v === 1),
	fade: v => { scene.uniforms.uFade.value = v },
	brightness: v => { scene.uniforms.uBright.value = v },
	spread: v => { scene.uniforms.uSpreadCos.value = Math.cos(v * Math.PI / 180) },
	speed: v => { scene.uniforms.uSpeed.value = v },
	pulse: v => { scene.uniforms.uPulseGain.value = v },
	offset: () => {},	// read by playhead()
	foveation: v => scene.setFoveation(v),
	fps: v => { if (!v) panel.set({ fps: '' }) },
	menuHeight: menu, menuDistance: menu, menuTilt: menu,
}
function stage() { scene.setStage(values.distance, values.height, values.scale) }
function menu() { panel.place(values.menuHeight, values.menuDistance, values.menuTilt) }

function setValue(key, value, persist = true) {
	values[key] = value
	APPLY[key](value)
	const control = controls[key]
	if (control) {
		control.input.value = value
		if (control.valueEl) control.valueEl.textContent = formatValue(BY_KEY[key], value)
	}
	panel.refresh()
	if (persist) save(values)
}

function stepSetting(key, dir) {
	setValue(key, stepValue(BY_KEY[key], values[key], dir))
}

function resetSettings() {
	const d = defaults()
	for (const key in d) if (key !== 'view') setValue(key, d[key], false)
	values.view = d.view
	controls.view.input.value = d.view
	save(values)
}

// Page controls, generated from the settings list: the main ones next to the transport, the
// rest in the Settings section.
const controls = {}
{
	const mainEl = document.getElementById('options')
	const settingsEl = document.getElementById('settings-body')
	for (const s of SETTINGS) {
		if (s.group) {
			const h = document.createElement('h3')
			h.textContent = s.group
			settingsEl.append(h)
			continue
		}
		const label = document.createElement('label')
		label.append(s.label + ' ')
		let input, valueEl = null
		if (s.options) {
			input = document.createElement('select')
			s.options.forEach((name, i) => input.add(new Option(name, i)))
		} else {
			input = Object.assign(document.createElement('input'), { type: 'range', min: s.min, max: s.max, step: s.step })
			valueEl = document.createElement('span')
			valueEl.className = 'value'
		}
		input.addEventListener('input', () => setValue(s.key, Number(input.value)))
		label.append(input)
		if (valueEl) label.append(valueEl)
		;(s.main ? mainEl : settingsEl).append(label)
		controls[s.key] = { input, valueEl }
	}
	document.getElementById('reset').addEventListener('click', resetSettings)
}

// Apply everything once. The view is not re-applied: the saved stage values win.
for (const s of SETTINGS) if (s.key && s.key !== 'view') setValue(s.key, values[s.key], false)
controls.view.input.value = values.view

function onPanelAction(id) {
	if (id === 'prev') library.prev()
	else if (id === 'next') library.next()
	else if (id === 'play') playPause()
	else if (id === 'hide') panel.toggle()
	else if (id === 'reset') resetSettings()
	else {
		const [, key, dir] = id.split(':')
		stepSetting(key, Number(dir))
	}
}

// --- Input -----------------------------------------------------------------------------------

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

document.getElementById('prev').addEventListener('click', () => library.prev())
document.getElementById('next').addEventListener('click', () => library.next())
pauseButton.addEventListener('click', togglePause)
addEventListener('keydown', e => {
	if (e.code === 'Space' && player && e.target.tagName !== 'INPUT') {
		e.preventDefault()
		togglePause()
	}
})

// In VR: the trigger presses the menu button it points at, and anywhere else plays and pauses.
// The grip or B/Y shows and hides the menu, A/X plays and pauses, and thumbstick flicks step
// through layouts (left/right) and backdrops (up/down). A WebXR select counts as a user
// gesture, so it may also create the AudioContext.
scene.onSelect = controller => {
	if (!panel.select(controller)) playPause()
}
scene.onSqueeze = () => panel.toggle()
scene.onGamepad = button => {
	if (button === 'a') playPause()
	else if (button === 'b') panel.toggle()
	else if (button === 'left' || button === 'right') stepSetting('layout', button === 'right' ? 1 : -1)
	else stepSetting('backdrop', button === 'down' ? 1 : -1)
}

// --- Playback --------------------------------------------------------------------------------

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

function playPause() {
	if (!source) library.next()	// nothing chosen yet: start with the first library track
	else if (!player) playButton.click()
	else if (ended) start()
	else togglePause()
}

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

// The fractional timeline step the listener is hearing now. The audio offset setting shifts
// the visuals later (positive) or earlier (negative), for matching sync by eye.
function playhead() {
	if (!rowEvents.length) return -1000
	const context = player.context
	const latency = (context.outputLatency || 0) + (context.baseLatency || 0) + values.offset / 1000
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

// --- Frame -----------------------------------------------------------------------------------

let frames = 0, fpsSince = performance.now()

scene.start(() => {
	// Frame rate, shown on the menu once a second when asked for.
	frames++
	const t = performance.now()
	if (t - fpsSince >= 1000) {
		if (values.fps) panel.set({ fps: `${Math.round(frames * 1000 / (t - fpsSince))} fps` })
		frames = 0
		fpsSince = t
	}
	panel.update(scene.controllers)
	if (!player || !timeline) return
	const now = playhead()
	scene.update(now)

	const step = Math.floor(now)
	if (step !== shownStep && step >= 0 && step < timeline.steps.length) {
		shownStep = step
		const { order, pattern, row } = timeline.steps[step]
		if (!ended) statusEl.textContent = `order ${order}  pattern ${pattern}  row ${String(row).padStart(2, '0')}`
		rowEl.textContent = song.patterns[pattern].rows[row].map(formatCell).join('  ')
		// The menu shows the order, not the row: it redraws a few times a minute, not per row.
		if (!ended) panel.set({
			position: `order ${order + 1} / ${song.orders.length}  ·  pattern ${pattern}`,
			progress: step / timeline.steps.length,
		})
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
