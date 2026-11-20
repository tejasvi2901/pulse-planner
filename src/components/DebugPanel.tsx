import { useSelector } from '@xstate/react'
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'

import { PROFILES } from '../character/motionProfiles'
import {
  PULSE_STATES,
  type PulseActorRef,
  type PulseEvent,
  type PulseEventType,
  type PulseSnapshot,
  type PulseState,
} from '../machine/pulseMachine'
import './DebugPanel.css'

const EVENTS: { type: Exclude<PulseEventType, 'DEBUG.GOTO'>; hint: string; extra?: boolean }[] = [
  { type: 'USER_TYPING', hint: 'The user is typing' },
  { type: 'SEND', hint: 'The user sent a message (new turn)' },
  { type: 'TOOL_CALL', hint: 'The agent called a tool (adds a particle)' },
  { type: 'TOKEN', hint: 'One streamed text token' },
  { type: 'NEEDS_APPROVAL', hint: 'A proposed fix needs a human decision' },
  { type: 'APPROVED', hint: 'The user approved the proposed plan' },
  { type: 'OVERRIDDEN', hint: 'The user kept their own plan' },
  { type: 'ASK_WHY', hint: 'The user asked why before deciding', extra: true },
  { type: 'ERROR', hint: 'A tool or model error, or low confidence' },
  { type: 'DONE', hint: 'The response finished, no approval needed', extra: true },
  { type: 'RESET', hint: 'Back to idle and clear the turn', extra: true },
]

const MOCK_TOOLS = ['get_plan', 'find_free_slots', 'check_schedule']

const STATE_LABEL: Record<PulseState, string> = {
  idle: 'Idle',
  listening: 'Listening',
  thinking: 'Thinking',
  explaining: 'Explaining',
  needsApproval: 'Needs approval',
  uncertain: 'Uncertain',
  done: 'Done',
}

type Step = { wait: number; event?: PulseEvent; stream?: number }

const SCENARIOS: Record<string, { label: string; steps: Step[] }> = {
  happy: {
    label: 'Happy path',
    steps: [
      ...Array.from({ length: 6 }, () => ({ wait: 160, event: { type: 'USER_TYPING' } as PulseEvent })),
      { wait: 700, event: { type: 'SEND', text: 'Dentist at 11, finish the report by 3, gym, call mom' } },
      { wait: 1100, event: { type: 'TOOL_CALL', name: 'get_plan' } },
      { wait: 1400, event: { type: 'TOOL_CALL', name: 'find_free_slots' } },
      { wait: 1400, event: { type: 'TOOL_CALL', name: 'check_schedule' } },
      { wait: 1500, stream: 46 },
      { wait: 500, event: { type: 'NEEDS_APPROVAL', proposal: 'Report before lunch, gym at 5' } },
      { wait: 3200, event: { type: 'APPROVED' } },
    ],
  },
  error: {
    label: 'Error path',
    steps: [
      { wait: 200, event: { type: 'SEND', text: 'Eight hours of meetings and a 5-hour must-do' } },
      { wait: 1100, event: { type: 'TOOL_CALL', name: 'check_schedule' } },
      { wait: 1500, event: { type: 'ERROR', message: 'Must-do tasks need more time than is free' } },
      { wait: 2200, stream: 20 },
      { wait: 800, event: { type: 'DONE' } },
    ],
  },
}

interface LogEntry {
  id: number
  time: number
  event: string
  count: number
  from: PulseState
  to: PulseState
  ignored: boolean
}

/** The debug tools appear in development builds, or in any build with ?debug in the URL. */
const DEBUG_REQUESTED = new URLSearchParams(window.location.search).has('debug')
const DEBUG_ENABLED = import.meta.env.DEV || DEBUG_REQUESTED

class Cancelled extends Error {}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Cancelled())
    const id = window.setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      window.clearTimeout(id)
      reject(new Cancelled())
    }, { once: true })
  })
}

/** Fire TOKEN events with a speech-like rhythm: quick bursts and short pauses between phrases. */
async function streamTokens(actor: PulseActorRef, count: number, signal: AbortSignal) {
  for (let i = 0; i < count; i++) {
    actor.send({ type: 'TOKEN' })
    const phraseBreak = i > 0 && i % 11 === 0
    await sleep(phraseBreak ? 420 : 45 + Math.random() * 75, signal)
  }
}

export function DebugPanel({ actor }: { actor: PulseActorRef }) {
  const snapshot = useSelector(actor, (s) => s)
  const state = snapshot.value as PulseState
  const profile = PROFILES[state]

  const [hidden, setHidden] = useState(() => !DEBUG_REQUESTED)
  const [running, setRunning] = useState<string | null>(null)
  const [log, setLog] = useState<LogEntry[]>([])
  const abortRef = useRef<AbortController | null>(null)

  // Event log, read from XState's inspection API so it also captures events sent by the agent later.
  useEffect(() => {
    const t0 = performance.now()
    let prev = actor.getSnapshot()
    let nextId = 0
    const sub = actor.system.inspect((ev) => {
      if (ev.type !== '@xstate.snapshot' || ev.actorRef !== actor) return
      if (ev.event.type.startsWith('xstate.')) return
      const snap = ev.snapshot as PulseSnapshot
      const entry: LogEntry = {
        id: nextId++,
        time: (performance.now() - t0) / 1000,
        event: ev.event.type === 'DEBUG.GOTO' ? `GOTO ${(ev.event as PulseEvent & { type: 'DEBUG.GOTO' }).state}` : ev.event.type,
        count: 1,
        from: prev.value as PulseState,
        to: snap.value as PulseState,
        ignored: snap === prev,
      }
      prev = snap
      setLog((entries) => {
        const last = entries[0]
        // Collapse token streams into one row.
        if (last && last.event === entry.event && last.from === last.to && entry.from === entry.to && last.ignored === entry.ignored) {
          return [{ ...last, count: last.count + 1, time: entry.time }, ...entries.slice(1)]
        }
        return [entry, ...entries].slice(0, 40)
      })
    })
    return () => sub.unsubscribe()
  }, [actor])

  const stop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setRunning(null)
  }, [])

  useEffect(() => stop, [stop])

  const run = useCallback(
    async (key: string, task: (signal: AbortSignal) => Promise<void>) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      setRunning(key)
      try {
        await task(controller.signal)
      } catch (err) {
        if (!(err instanceof Cancelled)) throw err
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null
          setRunning(null)
        }
      }
    },
    [],
  )

  const playScenario = (key: string) =>
    run(key, async (signal) => {
      actor.send({ type: 'RESET' })
      for (const step of SCENARIOS[key].steps) {
        await sleep(step.wait, signal)
        if (step.event) actor.send(step.event)
        if (step.stream) await streamTokens(actor, step.stream, signal)
      }
    })

  const toolCount = snapshot.context.toolCalls.length

  const fire = (type: (typeof EVENTS)[number]['type']) => {
    if (type === 'TOOL_CALL') {
      actor.send({ type, name: MOCK_TOOLS[toolCount % MOCK_TOOLS.length] })
    } else if (type === 'ERROR') {
      actor.send({ type, message: 'Tool returned conflicting results' })
    } else {
      actor.send({ type } as PulseEvent)
    }
  }

  // Keys 1 to 7 jump straight to a state (development builds, or with ?debug).
  useEffect(() => {
    if (!DEBUG_ENABLED) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return
      const index = Number(e.key) - 1
      if (index >= 0 && index < PULSE_STATES.length) {
        actor.send({ type: 'DEBUG.GOTO', state: PULSE_STATES[index] })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actor])

  // The panel stays mounted while hidden, so running scenarios and the event log keep going.
  return (
    <>
      {hidden && DEBUG_ENABLED && (
        <button type="button" className="debug-reopen" onClick={() => setHidden(false)}>
          Debug
        </button>
      )}
      <aside className="debug" hidden={hidden} aria-label="Debug controls" style={{ '--accent': profile.rim } as CSSProperties}>
        <header className="debug__header">
          <span className="debug__title">Debug</span>
          <button type="button" className="debug__link" onClick={() => setHidden(true)}>
            Hide
          </button>
        </header>

        <section className="debug__section debug__now">
          <div className="state-pill" aria-live="polite">
            <span className="state-pill__dot" />
            {STATE_LABEL[state]}
          </div>
          <p className="debug__intent">{profile.intent}</p>
          <dl className="debug__context">
            <div>
              <dt>Tool calls</dt>
              <dd>{toolCount ? snapshot.context.toolCalls.join(', ') : '—'}</dd>
            </div>
            <div>
              <dt>Tokens</dt>
              <dd>{snapshot.context.tokenCount}</dd>
            </div>
            {snapshot.context.lastError && (
              <div>
                <dt>Error</dt>
                <dd>{snapshot.context.lastError}</dd>
              </div>
            )}
          </dl>
        </section>

        <section className="debug__section">
          <h2 className="debug__heading">Events</h2>
          <div className="event-grid">
            {EVENTS.map(({ type, hint, extra }) => {
              const enabled = snapshot.can(
                type === 'TOOL_CALL' ? { type, name: 'x' } : ({ type } as PulseEvent),
              )
              return (
                <button
                  key={type}
                  type="button"
                  className={`event-btn${extra ? ' event-btn--extra' : ''}`}
                  disabled={!enabled}
                  title={hint}
                  onClick={() => fire(type)}
                >
                  {type}
                </button>
              )
            })}
          </div>
          <button
            type="button"
            className="wide-btn"
            disabled={!snapshot.can({ type: 'TOKEN' }) || running === 'stream'}
            onClick={() => run('stream', (signal) => streamTokens(actor, 40, signal))}
          >
            {running === 'stream' ? 'Streaming…' : 'Stream 40 tokens'}
          </button>
        </section>

        <section className="debug__section">
          <h2 className="debug__heading">Scenarios</h2>
          <div className="scenario-row">
            {Object.entries(SCENARIOS).map(([key, s]) => (
              <button
                key={key}
                type="button"
                className={`wide-btn${running === key ? ' is-running' : ''}`}
                onClick={() => (running === key ? stop() : playScenario(key))}
              >
                {running === key ? 'Stop' : `▶ ${s.label}`}
              </button>
            ))}
          </div>
        </section>

        <section className="debug__section">
          <h2 className="debug__heading">
            Jump to state <span className="debug__kbd-hint">keys 1–7</span>
          </h2>
          <div className="state-grid">
            {PULSE_STATES.map((s, i) => (
              <button
                key={s}
                type="button"
                className={`state-chip${s === state ? ' is-active' : ''}`}
                style={{ '--chip': PROFILES[s].rim } as CSSProperties}
                aria-pressed={s === state}
                onClick={() => actor.send({ type: 'DEBUG.GOTO', state: s })}
              >
                <span className="state-chip__dot" />
                <span className="state-chip__label">{STATE_LABEL[s]}</span>
                <kbd>{i + 1}</kbd>
              </button>
            ))}
          </div>
        </section>

        <section className="debug__section debug__log-section">
          <h2 className="debug__heading">
            Event log
            {log.length > 0 && (
              <button type="button" className="debug__link" onClick={() => setLog([])}>
                Clear
              </button>
            )}
          </h2>
          <ol className="event-log">
            {log.length === 0 && <li className="event-log__empty">Fire an event to see transitions.</li>}
            {log.map((entry) => (
              <li key={entry.id} className={entry.ignored ? 'is-ignored' : undefined}>
                <span className="event-log__time">{entry.time.toFixed(1)}s</span>
                <span className="event-log__event">
                  {entry.event}
                  {entry.count > 1 && <span className="event-log__count">×{entry.count}</span>}
                </span>
                <span className="event-log__transition">
                  {entry.ignored ? 'ignored' : entry.from === entry.to ? entry.to : `${entry.from} → ${entry.to}`}
                </span>
              </li>
            ))}
          </ol>
        </section>
      </aside>
    </>
  )
}
