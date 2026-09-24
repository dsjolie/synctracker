// Backdrops: fragment shaders on a sphere around the listener, computed from the view
// direction alone (so they sit at infinity, like a skybox). They move with the play head
// (uNow, in rows) rather than the clock, so a pause freezes them, and brighten with note
// energy. Shared controls: uFade (how far ahead of the listener depth-based backdrops fade
// out, so nothing rushes into your face), uBright, uSpreadCos (cosine of the half-angle
// around straight ahead that is lit), uSpeed and uPulseGain.

import * as THREE from 'three'

const COMMON = /* glsl */ `
	uniform float uNow, uPulse, uFade, uBright, uSpreadCos, uSpeed, uPulseGain;
	varying vec3 vDir;
	const float TAU = 6.2831853;
	#define TIME (uNow * uSpeed)
	#define PULSE (uPulse * uPulseGain)
	vec3 palette(float t) {
		return 0.5 + 0.5 * cos(TAU * (t + vec3(0.0, 0.33, 0.67)));
	}
	float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
	float hash3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
	// Lit within the spread around straight ahead (-z), soft at the edge.
	float spreadMask(vec3 d) { return smoothstep(uSpreadCos - 0.25, uSpreadCos + 0.05, -d.z); }
	// Tunnel coordinates: angle around the forward axis (0..1) and depth along it.
	vec2 tube(vec3 d) {
		return vec2(atan(d.y, d.x) / TAU, -d.z / max(length(d.xy), 1e-3));
	}
	// Fades out depth-based backdrops closer than uFade, so they end before reaching you.
	float nearFade(float depth) { return smoothstep(uFade * 0.5, uFade + 0.01, abs(depth)); }
	void emit(vec3 d, vec3 color) { gl_FragColor = vec4(color * uBright * spreadMask(d), 1.0); }
`

export const BACKDROPS = [
	{
		name: 'Tunnel',
		// Rings travel toward you along the lanes, one per beat.
		shader: /* glsl */ `
			void main() {
				vec3 d = normalize(vDir);
				vec2 t = tube(d);
				float beats = TIME / 4.0;
				float v = t.y * 0.6 + beats;
				float rings = pow(0.5 + 0.5 * cos(TAU * v), 6.0);
				float twist = 0.5 + 0.5 * cos(TAU * (t.x * 12.0 + v * 0.5 + beats * 0.125));
				float fog = exp(-abs(t.y) * 0.12) * nearFade(t.y);
				vec3 color = palette(v * 0.05 + 0.25 * cos(TAU * t.x) + 0.55);	// periodic in angle: no seam
				emit(d, color * (rings * 0.8 + twist * 0.25) * fog * (0.3 + PULSE * 0.5));
			}
		`,
	},
	{
		name: 'Starfield',
		// Warp: streaks rushing toward you out of the vanishing point, over still distant stars.
		shader: /* glsl */ `
			void main() {
				vec3 d = normalize(vDir);
				vec2 t = tube(d);
				vec2 g = vec2(t.x * 90.0, t.y * 2.0 + TIME * 0.35);
				vec2 cell = floor(g), f = fract(g);
				float h = hash(cell);
				float streak = step(0.9, h) * smoothstep(0.3, 0.0, abs(f.x - 0.5)) * smoothstep(0.5, 0.1, abs(f.y - 0.5));
				float warp = streak * nearFade(t.y) * exp(-abs(t.y) * 0.04);
				vec3 q = d * 160.0;
				vec3 c3 = floor(q);
				float far = step(0.996, hash3(c3)) * smoothstep(0.5, 0.1, length(fract(q) - 0.5));
				vec3 tint = mix(vec3(0.6, 0.75, 1.0), vec3(1.0, 0.85, 0.7), hash(cell + 7.0));
				emit(d, tint * warp * (0.6 + PULSE * 0.8) + vec3(0.7) * far * 0.6);
			}
		`,
	},
	{
		name: 'Synthwave',
		// A striped sun over neon mountains, and a grid floor scrolling toward you on the beat.
		shader: /* glsl */ `
			void main() {
				vec3 d = normalize(vDir);
				float az = atan(d.x, -d.z);	// 0 straight ahead
				float el = asin(clamp(d.y, -1.0, 1.0));
				vec3 color = mix(vec3(0.05, 0.0, 0.12), vec3(0.35, 0.05, 0.3), smoothstep(0.5, 0.0, el)) * step(0.0, el);
				// Sun, with bands cut out of its lower half that sink over time.
				vec2 s = vec2(az, el - 0.2) / 0.22;
				float r = length(s);
				float bands = step(0.0, s.y) + step(0.5, fract(s.y * 5.0 - TIME * 0.05)) * step(s.y, 0.0);
				color += mix(vec3(1.0, 0.25, 0.5), vec3(1.0, 0.85, 0.3), smoothstep(-1.0, 1.0, s.y)) * step(r, 1.0) * min(bands, 1.0) * (0.7 + PULSE * 0.4);
				color += vec3(1.0, 0.3, 0.6) * exp(-max(r - 1.0, 0.0) * 4.0) * 0.25;
				// Mountains: a ridge line of a few sines, dark with a bright edge.
				float ridge = 0.05 + 0.035 * sin(az * 7.0) + 0.02 * sin(az * 17.0 + 1.3) + 0.012 * sin(az * 41.0);
				float below = step(el, ridge) * step(0.0, el);
				color = mix(color, vec3(0.02, 0.0, 0.05), below);
				color += vec3(0.2, 0.9, 1.0) * smoothstep(0.006, 0.0, abs(el - ridge)) * step(0.0, el) * 0.8;
				// Floor grid on a plane below, fading near the listener and toward the horizon.
				if (d.y < -0.01) {
					vec2 p = d.xz * (2.0 / -d.y);
					p.y += TIME * 0.5;
					vec2 w = fwidth(p) * 1.5;
					vec2 line = smoothstep(w, vec2(0.0), abs(fract(p / 2.0 + 0.5) - 0.5) * 2.0);
					float grid = max(line.x, line.y);
					float dist = length(d.xz * (2.0 / -d.y));
					float fade = smoothstep(uFade, uFade * 2.0 + 0.01, dist) * exp(-dist * 0.02);
					color += vec3(1.0, 0.2, 0.8) * grid * fade * (0.6 + PULSE * 0.6);
				}
				emit(d, color * 0.8);
			}
		`,
	},
	{
		name: 'Kaleidoscope',
		// A six-fold mirrored pattern on a far screen ahead, turning and zooming with the beat.
		shader: /* glsl */ `
			void main() {
				vec3 d = normalize(vDir);
				vec2 uv = d.xy / max(-d.z, 0.05);
				float r = length(uv);
				float a = atan(uv.y, uv.x) + TIME * 0.01;
				float seg = TAU / 6.0;
				a = abs(mod(a, seg) - seg * 0.5);
				vec2 p = vec2(cos(a), sin(a)) * r * (2.0 + 0.4 * sin(TIME * 0.05));
				p += vec2(TIME * 0.02, 0.0);
				float v = sin(p.x * 6.0) * sin(p.y * 6.0) + 0.5 * sin(length(p) * 10.0 - TIME * 0.2);
				vec3 color = palette(v * 0.3 + r * 0.2 + TIME * 0.004) * smoothstep(0.1, 0.9, abs(v));
				float forward = smoothstep(0.0, 0.3, -d.z) * exp(-r * 0.35);
				emit(d, color * forward * (0.12 + PULSE * 0.25));
			}
		`,
	},
	{
		name: 'Nebula',
		// Soft clouds of layered noise drifting slowly, lit up by the notes.
		shader: /* glsl */ `
			float noise(vec3 p) {
				vec3 i = floor(p), f = fract(p);
				f = f * f * (3.0 - 2.0 * f);
				return mix(
					mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
					mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y),
					f.z);
			}
			void main() {
				vec3 d = normalize(vDir);
				vec3 p = d * 2.5 + vec3(0.0, 0.0, TIME * 0.004);
				float n = noise(p) * 0.5 + noise(p * 2.1 + 3.0) * 0.3 + noise(p * 4.3 + 7.0) * 0.2;
				float cloud = smoothstep(0.45, 0.8, n);
				vec3 color = mix(vec3(0.1, 0.2, 0.6), vec3(0.8, 0.2, 0.5), noise(p * 0.7 + 11.0)) * cloud;
				vec3 q = d * 200.0;
				float stars = step(0.997, hash3(floor(q))) * smoothstep(0.5, 0.1, length(fract(q) - 0.5));
				emit(d, color * (0.35 + PULSE * 0.5) + vec3(stars * 0.5));
			}
		`,
	},
	{
		name: 'Plasma',
		// The classic sum of sines, drifting a little every beat.
		shader: /* glsl */ `
			void main() {
				vec3 d = normalize(vDir);
				float t = TIME / 16.0;
				float v = sin(d.x * 4.0 + t * 2.0)
					+ sin(d.y * 5.0 - t * 1.4)
					+ sin((d.x + d.z) * 3.5 + t)
					+ sin(length(d.xz + vec2(sin(t * 0.6), cos(t * 0.8))) * 7.0 - t * 2.5);
				float horizon = smoothstep(-0.35, 0.25, d.y);	// darker below, where the score is
				emit(d, palette(v * 0.2 + t * 0.1) * horizon * (0.09 + PULSE * 0.22));
			}
		`,
	},
	{
		name: 'Copper bars',
		// Amiga raster bars swinging above the horizon, phased by the beat.
		shader: /* glsl */ `
			void main() {
				vec3 d = normalize(vDir);
				float e = asin(clamp(d.y, -1.0, 1.0));
				float beats = TIME / 4.0;
				vec3 color = vec3(0.0);
				for (int i = 0; i < 6; i++) {
					float fi = float(i);
					float x = (e - 0.45 - 0.28 * sin(beats * 0.7 + fi * 0.8)) / 0.045;
					color = max(color, palette(fi * 0.16 + 0.05) * max(1.0 - x * x, 0.0));
				}
				emit(d, color * (0.16 + PULSE * 0.3));
			}
		`,
	},
	{
		name: 'None',
		shader: /* glsl */ `
			void main() { gl_FragColor = vec4(0.02, 0.024, 0.04, 1.0); }
		`,
	},
]

export class Sky {
	constructor(uniforms) {
		this.materials = BACKDROPS.map(b => new THREE.ShaderMaterial({
			uniforms,
			side: THREE.BackSide,
			depthWrite: false,
			vertexShader: /* glsl */ `
				varying vec3 vDir;
				void main() {
					vDir = position;
					gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
				}
			`,
			fragmentShader: COMMON + b.shader,
		}))
		this.mesh = new THREE.Mesh(new THREE.SphereGeometry(60, 64, 32), this.materials[0])
		this.mesh.renderOrder = -1
		this.mesh.frustumCulled = false
	}

	set(index) {
		this.mesh.material = this.materials[index]
	}
}
