import { ArcRotateCamera, Camera, Color4, Engine, Matrix, Scene, Vector3 } from '@babylonjs/core'

import type { PulseState } from '../machine/pulseMachine'
import { BACKGROUND, PulseCharacter } from './PulseCharacter'

const BASE_FOV = 0.62
const PORTRAIT_FOV = 0.78

/**
 * Owns the Babylon engine, scene and camera, and drives Pulse every frame.
 * It knows nothing about React or XState; the canvas component wires those in.
 */
export class PulseStage {
  readonly character: PulseCharacter
  /** Called after each frame with the CSS-pixel position above Pulse's head. */
  onHeadAnchor?: (x: number, y: number) => void

  private readonly canvas: HTMLCanvasElement
  private readonly engine: Engine
  private readonly scene: Scene
  private readonly camera: ArcRotateCamera
  private readonly resizeObserver: ResizeObserver
  private readonly tmp = new Vector3()
  private readonly projected = new Vector3()
  private centerPx = { x: 0, y: 0 }
  private lastAnchor = { x: -1, y: -1 }

  constructor(canvas: HTMLCanvasElement, initialState: PulseState) {
    this.canvas = canvas
    this.engine = new Engine(canvas, true, { stencil: false, powerPreference: 'high-performance' }, true)
    // Cap the pixel ratio: above 2x costs a lot of GPU for little visible gain.
    this.engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, 2))

    this.scene = new Scene(this.engine)
    this.scene.clearColor = new Color4(BACKGROUND.r, BACKGROUND.g, BACKGROUND.b, 1)
    this.scene.skipPointerMovePicking = true

    this.camera = new ArcRotateCamera('pulse-camera', -Math.PI / 2, 1.47, 7.2, new Vector3(0, -0.05, 0), this.scene)
    this.camera.minZ = 0.1
    this.camera.maxZ = 100
    this.fitCamera()

    this.character = new PulseCharacter(this.scene, initialState)

    this.engine.runRenderLoop(this.frame)

    this.resizeObserver = new ResizeObserver(() => {
      this.engine.resize()
      this.fitCamera()
    })
    this.resizeObserver.observe(canvas)

    window.addEventListener('pointermove', this.onPointerMove)
    document.documentElement.addEventListener('pointerleave', this.onPointerLeave)
  }

  dispose() {
    window.removeEventListener('pointermove', this.onPointerMove)
    document.documentElement.removeEventListener('pointerleave', this.onPointerLeave)
    this.resizeObserver.disconnect()
    this.engine.stopRenderLoop()
    this.scene.dispose()
    this.engine.dispose()
  }

  private frame = () => {
    this.character.update(this.engine.getDeltaTime() / 1000)
    this.scene.render()

    this.toCss(this.character.getCenter(this.tmp), this.centerPx)
    if (this.onHeadAnchor) {
      const anchor = this.toCss(this.character.getHeadAnchor(this.tmp), { x: 0, y: 0 })
      if (Math.abs(anchor.x - this.lastAnchor.x) > 0.5 || Math.abs(anchor.y - this.lastAnchor.y) > 0.5) {
        this.lastAnchor = anchor
        this.onHeadAnchor(anchor.x, anchor.y)
      }
    }
  }

  /** Project a world point to CSS pixels relative to the canvas. */
  private toCss(world: Vector3, out: { x: number; y: number }) {
    const w = this.engine.getRenderWidth()
    const h = this.engine.getRenderHeight()
    Vector3.ProjectToRef(
      world,
      Matrix.IdentityReadOnly,
      this.scene.getTransformMatrix(),
      this.camera.viewport.toGlobal(w, h),
      this.projected,
    )
    const k = this.canvas.clientWidth / Math.max(w, 1)
    out.x = this.projected.x * k
    out.y = this.projected.y * k
    return out
  }

  /** Keep the whole orbit in frame on portrait screens. */
  private fitCamera() {
    const aspect = this.engine.getAspectRatio(this.camera)
    if (aspect < 1) {
      this.camera.fovMode = Camera.FOVMODE_HORIZONTAL_FIXED
      this.camera.fov = PORTRAIT_FOV
    } else {
      this.camera.fovMode = Camera.FOVMODE_VERTICAL_FIXED
      this.camera.fov = BASE_FOV
    }
  }

  private onPointerMove = (e: PointerEvent) => {
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const clamp = (v: number) => Math.max(-1, Math.min(1, v))
    const x = clamp((e.clientX - rect.left - this.centerPx.x) / (rect.width * 0.5))
    const y = clamp(-(e.clientY - rect.top - this.centerPx.y) / (rect.height * 0.5))
    this.character.setPointer(x, y)
  }

  private onPointerLeave = () => {
    this.character.setPointer(null)
  }
}
