import { ChiptuneJsPlayer } from './vendor/chiptune3/chiptune3.js'

// Indices into a pattern cell, as chiptune3 returns them (libopenmpt command order).
const NOTE = 0, INSTRUMENT = 1

const NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-']

const fileInput = document.getElementById('file')
const playButton = document.getElementById('play')
const pauseButton = document.getElementById('pause')
const statusEl = document.getElementById('status')
const rowEl = document.getElementById('row')

let player = null
let source = null	// ArrayBuffer from the file picker, or a URL string from ?mod=
let song = null
let lastRowKey = ''

const modParam = new URLSearchParams(location.search).get('mod')
if (modParam) {
	source = modParam
	playButton.disabled = false
	statusEl.textContent = `Ready: ${modParam}`
}

fileInput.addEventListener('change', async () => {
	const file = fileInput.files[0]
	if (!file) return
	source = await file.arrayBuffer()
	playButton.disabled = false
	statusEl.textContent = `Ready: ${file.name}`
})

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
	player.onEnded(() => { statusEl.textContent += ' — ended' })
	player.onError(e => {
		statusEl.textContent = `Error: ${e.type}`
		console.error('chiptune3 error', e)
	})
})

pauseButton.addEventListener('click', () => player.togglePause())

function start() {
	lastRowKey = ''
	if (typeof source === 'string') player.load(source)
	else player.play(source.slice(0))	// the buffer is transferred to the worklet, keep ours for replay
	pauseButton.disabled = false
}

function onMetadata(meta) {
	song = meta.song
	console.log('meta', meta)
	console.log(`"${meta.title}" — ${song.channels.length} channels, ${song.orders.length} orders, ` +
		`${song.patterns.length} patterns, ${meta.dur.toFixed(1)} s`)
}

function onProgress({ order, pattern, row }) {
	const key = `${order}:${row}`
	if (key === lastRowKey) return
	lastRowKey = key

	const cells = song.patterns[pattern].rows[row]
	const text = cells.map(formatCell).join(' | ')
	statusEl.textContent = `order ${order}  pattern ${pattern}  row ${row}`
	rowEl.textContent = text
	console.log(`${order}:${pattern}:${row}`, text)
}

function formatCell(cell) {
	const note = cell[NOTE]
	const instrument = cell[INSTRUMENT]
	return `${formatNote(note)} ${instrument ? String(instrument).padStart(2, '0') : '..'}`
}

// libopenmpt note values: 0 none, 1..120 C-0..B-9, 253 fade, 254 cut, 255 key off.
function formatNote(n) {
	if (n === 0) return '...'
	if (n === 255) return '==='
	if (n === 254) return '^^^'
	if (n === 253) return '~~~'
	return NOTE_NAMES[(n - 1) % 12] + Math.floor((n - 1) / 12)
}
