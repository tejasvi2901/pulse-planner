import Anthropic from '@anthropic-ai/sdk'

import type { AgentStreamEvent, ChatRequest, PlanProposal } from '../shared/agentProtocol.ts'
import { ProposalInput, TOOLS, ToolInputs, isReadTool, runReadTool, toProposal } from './tools.ts'

type MessageParam = Anthropic.Beta.BetaMessageParam
type ContentBlock = Anthropic.Beta.BetaContentBlock
type ToolUseBlock = Anthropic.Beta.BetaToolUseBlock
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam

const MODEL = 'claude-opus-5-5'
const MAX_MODEL_CALLS = 8
const MAX_JSON_RETRIES = 2
/** Stands in for unfinished work when a response is cut off; never shown to the user. */
const INTERRUPTED = 'This part of the response was interrupted before it finished.'

const SYSTEM_PROMPT = `You are Pulse, a friendly companion that helps people plan their day.

How you work:
- When someone tells you what's on their plate, first say in one short, friendly sentence what you're about to do, then read their current plan with get_plan and draft a schedule for the rest of today.
- Fixed appointments are events: keep them exactly where they are. Give tasks realistic durations, put deadline-driven and must-do work first, and leave short breaks between long stretches. Never schedule anything before the current time.
- Give each new task a temporary id ("new-1", "new-2", ...) and use it as task_id on the blocks that work on it; keep existing tasks' ids.
- Check your draft with check_schedule (same tasks and blocks) before proposing it. If the day can't hold everything, say so plainly and leave out the least important tasks, saying why.
- You can't change the plan yourself. Propose the complete plan with propose_plan; the user approves it, keeps their own plan, or asks why. Never describe a plan as in place until a tool result says the user approved it.
- If they ask why, explain your reasoning in two to four sentences, then propose again (revise it if their question changes your view). If they keep their own plan, acknowledge it in one sentence and don't propose again unless asked.
- For small talk or questions that don't need a plan change, just answer.

Style: warm, plain sentences, no markdown headings or bullet lists, under 100 words per message.`

/**
 * After a mid-output server-side fallback, blocks before the final `fallback`
 * block that the fallback model can't continue from (thinking, tool calls) are
 * left out of the echoed history; the fallback block itself stays in place.
 */
function echoableContent(content: ContentBlock[]): ContentBlock[] {
  const boundary = content.map((b) => b.type).lastIndexOf('fallback')
  if (boundary < 0) return content
  return content.filter(
    (b, i) => i >= boundary || !['thinking', 'redacted_thinking', 'tool_use', 'server_tool_use'].includes(b.type),
  )
}

function decisionResult(input: Extract<ChatRequest['input'], { kind: 'decision' }>): ToolResult {
  switch (input.decision) {
    case 'approve':
      return { type: 'tool_result', tool_use_id: input.toolUseId, content: 'The user approved. This plan is now their plan for today. Confirm in one or two sentences.' }
    case 'override':
      return {
        type: 'tool_result',
        tool_use_id: input.toolUseId,
        is_error: true,
        content: `The user kept their own plan.${input.note ? ` Their note: ${input.note}` : ''} Acknowledge in one sentence. Do not propose again unless asked.`,
      }
    case 'ask_why':
      return {
        type: 'tool_result',
        tool_use_id: input.toolUseId,
        is_error: true,
        content: 'The user has not decided yet and asked why. Explain your reasoning, then call propose_plan again.',
      }
  }
}

/**
 * One request's worth of agent work: append the user's input, then loop
 * model call -> read-only planning tools until the model answers, or proposes a
 * plan (which pauses the loop until the user decides in a later request).
 */
export async function* runAgent(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<AgentStreamEvent> {
  const client = new Anthropic()
  const messages = [...(request.history as MessageParam[])]
  const { plan, now } = request

  if (request.input.kind === 'message') {
    // The time goes in the user turn (not the system prompt) so the cached prefix stays stable.
    messages.push({ role: 'user', content: `[It is ${now} on ${plan.date}.]\n${request.input.text}` })
  } else {
    const pending = (request.pending ?? []) as ToolResult[]
    messages.push({ role: 'user', content: [...pending, decisionResult(request.input)] })
  }

  let jsonRetries = 0

  for (let call = 0; call < MAX_MODEL_CALLS; call++) {
    const stream = client.beta.messages.stream(
      {
        model: MODEL,
        max_tokens: 64000,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
        cache_control: { type: 'ephemeral' },
        // "updates" returns the short progress notes Claude writes between tool calls
        // (empty by default on this model); they become Pulse's narration in the chat.
        // Conversations live in the browser and outlive deploys. If the system prompt or tools change
        // between turns, drop the thinking blocks that no longer match instead of failing the request.
        thinking: { type: 'adaptive', display: 'updates', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
        // Planning chat doesn't need deep reasoning; low effort keeps replies quick and cheap.
        output_config: { effort: 'low' },
        // If a safety classifier declines, the API re-runs the request on a fallback model.
        betas: ['server-side-fallback-2026-07-01', 'thinking-display-updates-2026-08-18', 'thinking-binding-controls-2026-08-01'],
        fallbacks: 'default',
      },
      { signal },
    )

    let message: Anthropic.Beta.BetaMessage
    let spoke = false
    try {
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && (event.delta.type === 'text_delta' || event.delta.type === 'thinking_delta')) {
          const text = event.delta.type === 'text_delta' ? event.delta.text : event.delta.thinking
          if (!text || text.trim() === INTERRUPTED) continue
          yield { type: 'text', text }
          spoke = true
        } else if (event.type === 'content_block_start' && (event.content_block.type === 'text' || event.content_block.type === 'thinking')) {
          // Keep separate progress notes from running into each other.
          if (spoke) yield { type: 'text', text: ' ' }
        } else if (
          event.type === 'content_block_start' &&
          event.content_block.type === 'tool_use' &&
          isReadTool(event.content_block.name)
        ) {
          // Announce the call as soon as it starts, so Pulse reacts before the input finishes streaming.
          yield { type: 'tool_call', id: event.content_block.id, name: event.content_block.name }
        }
      }
      message = await stream.finalMessage()
      jsonRetries = 0
    } catch (err) {
      // With eager input streaming, unparseable tool JSON rejects the stream. Re-issue that turn only.
      if (err instanceof Anthropic.APIError || signal?.aborted || jsonRetries++ >= MAX_JSON_RETRIES) throw err
      continue
    }

    if (message.stop_reason === 'refusal') {
      yield { type: 'error', message: 'The model declined this request.' }
      yield { type: 'turn_end', outcome: 'refused', history: messages }
      return
    }

    const content = echoableContent(message.content)
    messages.push({ role: 'assistant', content })

    const toolUses = content.filter((b): b is ToolUseBlock => b.type === 'tool_use')
    if (toolUses.length === 0) {
      yield { type: 'turn_end', outcome: 'complete', history: messages }
      return
    }
    if (message.stop_reason === 'max_tokens') {
      throw new Error('A tool call was cut off by max_tokens.')
    }

    const results: ToolResult[] = []
    let proposal: { block: ToolUseBlock; proposal: PlanProposal } | null = null

    for (const block of toolUses) {
      if (isReadTool(block.name)) {
        const started = performance.now()
        let output: unknown
        let concern: string | undefined
        let isError = false
        const parsed = ToolInputs[block.name].safeParse(block.input)
        if (!parsed.success) {
          isError = true
          output = { INVALID_INPUT: JSON.stringify(block.input), problems: parsed.error.issues.map((i) => i.message).slice(0, 5) }
        } else {
          ;({ output, concern } = runReadTool(block.name, parsed.data, plan, now))
        }
        // The tools are instant; a short pause keeps the timeline readable.
        await new Promise((r) => setTimeout(r, Math.max(0, 350 - (performance.now() - started))))
        yield { type: 'tool_result', id: block.id, name: block.name, input: block.input, output, isError, concern }
        results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(output), is_error: isError || undefined })
      } else if (block.name === 'propose_plan') {
        const parsed = ProposalInput.safeParse(block.input)
        if (parsed.success && !proposal) {
          proposal = { block, proposal: toProposal(parsed.data, plan) }
        } else {
          results.push({
            type: 'tool_result',
            tool_use_id: block.id,
            is_error: true,
            content: parsed.success
              ? 'Only one proposal at a time.'
              : JSON.stringify({ INVALID_INPUT: JSON.stringify(block.input), problems: parsed.error.issues.map((i) => i.message).slice(0, 5) }),
          })
        }
      } else {
        results.push({ type: 'tool_result', tool_use_id: block.id, is_error: true, content: `Unknown tool ${block.name}` })
      }
    }

    if (proposal) {
      // Pause: the user's decision becomes this tool's result in the next request.
      yield { type: 'proposal', id: proposal.block.id, proposal: proposal.proposal }
      yield { type: 'turn_end', outcome: 'awaiting_approval', history: messages, pending: results }
      return
    }

    messages.push({ role: 'user', content: results })
  }

  yield { type: 'error', message: 'Stopped after too many steps.' }
  yield { type: 'turn_end', outcome: 'complete', history: messages }
}
