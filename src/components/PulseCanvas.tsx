import { useSelector } from '@xstate/react'
import { useEffect, useRef } from 'react'

import { PulseStage } from '../character/PulseStage'
import type { PulseActorRef, PulseState } from '../machine/pulseMachine'
import './PulseCanvas.css'

/**
 * Mounts the Babylon stage and forwards state-machine changes to the character.
 * The machine is subscribed to directly, so React never re-renders per frame.
 */
export function PulseCanvas({ actor, sideStep = 1 }: { actor: PulseActorRef; sideStep?: number }) {
  const stageRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const pulseStageRef = useRef<PulseStage | null>(null)
  const sideStepRef = useRef(sideStep)
  const uncertain = useSelector(actor, (s) => s.value === 'uncertain')

  useEffect(() => {
    const host = hostRef.current
    const stageEl = stageRef.current
    if (!host || !stageEl) return

    // Each mount gets its own canvas, so React StrictMode's double mount starts clean.
    const canvas = document.createElement('canvas')
    canvas.className = 'pulse-canvas'
    canvas.setAttribute('role', 'img')
    canvas.setAttribute('aria-label', 'Pulse, an animated assistant character')
    host.appendChild(canvas)

    let prev = actor.getSnapshot()
    const stage = new PulseStage(canvas, prev.value as PulseState)
    stage.character.setToolCalls(prev.context.toolCalls.length)
    stage.character.setSideStep(sideStepRef.current)
    pulseStageRef.current = stage
    if (import.meta.env.DEV) Object.assign(window, { __pulseStage: stage })
    stage.onHeadAnchor = (x, y) => {
      stageEl.style.setProperty('--head-x', `${x}px`)
      stageEl.style.setProperty('--head-y', `${y}px`)
    }

    const sub = actor.subscribe((snap) => {
      if (snap.value !== prev.value) stage.character.setState(snap.value as PulseState)
      const newTokens = snap.context.tokenCount - prev.context.tokenCount
      if (newTokens > 0) stage.character.token(newTokens)
      if (snap.context.toolCalls.length !== prev.context.toolCalls.length) {
        stage.character.setToolCalls(snap.context.toolCalls.length)
      }
      prev = snap
    })

    return () => {
      pulseStageRef.current = null
      sub.unsubscribe()
      stage.dispose()
      canvas.remove()
    }
  }, [actor])

  // Step aside only when the approval card appears beside Pulse on the stage.
  useEffect(() => {
    sideStepRef.current = sideStep
    pulseStageRef.current?.character.setSideStep(sideStep)
  }, [sideStep])

  return (
    <div className="pulse-stage" ref={stageRef}>
      <div className="pulse-canvas-host" ref={hostRef} />
      <div className="pulse-overlay">
        <div className={`confidence-badge${uncertain ? ' is-visible' : ''}`} aria-hidden={!uncertain}>
          <span className="confidence-badge__dot" />
          Low confidence
        </div>
      </div>
    </div>
  )
}
