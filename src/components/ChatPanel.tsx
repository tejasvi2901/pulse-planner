import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'

import type { AgentSession, TranscriptItem } from '../agent/useAgentSession'
import './ChatPanel.css'

const SUGGESTIONS = [
  'Dentist at 11, finish the report by 3, gym, call mom, groceries if time',
  'I only have the afternoon free. Study for 3 hours and do laundry',
]

const TOOL_LABEL: Record<string, string> = {
  get_plan: 'Read your plan',
  find_free_slots: 'Find free time',
  check_schedule: 'Check the schedule',
}

function summarizeInput(input: unknown) {
  if (!input || typeof input !== 'object') return ''
  return Object.entries(input as Record<string, unknown>)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(', ')
}

function ToolRow({ item }: { item: Extract<TranscriptItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false)
  const args = summarizeInput(item.input)
  return (
    <li className={`tool-row tool-row--${item.status}`}>
      <span className="tool-row__node" aria-hidden="true" />
      <div className="tool-row__body">
        <button
          type="button"
          className="tool-row__head"
          aria-expanded={open}
          disabled={item.status === 'running'}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="tool-row__name">{TOOL_LABEL[item.name] ?? item.name}</span>
          {args && <span className="tool-row__args">{args}</span>}
          <span className="tool-row__status">
            {item.status === 'running'
              ? 'running…'
              : item.status === 'error'
                ? 'failed'
                : `${((item.durationMs ?? 0) / 1000).toFixed(1)}s`}
          </span>
        </button>
        {open && item.output !== undefined && (
          <pre className="tool-row__output">{JSON.stringify(item.output, null, 2)}</pre>
        )}
      </div>
    </li>
  )
}

const PROPOSAL_STATUS: Record<string, string> = {
  pending: 'Waiting for your decision',
  approved: 'Approved, now your plan',
  kept: 'You kept your plan',
  asked: 'You asked why',
}

/** Group consecutive tool calls so they render as one connected timeline. */
function groupItems(items: TranscriptItem[]) {
  const groups: (TranscriptItem | { kind: 'tools'; id: string; tools: Extract<TranscriptItem, { kind: 'tool' }>[] })[] = []
  for (const item of items) {
    const last = groups[groups.length - 1]
    if (item.kind === 'tool') {
      if (last?.kind === 'tools') last.tools.push(item)
      else groups.push({ kind: 'tools', id: `tools-${item.id}`, tools: [item] })
    } else {
      groups.push(item)
    }
  }
  return groups
}

export function ChatPanel({ session, approvalSlot }: { session: AgentSession; approvalSlot?: ReactNode }) {
  const { items, busy, mode, pendingProposal, limitedUntil, send, notifyTyping, reset } = session
  const [draft, setDraft] = useState('')
  const logRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Keep the newest message in view.
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [items])

  const blocked = busy || Boolean(pendingProposal) || limitedUntil !== null
  const retryAt = limitedUntil ? new Date(limitedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    if (!draft.trim() || blocked) return
    send(draft)
    setDraft('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <section className="chat" aria-label="Chat with Pulse">
      <header className="chat__header">
        <div>
          <h2 className="chat__title">Chat</h2>
          {mode && (
            <span className={`mode-badge mode-badge--${mode}`}>{mode === 'live' ? 'Claude' : 'Scripted demo'}</span>
          )}
        </div>
        {items.length > 0 && (
          <button type="button" className="chat__reset" onClick={reset}>
            New chat
          </button>
        )}
      </header>

      <div className="chat__log" ref={logRef} role="log" aria-live="polite" aria-relevant="additions">
        {items.length === 0 && (
          <div className="chat__empty">
            <p>Tell Pulse what's on your plate today. It plans around your appointments and asks before changing anything.</p>
            {SUGGESTIONS.map((s) => (
              <button key={s} type="button" className="suggestion" disabled={blocked} onClick={() => send(s)}>
                {s}
              </button>
            ))}
          </div>
        )}

        {groupItems(items).map((item) => {
          switch (item.kind) {
            case 'user':
              return (
                <p key={item.id} className="msg msg--user">
                  {item.text}
                </p>
              )
            case 'assistant':
              return (
                <p key={item.id} className="msg msg--assistant">
                  {item.text}
                </p>
              )
            case 'tools':
              return (
                <ol key={item.id} className="tool-timeline" aria-label="Tool calls">
                  {item.tools.map((t) => (
                    <ToolRow key={t.id} item={t} />
                  ))}
                </ol>
              )
            case 'proposal':
              return (
                <div key={item.id} className={`proposal-ref proposal-ref--${item.status}`}>
                  <span className="proposal-ref__label">Proposed plan</span>
                  <span className="proposal-ref__title">{item.summary}</span>
                  <span className="proposal-ref__status">{PROPOSAL_STATUS[item.status]}</span>
                </div>
              )
            case 'notice':
              return (
                <p key={item.id} className="chat__notice">
                  {item.text}
                </p>
              )
            case 'error':
              return (
                <p key={item.id} className="chat__error" role="alert">
                  {item.text}
                </p>
              )
            default:
              return null
          }
        })}
      </div>

      {approvalSlot}

      <form className="composer" onSubmit={submit}>
        <label htmlFor="composer-input" className="visually-hidden">
          Message Pulse
        </label>
        <textarea
          id="composer-input"
          ref={inputRef}
          className="composer__input"
          rows={2}
          value={draft}
          placeholder={
            pendingProposal
              ? 'Approve, keep yours, or ask why first'
              : retryAt
                ? `Pulse needs a rest. Try again at ${retryAt}`
                : "What's on your plate today?"
          }
          disabled={Boolean(pendingProposal) || limitedUntil !== null}
          onChange={(e) => {
            setDraft(e.target.value)
            if (e.target.value) notifyTyping()
          }}
          onKeyDown={onKeyDown}
        />
        <button type="submit" className="composer__send" disabled={blocked || !draft.trim()}>
          {busy ? 'Working…' : 'Send'}
        </button>
      </form>
    </section>
  )
}
