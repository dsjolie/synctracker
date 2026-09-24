// Backdrops: fragment shaders on a sphere around the listener, computed from the view
// direction alone (so they sit at infinity, like a skybox). They move with the play head
// (uNow, in rows), not the clock, so a pause freezes them, and brighten with note energy.

import * as THREE from 'three'

const COMMON = /* glsl */ `
	uniform float uNow, uPulse;
	varying vec3 vDir;
	const float TAU = 6.2831853;
	vec3 palette(float t) {
		return 0.5 + 0.5 * cos(TAU * (t + vec3(0.0, 0.33, 0.67)));
	}
`

export const BACKDROPS = [
	{
		name: 'Tunnel',
		// Rings travel toward you along the lanes (-z), one per beat.
		shader: /* glsl */ `
			void main() {
				vec3 d = normalize(vDir);
				float around = atan(d.y, d.x) / TAU;
				float depth = -d.z / max(length(d.xy), 1e-3);
				float beats = uNow / 4.0;
				float v = depth * 0.6 + beats;
				float rings = pow(0.5 + 0.5 * cos(TAU * v), 6.0);
				float twist = 0.5 + 0.5 * cos(TAU * (around * 12.0 + v * 0.5 + beats * 0.125));
				// Dark beside and below the listener (keeps the score readable), fading out far away.
				float fog = exp(-abs(depth) * 0.45) * smoothstep(0.0, 0.9, abs(depth));
				vec3 color = palette(v * 0.05 + 0.25 * cos(TAU * around) + 0.55);	// periodic in angle: no seam
				float light = (rings * 0.8 + twist * 0.25) * fog * (0.25 + uPulse * 0.5);
				gl_FragColor = vec4(color * light, 1.0);
			}
		`,
	},
	{
		name: 'Plasma',
		// The classic sum of sines, drifting a little every beat.
		shader: /* glsl */ `
			void main() {
				vec3 d = normalize(vDir);
				float t = uNow / 16.0;
				float v = sin(d.x * 4.0 + t * 2.0)
					+ sin(d.y * 5.0 - t * 1.4)
					+ sin((d.x + d.z) * 3.5 + t)
					+ sin(length(d.xz + vec2(sin(t * 0.6), cos(t * 0.8))) * 7.0 - t * 2.5);
				vec3 color = palette(v * 0.2 + t * 0.1);
				float horizon = smoothstep(-0.35, 0.25, d.y);	// darker below, where the score is
				gl_FragColor = vec4(color * horizon * (0.09 + uPulse * 0.22), 1.0);
			}
		`,
	},
	{
		name: 'Copper bars',
		// Amiga raster bars swinging above the horizon, phased by the beat.
		shader: /* glsl */ `
			void main() {
				vec3 d = normalize(vDir);
				float e = asin(clamp(d.y, -1.0, 1.0));	// elevation
				float beats = uNow / 4.0;
				vec3 color = vec3(0.0);
				for (int i = 0; i < 6; i++) {
					float fi = float(i);
					float center = 0.45 + 0.28 * sin(beats * 0.7 + fi * 0.8);
					float x = (e - center) / 0.045;
					float bar = max(1.0 - x * x, 0.0);	// bright middle, dark edges, like a copper gradient
					color = max(color, palette(fi * 0.16 + 0.05) * bar);
				}
				gl_FragColor = vec4(color * (0.3 + uPulse * 0.5), 1.0);
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
