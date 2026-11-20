import type { AgentStreamEvent, ChatRequest, PlanProposal } from '../shared/agentProtocol.ts'
import {
  checkSchedule,
  freeSlots,
  isFitProblem,
  toMinutes,
  toTime,
  type Block,
  type DayPlan,
  type Priority,
  type Task,
} from '../shared/planner.ts'
import { runReadTool } from './tools.ts'

/*
 * A scripted stand-in for the live agent, used when no API key is configured
 * (or when the client asks for it). It parses the user's list with simple
 * rules, schedules it greedily with the same planner helpers the live tools
 * use, and emits the same events as the live agent.
 * Its history is plain text, so it can't be continued by the live agent.
 */

type Line = { role: 'user' | 'assistant'; content: string; dump?: string }

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const id = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(id)
      reject(signal.reason)
    })
  })

let serial = 0
const nextId = (p: string) => `${p}_scripted_${Date.now().toString(36)}_${serial++}`

// Parsing

const ESTIMATES: [RegExp, number][] = [
  [/\b(report|essay|deck|slides|proposal|write|study|homework|code|review)\b/i, 120],
  [/\b(gym|run|workout|yoga|swim)\b/i, 60],
  [/\b(groceries|shopping|errand|laundry|clean)\b/i, 45],
  [/\b(call|email|text|reply|pay|book)\b/i, 20],
]

/** "11", "11am", "3pm", "15:30", "3:30 pm" -> minutes after midnight. Bare 1–7 are read as afternoon. */
function parseClock(raw: string): number | null {
  const m = raw.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i)
  if (!m) return null
  let h = Number(m[1])
  const min = Number(m[2] ?? 0)
  const ampm = m[3]?.toLowerCase()
  if (ampm === 'pm' && h < 12) h += 12
  if (ampm === 'am' && h === 12) h = 0
  if (!ampm && h >= 1 && h <= 7) h += 12
  return h > 23 || min > 59 ? null : h * 60 + min
}

interface Parsed {
  tasks: Task[]
  events: Block[]
}

function parseDump(text: string): Parsed {
  const parts = text
    .split(/,|;|\n|\band then\b|\bthen\b|\band\b/i)
    .map((s) => s.trim().replace(/^(i (need|have) to|i'd like to|also|plus)\s+/i, ''))
    .filter((s) => s.length > 1)

  const tasks: Task[] = []
  const events: Block[] = []
  for (const part of parts) {
    const at = part.match(/\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i)
    const by = part.match(/\b(?:by|before)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i)
    const clean = (s: string) => s.replace(/\s+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase())

    if (at && parseClock(at[1]) !== null) {
      const start = parseClock(at[1])!
      events.push({ id: nextId('b'), start: toTime(start), end: toTime(start + 45), title: clean(part.replace(at[0], '')), kind: 'event' })
      continue
    }
    const due = by ? parseClock(by[1]) : null
    const optional = /\b(maybe|if (?:there's )?time)\b/i
    const title = clean((by ? part.replace(by[0], '') : part).replace(optional, ''))
    const minutes = ESTIMATES.find(([re]) => re.test(title))?.[1] ?? 30
    const priority: Priority = due !== null || /\b(must|urgent|important)\b/i.test(part) ? 'must' : optional.test(part) ? 'could' : 'should'
    tasks.push({ id: nextId('t'), title, minutes, priority, due: due !== null ? toTime(due) : undefined, done: false })
  }
  return { tasks, events }
}

// Scheduling

const RANK: Record<Priority, number> = { must: 0, should: 1, could: 2 }

function schedule(plan: DayPlan, parsed: Parsed, now: string) {
  const tasks = [...plan.tasks.filter((t) => !t.done), ...parsed.tasks]
  const blocks: Block[] = [...plan.blocks.filter((b) => b.kind === 'event'), ...parsed.events]
  const leftOut: { task: string; reason: string }[] = []
  const from = toTime(Math.max(toMinutes(now) + 5, toMinutes(plan.dayStart)))

  const ordered = [...tasks].sort(
    (a, b) => RANK[a.priority] - RANK[b.priority] || (a.due ? toMinutes(a.due) : 9999) - (b.due ? toMinutes(b.due) : 9999),
  )
  for (const task of ordered) {
    const slot = freeSlots({ ...plan, blocks }, task.minutes, from)[0]
    if (!slot) {
      leftOut.push({ task: task.title, reason: 'No gap long enough is left today.' })
      continue
    }
    const start = toMinutes(slot.start)
    blocks.push({ id: nextId('b'), start: slot.start, end: toTime(start + task.minutes), title: task.title, kind: 'task', taskId: task.id })
    // A short break after long work, if there's room.
    if (task.minutes >= 90 && slot.minutes >= task.minutes + 15) {
      blocks.push({ id: nextId('b'), start: toTime(start + task.minutes), end: toTime(start + task.minutes + 15), title: 'Break', kind: 'break' })
    }
  }
  return { tasks, blocks, leftOut }
}

function buildProposal(plan: DayPlan, dump: string, now: string): PlanProposal {
  const { tasks, blocks, leftOut } = schedule(plan, parseDump(dump), now)
  const issues = checkSchedule(plan, blocks, tasks)
  const fitProblems = issues.filter(isFitProblem).length
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
  const fitted = blocks.filter((b) => b.kind === 'task').length
  const events = blocks.filter((b) => b.kind === 'event').length
  return {
    summary: `${n(fitted, 'task')} fitted around ${n(events, 'fixed appointment')}, with deadline and must-do work first.`,
    tasks,
    blocks,
    leftOut,
    confidence: fitProblems ? 0.5 : leftOut.length ? 0.7 : 0.85,
    issues,
  }
}

// The script

export async function* runScriptedAgent(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<AgentStreamEvent> {
  const history = [...(request.history as Line[])]
  const { plan, now } = request
  const said: string[] = []

  async function* say(text: string): AsyncGenerator<AgentStreamEvent> {
    said.push(text)
    const words = text.split(/(?<=\s)/)
    for (const w of words) {
      yield { type: 'text', text: w }
      await sleep(/[.,]\s$/.test(w) ? 200 : 30 + Math.random() * 40, signal)
    }
  }

  async function* tool(name: 'get_plan' | 'find_free_slots' | 'check_schedule', input: Record<string, unknown>): AsyncGenerator<AgentStreamEvent> {
    const id = nextId('toolu')
    yield { type: 'tool_call', id, name }
    await sleep(500 + Math.random() * 400, signal)
    const { output, concern } = runReadTool(name, input, plan, now)
    yield { type: 'tool_result', id, name, input, output, isError: false, concern }
  }

  const finish = (outcome: 'complete' | 'awaiting_approval', userText: string, dump?: string): AgentStreamEvent => {
    history.push({ role: 'user', content: userText, dump }, { role: 'assistant', content: said.join(' ') })
    return { type: 'turn_end', outcome, history, pending: [] }
  }

  async function* propose(dump: string, proposal: PlanProposal): AsyncGenerator<AgentStreamEvent> {
    yield* tool('check_schedule', {
      blocks: proposal.blocks.map((b) => ({ start: b.start, end: b.end, title: b.title, kind: b.kind, task_id: b.taskId })),
    })
    const fit = proposal.issues.some(isFitProblem) || proposal.leftOut.length > 0
    yield* say(
      fit
        ? " Today is tight, so not everything fits. I've kept your appointments fixed and put the must-dos first. Have a look before you approve."
        : " Everything fits, with your appointments untouched and the deadline work first. Take a look and approve it if it works for you.",
    )
    yield { type: 'proposal', id: nextId('toolu'), proposal }
    yield finish('awaiting_approval', dump, dump)
  }

  yield {
    type: 'notice',
    mode: 'scripted',
    text: request.scripted
      ? 'Scripted demo mode: Pulse plans with simple rules instead of Claude.'
      : 'Scripted demo: no API key is configured, so Pulse plans with simple rules instead of Claude.',
  }
  await sleep(700, signal)

  const input = request.input
  if (input.kind === 'decision') {
    const dump = [...history].reverse().find((l) => l.dump)?.dump ?? ''
    if (input.decision === 'approve') {
      yield* say("Done, that's your plan for today. Tick things off as you go, and tell me if anything moves.")
      yield finish('complete', '[approved]')
    } else if (input.decision === 'override') {
      yield* say("No problem, you're keeping your plan. I'm here if you want another pass.")
      yield finish('complete', '[kept own plan]')
    } else {
      yield* say(
        'I kept every appointment exactly where it was, then filled the gaps from your current time onward. Deadline and must-do work goes first, then the rest by priority, with a short break after anything long.',
      )
      yield* propose(dump, buildProposal(plan, dump, now))
    }
    return
  }

  const parsed = parseDump(input.text)
  if (parsed.tasks.length + parsed.events.length === 0 || input.text.trim().split(/\s+/).length < 2) {
    yield* say("I'm Pulse. Tell me what's on your plate today, like \"dentist at 11, finish the report by 3, gym, call mom\", and I'll plan it with you.")
    yield finish('complete', input.text)
    return
  }

  yield* say("Let's plan it. First I'll look at what's already on your day.")
  yield* tool('get_plan', {})
  yield* say(` I count ${parsed.events.length} appointment${parsed.events.length === 1 ? '' : 's'} and ${parsed.tasks.length} task${parsed.tasks.length === 1 ? '' : 's'}. Finding the free time around them.`)
  yield* tool('find_free_slots', { min_minutes: 20 })
  yield* propose(input.text, buildProposal(plan, input.text, now))
}
