// The in-VR console: song info and buttons, on a panel in front of the listener at waist
// height, used by pointing a controller at it and pulling the trigger. It is a canvas texture,
// redrawn only when its content or the hovered button changes, never every frame.

import * as THREE from 'three'

const W = 1024, H = 640	// canvas pixels
const SIZE = 0.64	// panel width (m); height follows the canvas aspect

// Buttons: id, rectangle in canvas pixels, label (a function of the panel state for the
// ones that change).
const BUTTONS = [
	{ id: 'prev', x: 40, y: 210, w: 290, h: 90, label: () => 'Prev' },
	{ id: 'play', x: 367, y: 210, w: 290, h: 90, label: s => s.playing ? 'Pause' : 'Play' },
	{ id: 'next', x: 694, y: 210, w: 290, h: 90, label: () => 'Next' },
	...['layout', 'backdrop', 'view'].flatMap((kind, i) => {
		const y = 330 + i * 100
		return [
			{ id: `${kind}-1`, x: 290, y, w: 100, h: 80, label: () => '◀' },
			{ id: `${kind}+1`, x: 884, y, w: 100, h: 80, label: () => '▶' },
		]
	}),
]
const OPTION_ROWS = [['layout', 'Layout'], ['backdrop', 'Backdrop'], ['view', 'View']]

export class VRPanel {
	// onButton(id): 'prev' | 'play' | 'next' | '<kind>-1' | '<kind>+1'
	constructor(renderer, scene, onButton) {
		this.onButton = onButton
		this.state = { title: '', track: '', position: '', progress: 0, playing: false, layout: '', backdrop: '', view: '' }
		this.hover = null
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
		// Tilted up toward the listener, below the line of sight to the score.
		this.mesh.position.set(0, 0.95, -0.55)
		this.mesh.rotation.x = -0.65
		this.mesh.visible = false
		scene.add(this.mesh)
		this.raycaster = new THREE.Raycaster()
		this.dirty = true

		renderer.xr.addEventListener('sessionstart', () => { this.mesh.visible = true })
		renderer.xr.addEventListener('sessionend', () => { this.mesh.visible = false })
	}

	set(values) {
		for (const [k, v] of Object.entries(values)) {
			if (this.state[k] !== v) {
				this.state[k] = v
				this.dirty = true
			}
		}
	}

	toggle() {
		this.mesh.visible = !this.mesh.visible
	}

	// The button a controller points at, and the distance to the panel, or null.
	pointed(controller) {
		if (!this.mesh.visible) return null
		this.raycaster.setFromXRController(controller)
		const hit = this.raycaster.intersectObject(this.mesh)[0]
		if (!hit) return null
		const x = hit.uv.x * W, y = (1 - hit.uv.y) * H
		const button = BUTTONS.find(b => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h)
		return { button: button?.id ?? null, distance: hit.distance }
	}

	// Trigger pulled: press the button pointed at. Returns whether the panel took it.
	select(controller) {
		const p = this.pointed(controller)
		if (!p) return false
		if (p.button) this.onButton(p.button)
		return true
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
		const ctx = this.ctx, s = this.state
		ctx.clearRect(0, 0, W, H)
		roundRect(ctx, 0, 0, W, H, 28, 'rgba(10, 12, 22, 0.88)')
		ctx.textBaseline = 'middle'

		ctx.fillStyle = '#ffffff'
		ctx.font = 'bold 46px system-ui, sans-serif'
		ctx.fillText(fit(ctx, s.title || 'SyncTracker', W - 80), 40, 55)
		ctx.fillStyle = '#9aa7c7'
		ctx.font = '32px system-ui, sans-serif'
		ctx.fillText(fit(ctx, s.track, W - 80), 40, 108)
		ctx.fillText(fit(ctx, s.position, W - 80), 40, 152)
		roundRect(ctx, 40, 180, W - 80, 8, 4, '#1b2238')
		roundRect(ctx, 40, 180, (W - 80) * s.progress, 8, 4, '#6f9cff')

		for (const b of BUTTONS) {
			roundRect(ctx, b.x, b.y, b.w, b.h, 16, b.id === this.hover ? '#34467a' : '#1b2238')
			ctx.fillStyle = '#e6ecff'
			ctx.font = 'bold 40px system-ui, sans-serif'
			ctx.textAlign = 'center'
			ctx.fillText(b.label(s), b.x + b.w / 2, b.y + b.h / 2)
			ctx.textAlign = 'left'
		}
		OPTION_ROWS.forEach(([kind, label], i) => {
			const y = 330 + i * 100 + 40
			ctx.fillStyle = '#9aa7c7'
			ctx.font = '36px system-ui, sans-serif'
			ctx.fillText(label, 40, y)
			ctx.fillStyle = '#ffffff'
			ctx.font = 'bold 40px system-ui, sans-serif'
			ctx.textAlign = 'center'
			ctx.fillText(s[kind], (390 + 884) / 2, y)
			ctx.textAlign = 'left'
		})

		this.texture.needsUpdate = true
		this.dirty = false
	}
}

function roundRect(ctx, x, y, w, h, r, fill) {
	ctx.fillStyle = fill
	ctx.beginPath()
	ctx.roundRect(x, y, w, h, r)
	ctx.fill()
}

// Truncate text with an ellipsis to fit a width.
function fit(ctx, text, width) {
	if (ctx.measureText(text).width <= width) return text
	while (text.length > 1 && ctx.measureText(text + '…').width > width) text = text.slice(0, -1)
	return text + '…'
}
