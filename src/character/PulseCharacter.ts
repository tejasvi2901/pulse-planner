import {
  Color3,
  Color4,
  GlowLayer,
  Matrix,
  Mesh,
  MeshBuilder,
  Scene,
  ShaderMaterial,
  StandardMaterial,
  TrailMesh,
  TransformNode,
  Vector3,
} from '@babylonjs/core'

import { PULSE_STATES, type PulseState } from '../machine/pulseMachine'
import { PROFILES, springFor, type MotionKey } from './motionProfiles'
import { registerShaders } from './shaders'
import { Spring } from './spring'

export const BACKGROUND = Color3.FromHexString('#070b16')

const MOTION_KEYS = Object.keys(PROFILES.idle.motion) as MotionKey[]
const MAX_ORBITERS = 8
const BLINK_DURATION = 0.16
const EYE_SPREAD = 0.29 // radians either side of centre
const EYE_HEIGHT = 0.16 // radians above the equator
const GROUND_Y = -1.32
const TAU = Math.PI * 2

const STATE_COLORS = Object.fromEntries(
  PULSE_STATES.map((s) => [
    s,
    { core: Color3.FromHexString(PROFILES[s].core), rim: Color3.FromHexString(PROFILES[s].rim) },
  ]),
) as Record<PulseState, { core: Color3; rim: Color3 }>

type GlowRole = 'body' | 'orbiter' | 'trail' | 'glint' | 'none'

/** Every motion parameter as a spring, plus eased colours. */
class MotionController {
  readonly core: Color3
  readonly rim: Color3
  private readonly springs = {} as Record<MotionKey, Spring>
  private targetCore: Color3
  private targetRim: Color3

  constructor(state: PulseState) {
    const profile = PROFILES[state]
    for (const key of MOTION_KEYS) {
      this.springs[key] = new Spring(profile.motion[key], springFor(key))
    }
    this.core = STATE_COLORS[state].core.clone()
    this.rim = STATE_COLORS[state].rim.clone()
    this.targetCore = this.core.clone()
    this.targetRim = this.rim.clone()
  }

  setState(state: PulseState, withEntryKick: boolean) {
    const profile = PROFILES[state]
    for (const key of MOTION_KEYS) this.springs[key].target = profile.motion[key]
    this.targetCore = STATE_COLORS[state].core
    this.targetRim = STATE_COLORS[state].rim
    if (withEntryKick && profile.entry) {
      for (const [key, velocity] of Object.entries(profile.entry)) {
        this.springs[key as MotionKey].kick(velocity)
      }
    }
  }

  kick(key: MotionKey, velocity: number) {
    this.springs[key].kick(velocity)
  }

  get(key: MotionKey) {
    return this.springs[key].value
  }

  update(dt: number) {
    for (const key of MOTION_KEYS) this.springs[key].step(dt)
    const t = 1 - Math.exp(-dt * 3.2)
    Color3.LerpToRef(this.core, this.targetCore, t, this.core)
    Color3.LerpToRef(this.rim, this.targetRim, t, this.rim)
  }
}

interface Orbiter {
  mesh: Mesh
  trail: TrailMesh
  material: StandardMaterial
  trailMaterial: StandardMaterial
  radius: Spring
  size: Spring
  phase: number
  speed: number
  plane: Matrix
  alive: boolean
}

interface Eye {
  pupil: Mesh
  glint: Mesh
  side: -1 | 1
}

/**
 * Pulse: a stylised orb built from primitives and a custom shader. It has no
 * rigging. All the character comes from springs, oscillators and two eyes.
 */
export class PulseCharacter {
  private readonly scene: Scene
  private readonly motion: MotionController
  private readonly glowLayer: GlowLayer

  private readonly root: TransformNode
  private readonly squash: TransformNode
  private readonly eyeRoot: TransformNode
  private readonly body: Mesh
  private readonly bodyMaterial: ShaderMaterial
  private readonly eyes: Eye[] = []
  private readonly ground: Mesh
  private readonly groundMaterial: ShaderMaterial
  private readonly backdropMaterial: ShaderMaterial
  private readonly orbiters: Orbiter[] = []
  private readonly glowRoles = new WeakMap<object, GlowRole>()

  private state: PulseState = 'idle'
  private time = 0
  private phase = { breath: 0, pulse: 0, wobble: 0, noise: 0, swirl: 0, talk: 0 }
  private talkEnergy = 0
  private orbiterSerial = 0
  /** Scales shiftX: 1 when the approval card sits beside Pulse on the stage, 0 when it is docked elsewhere. */
  private sideStep = 1

  // Eyes
  private blinkIn = 1.5
  private blinkT = -1
  private pointerTarget: { x: number; y: number } | null = null
  private pointer = { x: 0, y: 0 }
  private saccade = { x: 0, y: 0, tx: 0, ty: 0, next: 1 }

  // Scratch objects, reused every frame to avoid garbage.
  private readonly tmpMatrix = new Matrix()
  private readonly tmpVec = new Vector3()
  private readonly tmpVec2 = new Vector3()
  private readonly faceDir = new Vector3(0, 0, -1)
  private readonly glowColor = new Color3()

  constructor(scene: Scene, initialState: PulseState = 'idle') {
    registerShaders()
    this.scene = scene
    this.state = initialState
    this.motion = new MotionController(initialState)

    // Hierarchy: root (position and lean) > squash (scale) > body and eyes
    this.root = new TransformNode('pulse-root', scene)
    this.squash = new TransformNode('pulse-squash', scene)
    this.squash.parent = this.root

    this.body = MeshBuilder.CreateSphere('pulse-body', { diameter: 2, segments: 64 }, scene)
    this.body.parent = this.squash
    this.bodyMaterial = new ShaderMaterial('pulse-body-mat', scene, 'pulseBody', {
      attributes: ['position', 'normal'],
      uniforms: [
        'world',
        'worldViewProjection',
        'cameraPosition',
        'noisePhase',
        'noiseAmp',
        'noiseFreq',
        'faceDir',
        'coreColor',
        'rimColor',
        'glow',
        'pulse',
        'swirlPhase',
        'swirlAmount',
      ],
    })
    this.body.material = this.bodyMaterial
    this.glowRoles.set(this.body, 'body')

    this.eyeRoot = new TransformNode('pulse-eyes', scene)
    this.eyeRoot.parent = this.squash
    this.buildEyes()

    this.ground = MeshBuilder.CreateDisc('pulse-ground', { radius: 1.8, tessellation: 64 }, scene)
    this.ground.rotation.x = Math.PI / 2
    this.ground.position.y = GROUND_Y
    this.groundMaterial = new ShaderMaterial('pulse-ground-mat', scene, 'pulseGround', {
      attributes: ['position'],
      uniforms: ['worldViewProjection', 'color', 'intensity', 'radius'],
      needAlphaBlending: true,
    })
    this.groundMaterial.backFaceCulling = false
    this.groundMaterial.setFloat('radius', 1.8)
    this.ground.material = this.groundMaterial

    const backdrop = MeshBuilder.CreatePlane('pulse-backdrop', { width: 60, height: 36 }, scene)
    backdrop.position.z = 7
    backdrop.position.y = -0.3
    this.backdropMaterial = new ShaderMaterial('pulse-backdrop-mat', scene, 'pulseBackdrop', {
      attributes: ['position'],
      uniforms: ['worldViewProjection', 'color', 'baseColor', 'intensity', 'radius'],
    })
    this.backdropMaterial.backFaceCulling = false
    this.backdropMaterial.setFloat('radius', 10)
    this.backdropMaterial.setColor3('baseColor', BACKGROUND)
    backdrop.material = this.backdropMaterial

    this.glowLayer = new GlowLayer('pulse-glow', scene, { mainTextureRatio: 0.5, blurKernelSize: 48 })
    this.glowLayer.intensity = 0.55
    this.glowLayer.addExcludedMesh(this.ground)
    this.glowLayer.addExcludedMesh(backdrop)
    this.glowLayer.customEmissiveColorSelector = (mesh, _subMesh, _material, result) =>
      this.selectGlow(mesh, result)
  }

  // Inputs from the state machine

  setState(state: PulseState) {
    if (state === this.state) return
    this.state = state
    this.motion.setState(state, true)
    // People blink when their attention shifts, so Pulse does too.
    if (this.blinkT < 0) this.blinkIn = Math.min(this.blinkIn, 0.06)
  }

  /** Streamed text arrived. Each token adds energy to the talking bounce. */
  token(count = 1) {
    this.talkEnergy = Math.min(1, this.talkEnergy + 0.3 * count)
  }

  /** Keep one orbiting particle per tool call in this turn. */
  setToolCalls(count: number) {
    const target = Math.min(count, MAX_ORBITERS)
    const alive = this.orbiters.filter((o) => o.alive)
    for (let i = alive.length; i < target; i++) {
      this.spawnOrbiter()
      this.motion.kick('scale', 0.6) // a small puff as the particle is released
    }
    for (let i = target; i < alive.length; i++) alive[i].alive = false
  }

  /** Pointer position relative to the character, from -1 to 1. Pass null when the pointer leaves. */
  setPointer(x: number | null, y = 0) {
    this.pointerTarget = x === null ? null : { x, y }
  }

  setSideStep(factor: number) {
    this.sideStep = factor
  }

  /** World-space point just above Pulse's head, for anchoring HTML badges. */
  getHeadAnchor(out: Vector3) {
    const s = this.squash.scaling.y
    return out.copyFrom(this.root.position).addInPlaceFromFloats(0, 1.25 * s, 0)
  }

  getCenter(out: Vector3) {
    return out.copyFrom(this.root.position)
  }

  // Per-frame update

  update(rawDt: number) {
    const dt = Math.min(Math.max(rawDt, 0), 1 / 20)
    this.time += dt
    this.motion.update(dt)
    const m = (key: MotionKey) => this.motion.get(key)

    // Oscillator phases are integrated, so changing a rate never makes the motion jump.
    this.phase.breath += dt * TAU * m('breathRate')
    this.phase.pulse += dt * TAU * m('pulseRate')
    this.phase.wobble += dt * TAU * m('wobbleRate')
    this.phase.noise += dt * m('noiseSpeed')
    this.phase.swirl += dt * m('swirlSpeed')

    // Talking bounce: a hop rhythm whose height follows how actively text is streaming.
    this.talkEnergy *= Math.exp(-dt * 2.0)
    if (this.talkEnergy > 0.004) this.phase.talk += dt * TAU * (2.1 + 0.8 * this.talkEnergy)
    else this.phase.talk = 0
    const hop = Math.abs(Math.sin(this.phase.talk))
    const talkY = this.talkEnergy * 0.16 * hop
    const talkStretch = 1 + this.talkEnergy * (0.05 * hop - 0.09 * Math.pow(1 - hop, 6))

    // Body transform
    const breath = 1 + m('breathAmp') * Math.sin(this.phase.breath)
    const pulse = m('pulseAmp') * (0.5 + 0.5 * Math.sin(this.phase.pulse))
    const wobble = m('wobbleAmp') * Math.sin(this.phase.wobble)
    const hover = Math.sin(this.time * 0.6) * 0.025
    const lean = m('lean')
    const scale = m('scale') * breath

    this.root.position.set(
      wobble * 0.5 + m('shiftX') * this.sideStep,
      m('lift') + hover + talkY,
      -lean * 0.22,
    )
    this.root.rotation.set(
      -lean * 0.16,
      -m('turn') * 0.55,
      wobble,
    )
    const xz = scale / Math.sqrt(talkStretch)
    this.squash.scaling.set(xz, scale * talkStretch, xz)

    this.updateEyes(dt, m)

    // Shader uniforms
    const glow = m('glow') + pulse * 0.4 + this.talkEnergy * hop * 0.25
    const mat = this.bodyMaterial
    mat.setFloat('noisePhase', this.phase.noise)
    mat.setFloat('noiseAmp', m('noiseAmp'))
    mat.setFloat('noiseFreq', m('noiseFreq'))
    mat.setFloat('swirlPhase', this.phase.swirl * 4)
    mat.setFloat('swirlAmount', Math.max(0, m('swirlAmount')))
    mat.setFloat('glow', glow)
    mat.setFloat('pulse', pulse)
    mat.setColor3('coreColor', this.motion.core)
    mat.setColor3('rimColor', this.motion.rim)
    mat.setVector3('faceDir', this.faceDir)

    this.glowColor.copyFrom(this.motion.rim).scaleInPlace(0.1 + glow * 0.3)

    // Ground light pool: smaller and dimmer while the body is in the air.
    const height = Math.max(0, this.root.position.y)
    const groundScale = (1 - Math.min(height * 0.35, 0.4)) * m('scale')
    this.ground.scaling.set(groundScale, groundScale, groundScale)
    this.groundMaterial.setColor3('color', this.motion.rim)
    this.groundMaterial.setFloat(
      'intensity',
      (0.2 + glow * 0.22) * (1 - Math.min(height * 1.2, 0.6)),
    )

    this.backdropMaterial.setColor3('color', this.motion.core)
    this.backdropMaterial.setFloat('intensity', 0.2 + glow * 0.05)

    this.updateOrbiters(dt, m)
  }

  // Eyes

  private buildEyes() {
    const pupilMat = new StandardMaterial('pulse-pupil-mat', this.scene)
    pupilMat.disableLighting = true
    pupilMat.emissiveColor = Color3.FromHexString('#0a1022')
    pupilMat.specularColor = Color3.Black()

    const glintMat = new StandardMaterial('pulse-glint-mat', this.scene)
    glintMat.disableLighting = true
    glintMat.emissiveColor = Color3.White()

    for (const side of [-1, 1] as const) {
      // Each eye sits on a pivot at the body centre, so turning the pivot slides the eye over the surface.
      const pivot = new TransformNode(`pulse-eye-pivot-${side}`, this.scene)
      pivot.parent = this.eyeRoot
      pivot.rotation.set(EYE_HEIGHT, -side * EYE_SPREAD, 0)

      const pupil = MeshBuilder.CreateSphere(`pulse-pupil-${side}`, { diameter: 1, segments: 20 }, this.scene)
      pupil.parent = pivot
      pupil.position.z = -1
      pupil.scaling.set(0.17, 0.25, 0.08)
      pupil.material = pupilMat
      this.glowRoles.set(pupil, 'none')

      const glint = MeshBuilder.CreateSphere(`pulse-glint-${side}`, { diameter: 0.055, segments: 8 }, this.scene)
      glint.parent = pivot
      glint.position.set(0.035, 0.06, -1.035)
      glint.material = glintMat
      this.glowRoles.set(glint, 'glint')

      this.eyes.push({ pupil, glint, side })
    }
  }

  private updateEyes(dt: number, m: (key: MotionKey) => number) {
    // Blinking: randomised, roughly blinkRate times per second, with the odd double blink.
    if (this.blinkT < 0) {
      this.blinkIn -= dt
      if (this.blinkIn <= 0) this.blinkT = 0
    }
    let blink = 0
    if (this.blinkT >= 0) {
      this.blinkT += dt
      blink = Math.sin(Math.PI * Math.min(this.blinkT / BLINK_DURATION, 1))
      if (this.blinkT >= BLINK_DURATION) {
        this.blinkT = -1
        const rate = Math.max(m('blinkRate'), 0.05)
        this.blinkIn = Math.random() < 0.15 ? 0.12 : Math.min(Math.max(-Math.log(Math.random()) / rate, 1.2), 8)
      }
    }

    // Small saccades keep the eyes alive. They dart more while thinking.
    this.saccade.next -= dt
    if (this.saccade.next <= 0) {
      const amp = this.state === 'thinking' ? 0.16 : this.state === 'needsApproval' ? 0.02 : 0.06
      this.saccade.tx = (Math.random() * 2 - 1) * amp
      this.saccade.ty = (Math.random() * 2 - 1) * amp * 0.7
      this.saccade.next = 0.5 + Math.random() * 2
    }
    const fast = 1 - Math.exp(-dt * 30)
    this.saccade.x += (this.saccade.tx - this.saccade.x) * fast
    this.saccade.y += (this.saccade.ty - this.saccade.y) * fast

    const pt = this.pointerTarget ?? { x: 0, y: 0 }
    const smooth = 1 - Math.exp(-dt * 6)
    this.pointer.x += (pt.x - this.pointer.x) * smooth
    this.pointer.y += (pt.y - this.pointer.y) * smooth

    const follow = Math.min(Math.max(m('followPointer'), 0), 1)
    const gx = m('gazeX') * (1 - follow) + this.pointer.x * follow + this.saccade.x
    const gy = m('gazeY') * (1 - follow) + this.pointer.y * follow + this.saccade.y
    this.eyeRoot.rotation.set(gy * 0.26, -gx * 0.32, 0)

    // Direction of the eye line in body space, so the shader can calm the skin around it.
    Matrix.RotationYawPitchRollToRef(this.eyeRoot.rotation.y, this.eyeRoot.rotation.x, 0, this.tmpMatrix)
    this.tmpVec.set(0, Math.sin(EYE_HEIGHT), -Math.cos(EYE_HEIGHT))
    Vector3.TransformNormalToRef(this.tmpVec, this.tmpMatrix, this.faceDir)

    const open = Math.max(m('eyeOpen'), 0.05) * (1 - 0.92 * blink)
    const asym = m('eyeAsym')
    for (const eye of this.eyes) {
      // Doubt: one eye narrows and the other opens slightly.
      const sideOpen = open * (eye.side === 1 ? 1 - asym * 0.45 : 1 + asym * 0.12)
      eye.pupil.scaling.y = 0.25 * sideOpen
      eye.pupil.scaling.x = 0.17 * (1 + (1 - Math.min(sideOpen, 1)) * 0.12)
      const g = Math.min(sideOpen, 1)
      eye.glint.scaling.setAll(g)
      eye.glint.position.y = 0.06 * g
      eye.glint.isVisible = g > 0.3
    }
  }

  // Tool-call particles

  private spawnOrbiter() {
    const index = this.orbiterSerial++
    const mesh = MeshBuilder.CreateSphere(`pulse-orbiter-${index}`, { diameter: 0.14, segments: 12 }, this.scene)
    const material = new StandardMaterial(`pulse-orbiter-mat-${index}`, this.scene)
    material.disableLighting = true
    material.emissiveColor = this.motion.rim.clone()
    mesh.material = material
    this.getCenter(mesh.position)
    this.glowRoles.set(mesh, 'orbiter')

    const trail = new TrailMesh(`pulse-trail-${index}`, mesh, this.scene, {
      diameter: 0.05,
      length: 34,
      autoStart: true,
    })
    const trailMaterial = new StandardMaterial(`pulse-trail-mat-${index}`, this.scene)
    trailMaterial.disableLighting = true
    trailMaterial.emissiveColor = this.motion.rim.clone()
    trailMaterial.alpha = 0.45
    trail.material = trailMaterial
    this.glowRoles.set(trail, 'trail')

    // Spread orbital planes around the body using the golden angle.
    const golden = 2.39996
    const plane = Matrix.RotationYawPitchRoll(index * golden, (index % 2 ? 1 : -1) * (0.35 + (index % 3) * 0.22), 0)

    const radius = new Spring(0.3, { stiffness: 45, damping: 7 })
    radius.kick(4)
    const size = new Spring(0, { stiffness: 140, damping: 12 })
    size.kick(5)

    this.orbiters.push({
      mesh,
      trail,
      material,
      trailMaterial,
      radius,
      size,
      phase: Math.random() * TAU,
      speed: 1 + (index % 4) * 0.12,
      plane,
      alive: true,
    })
  }

  private updateOrbiters(dt: number, m: (key: MotionKey) => number) {
    const center = this.getCenter(this.tmpVec2)
    const baseRadius = m('orbitRadius')
    const visible = Math.max(0, m('orbitVisible'))
    const speed = m('orbitSpeed')

    let slot = 0
    for (let i = this.orbiters.length - 1; i >= 0; i--) {
      const o = this.orbiters[i]
      if (o.alive) {
        o.radius.target = baseRadius * (1 + 0.08 * slot++)
        o.size.target = visible
      } else {
        o.radius.target = 0
        o.size.target = 0
      }
      o.radius.step(dt)
      o.size.step(dt)
      o.phase += dt * speed * o.speed

      const r = Math.max(o.radius.value, 0)
      this.tmpVec.set(Math.cos(o.phase) * r, Math.sin(o.phase * 2) * 0.06, Math.sin(o.phase) * r)
      Vector3.TransformCoordinatesToRef(this.tmpVec, o.plane, o.mesh.position)
      o.mesh.position.addInPlace(center)

      const size = Math.max(o.size.value, 0)
      const twinkle = 1 + 0.15 * Math.sin(this.time * 7 + i)
      o.mesh.scaling.setAll(size * twinkle)
      o.mesh.isVisible = size > 0.02
      o.trail.visibility = Math.min(size, 1)
      o.material.emissiveColor.copyFrom(this.motion.rim)
      o.trailMaterial.emissiveColor.copyFrom(this.motion.rim)

      if (!o.alive && size < 0.01 && Math.abs(o.size.velocity) < 0.01) {
        o.trail.dispose()
        o.mesh.dispose()
        o.material.dispose()
        o.trailMaterial.dispose()
        this.orbiters.splice(i, 1)
      }
    }
  }

  // Glow

  private selectGlow(mesh: Mesh, result: Color4) {
    switch (this.glowRoles.get(mesh) ?? 'none') {
      case 'body':
        result.set(this.glowColor.r, this.glowColor.g, this.glowColor.b, 1)
        break
      case 'orbiter':
        result.set(this.motion.rim.r, this.motion.rim.g, this.motion.rim.b, 1)
        break
      case 'trail':
        result.set(this.motion.rim.r * 0.6, this.motion.rim.g * 0.6, this.motion.rim.b * 0.6, 1)
        break
      case 'glint':
        result.set(0.35, 0.35, 0.35, 1)
        break
      default:
        result.set(0, 0, 0, 1)
    }
  }
}
