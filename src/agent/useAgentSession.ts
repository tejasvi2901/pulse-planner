import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  AgentStreamEvent,
  ChatRequest,
  UserDecision,
  PendingToolResults,
  PlanProposal,
} from '../../shared/agentProtocol'
import type { PulseActorRef } from '../machine/pulseMachine'
import { nowString, readStored, todayString, writeStored, type PlanApi } from '../planner/usePlan'
import { machineEventFor, machineEventForDecision } from './eventMapping'

export type ToolStatus = 'running' | 'ok' | 'error'
export type ProposalStatus = 'pending' | 'approved' | 'kept' | 'asked'

export type TranscriptItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'tool'; id: string; name: string; status: ToolStatus; input?: unknown; output?: unknown; startedAt: number; durationMs?: number }
  | { kind: 'proposal'; id: string; summary: string; status: ProposalStatus }
  | { kind: 'notice'; id: string; text: string }
  | { kind: 'error'; id: string; text: string }

export type AgentMode = 'live' | 'scripted'

interface PendingProposal {
  itemId: string
  toolUseId: string
  proposal: PlanProposal
}

/** What survives a reload (same day only). */
interface StoredChat {
  date: string
  items: TranscriptItem[]
  history: unknown[]
  pending?: PendingToolResults
  pendingProposal: PendingProposal | null
  mode: AgentMode | null
}

const KEY = 'pulse.chat.v1'

let itemSerial = 0
const nextId = () => `item-${Date.now().toString(36)}-${itemSerial++}`

const forceScripted = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('scripted')

function loadChat(): StoredChat | null {
  const stored = readStored<StoredChat>(KEY)
  if (!stored || stored.date !== todayString()) return null
  // A tool still "running" was interrupted by the reload.
  stored.items = stored.items.map((x) => (x.kind === 'tool' && x.status === 'running' ? { ...x, status: 'error' } : x))
  return stored
}

/**
 * Owns the conversation with /api/chat: keeps the opaque history, streams
 * events into a transcript, forwards each event to Pulse's state machine, and
 * adopts a proposed plan only when the user approves it.
 */
export function useAgentSession(actor: PulseActorRef, planApi: PlanApi) {
  const [initial] = useState(loadChat)
  const [items, setItems] = useState<TranscriptItem[]>(initial?.items ?? [])
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<AgentMode | null>(initial?.mode ?? null)
  const [pendingProposal, setPendingProposal] = useState<PendingProposal | null>(initial?.pendingProposal ?? null)
  const [limitedUntil, setLimitedUntil] = useState<number | null>(null)

  const history = useRef<unknown[]>(initial?.history ?? [])
  const pending = useRef<PendingToolResults | undefined>(initial?.pending)
  const abortRef = useRef<AbortController | null>(null)
  const lastTyping = useRef(0)
  const modeRef = useRef<AgentMode | null>(initial?.mode ?? null)
  const planRef = useRef(planApi.plan)
  useEffect(() => {
    planRef.current = planApi.plan
  }, [planApi.plan])

  // Restore Pulse's posture if a proposal was waiting when the page was reloaded.
  useEffect(() => {
    if (initial?.pendingProposal) actor.send({ type: 'DEBUG.GOTO', state: 'needsApproval' })
  }, [actor, initial])

  // Persist after each completed request (not mid-stream).
  useEffect(() => {
    if (busy) return
    writeStored(KEY, {
      date: todayString(),
      items,
      history: history.current,
      pending: pending.current,
      pendingProposal,
      mode,
    } satisfies StoredChat)
  }, [busy, items, pendingProposal, mode])

  // Clear the rate-limit lock when it expires.
  useEffect(() => {
    if (!limitedUntil) return
    const id = window.setTimeout(() => setLimitedUntil(null), Math.max(0, limitedUntil - Date.now()))
    return () => window.clearTimeout(id)
  }, [limitedUntil])

  const apply = useCallback(
    (event: AgentStreamEvent) => {
      const machineEvent = machineEventFor(event)
      if (machineEvent) actor.send(machineEvent)

      switch (event.type) {
        case 'notice':
          if (modeRef.current !== event.mode) {
            modeRef.current = event.mode
            setMode(event.mode)
            if (event.mode === 'scripted') setItems((xs) => [...xs, { kind: 'notice', id: nextId(), text: event.text }])
          }
          break
        case 'text':
          setItems((xs) => {
            const last = xs[xs.length - 1]
            if (last?.kind === 'assistant') return [...xs.slice(0, -1), { ...last, text: last.text + event.text }]
            return [...xs, { kind: 'assistant', id: nextId(), text: event.text.trimStart() }]
          })
          break
        case 'tool_call':
          setItems((xs) => [...xs, { kind: 'tool', id: event.id, name: event.name, status: 'running', startedAt: performance.now() }])
          break
        case 'tool_result':
          setItems((xs) => {
            const done = (x: Extract<TranscriptItem, { kind: 'tool' }>) => ({
              ...x,
              status: (event.isError ? 'error' : 'ok') as ToolStatus,
              input: event.input,
              output: event.output,
              durationMs: performance.now() - x.startedAt,
            })
            if (!xs.some((x) => x.kind === 'tool' && x.id === event.id)) {
              return [...xs, done({ kind: 'tool', id: event.id, name: event.name, status: 'running', startedAt: performance.now() })]
            }
            return xs.map((x) => (x.kind === 'tool' && x.id === event.id ? done(x) : x))
          })
          break
        case 'proposal': {
          const itemId = nextId()
          setItems((xs) => [...xs, { kind: 'proposal', id: itemId, summary: event.proposal.summary, status: 'pending' }])
          setPendingProposal({ itemId, toolUseId: event.id, proposal: event.proposal })
          break
        }
        case 'turn_end':
          history.current = event.history
          pending.current = event.pending
          break
        case 'rate_limited':
          setLimitedUntil(Date.now() + event.retryAfter * 1000)
          setItems((xs) => [...xs, { kind: 'error', id: nextId(), text: event.message }])
          break
        case 'error':
          setItems((xs) => [...xs, { kind: 'error', id: nextId(), text: event.message }])
          break
      }
    },
    [actor],
  )

  /** Returns true when the server finished the turn (sent turn_end). */
  const post = useCallback(
    async (body: Omit<ChatRequest, 'plan' | 'now'>): Promise<boolean> => {
      let finished = false
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      setBusy(true)
      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, plan: planRef.current, now: nowString() } satisfies ChatRequest),
          signal: controller.signal,
        })
        if (res.status === 429) {
          apply((await res.json()) as AgentStreamEvent)
          return false
        }
        if (!res.ok || !res.body) throw new Error(`Request failed (${res.status})`)

        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
        let buffer = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += value
          let newline: number
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).trim()
            buffer = buffer.slice(newline + 1)
            if (!line) continue
            const event = JSON.parse(line) as AgentStreamEvent
            if (event.type === 'turn_end') finished = true
            apply(event)
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          apply({ type: 'error', message: err instanceof Error ? err.message : 'Connection lost' })
        }
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null
          setBusy(false)
        }
      }
      return finished
    },
    [apply],
  )

  const limited = limitedUntil !== null

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      if (!trimmed || busy || pendingProposal || limited) return
      setItems((xs) => [...xs, { kind: 'user', id: nextId(), text: trimmed }])
      actor.send({ type: 'SEND', text: trimmed })
      void post({ history: history.current, input: { kind: 'message', text: trimmed }, scripted: forceScripted || undefined })
    },
    [actor, busy, limited, pendingProposal, post],
  )

  const decide = useCallback(
    (decision: UserDecision) => {
      if (!pendingProposal || busy) return
      const status: ProposalStatus =
        decision.decision === 'approve' ? 'approved' : decision.decision === 'override' ? 'kept' : 'asked'
      if (decision.decision === 'approve') planApi.adopt(pendingProposal.proposal)
      setItems((xs) => xs.map((x) => (x.kind === 'proposal' && x.id === pendingProposal.itemId ? { ...x, status } : x)))
      setPendingProposal(null)
      actor.send(machineEventForDecision(decision.decision))
      const waiting = pendingProposal
      void post({
        history: history.current,
        pending: pending.current,
        input: { kind: 'decision', toolUseId: waiting.toolUseId, ...decision },
        scripted: forceScripted || undefined,
      }).then((finished) => {
        // If the decision never reached Claude, the proposal is still open: put the card back,
        // otherwise the next message would leave the proposal unanswered.
        if (finished) return
        setPendingProposal(waiting)
        setItems((xs) => xs.map((x) => (x.kind === 'proposal' && x.id === waiting.itemId ? { ...x, status: 'pending' } : x)))
        actor.send({ type: 'DEBUG.GOTO', state: 'needsApproval' })
      })
    },
    [actor, busy, pendingProposal, planApi, post],
  )

  /** Call on every keystroke; Pulse hears it at most every 300 ms. */
  const notifyTyping = useCallback(() => {
    const now = performance.now()
    if (now - lastTyping.current < 300) return
    lastTyping.current = now
    actor.send({ type: 'USER_TYPING' })
  }, [actor])

  /** Start the conversation over (the plan itself is reset separately). */
  const reset = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    history.current = []
    pending.current = undefined
    modeRef.current = null
    setItems([])
    setBusy(false)
    setMode(null)
    setPendingProposal(null)
    writeStored(KEY, null)
    actor.send({ type: 'RESET' })
  }, [actor])

  return { items, busy, mode, pendingProposal, limitedUntil, send, decide, notifyTyping, reset }
}

export type AgentSession = ReturnType<typeof useAgentSession>
