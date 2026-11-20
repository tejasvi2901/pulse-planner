import type { Block, DayPlan, ScheduleIssue, Task } from './planner.ts'

/**
 * Wire protocol between the browser and /api/chat.
 *
 * The server is stateless: the client keeps the conversation history (opaque
 * Anthropic message params) and the day plan, and sends both with every
 * request. The server streams NDJSON events, one AgentStreamEvent per line.
 */

export interface PlanProposal {
  summary: string
  tasks: Task[]
  blocks: Block[]
  leftOut: { task: string; reason: string }[]
  /** 0 to 1. Below 0.6 is shown as low confidence. */
  confidence: number
  /** Problems the server found when checking the proposal. */
  issues: ScheduleIssue[]
}

export type UserDecision =
  | { decision: 'approve' }
  /** "Keep mine": the user keeps their current plan. */
  | { decision: 'override'; note?: string }
  | { decision: 'ask_why' }

export type ChatInput =
  | { kind: 'message'; text: string }
  | ({ kind: 'decision'; toolUseId: string } & UserDecision)

/**
 * Tool results already produced in the turn that paused for approval. They are
 * sent back with the decision so every result lands in one user message.
 */
export type PendingToolResults = unknown[]

export interface ChatRequest {
  /** Conversation so far, exactly as the server last returned it. Never edited by the client. */
  history: unknown[]
  pending?: PendingToolResults
  input: ChatInput
  /** The user's current plan for today. */
  plan: DayPlan
  /** The user's local time, "HH:MM". */
  now: string
  /** Force the scripted agent even when an API key is configured. */
  scripted?: boolean
}

export type TurnOutcome = 'complete' | 'awaiting_approval' | 'refused'

export type AgentStreamEvent =
  /** Informational banner, e.g. that the scripted agent is running. */
  | { type: 'notice'; text: string; mode: 'live' | 'scripted' }
  /** A chunk of streamed answer text. */
  | { type: 'text'; text: string }
  /** A read-only planning tool call started. */
  | { type: 'tool_call'; id: string; name: string }
  /**
   * A read-only tool finished. `concern` is set when it found that the day
   * doesn't fit (must-dos unscheduled, deadlines missed, overbooked).
   */
  | { type: 'tool_result'; id: string; name: string; input: unknown; output: unknown; isError: boolean; concern?: string }
  /** Pulse proposed a new plan that needs the user's approval. */
  | { type: 'proposal'; id: string; proposal: PlanProposal }
  /** The request finished. Replace local history with `history`. */
  | { type: 'turn_end'; outcome: TurnOutcome; history: unknown[]; pending?: PendingToolResults }
  /** Too many requests; `retryAfter` is in seconds. */
  | { type: 'rate_limited'; message: string; retryAfter: number }
  | { type: 'error'; message: string }

export const READ_TOOLS = ['get_plan', 'find_free_slots', 'check_schedule'] as const
export type ReadTool = (typeof READ_TOOLS)[number]
