/**
 * The day-planning domain, shared by the server tools and the UI.
 * Times are local wall-clock "HH:MM" strings for a single day.
 */

export type Priority = 'must' | 'should' | 'could'
export type BlockKind = 'task' | 'event' | 'break'

export interface Task {
  id: string
  title: string
  /** Estimated duration in minutes. */
  minutes: number
  priority: Priority
  /** Optional deadline, "HH:MM". */
  due?: string
  done: boolean
}

export interface Block {
  id: string
  start: string
  end: string
  title: string
  /** Events are fixed appointments; tasks and breaks can move. */
  kind: BlockKind
  taskId?: string
}

export interface DayPlan {
  /** "YYYY-MM-DD" */
  date: string
  dayStart: string
  dayEnd: string
  tasks: Task[]
  blocks: Block[]
}

export const PLAN_LIMITS = { tasks: 60, blocks: 80, title: 120 } as const

// Time helpers

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/

export const isTime = (s: string) => TIME.test(s)

export function toMinutes(t: string): number {
  const m = TIME.exec(t)
  if (!m) throw new Error(`Invalid time "${t}"`)
  return Number(m[1]) * 60 + Number(m[2])
}

export function toTime(minutes: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.round(minutes)))
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`
}

export const blockMinutes = (b: Block) => toMinutes(b.end) - toMinutes(b.start)

export function emptyPlan(date: string): DayPlan {
  return { date, dayStart: '08:00', dayEnd: '20:00', tasks: [], blocks: [] }
}

export const sortBlocks = (blocks: Block[]) => [...blocks].sort((a, b) => toMinutes(a.start) - toMinutes(b.start))

// Analysis

export interface Slot {
  start: string
  end: string
  minutes: number
}

/** Free gaps between blocks within the working day, optionally starting no earlier than `from`. */
export function freeSlots(plan: DayPlan, minMinutes = 1, from?: string): Slot[] {
  const dayStart = Math.max(toMinutes(plan.dayStart), from ? toMinutes(from) : 0)
  const dayEnd = toMinutes(plan.dayEnd)
  const slots: Slot[] = []
  let cursor = dayStart
  for (const b of sortBlocks(plan.blocks)) {
    const s = toMinutes(b.start)
    const e = toMinutes(b.end)
    if (s > cursor) slots.push({ start: toTime(cursor), end: toTime(Math.min(s, dayEnd)), minutes: Math.min(s, dayEnd) - cursor })
    cursor = Math.max(cursor, e)
    if (cursor >= dayEnd) break
  }
  if (cursor < dayEnd) slots.push({ start: toTime(cursor), end: toTime(dayEnd), minutes: dayEnd - cursor })
  return slots.filter((s) => s.minutes >= minMinutes)
}

export type IssueKind = 'overlap' | 'outside_day' | 'invalid_time' | 'event_changed' | 'must_unscheduled' | 'past_due' | 'overbooked'

export interface ScheduleIssue {
  kind: IssueKind
  message: string
}

/**
 * Problems with a proposed schedule against the current plan:
 * overlaps, blocks outside the day, moved fixed events, must-do tasks not scheduled,
 * deadlines missed, and more task time than free time.
 */
export function checkSchedule(current: DayPlan, blocks: Block[], tasks: Task[] = current.tasks): ScheduleIssue[] {
  const issues: ScheduleIssue[] = []
  const valid = blocks.filter((b) => {
    const ok = isTime(b.start) && isTime(b.end) && toMinutes(b.end) > toMinutes(b.start)
    if (!ok) issues.push({ kind: 'invalid_time', message: `"${b.title}" has an invalid time range ${b.start}–${b.end}.` })
    return ok
  })
  const sorted = sortBlocks(valid)

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]
    const cur = sorted[i]
    if (toMinutes(cur.start) < toMinutes(prev.end)) {
      issues.push({ kind: 'overlap', message: `"${prev.title}" (${prev.start}–${prev.end}) overlaps "${cur.title}" (${cur.start}–${cur.end}).` })
    }
  }

  const dayStart = toMinutes(current.dayStart)
  const dayEnd = toMinutes(current.dayEnd)
  for (const b of sorted) {
    if (b.kind !== 'event' && (toMinutes(b.start) < dayStart || toMinutes(b.end) > dayEnd)) {
      issues.push({ kind: 'outside_day', message: `"${b.title}" runs outside the day (${current.dayStart}–${current.dayEnd}).` })
    }
  }

  for (const ev of current.blocks.filter((b) => b.kind === 'event')) {
    const same = sorted.find((b) => b.kind === 'event' && b.title === ev.title)
    if (!same) issues.push({ kind: 'event_changed', message: `Fixed event "${ev.title}" is missing.` })
    else if (same.start !== ev.start || same.end !== ev.end) {
      issues.push({ kind: 'event_changed', message: `Fixed event "${ev.title}" moved from ${ev.start} to ${same.start}.` })
    }
  }

  const scheduled = new Set(sorted.map((b) => b.taskId).filter(Boolean))
  for (const t of tasks) {
    if (t.done) continue
    const taskBlocks = sorted.filter((b) => b.taskId === t.id)
    if (t.priority === 'must' && !scheduled.has(t.id)) {
      issues.push({ kind: 'must_unscheduled', message: `Must-do "${t.title}" is not scheduled.` })
    }
    if (t.due && taskBlocks.length && taskBlocks.some((b) => toMinutes(b.end) > toMinutes(t.due!))) {
      issues.push({ kind: 'past_due', message: `"${t.title}" finishes after its ${t.due} deadline.` })
    }
  }

  // Only must-dos count: dropping a could-do is normal planning, not a problem.
  const mustMinutes = tasks.filter((t) => !t.done && t.priority === 'must').reduce((sum, t) => sum + t.minutes, 0)
  const freeForTasks =
    dayEnd - dayStart - current.blocks.filter((b) => b.kind === 'event').reduce((sum, b) => sum + blockMinutes(b), 0)
  if (mustMinutes > freeForTasks) {
    issues.push({
      kind: 'overbooked',
      message: `Must-do tasks need ${mustMinutes} min but only ${freeForTasks} min are free between events.`,
    })
  }
  return issues
}

/** Issues that mean the day genuinely doesn't fit, which Pulse shows as uncertainty. */
export const isFitProblem = (issue: ScheduleIssue) => issue.kind === 'must_unscheduled' || issue.kind === 'overbooked' || issue.kind === 'past_due'

// Diffing (for the approval card)

export interface PlanDiff {
  added: Block[]
  removed: Block[]
  moved: { before: Block; after: Block }[]
  unchanged: Block[]
}

const blockKey = (b: Block) => b.taskId ?? `${b.kind}:${b.title.toLowerCase()}`

export function diffPlans(before: Block[], after: Block[]): PlanDiff {
  const remaining = new Map<string, Block[]>()
  for (const b of before) remaining.set(blockKey(b), [...(remaining.get(blockKey(b)) ?? []), b])

  const diff: PlanDiff = { added: [], removed: [], moved: [], unchanged: [] }
  for (const b of sortBlocks(after)) {
    const candidates = remaining.get(blockKey(b))
    const match = candidates?.shift()
    if (!match) diff.added.push(b)
    else if (match.start === b.start && match.end === b.end) diff.unchanged.push(b)
    else diff.moved.push({ before: match, after: b })
  }
  for (const left of remaining.values()) diff.removed.push(...left)
  return diff
}
