export interface SpringConfig {
  /** Higher = snappier. */
  stiffness: number
  /** Higher = less overshoot. Critical damping is 2 * sqrt(stiffness). */
  damping: number
}

/**
 * A damped spring that chases a target value. Slightly under-damped springs give
 * motion natural follow-through, and a velocity kick gives anticipation.
 */
export class Spring {
  value: number
  target: number
  velocity = 0
  config: SpringConfig

  constructor(value: number, config: SpringConfig) {
    this.value = value
    this.target = value
    this.config = config
  }

  kick(velocity: number) {
    this.velocity += velocity
  }

  step(dt: number) {
    // Fixed sub-steps keep stiff springs stable when a frame takes longer than usual.
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)))
    const h = dt / steps
    const { stiffness, damping } = this.config
    for (let i = 0; i < steps; i++) {
      const accel = -stiffness * (this.value - this.target) - damping * this.velocity
      this.velocity += accel * h
      this.value += this.velocity * h
    }
    return this.value
  }
}
