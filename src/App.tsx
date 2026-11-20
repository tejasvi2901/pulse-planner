import { useActorRef } from '@xstate/react'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { UserDecision } from '../shared/agentProtocol'
import { useAgentSession } from './agent/useAgentSession'
import { ApprovalCard } from './components/ApprovalCard'
import { ChatPanel } from './components/ChatPanel'
import { DayTimeline } from './components/DayTimeline'
import { DebugPanel } from './components/DebugPanel'
import { PulseCanvas } from './components/PulseCanvas'
import { pulseMachine } from './machine/pulseMachine'
import { usePlan } from './planner/usePlan'
import './App.css'

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])
  return matches
}

/** The card floats beside Pulse only when the stage is wide enough for both. */
function useCardBesidePulse() {
  const ref = useRef<HTMLElement>(null)
  const [beside, setBeside] = useState(true)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setBeside(width >= 720 && width / Math.max(height, 1) >= 1.1)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, beside] as const
}

type Tab = 'day' | 'chat'

export default function App() {
  const actor = useActorRef(pulseMachine)
  const planApi = usePlan()
  const session = useAgentSession(actor, planApi)
  const [stageRef, cardBeside] = useCardBesidePulse()
  const wide = useMediaQuery('(min-width: 1200px)')
  const [tab, setTab] = useState<Tab>('chat')

  // In the tabbed layout, a new proposal appears in the chat tab, so bring it forward
  // (adjusting state during render when the proposal changes, as React recommends).
  const proposalId = session.pendingProposal?.toolUseId
  const [seenProposal, setSeenProposal] = useState(proposalId)
  if (proposalId !== seenProposal) {
    setSeenProposal(proposalId)
    if (proposalId) setTab('chat')
  }

  const decide = useCallback(
    (decision: UserDecision) => {
      session.decide(decision)
      // Show the result of an approval on the day view.
      if (decision.decision === 'approve' && !wide) window.setTimeout(() => setTab('day'), 900)
    },
    [session, wide],
  )

  const newDay = useCallback(() => {
    planApi.reset()
    session.reset()
  }, [planApi, session])

  const card = session.pendingProposal && (
    <ApprovalCard
      key={session.pendingProposal.toolUseId}
      proposal={session.pendingProposal.proposal}
      current={planApi.plan.blocks}
      disabled={session.busy}
      onDecide={decide}
      docked={!cardBeside}
    />
  )

  const day = <DayTimeline planApi={planApi} onNewDay={newDay} />
  const chat = <ChatPanel session={session} approvalSlot={cardBeside ? null : card} />

  return (
    <div className={`app${wide ? ' app--wide' : ''}`}>
      {wide && <aside className="app__day">{day}</aside>}

      <main className="app__stage" ref={stageRef}>
        <PulseCanvas actor={actor} sideStep={cardBeside ? 1 : 0} />
        <header className="app__brand">
          <span className="app__name">Pulse</span>
          <span className="app__tagline">Plans your day with you</span>
        </header>
        {cardBeside && card}
      </main>

      <aside className="app__side">
        {wide ? (
          chat
        ) : (
          <>
            <div className="tabs" role="tablist" aria-label="Panels">
              {(['day', 'chat'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  id={`tab-${t}`}
                  aria-selected={tab === t}
                  aria-controls={`panel-${t}`}
                  className={`tabs__tab${tab === t ? ' is-active' : ''}`}
                  onClick={() => setTab(t)}
                >
                  {t === 'day' ? 'Day' : 'Chat'}
                  {t === 'chat' && session.pendingProposal && <span className="tabs__badge" aria-label="needs approval" />}
                </button>
              ))}
            </div>
            <div className="tabs__panel" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
              {tab === 'day' ? day : chat}
            </div>
          </>
        )}
      </aside>

      <DebugPanel actor={actor} />
    </div>
  )
}
