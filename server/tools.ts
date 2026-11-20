import type Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'

import type { PlanProposal, ReadTool } from '../shared/agentProtocol.ts'
import {
  PLAN_LIMITS,
  checkSchedule,
  freeSlots,
  isFitProblem,
  sortBlocks,
  type Block,
  type DayPlan,
  type Task,
} from '../shared/planner.ts'

/*
 * Planning tools. The read-only ones compute on the plan the browser sent with
 * the request; propose_plan is gated: it pauses the agent until the user
 * approves, keeps their plan, or asks why.
 */

const time = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'Use 24-hour HH:MM')
const title = z.string().trim().min(1).max(PLAN_LIMITS.title)

export const TaskSchema = z.object({
  id: z.string().min(1).max(60),
  title,
  minutes: z.number().int().min(5).max(16 * 60),
  priority: z.enum(['must', 'should', 'could']),
  due: time.optional(),
  done: z.boolean(),
})

export const BlockSchema = z.object({
  id: z.string().min(1).max(60),
  start: time,
  end: time,
  title,
  kind: z.enum(['task', 'event', 'break']),
  taskId: z.string().max(60).optional(),
})

export const PlanSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dayStart: time,
  dayEnd: time,
  tasks: z.array(TaskSchema).max(PLAN_LIMITS.tasks),
  blocks: z.array(BlockSchema).max(PLAN_LIMITS.blocks),
})

/** What the model sends: ids are optional for new items, snake_case like the tool schemas. */
const TaskIn = z.object({
  id: z.string().max(60).optional(),
  title,
  minutes: z.number().int().min(5).max(16 * 60),
  priority: z.enum(['must', 'should', 'could']),
  due: time.optional(),
  done: z.boolean().optional(),
})

const BlockIn = z.object({
  start: time,
  end: time,
  title,
  kind: z.enum(['task', 'event', 'break']),
  task_id: z.string().max(60).optional(),
})

export const ToolInputs = {
  get_plan: z.object({}),
  find_free_slots: z.object({ min_minutes: z.number().int().min(5).max(600).optional(), from: time.optional() }),
  check_schedule: z.object({
    blocks: z.array(BlockIn).max(PLAN_LIMITS.blocks),
    tasks: z.array(TaskIn).max(PLAN_LIMITS.tasks).optional(),
  }),
} satisfies Record<ReadTool, z.ZodType>

export const ProposalInput = z.object({
  summary: z.string().min(1).max(600),
  tasks: z.array(TaskIn).max(PLAN_LIMITS.tasks),
  blocks: z.array(BlockIn).max(PLAN_LIMITS.blocks),
  left_out: z.array(z.object({ task: z.string().max(PLAN_LIMITS.title), reason: z.string().max(300) })).max(30).default([]),
  confidence: z.number().min(0).max(1),
})

export const isReadTool = (name: string): name is ReadTool => name in ToolInputs

let idSerial = 0
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(idSerial++).toString(36)}`

/**
 * Turn the model's draft into real tasks and blocks. Existing tasks keep their
 * ids; new tasks get real ids, and blocks that referenced them by a temporary
 * id (e.g. "new-1") or by title are linked to them.
 */
function normalizeDraft(
  tasksIn: z.infer<typeof TaskIn>[] | undefined,
  blocksIn: z.infer<typeof BlockIn>[],
  current: DayPlan,
): { tasks: Task[]; blocks: Block[] } {
  const draftIds = new Map<string, string>()
  const tasks: Task[] = (tasksIn ?? current.tasks).map((t) => {
    const existing = t.id ? current.tasks.find((c) => c.id === t.id) : undefined
    const id = existing?.id ?? newId('t')
    if (t.id) draftIds.set(t.id, id)
    return { id, title: t.title, minutes: t.minutes, priority: t.priority, due: t.due, done: t.done ?? existing?.done ?? false }
  })
  const byTitle = new Map(tasks.map((t) => [t.title.toLowerCase(), t.id]))
  const blocks = sortBlocks(
    blocksIn.map((b) => ({
      id: newId('b'),
      start: b.start,
      end: b.end,
      title: b.title,
      kind: b.kind,
      taskId: b.kind === 'task' ? ((b.task_id && draftIds.get(b.task_id)) || byTitle.get(b.title.toLowerCase())) : undefined,
    })),
  )
  return { tasks, blocks }
}

/** Turn the model's proposal into a full plan the browser can adopt. */
export function toProposal(input: z.infer<typeof ProposalInput>, current: DayPlan): PlanProposal {
  const { tasks, blocks } = normalizeDraft(input.tasks, input.blocks, current)
  return {
    summary: input.summary,
    tasks,
    blocks,
    leftOut: input.left_out,
    confidence: input.confidence,
    issues: checkSchedule(current, blocks, tasks),
  }
}

export interface ReadResult {
  output: unknown
  /** Set when the result shows the day doesn't fit. */
  concern?: string
}

export function runReadTool(name: ReadTool, rawInput: unknown, plan: DayPlan, now: string): ReadResult {
  switch (name) {
    case 'get_plan': {
      ToolInputs.get_plan.parse(rawInput)
      return {
        output: {
          date: plan.date,
          now,
          day: `${plan.dayStart}–${plan.dayEnd}`,
          tasks: plan.tasks,
          schedule: sortBlocks(plan.blocks),
          free_from_now: freeSlots(plan, 5, now),
        },
      }
    }
    case 'find_free_slots': {
      const input = ToolInputs.find_free_slots.parse(rawInput)
      return { output: { slots: freeSlots(plan, input.min_minutes ?? 15, input.from ?? now) } }
    }
    case 'check_schedule': {
      const input = ToolInputs.check_schedule.parse(rawInput)
      const { tasks, blocks } = normalizeDraft(input.tasks, input.blocks, plan)
      const issues = checkSchedule(plan, blocks, tasks)
      const fit = issues.filter(isFitProblem)
      return {
        output: { ok: issues.length === 0, issues },
        concern: fit.length ? fit[0].message : undefined,
      }
    }
  }
}

const TASK_JSON_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Existing task id, or a temporary id such as "new-1" for a new task' },
    title: { type: 'string' },
    minutes: { type: 'integer', description: 'Realistic estimate' },
    priority: { type: 'string', enum: ['must', 'should', 'could'] },
    due: { type: 'string', description: 'Deadline HH:MM, if any' },
    done: { type: 'boolean' },
  },
  required: ['id', 'title', 'minutes', 'priority'],
} as const

const BLOCK_JSON_SCHEMA = {
  type: 'object',
  properties: {
    start: { type: 'string', description: '24-hour HH:MM' },
    end: { type: 'string', description: '24-hour HH:MM' },
    title: { type: 'string' },
    kind: { type: 'string', enum: ['task', 'event', 'break'], description: 'event = fixed appointment' },
    task_id: { type: 'string', description: "For task blocks: the id of the task it works on (existing id, or the temporary id you gave a new task)" },
  },
  required: ['start', 'end', 'title', 'kind'],
} as const

export const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'get_plan',
    description:
      "Read the user's current plan for today: tasks, scheduled blocks, working hours, the current time and free time from now. Call this first in a conversation, and again if the user says they changed something.",
    eager_input_streaming: true,
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'find_free_slots',
    description: 'List free gaps in the current schedule. Call this when you need to know where a task of a given length could go.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        min_minutes: { type: 'integer', description: 'Only return gaps at least this long (default 15)' },
        from: { type: 'string', description: 'Earliest start, HH:MM (default: now)' },
      },
    },
  },
  {
    name: 'check_schedule',
    description:
      'Check a draft before proposing it: overlaps, fixed events moved, blocks outside the day, must-do tasks left out, deadlines missed, overbooking. Pass the same tasks and blocks you intend to propose. Call this on your draft before propose_plan.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        tasks: { type: 'array', items: TASK_JSON_SCHEMA, description: 'All tasks in the draft (defaults to the current tasks)' },
        blocks: { type: 'array', items: BLOCK_JSON_SCHEMA },
      },
      required: ['blocks'],
    },
  },
  {
    name: 'propose_plan',
    description:
      "Propose the full plan for the rest of today. Nothing changes until the user approves; they may keep their own plan or ask why. Include every task (existing ones with their id, new ones without) and every block, including fixed events. Call it on its own, not alongside other tools, and never describe the plan as already in place.",
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One or two sentences describing the plan' },
        tasks: { type: 'array', items: TASK_JSON_SCHEMA },
        blocks: { type: 'array', items: BLOCK_JSON_SCHEMA },
        left_out: {
          type: 'array',
          description: 'Tasks that did not fit today, with a short reason',
          items: {
            type: 'object',
            properties: { task: { type: 'string' }, reason: { type: 'string' } },
            required: ['task', 'reason'],
          },
        },
        confidence: { type: 'number', description: 'How confident you are this plan works, 0 to 1' },
      },
      required: ['summary', 'tasks', 'blocks', 'confidence'],
    },
  },
]
