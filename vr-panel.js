// The in-VR menu: a panel in front of the listener, used by pointing a controller at it and
// pulling the trigger. Tabs: Play (song info, transport and the main choices), Library (pick
// a track, folder by folder) and Settings (every setting, a page at a time). It is a canvas
// texture, redrawn only when its content or the hovered button changes, never every frame.

import * as THREE from 'three'
import { SETTINGS, formatValue } from './settings.js'
import { count } from './library.js'

const W = 1024, H = 800	// canvas pixels
const SIZE = 0.64	// panel width (m); height follows the canvas aspect
const ROW_H = 92
const ROWS_PER_PAGE = 5
const LIST_TOP = 172	// first row of the Settings and Library lists

// Settings pages: each group's entries, a page at a time. {group, entries}
const ENTRY_PAGES = []
let group = ''
for (const s of SETTINGS) {
	if (s.group) { group = s.group; continue }
	if (s.main) continue
	const last = ENTRY_PAGES.at(-1)
	if (!last || last.group !== group || last.entries.length === ROWS_PER_PAGE) ENTRY_PAGES.push({ group, entries: [s] })
	else last.entries.push(s)
}
const MAIN = SETTINGS.filter(s => s.main)

export class VRPanel {
	// onAction(id): 'prev' | 'play' | 'next' | 'hide' | 'exit' | 'reset' | 'set:<key>:<+1|-1>'
	constructor(renderer, scene, values, onAction) {
		this.values = values	// the live settings object
		this.onAction = onAction
		this.library = null	// set by the app
		this.info = { title: '', track: '', position: '', progress: 0, playing: false, fps: '' }
		this.tab = 'play'
		this.page = 0	// Settings page
		this.folders = []	// Library: the open folder's path from the root
		this.libPage = 0
		this.hover = null
		this.buttons = []
		this.canvas = document.createElement('canvas')
		this.canvas.width = W
		this.canvas.height = H
		this.ctx = this.canvas.getContext('2d')
		this.texture = new THREE.CanvasTexture(this.canvas)
		this.texture.colorSpace = THREE.SRGBColorSpace
		this.mesh = new THREE.Mesh(
			new THREE.PlaneGeometry(SIZE, SIZE * H / W),
			new THREE.MeshBasicMaterial({ map: this.texture, transparent: true }),
		)
		this.mesh.visible = false
		scene.add(this.mesh)
		this.raycaster = new THREE.Raycaster()
		this.dirty = true

		renderer.xr.addEventListener('sessionstart', () => { this.mesh.visible = true })
		renderer.xr.addEventListener('sessionend', () => { this.mesh.visible = false })
	}

	place(height, distance, tiltDegrees) {
		this.mesh.position.set(0, height, -distance)
		this.mesh.rotation.x = -THREE.MathUtils.degToRad(tiltDegrees)
		this.mesh.updateMatrixWorld()
	}

	set(info) {
		for (const [k, v] of Object.entries(info)) {
			if (this.info[k] !== v) {
				this.info[k] = v
				this.dirty = true
			}
		}
	}

	refresh() { this.dirty = true }	// settings or the library changed

	toggle() {
		this.mesh.visible = !this.mesh.visible
		this.dirty = true
	}

	// The button a controller points at, and the distance to the panel, or null.
	pointed(controller) {
		if (!this.mesh.visible) return null
		this.raycaster.setFromXRController(controller)
		const hit = this.raycaster.intersectObject(this.mesh)[0]
		if (!hit) return null
		const x = hit.uv.x * W, y = (1 - hit.uv.y) * H
		const button = this.buttons.find(b => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h)
		return { button: button?.id ?? null, distance: hit.distance }
	}

	// Trigger pulled: press the button pointed at. Returns whether the panel took it.
	select(controller) {
		const p = this.pointed(controller)
		if (!p) return false
		if (p.button) this.press(p.button)
		return true
	}

	press(id) {
		const [kind, arg] = id.split(':')
		if (kind === 'tab') {
			this.tab = arg
			if (arg === 'library') this.openCurrentFolder()
		} else if (kind === 'page') {
			this.page = (this.page + Number(arg) + ENTRY_PAGES.length) % ENTRY_PAGES.length
		} else if (kind === 'libpage') {
			const pages = this.libraryPages()
			this.libPage = (this.libPage + Number(arg) + pages) % pages
		} else if (id === 'lib:up') {
			this.folders.pop()
			this.libPage = 0
		} else if (kind === 'lib') {
			const item = this.libraryItems()[Number(arg)]
			if (item.dir) {
				this.folders.push(item.dir)
				this.libPage = 0
			} else {
				this.library.pick(item.file)
			}
		} else {
			this.onAction(id)
		}
		this.dirty = true
	}

	// Per frame: ray lengths and hover. Redraws (a texture upload) only when something changed.
	update(controllers) {
		let hover = null
		for (const c of controllers) {
			const p = this.pointed(c)
			c.getObjectByName('ray').scale.z = p ? p.distance : 3
			if (p?.button) hover = p.button
		}
		if (hover !== this.hover) {
			this.hover = hover
			this.dirty = true
		}
		if (this.dirty && this.mesh.visible) this.draw()
	}

	draw() {
		const ctx = this.ctx
		this.buttons = []
		ctx.clearRect(0, 0, W, H)
		roundRect(ctx, 0, 0, W, H, 28, 'rgba(10, 12, 22, 0.9)')
		ctx.textBaseline = 'middle'

		this.button('tab:play', 30, 24, 160, 70, 'Play', this.tab === 'play')
		this.button('tab:library', 200, 24, 200, 70, 'Library', this.tab === 'library')
		this.button('tab:settings', 410, 24, 210, 70, 'Settings', this.tab === 'settings')
		this.button('hide', 654, 24, 150, 70, 'Hide')
		this.button('exit', 814, 24, 180, 70, 'Exit VR')

		if (this.tab === 'play') this.drawPlay()
		else if (this.tab === 'library') this.drawLibrary()
		else this.drawSettings()

		this.texture.needsUpdate = true
		this.dirty = false
	}

	drawPlay() {
		const s = this.info
		const titleWidth = W - 80 - (s.fps ? 150 : 0)
		this.text(fit(this.ctx, s.title || 'SyncTracker', titleWidth, 'bold 44px system-ui, sans-serif'), 40, 140, '#fff', 'bold 44px')
		if (s.fps) this.text(s.fps, W - 40, 140, '#9aa7c7', '32px', 'right')
		this.text(fit(this.ctx, [s.track, s.position].filter(Boolean).join('   ·   '), W - 80, '30px system-ui, sans-serif'), 40, 192, '#9aa7c7', '30px')
		roundRect(this.ctx, 40, 222, W - 80, 8, 4, '#1b2238')
		roundRect(this.ctx, 40, 222, (W - 80) * s.progress, 8, 4, '#6f9cff')
		this.button('prev', 40, 252, 290, 88, 'Prev')
		this.button('play', 367, 252, 290, 88, s.playing ? 'Pause' : 'Play')
		this.button('next', 694, 252, 290, 88, 'Next')
		MAIN.forEach((setting, i) => this.settingRow(setting, 370 + i * ROW_H))
	}

	// Library: the open folder's subfolders, then its tracks.
	libraryItems() {
		const folder = this.folders.at(-1) ?? this.library?.tree
		if (!folder) return []
		return [...folder.dirs.map(dir => ({ dir })), ...folder.files.map(file => ({ file }))]
	}

	libraryPages() {
		return Math.max(1, Math.ceil(this.libraryItems().length / ROWS_PER_PAGE))
	}

	// Open the folder holding the playing track, at its page.
	openCurrentFolder() {
		const lib = this.library
		if (!lib?.tree) return
		this.folders = lib.current ? lib.folderPath(lib.current) : []
		const i = this.libraryItems().findIndex(item => item.file && lib.urlOf(item.file) === lib.current)
		this.libPage = i === -1 ? 0 : Math.floor(i / ROWS_PER_PAGE)
	}

	drawLibrary() {
		const lib = this.library
		if (!lib?.tree) {
			this.text('No library loaded', 40, 140, '#9aa7c7', '32px')
			return
		}
		const path = ['Library', ...this.folders.map(f => f.name)].join(' / ')
		this.text(fit(this.ctx, path, W - 280, 'bold 32px system-ui, sans-serif'), 40, 140, '#6f9cff', 'bold 32px')
		if (this.folders.length) this.button('lib:up', W - 200, 108, 160, 60, 'Up')
		const items = this.libraryItems()
		const first = this.libPage * ROWS_PER_PAGE
		items.slice(first, first + ROWS_PER_PAGE).forEach((item, i) => {
			const y = LIST_TOP + 14 + i * ROW_H
			const label = item.dir ? `${item.dir.name}/   (${count(item.dir)})` : item.file.name
			const playing = !!item.file && lib.urlOf(item.file) === lib.current
			this.button(`lib:${first + i}`, 40, y, W - 80, 76, fit(this.ctx, label, W - 140, 'bold 34px system-ui, sans-serif'),
				playing, 'left', item.dir ? '#9ec0ff' : playing ? '#8f8' : '#e6ecff')
		})
		this.pager('libpage', this.libPage, this.libraryPages())
	}

	drawSettings() {
		const page = ENTRY_PAGES[this.page]
		this.text(page.group, 40, 140, '#6f9cff', 'bold 32px')
		page.entries.forEach((setting, i) => this.settingRow(setting, LIST_TOP + i * ROW_H))
		this.pager('page', this.page, ENTRY_PAGES.length)
		this.button('reset', W - 330, H - 96, 290, 72, 'Reset all')
	}

	pager(id, page, pages) {
		const y = H - 96
		this.button(`${id}:-1`, 40, y, 110, 72, '◀')
		this.text(`Page ${page + 1} / ${pages}`, 280, y + 36, '#9aa7c7', '32px', 'center')
		this.button(`${id}:+1`, 410, y, 110, 72, '▶')
	}

	// Label, ◀, value, ▶ for one setting.
	settingRow(setting, y) {
		this.text(setting.label, 40, y + 38, '#9aa7c7', '32px')
		this.button(`set:${setting.key}:-1`, 420, y, 100, 76, '◀')
		this.text(formatValue(setting, this.values[setting.key]), (520 + 884) / 2, y + 38, '#fff', 'bold 36px', 'center')
		this.button(`set:${setting.key}:+1`, 884, y, 100, 76, '▶')
	}

	button(id, x, y, w, h, label, active = false, align = 'center', color = null) {
		this.buttons.push({ id, x, y, w, h })
		roundRect(this.ctx, x, y, w, h, 16, id === this.hover ? '#34467a' : active ? '#2a3a66' : '#1b2238')
		const tx = align === 'center' ? x + w / 2 : x + 24
		this.text(label, tx, y + h / 2, color ?? (active ? '#fff' : '#e6ecff'), 'bold 34px', align)
	}

	text(text, x, y, color, size, align = 'left') {
		const ctx = this.ctx
		ctx.fillStyle = color
		ctx.font = `${size} system-ui, sans-serif`
		ctx.textAlign = align
		ctx.fillText(text, x, y)
		ctx.textAlign = 'left'
	}
}

function roundRect(ctx, x, y, w, h, r, fill) {
	ctx.fillStyle = fill
	ctx.beginPath()
	ctx.roundRect(x, y, w, h, r)
	ctx.fill()
}

// Truncate text with an ellipsis to fit a width, in the given font.
function fit(ctx, text, width, font) {
	ctx.font = font
	if (ctx.measureText(text).width <= width) return text
	while (text.length > 1 && ctx.measureText(text + '…').width > width) text = text.slice(0, -1)
	return text + '…'
}
