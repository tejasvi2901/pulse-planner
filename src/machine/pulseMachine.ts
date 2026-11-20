import { assign, setup, type ActorRefFrom, type SnapshotFrom } from 'xstate'

/**
 * Pulse's behavioural state machine.
 *
 * Every state maps 1:1 to a body-language profile (see character/motionProfiles.ts),
 * so whatever the agent is doing is always legible on the character.
 */

export const PULSE_STATES = [
  'idle',
  'listening',
  'thinking',
  'explaining',
  'needsApproval',
  'uncertain',
  'done',
] as const

export type PulseState = (typeof PULSE_STATES)[number]

export type PulseEvent =
  /** The user is typing in the input. Repeated events keep Pulse listening. */
  | { type: 'USER_TYPING' }
  /** The user sent a message: a new turn starts. */
  | { type: 'SEND'; text?: string }
  /** The agent called a tool. Each call adds an orbiting particle. */
  | { type: 'TOOL_CALL'; name?: string }
  /** One streamed chunk of response text. Drives the explaining bounce. */
  | { type: 'TOKEN'; text?: string }
  /** The agent proposed an action that a human has to approve. */
  | { type: 'NEEDS_APPROVAL'; proposal?: string }
  /** The user approved the proposal. */
  | { type: 'APPROVED' }
  /** The user kept their own plan instead of the proposal. */
  | { type: 'OVERRIDDEN' }
  /** The user asked Pulse to explain the proposal before deciding. */
  | { type: 'ASK_WHY' }
  /** A tool or model error, or an answer Pulse can't stand behind. */
  | { type: 'ERROR'; message?: string }
  /** The response finished without needing approval. */
  | { type: 'DONE' }
  /** Return to idle and clear the turn. */
  | { type: 'RESET' }
  /** Debug only: jump straight to a state. */
  | { type: 'DEBUG.GOTO'; state: PulseState }

export type PulseEventType = PulseEvent['type']

export interface PulseContext {
  /** Tool calls made in the current turn, in order. */
  toolCalls: string[]
  /** Text tokens streamed in the current turn. */
  tokenCount: number
  /** Last error message, shown while uncertain. */
  lastError: string | null
}

const emptyTurn: PulseContext = { toolCalls: [], tokenCount: 0, lastError: null }

export const pulseMachine = setup({
  types: {
    context: {} as PulseContext,
    events: {} as PulseEvent,
  },
  actions: {
    startTurn: assign(() => ({ ...emptyTurn })),
    recordToolCall: assign({
      toolCalls: ({ context, event }) => [
        ...context.toolCalls,
        event.type === 'TOOL_CALL' ? (event.name ?? 'tool') : 'tool',
      ],
    }),
    countToken: assign({ tokenCount: ({ context }) => context.tokenCount + 1 }),
    recordError: assign({
      lastError: ({ event }) =>
        event.type === 'ERROR' ? (event.message ?? 'Something went wrong') : null,
    }),
  },
  delays: {
    /** If the user stops typing without sending, Pulse relaxes back to idle. */
    typingTimeout: 8000,
  },
}).createMachine({
  id: 'pulse',
  initial: 'idle',
  context: { ...emptyTurn },
  on: {
    RESET: { target: '.idle', actions: 'startTurn' },
    'DEBUG.GOTO': PULSE_STATES.map((state) => ({
      guard: ({ event }: { event: PulseEvent }) =>
        event.type === 'DEBUG.GOTO' && event.state === state,
      target: `.${state}`,
    })),
  },
  states: {
    idle: {
      on: {
        USER_TYPING: 'listening',
        SEND: { target: 'thinking', actions: 'startTurn' },
      },
    },

    listening: {
      after: { typingTimeout: 'idle' },
      on: {
        // Re-entering restarts the typing timeout.
        USER_TYPING: { target: 'listening', reenter: true },
        SEND: { target: 'thinking', actions: 'startTurn' },
      },
    },

    thinking: {
      on: {
        TOOL_CALL: { actions: 'recordToolCall' },
        TOKEN: { target: 'explaining', actions: 'countToken' },
        NEEDS_APPROVAL: 'needsApproval',
        ERROR: { target: 'uncertain', actions: 'recordError' },
        DONE: 'done',
      },
    },

    explaining: {
      on: {
        TOKEN: { actions: 'countToken' },
        // The agent can go back to its tools mid-answer.
        TOOL_CALL: { target: 'thinking', actions: 'recordToolCall' },
        NEEDS_APPROVAL: 'needsApproval',
        ERROR: { target: 'uncertain', actions: 'recordError' },
        DONE: 'done',
      },
    },

    needsApproval: {
      // Deliberately sticky: Pulse does not move on until the human decides.
      on: {
        APPROVED: 'done',
        // When the user keeps their own plan, Pulse yields and pays attention to them.
        OVERRIDDEN: 'listening',
        // Asked why: back to reasoning, keeping this turn's tool calls.
        ASK_WHY: 'thinking',
        ERROR: { target: 'uncertain', actions: 'recordError' },
      },
    },

    uncertain: {
      on: {
        USER_TYPING: 'listening',
        SEND: { target: 'thinking', actions: 'startTurn' },
        // Retrying with another tool, or explaining what it isn't sure about.
        TOOL_CALL: { target: 'thinking', actions: 'recordToolCall' },
        TOKEN: { target: 'explaining', actions: 'countToken' },
        // It can still propose (e.g. a plan that leaves things out) or finish, while unsure.
        NEEDS_APPROVAL: 'needsApproval',
        DONE: 'done',
      },
    },

    done: {
      on: {
        USER_TYPING: 'listening',
        SEND: { target: 'thinking', actions: 'startTurn' },
      },
    },
  },
})

export type PulseActorRef = ActorRefFrom<typeof pulseMachine>
export type PulseSnapshot = SnapshotFrom<typeof pulseMachine>
