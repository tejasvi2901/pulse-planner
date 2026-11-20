import type { AgentStreamEvent, UserDecision } from '../../shared/agentProtocol'
import type { PulseEvent } from '../machine/pulseMachine'

/**
 * The one place where agent activity becomes body language.
 * Every streamed event maps to at most one state-machine event.
 */
export function machineEventFor(event: AgentStreamEvent): PulseEvent | null {
  switch (event.type) {
    case 'text':
      return { type: 'TOKEN', text: event.text }
    case 'tool_call':
      return { type: 'TOOL_CALL', name: event.name }
    case 'tool_result':
      // A failed tool, or a day that doesn't fit, makes Pulse visibly unsure until it recovers.
      if (event.isError) return { type: 'ERROR', message: `${event.name} failed` }
      return event.concern ? { type: 'ERROR', message: event.concern } : null
    case 'proposal':
      return { type: 'NEEDS_APPROVAL', proposal: event.proposal.summary }
    case 'turn_end':
      return event.outcome === 'complete' ? { type: 'DONE' } : null
    case 'rate_limited':
    case 'error':
      return { type: 'ERROR', message: event.message }
    case 'notice':
      return null
  }
}

/** The user's decision, as Pulse feels it (sent the moment they click). */
export function machineEventForDecision(decision: UserDecision['decision']): PulseEvent {
  switch (decision) {
    case 'approve':
      return { type: 'APPROVED' }
    case 'override':
      return { type: 'OVERRIDDEN' }
    case 'ask_why':
      return { type: 'ASK_WHY' }
  }
}
