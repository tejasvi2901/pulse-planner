import type { PulseState } from '../machine/pulseMachine'
import type { SpringConfig } from './spring'

/**
 * Body-language parameters. Each state sets a target, and every value springs
 * toward it, so state changes are eased instead of snapping.
 */
export interface MotionParams {
  /** Overall body size. Below 1 reads as drawing inward, above 1 as opening up. */
  scale: number
  /** Breathing amplitude, as a fraction of scale. */
  breathAmp: number
  /** Breaths per second. */
  breathRate: number
  /** Soft emissive pulse amplitude (0 to 1). */
  pulseAmp: number
  /** Pulses per second. */
  pulseRate: number
  /** Lean toward the user and the input (0 to 1). Negative pulls back. */
  lean: number
  /** Body yaw (-1 to 1). Positive turns toward screen-right, where the approval card sits. */
  turn: number
  /** Vertical offset of the body, in world units. */
  lift: number
  /** Sideways step, in world units. Negative moves left to make room for the approval card. */
  shiftX: number
  /** Side-to-side wobble, in radians. */
  wobbleAmp: number
  /** Wobbles per second. */
  wobbleRate: number
  /** Surface displacement amplitude. */
  noiseAmp: number
  /** Surface displacement frequency. */
  noiseFreq: number
  /** How fast the surface churns. */
  noiseSpeed: number
  /** Visibility of the inward-flowing swirl (0 to 1). */
  swirlAmount: number
  /** Swirl flow speed. */
  swirlSpeed: number
  /** Rim light and glow intensity. */
  glow: number
  /** Eye openness. 1 is neutral, below 1 squints, above 1 is wide-eyed. */
  eyeOpen: number
  /** Eye asymmetry. Above 0, one eye narrows, which reads as doubt. */
  eyeAsym: number
  /** Gaze direction (-1 to 1). Positive x looks screen-right, positive y looks up. */
  gazeX: number
  gazeY: number
  /** How much the eyes follow the pointer (0 to 1). */
  followPointer: number
  /** Orbit radius of the tool-call particles. */
  orbitRadius: number
  /** Orbit speed of the tool-call particles. */
  orbitSpeed: number
  /** Visibility of the tool-call particles (0 to 1). */
  orbitVisible: number
  /** Average blinks per second. */
  blinkRate: number
}

export type MotionKey = keyof MotionParams

export interface StateProfile {
  motion: MotionParams
  /** Main body colour (hex). */
  core: string
  /** Rim, glow and particle colour (hex). */
  rim: string
  /** Velocity kicks applied on entry: anticipation and follow-through. */
  entry?: Partial<Record<MotionKey, number>>
  /** One-line behaviour note, used by the debug panel. */
  intent: string
}

const base: MotionParams = {
  scale: 1,
  breathAmp: 0.03,
  breathRate: 0.22,
  pulseAmp: 0,
  pulseRate: 1,
  lean: 0,
  turn: 0,
  lift: 0,
  shiftX: 0,
  wobbleAmp: 0,
  wobbleRate: 1.4,
  noiseAmp: 0.03,
  noiseFreq: 1.2,
  noiseSpeed: 0.25,
  swirlAmount: 0,
  swirlSpeed: 1,
  glow: 0.35,
  eyeOpen: 1,
  eyeAsym: 0,
  gazeX: 0,
  gazeY: 0,
  followPointer: 0.6,
  orbitRadius: 0,
  orbitSpeed: 1,
  orbitVisible: 0,
  blinkRate: 0.25,
}

export const PROFILES: Record<PulseState, StateProfile> = {
  idle: {
    intent: 'Slow breathing. Eyes drift after the cursor.',
    core: '#2f6bff',
    rim: '#6fe3ff',
    motion: { ...base },
  },

  listening: {
    intent: 'Leans toward the input with a soft pulse and wide eyes.',
    core: '#1f9fff',
    rim: '#9bf0ff',
    entry: { scale: 0.7, lift: 0.5 },
    motion: {
      ...base,
      scale: 1.06,
      breathAmp: 0.018,
      breathRate: 0.35,
      pulseAmp: 0.45,
      pulseRate: 1.1,
      lean: 1,
      lift: 0.04,
      noiseAmp: 0.025,
      glow: 0.55,
      eyeOpen: 1.15,
      gazeY: -0.35,
      followPointer: 0.25,
      blinkRate: 0.3,
    },
  },

  thinking: {
    intent: 'Draws inward and swirls. One orbiting particle per tool call.',
    core: '#5b3df5',
    rim: '#b49cff',
    entry: { scale: -0.9 },
    motion: {
      ...base,
      scale: 0.92,
      breathAmp: 0.012,
      breathRate: 0.5,
      pulseAmp: 0.15,
      pulseRate: 2,
      lift: 0.08,
      noiseAmp: 0.05,
      noiseFreq: 1.9,
      noiseSpeed: 0.9,
      swirlAmount: 1,
      swirlSpeed: 2.6,
      glow: 0.5,
      eyeOpen: 0.82,
      gazeX: 0.38,
      gazeY: 0.45,
      followPointer: 0,
      orbitRadius: 1.7,
      orbitSpeed: 1.7,
      orbitVisible: 1,
      blinkRate: 0.12,
    },
  },

  explaining: {
    intent: 'Faces you and bounces gently in rhythm with the streamed text.',
    core: '#2563eb',
    rim: '#5eead4',
    entry: { lift: 0.9, scale: 0.4 },
    motion: {
      ...base,
      scale: 1.02,
      breathAmp: 0.015,
      breathRate: 0.4,
      pulseAmp: 0.2,
      pulseRate: 1.6,
      lean: 0.4,
      lift: 0.1,
      noiseAmp: 0.03,
      swirlAmount: 0.2,
      swirlSpeed: 0.8,
      glow: 0.6,
      eyeOpen: 1.05,
      followPointer: 0.2,
      orbitRadius: 2,
      orbitSpeed: 0.55,
      orbitVisible: 0.7,
      blinkRate: 0.3,
    },
  },

  needsApproval: {
    intent: 'Holds still, turns to the approval card and warms up.',
    core: '#e8791c',
    rim: '#ffd08a',
    entry: { scale: 0.5 },
    motion: {
      ...base,
      scale: 1,
      breathAmp: 0.004,
      breathRate: 0.15,
      pulseAmp: 0.3,
      pulseRate: 0.55,
      lean: 0.5,
      turn: 0.55,
      lift: 0.05,
      shiftX: -1.1,
      noiseAmp: 0.015,
      noiseSpeed: 0.08,
      glow: 0.75,
      eyeOpen: 1.1,
      gazeX: 0.55,
      gazeY: -0.05,
      followPointer: 0,
      orbitRadius: 1.9,
      orbitSpeed: 0,
      orbitVisible: 0.6,
      blinkRate: 0.15,
    },
  },

  uncertain: {
    intent: 'Wobbles slightly, narrows one eye and shows a low-confidence badge.',
    core: '#535782',
    rim: '#aea8dc',
    entry: { turn: -0.6 },
    motion: {
      ...base,
      scale: 0.96,
      breathAmp: 0.02,
      breathRate: 0.3,
      lean: -0.25,
      wobbleAmp: 0.085,
      wobbleRate: 1.3,
      noiseAmp: 0.045,
      noiseFreq: 1.6,
      noiseSpeed: 0.5,
      swirlAmount: 0.15,
      swirlSpeed: 0.6,
      glow: 0.25,
      eyeOpen: 0.92,
      eyeAsym: 0.4,
      gazeX: -0.3,
      gazeY: 0.2,
      followPointer: 0,
      orbitRadius: 1.6,
      orbitSpeed: 0.45,
      orbitVisible: 0.5,
      blinkRate: 0.4,
    },
  },

  done: {
    intent: 'Absorbs the particles, settles and glows.',
    core: '#12b886',
    rim: '#a6f4c5',
    entry: { scale: 1.1, lift: 0.6 },
    motion: {
      ...base,
      scale: 1.04,
      breathAmp: 0.025,
      breathRate: 0.18,
      lift: -0.04,
      noiseAmp: 0.02,
      noiseSpeed: 0.15,
      glow: 1.15,
      eyeOpen: 0.5,
      gazeY: 0.1,
      followPointer: 0.3,
      orbitRadius: 0,
      orbitSpeed: 1.4,
      orbitVisible: 0,
      blinkRate: 0.2,
    },
  },
}

const DEFAULT_SPRING: SpringConfig = { stiffness: 60, damping: 12 }

/**
 * Per-parameter spring tuning. The eyes are fast and the body is slower, so the
 * eyes lead and the body follows, as they do in hand-drawn animation.
 */
export const SPRINGS: Partial<Record<MotionKey, SpringConfig>> = {
  scale: { stiffness: 140, damping: 11 },
  lift: { stiffness: 90, damping: 10 },
  shiftX: { stiffness: 22, damping: 8.5 },
  lean: { stiffness: 60, damping: 11 },
  turn: { stiffness: 35, damping: 9 },
  gazeX: { stiffness: 160, damping: 20 },
  gazeY: { stiffness: 160, damping: 20 },
  eyeOpen: { stiffness: 180, damping: 18 },
  eyeAsym: { stiffness: 80, damping: 14 },
  glow: { stiffness: 25, damping: 9 },
  orbitRadius: { stiffness: 45, damping: 7 },
  orbitVisible: { stiffness: 30, damping: 10 },
  orbitSpeed: { stiffness: 18, damping: 8 },
  swirlAmount: { stiffness: 16, damping: 8 },
  swirlSpeed: { stiffness: 16, damping: 8 },
  wobbleAmp: { stiffness: 20, damping: 8 },
}

export const springFor = (key: MotionKey): SpringConfig => SPRINGS[key] ?? DEFAULT_SPRING
