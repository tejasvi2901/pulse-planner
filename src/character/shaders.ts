import { Effect } from '@babylonjs/core'

/*
 * 3D simplex noise by Ian McEwan and Stefan Gustavson (Ashima Arts / webgl-noise).
 * MIT licence: https://github.com/ashima/webgl-noise
 */
const SIMPLEX_NOISE = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`

const BODY_VERTEX = /* glsl */ `
precision highp float;

attribute vec3 position;
attribute vec3 normal;

uniform mat4 world;
uniform mat4 worldViewProjection;
uniform float noisePhase;
uniform float noiseAmp;
uniform float noiseFreq;
uniform vec3 faceDir;

varying vec3 vPositionW;
varying vec3 vNormalW;
varying vec3 vLocal;
varying float vNoise;

${SIMPLEX_NOISE}

void main() {
  vec3 dir = normalize(position);
  float n = snoise(position * noiseFreq + vec3(0.0, noisePhase, noisePhase * 0.6));
  // Keep the skin calm where the eyes sit, so they never sink into the surface.
  float faceCalm = 1.0 - 0.85 * smoothstep(0.78, 0.97, dot(dir, faceDir));
  vec3 displaced = position + normal * n * noiseAmp * faceCalm;

  vec4 worldPos = world * vec4(displaced, 1.0);
  vPositionW = worldPos.xyz;
  vNormalW = normalize(mat3(world) * normal);
  vLocal = position;
  vNoise = n;
  gl_Position = worldViewProjection * vec4(displaced, 1.0);
}
`

const BODY_FRAGMENT = /* glsl */ `
precision highp float;

varying vec3 vPositionW;
varying vec3 vNormalW;
varying vec3 vLocal;
varying float vNoise;

uniform vec3 cameraPosition;
uniform vec3 coreColor;
uniform vec3 rimColor;
uniform float glow;
uniform float pulse;
uniform float swirlPhase;
uniform float swirlAmount;

void main() {
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vPositionW);
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float fresnel = pow(1.0 - ndv, 3.0);

  // Inward-flowing spiral around the facing axis. As the phase grows, the arms flow to the centre.
  vec2 q = vLocal.xy;
  float r = length(q);
  float a = atan(q.y, q.x);
  float arms = sin(a * 3.0 + r * 9.0 + swirlPhase);
  float swirl = smoothstep(0.25, 1.0, arms) * smoothstep(1.0, 0.1, r) * swirlAmount;

  // Soft key light from the upper left, wrapped so the shadow side never goes black.
  vec3 L = normalize(vec3(-0.45, 0.75, -0.5));
  float wrap = clamp(dot(N, L) * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(coreColor * 0.32, coreColor * 0.95, wrap);
  col = mix(col, rimColor, clamp(vNoise * 0.12 + 0.05, 0.0, 1.0)); // subtle marbling
  col += coreColor * pow(ndv, 4.0) * 0.18; // gel-like inner light facing the viewer
  col += rimColor * swirl * 0.45;

  vec3 H = normalize(L + V);
  float spec = pow(clamp(dot(N, H), 0.0, 1.0), 56.0) * 0.4;

  col += rimColor * fresnel * (0.45 + glow * 0.6);
  col += rimColor * pulse * 0.15;
  col += spec;
  gl_FragColor = vec4(col, 1.0);
}
`

/** Soft pool of light on the floor. It shrinks and fades as the body rises. */
const GROUND_VERTEX = /* glsl */ `
precision highp float;
attribute vec3 position;
uniform mat4 worldViewProjection;
varying vec2 vPos;
void main() {
  vPos = position.xy;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}
`

const GROUND_FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 vPos;
uniform vec3 color;
uniform float intensity;
uniform float radius;
void main() {
  float r = length(vPos) / radius;
  float a = pow(1.0 - smoothstep(0.0, 1.0, r), 2.2) * intensity;
  gl_FragColor = vec4(color, a);
}
`

/** Large backdrop behind the character, tinted with the state's colour. */
const BACKDROP_FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 vPos;
uniform vec3 color;
uniform vec3 baseColor;
uniform float intensity;
uniform float radius;
void main() {
  float r = length(vPos) / radius;
  float a = pow(1.0 - smoothstep(0.0, 1.0, r), 1.6) * intensity;
  gl_FragColor = vec4(mix(baseColor, color, a), 1.0);
}
`

let registered = false

export function registerShaders() {
  if (registered) return
  Effect.ShadersStore.pulseBodyVertexShader = BODY_VERTEX
  Effect.ShadersStore.pulseBodyFragmentShader = BODY_FRAGMENT
  Effect.ShadersStore.pulseGroundVertexShader = GROUND_VERTEX
  Effect.ShadersStore.pulseGroundFragmentShader = GROUND_FRAGMENT
  Effect.ShadersStore.pulseBackdropVertexShader = GROUND_VERTEX
  Effect.ShadersStore.pulseBackdropFragmentShader = BACKDROP_FRAGMENT
  registered = true
}
