// The score in space: one lane per channel, rows coming toward the play point, notes landing
// on it as you hear them. Several layouts share one GLSL function, layoutPos(rows ahead, lane);
// everything else (note orientation, lane lines, pads, beat strips, hit rings) is derived from
// it. All motion is done in the vertex shaders from one uniform (uNow, the play position in
// timeline steps), so a frame costs a few uniform updates and no buffer or texture uploads.

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { VRButton } from 'three/addons/webxr/VRButton.js'
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js'
import { Sky } from './backdrops.js'

const MAX_LANES = 64
const EYE = 1.6	// listener eye height (m) for the desktop camera

// Layouts, in the listener's frame (standing at the origin, looking down -z). lift: how far
// pitch raises a note off its lane (m); behind: rows a played note stays visible; linger:
// played notes stay put and fade (a tracker screen) instead of bursting on the play point;
// maxAhead: a cap on the rows shown ahead; focus: where the desktop camera looks.
export const LAYOUTS = [
	{ name: 'Fan', lift: 0.5, behind: 6, linger: 0, focus: [0, 1.0, -3.0] },
	{ name: 'Highway', lift: 0.5, behind: 6, linger: 0, focus: [0, 1.0, -3.2] },
	{ name: 'Wheel', lift: 0.25, behind: 6, linger: 0, focus: [0, 1.65, -2.2] },
	{ name: 'Tube', lift: 0.3, behind: 6, linger: 0, focus: [0, 1.5, -3.5] },
	{ name: 'Vortex', lift: 0.25, behind: 6, linger: 0, focus: [0, 1.5, -3.5] },
	{ name: 'Tracker', lift: 0.0, behind: 16, linger: 1, maxAhead: 24, focus: [0, 1.3, -2.0] },
]

export const SHAPES = ['Box', 'Gem', 'Ball', 'Tile', 'Text']
const TEXT_SHAPE = 4

// View presets: where the whole score is placed relative to the listener.
export const VIEWS = [
	{ name: 'In front', distance: 1.5, height: 0.35, scale: 0.75 },
	{ name: 'Around you', distance: 0, height: 0, scale: 1 },
	{ name: 'Big screen', distance: 4, height: 0.1, scale: 1.4 },
	{ name: 'Tabletop', distance: 0.6, height: 0.75, scale: 0.28 },
]

const LAYOUT_GLSL = /* glsl */ `
	uniform float uNow, uLanes, uLayout, uSpacing, uFanStep, uLift;
	const float PI = 3.14159265;

	// Where a point sits that is d rows ahead of the play head (0 = now) in lane "lane"
	// (continuous: 0.5 is halfway between lanes 0 and 1). Played rows (d < 0) stay on the play
	// point, except on the tracker wall, where they scroll on up.
	vec3 layoutPos(float d, float lane) {
		float n = max(uLanes, 1.0);
		float c = lane - (n - 1.0) * 0.5;	// lane relative to the middle
		if (uLayout > 4.5) {	// Tracker: a wall of columns, rows scrolling up past a fixed line
			return vec3(c * 0.3, 1.6 - d * 0.065, -2.0);
		}
		d = max(d, 0.0);
		if (uLayout < 0.5) {	// Fan: lanes radiate out from in front of the listener
			float a = c * uFanStep, r = 1.1 + d * uSpacing;
			return vec3(sin(a) * r, 0.75 + (r - 1.1) * 0.12, -cos(a) * r);
		}
		if (uLayout < 1.5) {	// Highway: parallel lanes running away, rising slightly
			float z = 1.1 + d * uSpacing;
			return vec3(c * 0.26, 0.75 + (z - 1.1) * 0.12, -z);
		}
		if (uLayout < 2.5) {	// Wheel: a disc, one ring per lane; rows turn down to the bottom
			float a = d * (2.0 * PI / 64.0), r = 0.5 + (lane + 0.5) / n * 1.0;
			return vec3(-sin(a) * r, 1.65 - cos(a) * r, -2.2);
		}
		if (uLayout < 3.5) {	// Tube: lanes around a ring you look through; rows come down it
			float a = lane / n * 2.0 * PI;
			return vec3(sin(a) * 0.9, 1.5 + cos(a) * 0.9, -(1.1 + d * uSpacing * 1.3));
		}
		// Vortex: a tube that narrows and twists into the distance
		float a = lane / n * 2.0 * PI + d * 0.07;
		float r = 0.9 / (1.0 + d * 0.035);
		return vec3(sin(a) * r, 1.5 + cos(a) * r, -(1.1 + d * uSpacing * 1.2));
	}

	// Unit axes at a point (across the lanes, up off the score, along time) and the distances
	// to the next lane and row.
	void layoutFrame(float d, float lane, out vec3 across, out vec3 up, out vec3 along,
			out float laneGap, out float rowGap) {
		if (uLayout < 4.5) d = max(d, 0.0);
		vec3 p = layoutPos(d, lane);
		vec3 a = layoutPos(d, lane + 0.5) - layoutPos(d, lane - 0.5);
		vec3 l = layoutPos(d + 1.0, lane) - p;
		laneGap = length(a);
		rowGap = length(l);
		across = a / laneGap;
		along = l / rowGap;
		up = normalize(cross(across, along));
	}

	const vec4 CULLED = vec4(0.0, 0.0, 2.0, 1.0);	// outside the clip volume
`

export class ScoreScene {
	constructor(container) {
		this.renderer = new THREE.WebGLRenderer({ antialias: true })
		this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
		this.renderer.setSize(innerWidth, innerHeight)
		this.renderer.xr.enabled = true
		container.appendChild(this.renderer.domElement)
		document.body.appendChild(VRButton.createButton(this.renderer))

		this.scene = new THREE.Scene()
		this.camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 100)
		this.controls = new OrbitControls(this.camera, this.renderer.domElement)
		this.controls.enableDamping = true

		this.uniforms = {
			uNow: { value: -1000 },
			uLanes: { value: 1 },
			uLayout: { value: 0 },
			uSpacing: { value: 0.14 },	// metres per row
			uFanStep: { value: THREE.MathUtils.degToRad(17) },	// angle between lanes in the fan
			uLift: { value: LAYOUTS[0].lift },
			uAhead: { value: 48 },
			uBehind: { value: 6 },
			uLinger: { value: 0 },
			uNoteWidth: { value: 0.62 },
			uShape: { value: 0 },
			uStageScale: { value: 1 },
			uAtlas: { value: makeNoteAtlas() },
			uLaneHit: { value: new Float32Array(MAX_LANES) },	// step of each lane's latest note
			uPulse: { value: 0 },	// note energy, kicked by each landing note and decaying
			// Backdrop controls (see backdrops.js)
			uFade: { value: 3 },
			uBright: { value: 1 },
			uSpreadCos: { value: -0.5 },
			uSpeed: { value: 1 },
			uPulseGain: { value: 1 },
		}

		this.sky = new Sky(this.uniforms)
		this.scene.add(this.sky.mesh)
		this.stage = new THREE.Group()	// the score, placed by the view settings
		this.scene.add(this.stage)
		this.songObjects = []
		this.lastUpdate = performance.now()
		this.layout = 0
		this.ahead = 48
		this.liftScale = 1
		this.show = { rings: true, beats: true }

		// Controllers: a ray to point with and the controller model. The app decides what the
		// trigger (select), grip (squeeze), face buttons and thumbstick do.
		this.onSelect = null	// (controller) => void
		this.onSqueeze = null
		this.onGamepad = null	// ('a' | 'b' | 'left' | 'right' | 'up' | 'down') => void
		this.controllers = []
		const models = new XRControllerModelFactory()
		const rayGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)])
		for (const i of [0, 1]) {
			const controller = this.renderer.xr.getController(i)
			controller.addEventListener('select', () => this.onSelect?.(controller))
			controller.addEventListener('squeeze', () => this.onSqueeze?.(controller))
			const ray = new THREE.Line(rayGeometry, new THREE.LineBasicMaterial({ color: 0x8fb4ff, transparent: true, opacity: 0.5 }))
			ray.name = 'ray'
			ray.scale.z = 3
			controller.add(ray)
			this.scene.add(controller)
			this.controllers.push(controller)
			const grip = this.renderer.xr.getControllerGrip(i)
			grip.add(models.createControllerModel(grip))
			this.scene.add(grip)
		}
		this.pads = new Map()	// input source -> previous button/stick state, for edges

		addEventListener('resize', () => {
			this.camera.aspect = innerWidth / innerHeight
			this.camera.updateProjectionMatrix()
			this.renderer.setSize(innerWidth, innerHeight)
		})
	}

	// --- Settings ---------------------------------------------------------------------------

	setLayout(index) {
		const l = LAYOUTS[index]
		this.layout = index
		this.uniforms.uLayout.value = index
		this.uniforms.uLift.value = l.lift * this.liftScale
		this.uniforms.uBehind.value = l.behind
		this.uniforms.uLinger.value = l.linger
		this.setAhead(this.ahead)
		this.aimCamera()
	}

	setAhead(rows) {
		this.ahead = rows
		this.uniforms.uAhead.value = Math.min(rows, LAYOUTS[this.layout].maxAhead ?? Infinity)
	}

	setLiftScale(scale) {
		this.liftScale = scale
		this.uniforms.uLift.value = LAYOUTS[this.layout].lift * scale
	}

	setShape(index) {
		this.uniforms.uShape.value = index
		if (this.noteMesh) {
			this.noteMesh.geometry.dispose()
			this.noteMesh.geometry = this.noteGeometry()
		}
	}

	setBackdrop(index) {
		this.sky.set(index)
	}

	setStage(distance, height, scale) {
		this.stage.position.set(0, height, -distance)
		this.stage.scale.setScalar(scale)
		this.stage.updateMatrixWorld()
		this.uniforms.uStageScale.value = scale
		this.aimCamera()
	}

	setVisible(part, on) {
		this.show[part] = on
		if (this[part + 'Mesh']) this[part + 'Mesh'].visible = on
	}

	setFoveation(value) {
		this.renderer.xr.setFoveation(value)
	}

	// Desktop camera: at the listener's eyes, looking at the layout's focus as placed by the view.
	aimCamera() {
		const target = this.stage.localToWorld(new THREE.Vector3().fromArray(LAYOUTS[this.layout].focus))
		this.camera.position.set(0, EYE, 0.01)
		this.controls.target.copy(target)
		this.controls.update()
	}

	// --- Song -------------------------------------------------------------------------------

	// Build the score for a song. notes: from collectNotes, sorted by step.
	setSong(timeline, notes, channelCount) {
		for (const obj of this.songObjects) {
			this.stage.remove(obj)
			obj.geometry.dispose()
		}
		this.songObjects = []

		const lanes = Math.min(channelCount, MAX_LANES)
		const u = this.uniforms
		u.uLanes.value = lanes
		u.uFanStep.value = Math.min(THREE.MathUtils.degToRad(150) / Math.max(lanes - 1, 1), THREE.MathUtils.degToRad(17))
		u.uLaneHit.value.fill(-1000)
		this.notes = notes.filter(n => n.channel < lanes)
		this.nextNote = 0
		this.noteAttributes = this.makeNoteAttributes()

		this.noteMesh = this.add(this.makeNotes())
		this.ringsMesh = this.add(this.makeRings())
		this.add(this.makeLanes(lanes))
		this.add(this.makePads(lanes))
		this.beatsMesh = this.add(this.makeBeats(timeline))
		this.ringsMesh.visible = this.show.rings
		this.beatsMesh.visible = this.show.beats
	}

	add(obj) {
		obj.frustumCulled = false	// positions are computed in the shader
		this.stage.add(obj)
		this.songObjects.push(obj)
		return obj
	}

	material(vertexShader, fragmentShader) {
		return new THREE.ShaderMaterial({
			uniforms: this.uniforms,
			vertexShader: LAYOUT_GLSL + vertexShader,
			fragmentShader,
			transparent: true,
			depthWrite: false,
			blending: THREE.AdditiveBlending,
		})
	}

	// Per-note instance data, shared by the notes and the hit rings.
	makeNoteAttributes() {
		const notes = this.notes
		let lo = Infinity, hi = -Infinity
		for (const n of notes) { lo = Math.min(lo, n.note); hi = Math.max(hi, n.note) }
		const step = new Float32Array(notes.length)
		const lane = new Float32Array(notes.length)
		const note = new Float32Array(notes.length)
		const pitch = new Float32Array(notes.length)
		const volume = new Float32Array(notes.length)
		const color = new Float32Array(notes.length * 3)
		const c = new THREE.Color()
		notes.forEach((n, i) => {
			step[i] = n.step
			lane[i] = n.channel
			note[i] = n.note
			pitch[i] = hi > lo ? (n.note - lo) / (hi - lo) : 0.5
			volume[i] = n.volume
			c.setHSL((n.instrument * 0.618034) % 1, 0.75, 0.55)
			color.set([c.r, c.g, c.b], i * 3)
		})
		return {
			aStep: new THREE.InstancedBufferAttribute(step, 1),
			aLane: new THREE.InstancedBufferAttribute(lane, 1),
			aNote: new THREE.InstancedBufferAttribute(note, 1),
			aPitch: new THREE.InstancedBufferAttribute(pitch, 1),
			aVolume: new THREE.InstancedBufferAttribute(volume, 1),
			aColor: new THREE.InstancedBufferAttribute(color, 3),
		}
	}

	instanced(base) {
		const geometry = new THREE.InstancedBufferGeometry().copy(base)
		base.dispose()
		geometry.instanceCount = this.notes.length
		for (const [name, attribute] of Object.entries(this.noteAttributes)) geometry.setAttribute(name, attribute)
		return geometry
	}

	noteGeometry() {
		const shape = this.uniforms.uShape.value
		return this.instanced(
			shape === 1 ? new THREE.OctahedronGeometry(0.6)
				: shape === 2 ? new THREE.IcosahedronGeometry(0.55, 1)
				: shape === TEXT_SHAPE ? new THREE.PlaneGeometry(1, 1)
				: new THREE.BoxGeometry(1, 1, 1))
	}

	makeNotes() {
		const material = this.material(/* glsl */ `
			uniform float uAhead, uBehind, uLinger, uNoteWidth, uShape, uStageScale;
			attribute float aStep, aLane, aNote, aPitch, aVolume;
			attribute vec3 aColor;
			varying vec3 vColor;
			varying float vShade, vNote;
			varying vec2 vUv;
			void main() {
				float d = aStep - uNow;
				if (d > uAhead || d < -uBehind) { gl_Position = CULLED; return; }
				vec3 across, up, along; float laneGap, rowGap;
				layoutFrame(d, aLane, across, up, along, laneGap, rowGap);
				float hit = d < 0.0 ? exp(d * 0.8) : 0.0;			// burst after the note plays
				float arrive = smoothstep(4.0, 0.0, d) * step(0.0, d);	// brighten on approach
				float played = d < 0.0 ? mix(hit, 0.5 * smoothstep(-uBehind, 0.0, d) + hit, uLinger) : 1.0;
				float burst = 1.0 + hit * 0.9 * (1.0 - uLinger);
				vec3 center = layoutPos(d, aLane) + up * (aPitch * uLift);
				float fade = smoothstep(uAhead, uAhead * 0.6, d) * played;
				if (uShape > 3.5) {
					// Text: the note name, facing the viewer.
					vec4 mv = modelViewMatrix * vec4(center, 1.0);
					float w = laneGap * 0.9 * uStageScale * (1.0 + hit * 0.4);
					mv.xy += position.xy * vec2(w, w * 0.25);
					gl_Position = projectionMatrix * mv;
					vShade = fade * (0.6 + arrive * 0.8 + hit * 1.5);
				} else {
					vec3 size = vec3(laneGap * uNoteWidth, 0.03 + 0.05 * aVolume, rowGap * 0.7);
					if (uShape > 0.5 && uShape < 2.5) {	// gem, ball: roughly round
						float s = min(size.x, size.z * 1.4);
						size = vec3(s, s * (0.5 + 0.5 * aVolume), s);
					}
					if (uShape > 2.5) size.y = 0.008;	// tile
					size *= burst;
					vec3 p = center + across * position.x * size.x + up * position.y * size.y + along * position.z * size.z;
					gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
					float face = 0.55 + 0.45 * max(normal.y, 0.0);	// lit from above so the shapes read as solid
					vShade = fade * face * (0.45 + 0.55 * aVolume) * (0.55 + arrive * 0.8 + hit * 2.2);
				}
				vColor = aColor;
				vNote = aNote;
				vUv = uv;
			}
		`, /* glsl */ `
			uniform float uShape;
			uniform sampler2D uAtlas;
			varying vec3 vColor;
			varying float vShade, vNote;
			varying vec2 vUv;
			void main() {
				float mask = 1.0;
				if (uShape > 3.5) {
					float col = mod(vNote, 8.0), row = floor(vNote / 8.0);
					mask = texture2D(uAtlas, vec2((col + vUv.x) / 8.0, (15.0 - row + vUv.y) / 16.0)).r * 1.6;
				}
				gl_FragColor = vec4(vColor * vShade * mask, 1.0);
			}
		`)
		return new THREE.Mesh(this.noteGeometry(), material)
	}

	// A ring expanding from each note where it lands.
	makeRings() {
		const material = this.material(/* glsl */ `
			attribute float aStep, aLane, aVolume;
			attribute vec3 aColor;
			varying vec3 vColor;
			varying vec2 vUv;
			varying float vFade;
			const float RING_ROWS = 5.0;
			void main() {
				float d = aStep - uNow;
				if (d > 0.0 || d < -RING_ROWS) { gl_Position = CULLED; return; }
				float t = -d / RING_ROWS;
				vec3 across, up, along; float laneGap, rowGap;
				layoutFrame(0.0, aLane, across, up, along, laneGap, rowGap);
				float r = laneGap * (0.3 + 1.2 * t);
				vec3 p = layoutPos(0.0, aLane) + across * position.x * r + along * position.y * r;
				gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
				vColor = aColor;
				vUv = uv;
				vFade = (1.0 - t) * (1.0 - t) * (0.4 + 0.6 * aVolume);
			}
		`, /* glsl */ `
			varying vec3 vColor;
			varying vec2 vUv;
			varying float vFade;
			void main() {
				float r = length(vUv - 0.5) * 2.0;
				float ring = smoothstep(0.75, 0.9, r) * smoothstep(1.0, 0.9, r);
				gl_FragColor = vec4(vColor * ring * vFade * 1.4, 1.0);
			}
		`)
		return new THREE.Mesh(this.instanced(new THREE.PlaneGeometry(1, 1)), material)
	}

	// A faint line down the middle of each lane, from the play point to the far end, in
	// segments so it follows curved layouts.
	makeLanes(lanes) {
		const segments = 32
		const laneIds = [], along = []
		for (let lane = 0; lane < lanes; lane++) {
			for (let i = 0; i < segments; i++) {
				laneIds.push(lane, lane)
				along.push(i / segments, (i + 1) / segments)
			}
		}
		const geometry = new THREE.BufferGeometry()
		geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(laneIds.length * 3), 3))
		geometry.setAttribute('aLane', new THREE.Float32BufferAttribute(laneIds, 1))
		geometry.setAttribute('aAlong', new THREE.Float32BufferAttribute(along, 1))
		const material = this.material(/* glsl */ `
			uniform float uAhead;
			uniform float uLaneHit[${MAX_LANES}];
			attribute float aLane, aAlong;
			varying float vShade;
			void main() {
				vec3 across, up, along; float laneGap, rowGap;
				float d = aAlong * uAhead;
				layoutFrame(d, aLane, across, up, along, laneGap, rowGap);
				vec3 p = layoutPos(d, aLane) - up * 0.005;
				gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
				float hit = exp(-(uNow - uLaneHit[int(aLane)]) * 0.6);
				vShade = (1.0 - aAlong) * (0.18 + 0.5 * hit);
			}
		`, /* glsl */ `
			varying float vShade;
			void main() { gl_FragColor = vec4(vec3(0.35, 0.55, 1.0) * vShade, 1.0); }
		`)
		return new THREE.LineSegments(geometry, material)
	}

	// A pad per lane at the play point that flashes when the lane plays a note.
	makePads(lanes) {
		const geometry = new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(1, 1))
		geometry.instanceCount = lanes
		geometry.setAttribute('aLane', new THREE.InstancedBufferAttribute(new Float32Array([...Array(lanes).keys()]), 1))
		const material = this.material(/* glsl */ `
			uniform float uLaneHit[${MAX_LANES}];
			attribute float aLane;
			varying vec2 vUv;
			varying float vHit;
			void main() {
				vec3 across, up, along; float laneGap, rowGap;
				layoutFrame(0.0, aLane, across, up, along, laneGap, rowGap);
				vec3 p = layoutPos(0.0, aLane) - up * 0.01
					+ across * position.x * laneGap * 0.8 + along * position.y * rowGap * 1.6;
				gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
				vUv = uv;
				vHit = exp(-(uNow - uLaneHit[int(aLane)]) * 0.9);
			}
		`, /* glsl */ `
			varying vec2 vUv;
			varying float vHit;
			void main() {
				vec2 q = abs(vUv - 0.5) * 2.0;
				float edge = smoothstep(0.75, 1.0, max(q.x, q.y));
				float glow = 0.12 + edge * 0.35 + vHit * (0.6 + edge * 0.6);
				gl_FragColor = vec4(vec3(0.5, 0.75, 1.0) * glow, 1.0);
			}
		`)
		return new THREE.Mesh(geometry, material)
	}

	// Strips across the lanes on every beat (4 rows), brighter on every bar (16 rows), so the
	// grid keeps moving through quiet passages.
	makeBeats(timeline) {
		const beats = []
		timeline.steps.forEach(({ row }, step) => {
			if (row % 4 === 0) beats.push(step, row % 16 === 0 ? 1 : 0.4)
		})

		// aT runs 0..1 across the lanes, position.z across the strip's width.
		const segments = 48
		const positions = [], ts = [], indices = []
		for (let i = 0; i <= segments; i++) {
			positions.push(0, 0, -0.5, 0, 0, 0.5)
			ts.push(i / segments, i / segments)
			if (i < segments) {
				const a = i * 2
				indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
			}
		}
		const geometry = new THREE.InstancedBufferGeometry()
		geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
		geometry.setAttribute('aT', new THREE.Float32BufferAttribute(ts, 1))
		geometry.setIndex(indices)
		geometry.instanceCount = beats.length / 2
		const interleaved = new THREE.InstancedInterleavedBuffer(new Float32Array(beats), 2)
		geometry.setAttribute('aStep', new THREE.InterleavedBufferAttribute(interleaved, 1, 0))
		geometry.setAttribute('aWeight', new THREE.InterleavedBufferAttribute(interleaved, 1, 1))

		const material = this.material(/* glsl */ `
			uniform float uAhead;
			attribute float aT, aStep, aWeight;
			varying float vShade;
			void main() {
				float d = aStep - uNow;
				if (d > uAhead || d < 0.0) { gl_Position = CULLED; return; }
				float lane = mix(-0.5, uLanes - 0.5, aT);
				vec3 across, up, along; float laneGap, rowGap;
				layoutFrame(d, lane, across, up, along, laneGap, rowGap);
				vec3 p = layoutPos(d, lane) - up * 0.008 + along * position.z * 0.012;
				gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
				vShade = aWeight * smoothstep(uAhead, uAhead * 0.5, d) * smoothstep(0.0, 1.5, d) * 0.22;
			}
		`, /* glsl */ `
			varying float vShade;
			void main() { gl_FragColor = vec4(vec3(0.4, 0.5, 0.9) * vShade, 1.0); }
		`)
		return new THREE.Mesh(geometry, material)
	}

	// --- Frame ------------------------------------------------------------------------------

	// Move the play head. now: fractional timeline step (what the listener hears).
	update(now) {
		const u = this.uniforms
		const t = performance.now()
		u.uPulse.value *= Math.exp(-(t - this.lastUpdate) / 1000 * 5)
		this.lastUpdate = t
		if (this.notes) {
			// Seeking backwards: rescan the lanes' latest notes from the start.
			if (now < u.uNow.value) {
				this.nextNote = 0
				u.uLaneHit.value.fill(-1000)
			}
			const notes = this.notes
			while (this.nextNote < notes.length && notes[this.nextNote].step <= now) {
				const n = notes[this.nextNote++]
				u.uLaneHit.value[n.channel] = n.step
				if (now - n.step < 1) u.uPulse.value = Math.min(u.uPulse.value + n.volume * 0.3, 1.2)
			}
		}
		u.uNow.value = now
	}

	// Face buttons (A/X, B/Y) and thumbstick flicks, as edges. Quest Touch: buttons[4] is A/X,
	// buttons[5] B/Y; axes[2], axes[3] the thumbstick.
	pollGamepads() {
		const session = this.renderer.xr.getSession()
		if (!session || !this.onGamepad) return
		for (const source of session.inputSources) {
			const pad = source.gamepad
			if (!pad) continue
			const now = {
				a: !!pad.buttons[4]?.pressed,
				b: !!pad.buttons[5]?.pressed,
				left: (pad.axes[2] ?? 0) < -0.7,
				right: (pad.axes[2] ?? 0) > 0.7,
				up: (pad.axes[3] ?? 0) < -0.7,
				down: (pad.axes[3] ?? 0) > 0.7,
			}
			const before = this.pads.get(source) ?? {}
			for (const k in now) if (now[k] && !before[k]) this.onGamepad(k)
			this.pads.set(source, now)
		}
	}

	start(frame) {
		this.renderer.setAnimationLoop(() => {
			this.pollGamepads()
			frame()
			if (!this.renderer.xr.isPresenting) this.controls.update()
			this.renderer.render(this.scene, this.camera)
		})
	}
}

// Note names (C-0 .. B-9) for the Text shape: 8 x 16 cells of 128 x 32 px, index = libopenmpt
// note value. Drawn and uploaded once.
function makeNoteAtlas() {
	const names = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-']
	const canvas = document.createElement('canvas')
	canvas.width = 1024
	canvas.height = 512
	const ctx = canvas.getContext('2d')
	ctx.fillStyle = '#fff'
	ctx.font = 'bold 28px ui-monospace, Consolas, monospace'
	ctx.textAlign = 'center'
	ctx.textBaseline = 'middle'
	for (let n = 1; n <= 120; n++) {
		const col = n % 8, row = Math.floor(n / 8)
		ctx.fillText(names[(n - 1) % 12] + Math.floor((n - 1) / 12), col * 128 + 64, row * 32 + 17)
	}
	const texture = new THREE.CanvasTexture(canvas)
	texture.anisotropy = 4
	return texture
}
