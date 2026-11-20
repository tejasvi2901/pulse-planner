import { useEffect, useRef } from 'react'

import type { UserDecision, PlanProposal } from '../../shared/agentProtocol'
import { diffPlans, isFitProblem, sortBlocks, type Block } from '../../shared/planner'
import './ApprovalCard.css'

const LOW_CONFIDENCE = 0.6

type Row = { block: Block; change: 'new' | 'moved' | 'same'; from?: string }

/**
 * The human-in-the-loop gate. Pulse turns toward this card while it waits;
 * the plan in the browser changes only when the user approves.
 */
export function ApprovalCard({
  proposal,
  current,
  disabled,
  onDecide,
  docked = false,
}: {
  proposal: PlanProposal
  current: Block[]
  disabled: boolean
  onDecide: (decision: UserDecision) => void
  /** Docked in the side panel (narrow layouts) instead of floating beside Pulse. */
  docked?: boolean
}) {
  const approveRef = useRef<HTMLButtonElement>(null)
  const pct = Math.round(proposal.confidence * 100)
  const low = proposal.confidence < LOW_CONFIDENCE
  const diff = diffPlans(current, proposal.blocks)
  const firstPlan = current.length === 0

  const rows: Row[] = sortBlocks(proposal.blocks).map((block) => {
    const moved = diff.moved.find((m) => m.after.id === block.id)
    if (moved) return { block, change: 'moved', from: moved.before.start }
    if (diff.added.some((a) => a.id === block.id)) return { block, change: 'new' }
    return { block, change: 'same' }
  })
  const warnings = proposal.issues.filter((i) => !isFitProblem(i))

  // Move focus to the decision so keyboard users land on it.
  useEffect(() => {
    approveRef.current?.focus({ preventScroll: true })
  }, [proposal])

  return (
    <section className={`approval${docked ? ' approval--docked' : ''}`} role="region" aria-labelledby="approval-title">
      <p className="approval__eyebrow">
        <span className="approval__dot" aria-hidden="true" />
        {firstPlan ? 'Proposed plan' : 'Proposed changes'} · needs your approval
      </p>
      <h2 id="approval-title" className="approval__title">
        {proposal.summary}
      </h2>

      <div className="approval__scroll">
        <ol className="plan-diff" aria-label="Proposed schedule">
          {rows.map(({ block, change, from }) => (
            <li key={block.id} className={`plan-diff__row plan-diff__row--${block.kind} plan-diff__row--${change}`}>
              <span className="plan-diff__time">
                {block.start}–{block.end}
              </span>
              <span className="plan-diff__title">{block.title}</span>
              {!firstPlan && change !== 'same' && (
                <span className="plan-diff__tag">{change === 'new' ? 'new' : `was ${from}`}</span>
              )}
            </li>
          ))}
          {diff.removed.map((block) => (
            <li key={block.id} className="plan-diff__row plan-diff__row--removed">
              <span className="plan-diff__time">
                {block.start}–{block.end}
              </span>
              <span className="plan-diff__title">{block.title}</span>
              <span className="plan-diff__tag">removed</span>
            </li>
          ))}
        </ol>

        {proposal.leftOut.length > 0 && (
          <div className="approval__left-out">
            <h3>Doesn't fit today</h3>
            <ul>
              {proposal.leftOut.map((l) => (
                <li key={l.task}>
                  <strong>{l.task}</strong> {l.reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        {warnings.length > 0 && (
          <ul className="approval__warnings" aria-label="Warnings">
            {warnings.map((w) => (
              <li key={w.message}>{w.message}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="approval__meta">
        <div className={`confidence${low ? ' confidence--low' : ''}`}>
          <span className="confidence__label">{low ? 'Low confidence' : 'Confidence'}</span>
          <span className="confidence__track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Confidence">
            <span className="confidence__fill" style={{ width: `${pct}%` }} />
          </span>
          <span className="confidence__value">{pct}%</span>
        </div>
      </div>

      <div className="approval__actions">
        <button ref={approveRef} type="button" className="btn btn--primary" disabled={disabled} onClick={() => onDecide({ decision: 'approve' })}>
          Approve
        </button>
        <button type="button" className="btn" disabled={disabled} onClick={() => onDecide({ decision: 'override' })}>
          Keep mine
        </button>
        <button type="button" className="btn btn--ghost" disabled={disabled} onClick={() => onDecide({ decision: 'ask_why' })}>
          Ask why
        </button>
      </div>
    </section>
  )
}
