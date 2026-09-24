// The score in space: one lane per channel, fanned out in front of the listener. Rows come
// toward you along the lanes and land on the "now" arc. All motion is done in the vertex
// shaders from one uniform (uNow, the play position in timeline steps), so a frame costs a
// few uniform updates and no buffer or texture uploads.

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { VRButton } from 'three/addons/webxr/VRButton.js'

const LAYOUT = {
	near: 1.1,		// radius of the now arc (m)
	spacing: 0.14,	// metres per row
	ahead: 48,		// rows shown before they play
	behind: 6,		// rows a note lingers on the now arc after playing
	base: 0.75,		// height of the now arc (m, above the floor)
	ramp: 0.12,		// the lanes rise by this much per metre of distance
	pitchHeight: 0.5,	// height range for pitch (m)
	maxSpan: THREE.MathUtils.degToRad(150),
	laneAngle: THREE.MathUtils.degToRad(17),
}

const MAX_LANES = 64

// Shared by all score shaders: place a point given its step, lane and height above the lane.
const PLACE = /* glsl */ `
	uniform float uNow, uNear, uSpacing, uBase, uRamp, uSpan, uLanes;
	float laneAngle(float lane) {
		return uLanes > 1.0 ? (lane / (uLanes - 1.0) - 0.5) * uSpan : 0.0;
	}
	float radiusFor(float d) { return uNear + max(d, 0.0) * uSpacing; }
	// local: offset in the lane's frame (x across, y up, z toward the listener)
	vec3 place(vec3 local, float angle, float r, float lift) {
		float c = cos(angle), s = sin(angle);
		vec3 p = vec3(local.x * c - local.z * s, local.y, local.x * s + local.z * c);
		return p + vec3(s * r, uBase + (r - uNear) * uRamp + lift, -c * r);
	}
`

export class ScoreScene {
	constructor(container) {
		this.renderer = new THREE.WebGLRenderer({ antialias: true })
		this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
		this.renderer.setSize(innerWidth, innerHeight)
		this.renderer.xr.enabled = true
		container.appendChild(this.renderer.domElement)
		document.body.appendChild(VRButton.createButton(this.renderer))
		this.onSelect = null	// controller trigger, set by the app
		this.onSqueeze = null	// controller grip

		this.scene = new THREE.Scene()
		this.scene.background = new THREE.Color(0x05060a)

		// Flat view: behind and above the listener, looking down the lanes. In VR the headset
		// pose replaces this and the listener stands at the origin.
		this.camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 100)
		this.camera.position.set(0, 2.3, 2.4)
		this.controls = new OrbitControls(this.camera, this.renderer.domElement)
		this.controls.target.set(0, 0.9, -2.6)
		this.controls.enableDamping = true
		this.controls.update()

		this.uniforms = {
			uNow: { value: -1000 },
			uNear: { value: LAYOUT.near },
			uSpacing: { value: LAYOUT.spacing },
			uBase: { value: LAYOUT.base },
			uRamp: { value: LAYOUT.ramp },
			uSpan: { value: 0 },
			uLanes: { value: 1 },
			uAhead: { value: LAYOUT.ahead },
			uBehind: { value: LAYOUT.behind },
			uPitchHeight: { value: LAYOUT.pitchHeight },
			uLaneWidth: { value: LAYOUT.laneAngle },	// angle between lanes (rad)
			uLaneHit: { value: new Float32Array(MAX_LANES) },	// step of each lane's latest note
			uPulse: { value: 0 },	// note energy, kicked by each landing note and decaying
		}
		this.songObjects = []
		this.lastUpdate = performance.now()
		this.scene.add(this.makeTunnel())
		for (const i of [0, 1]) {
			const controller = this.renderer.xr.getController(i)
			controller.addEventListener('select', () => this.onSelect?.())
			controller.addEventListener('squeeze', () => this.onSqueeze?.())
			this.scene.add(controller)
		}

		addEventListener('resize', () => {
			this.camera.aspect = innerWidth / innerHeight
			this.camera.updateProjectionMatrix()
			this.renderer.setSize(innerWidth, innerHeight)
		})
	}

	// Build the score for a song. notes: from collectNotes, sorted by step.
	setSong(timeline, notes, channelCount) {
		for (const obj of this.songObjects) {
			this.scene.remove(obj)
			obj.geometry.dispose()
		}
		this.songObjects = []

		const lanes = Math.min(channelCount, MAX_LANES)
		this.uniforms.uLanes.value = lanes
		this.uniforms.uSpan.value = Math.min(LAYOUT.maxSpan, (lanes - 1) * LAYOUT.laneAngle)
		this.uniforms.uLaneHit.value.fill(-1000)
		this.notes = notes.filter(n => n.channel < lanes)
		this.nextNote = 0
		this.uniforms.uLaneWidth.value = Math.min(LAYOUT.maxSpan / Math.max(lanes - 1, 1), LAYOUT.laneAngle)

		this.add(this.makeNotes())
		this.add(this.makeLanes(lanes))
		this.add(this.makePads(lanes))
		this.add(this.makeBeats(timeline))
	}

	add(obj) {
		obj.frustumCulled = false	// positions are computed in the shader
		this.scene.add(obj)
		this.songObjects.push(obj)
	}

	material(vertexShader, fragmentShader) {
		return new THREE.ShaderMaterial({
			uniforms: this.uniforms,
			vertexShader, fragmentShader,
			transparent: true,
			depthWrite: false,
			blending: THREE.AdditiveBlending,
		})
	}

	makeNotes() {
		const notes = this.notes
		const pitches = notes.map(n => n.note)
		const lo = Math.min(...pitches), hi = Math.max(...pitches)
		const step = new Float32Array(notes.length)
		const lane = new Float32Array(notes.length)
		const pitch = new Float32Array(notes.length)
		const volume = new Float32Array(notes.length)
		const color = new Float32Array(notes.length * 3)
		const c = new THREE.Color()
		notes.forEach((n, i) => {
			step[i] = n.step
			lane[i] = n.channel
			pitch[i] = hi > lo ? (n.note - lo) / (hi - lo) : 0.5
			volume[i] = n.volume
			c.setHSL((n.instrument * 0.618034) % 1, 0.75, 0.55)
			color.set([c.r, c.g, c.b], i * 3)
		})

		const geometry = new THREE.InstancedBufferGeometry().copy(new THREE.BoxGeometry(1, 1, 1))
		geometry.instanceCount = notes.length
		geometry.setAttribute('aStep', new THREE.InstancedBufferAttribute(step, 1))
		geometry.setAttribute('aLane', new THREE.InstancedBufferAttribute(lane, 1))
		geometry.setAttribute('aPitch', new THREE.InstancedBufferAttribute(pitch, 1))
		geometry.setAttribute('aVolume', new THREE.InstancedBufferAttribute(volume, 1))
		geometry.setAttribute('aColor', new THREE.InstancedBufferAttribute(color, 3))

		const material = this.material(PLACE + /* glsl */ `
			uniform float uAhead, uBehind, uPitchHeight;
			uniform float uLaneWidth;
			attribute float aStep, aLane, aPitch, aVolume;
			attribute vec3 aColor;
			varying vec3 vColor;
			varying float vShade;
			void main() {
				float d = aStep - uNow;
				if (d > uAhead || d < -uBehind) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
				float angle = laneAngle(aLane);
				float r = radiusFor(d);
				float hit = d < 0.0 ? exp(d * 0.8) : 0.0;			// burst after the note plays
				float arrive = smoothstep(4.0, 0.0, d) * step(0.0, d);	// brighten on approach
				float width = r * uLaneWidth * 0.62;
				vec3 size = vec3(width, 0.03 + 0.05 * aVolume, uSpacing * 0.7);
				size *= 1.0 + hit * 0.9;
				vec3 p = place(position * size, angle, r, aPitch * uPitchHeight);
				gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
				float fade = smoothstep(uAhead, uAhead * 0.6, d) * (d < 0.0 ? hit : 1.0);
				// Box faces: lighten the top so the notes read as solid.
				float face = normal.y > 0.5 ? 1.0 : 0.55;
				vShade = fade * face * (0.45 + 0.55 * aVolume) * (0.55 + arrive * 0.8 + hit * 2.2);
				vColor = aColor;
			}
		`, /* glsl */ `
			varying vec3 vColor;
			varying float vShade;
			void main() { gl_FragColor = vec4(vColor * vShade, 1.0); }
		`)
		return new THREE.Mesh(geometry, material)
	}

	// A faint line down the middle of each lane, from the now arc to the far end.
	makeLanes(lanes) {
		const positions = [], laneIds = [], along = []
		for (let lane = 0; lane < lanes; lane++) {
			positions.push(0, 0, 0, 0, 0, 0)
			laneIds.push(lane, lane)
			along.push(0, 1)
		}
		const geometry = new THREE.BufferGeometry()
		geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
		geometry.setAttribute('aLane', new THREE.Float32BufferAttribute(laneIds, 1))
		geometry.setAttribute('aAlong', new THREE.Float32BufferAttribute(along, 1))
		const material = this.material(PLACE + /* glsl */ `
			uniform float uAhead;
			uniform float uLaneHit[${MAX_LANES}];
			attribute float aLane, aAlong;
			varying float vShade;
			void main() {
				float r = radiusFor(aAlong * uAhead);
				vec3 p = place(vec3(0.0), laneAngle(aLane), r, -0.005);
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

	// A pad per lane on the now arc that flashes when the lane plays a note.
	makePads(lanes) {
		const geometry = new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2))
		geometry.instanceCount = lanes
		geometry.setAttribute('aLane', new THREE.InstancedBufferAttribute(new Float32Array([...Array(lanes).keys()]), 1))
		const material = this.material(PLACE + /* glsl */ `
			uniform float uLaneWidth;
			uniform float uLaneHit[${MAX_LANES}];
			attribute float aLane;
			varying vec2 vUv;
			varying float vHit;
			void main() {
				vec3 size = vec3(uNear * uLaneWidth * 0.8, 1.0, uSpacing * 1.6);
				vec3 p = place(position * size, laneAngle(aLane), uNear, -0.01);
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

	// Arcs across the lanes on every beat (4 rows), brighter on every bar (16 rows), so the
	// grid keeps moving through quiet passages.
	makeBeats(timeline) {
		const beats = []
		timeline.steps.forEach(({ row }, step) => {
			if (row % 4 === 0) beats.push(step, row % 16 === 0 ? 1 : 0.4)
		})
		const beatData = new Float32Array(beats)

		// A strip across the arc: aT runs 0..1 along the arc, position.z across its width.
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
		const interleaved = new THREE.InstancedInterleavedBuffer(beatData, 2)
		geometry.setAttribute('aStep', new THREE.InterleavedBufferAttribute(interleaved, 1, 0))
		geometry.setAttribute('aWeight', new THREE.InterleavedBufferAttribute(interleaved, 1, 1))

		const material = this.material(PLACE + /* glsl */ `
			uniform float uAhead, uLaneWidth;
			attribute float aT, aStep, aWeight;
			varying float vShade;
			void main() {
				float d = aStep - uNow;
				if (d > uAhead || d < 0.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
				float r = radiusFor(d);
				float halfSpan = uLanes > 1.0 ? uSpan * 0.5 + uLaneWidth * 0.5 : uLaneWidth * 0.5;
				float angle = mix(-halfSpan, halfSpan, aT);
				vec3 p = place(vec3(0.0, 0.0, position.z * 0.012), angle, r, -0.008);
				gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
				vShade = aWeight * smoothstep(uAhead, uAhead * 0.5, d) * smoothstep(0.0, 1.5, d) * 0.22;
			}
		`, /* glsl */ `
			varying float vShade;
			void main() { gl_FragColor = vec4(vec3(0.4, 0.5, 0.9) * vShade, 1.0); }
		`)
		return new THREE.Mesh(geometry, material)
	}

	// The backdrop: a demoscene tunnel on a sphere around the listener, computed from the view
	// direction alone (so it sits at infinity, like a skybox). Its rings travel toward you
	// with the play head, one per beat, and it brightens with note energy.
	makeTunnel() {
		const material = new THREE.ShaderMaterial({
			uniforms: this.uniforms,
			side: THREE.BackSide,
			depthWrite: false,
			vertexShader: /* glsl */ `
				varying vec3 vDir;
				void main() {
					vDir = position;
					gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
				}
			`,
			fragmentShader: /* glsl */ `
				uniform float uNow, uPulse;
				varying vec3 vDir;
				const float TAU = 6.2831853;
				vec3 palette(float t) {
					return 0.5 + 0.5 * cos(TAU * (t + vec3(0.0, 0.33, 0.67)));
				}
				void main() {
					vec3 d = normalize(vDir);
					// Tunnel along the lanes (-z): angle around the axis, and depth along it.
					float around = atan(d.y, d.x) / TAU;
					float depth = -d.z / max(length(d.xy), 1e-3);
					float beats = uNow / 4.0;
					float v = depth * 0.6 + beats;
					float rings = pow(0.5 + 0.5 * cos(TAU * v), 6.0);
					float twist = 0.5 + 0.5 * cos(TAU * (around * 12.0 + v * 0.5 + beats * 0.125));
					// Dark beside and below the listener (keeps the lanes readable), fading out far away.
					float fog = exp(-abs(depth) * 0.45) * smoothstep(0.0, 0.9, abs(depth));
					vec3 color = palette(v * 0.05 + 0.25 * cos(TAU * around) + 0.55);	// periodic in angle: no seam
					float light = (rings * 0.8 + twist * 0.25) * fog * (0.25 + uPulse * 0.5);
					gl_FragColor = vec4(color * light, 1.0);
				}
			`,
		})
		const sky = new THREE.Mesh(new THREE.SphereGeometry(60, 64, 32), material)
		sky.renderOrder = -1
		sky.frustumCulled = false
		return sky
	}

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

	start(frame) {
		this.renderer.setAnimationLoop(() => {
			frame()
			this.controls.update()
			this.renderer.render(this.scene, this.camera)
		})
	}
}
