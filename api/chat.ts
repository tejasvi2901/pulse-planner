import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'

import type { AgentStreamEvent, ChatRequest } from '../shared/agentProtocol.ts'
import { runAgent } from '../server/agent.ts'
import { checkLimits, limitMessage, visitorId } from '../server/rateLimit.ts'
import { runScriptedAgent } from '../server/scriptedAgent.ts'
import { PlanSchema } from '../server/tools.ts'

/*
 * POST /api/chat: a Vercel function (Web-standard handler). In local
 * development the same handler is served by the Vite plugin in vite.config.ts.
 * Streams newline-delimited JSON AgentStreamEvents.
 */

const RequestSchema = z.object({
  history: z.array(z.unknown()).max(60),
  pending: z.array(z.unknown()).max(10).optional(),
  scripted: z.boolean().optional(),
  plan: PlanSchema,
  now: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
  input: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('message'), text: z.string().trim().min(1).max(1500) }),
    z.object({
      kind: z.literal('decision'),
      toolUseId: z.string().min(1).max(200),
      decision: z.enum(['approve', 'override', 'ask_why']),
      note: z.string().max(300).optional(),
    }),
  ]),
})

const hasCredentials = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)

export async function POST(request: Request): Promise<Response> {
  let body: ChatRequest
  try {
    body = RequestSchema.parse(await request.json()) as ChatRequest
  } catch {
    return Response.json({ error: 'Invalid request' }, { status: 400 })
  }

  const scripted = body.scripted || !hasCredentials()

  // A decision must answer the propose_plan call in the last assistant turn.
  if (body.input.kind === 'decision' && !answersOpenProposal(body.history, body.input.toolUseId)) {
    return Response.json({ error: 'No open proposal to decide on' }, { status: 400 })
  }

  // Only requests that spend API credit count towards the limits. Approve and "keep mine" skip the
  // per-visitor limits (they close an open proposal with one short reply, and blocking them would
  // strand the conversation) but still count towards the global daily cap.
  if (!scripted) {
    const closesProposal = body.input.kind === 'decision' && body.input.decision !== 'ask_why'
    const limit = await checkLimits(visitorId(request), { globalOnly: closesProposal })
    if (!limit.ok) {
      const event: AgentStreamEvent = { type: 'rate_limited', message: limitMessage(limit), retryAfter: limit.retryAfter }
      return Response.json(event, { status: 429, headers: { 'retry-after': String(limit.retryAfter) } })
    }
  }

  const events = scripted ? runScriptedAgent(body, request.signal) : runAgent(body, request.signal)
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: AgentStreamEvent) => controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'))
      try {
        if (!scripted) send({ type: 'notice', mode: 'live', text: 'Pulse is planning with Claude.' })
        for await (const event of events) send(event)
      } catch (err) {
        if (!request.signal.aborted) {
          console.error('[api/chat]', err)
          send({ type: 'error', message: describeError(err) })
        }
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  })
}

function answersOpenProposal(history: unknown[], toolUseId: string): boolean {
  const last = history[history.length - 1] as { role?: string; content?: unknown } | undefined
  if (!last || last.role !== 'assistant') return false
  // Scripted history is plain text; its proposals aren't tool calls.
  if (typeof last.content === 'string') return true
  return Array.isArray(last.content) && last.content.some(
    (b: { type?: string; id?: string; name?: string }) => b?.type === 'tool_use' && b.id === toolUseId && b.name === 'propose_plan',
  )
}

function describeError(err: unknown) {
  if (err instanceof Anthropic.AuthenticationError) return 'The API key was rejected.'
  if (err instanceof Anthropic.RateLimitError) return 'Pulse is busy right now. Try again in a moment.'
  if (err instanceof Anthropic.InternalServerError) return 'Claude is temporarily unavailable.'
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach Claude.'
  return 'Something went wrong while planning.'
}
