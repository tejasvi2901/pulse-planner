# Pulse

**A day planner with a face.** Tell Pulse what's on your plate today ("dentist at 11, finish the report by 3, gym, call mom") and it plans your day around your appointments. Nothing changes until you approve.

Pulse is an animated companion, a soft 3D orb with eyes, whose body language shows what the AI is doing at every moment. You can see it listening, thinking, explaining, waiting for your decision or unsure, without reading a status line.

## How it works

1. **You describe your day** in plain words. Pulse leans in while you type.
2. **Pulse plans it with Claude.** It reads your current plan, finds free time, and checks a draft for overlaps, moved appointments, missed deadlines and overbooking. Each tool call appears in the chat as a step, and as a particle orbiting Pulse.
3. **You decide.** The proposal shows what's new, what moved, what doesn't fit and why, plus Pulse's confidence. Choose **Approve**, **Keep mine** or **Ask why**. Until you approve, your plan stays exactly as it was.

Your plan is saved in your browser only. The conversation, and the plan Pulse needs to read, are sent to the server and to Anthropic's API to generate replies; nothing is stored server-side.

## Body language

| State | What Pulse does | When |
| --- | --- | --- |
| Idle | Breathes slowly; eyes follow your cursor | Nothing happening |
| Listening | Leans toward you, pulses softly, eyes widen | You're typing |
| Thinking | Draws inward and swirls; one orbiting particle per tool call | Pulse is working out a plan |
| Explaining | Bounces gently in rhythm with the streamed text | Pulse is talking |
| Needs approval | Holds still, turns to the proposal and turns warm amber | A plan is waiting for your decision |
| Uncertain | Wobbles, narrows one eye, shows a "Low confidence" badge | The day doesn't fit, or something failed |
| Done | Absorbs the particles, settles and glows green | You approved |

The behaviour is a state machine ([`src/machine/pulseMachine.ts`](src/machine/pulseMachine.ts)). Each state maps to a motion profile ([`src/character/motionProfiles.ts`](src/character/motionProfiles.ts)), and every parameter is driven by springs, so changes ease in and overshoot slightly instead of snapping. Streamed agent events map onto machine events in one place ([`src/agent/eventMapping.ts`](src/agent/eventMapping.ts)).

## Stack

- **Front end:** Vite, React and TypeScript; the character is built from Babylon.js primitives with a custom GLSL shader, and has no rigging.
- **Behaviour:** XState.
- **Agent:** a Vercel serverless function ([`api/chat.ts`](api/chat.ts)) that runs Claude with planning tools and streams NDJSON events. The approval gate is a `propose_plan` tool that the server never executes; the user's decision becomes its result in the next request.
- **Abuse protection:** per-visitor and global rate limits backed by Upstash Redis ([`server/rateLimit.ts`](server/rateLimit.ts)).

## Run it locally

Requires Node.js 20 or later.

```bash
npm install
cp .env.example .env.local   # then add your Anthropic API key
npm run dev
```

Open http://localhost:5173.

- **Without an API key** Pulse runs a scripted demo with simple scheduling rules, so you can try the whole flow for free. Add `?scripted` to the URL to force it.
- **Debug drawer:** in development, use the Debug button, or add `?debug` to the URL in any build. It fires state-machine events, plays scenarios and shows the transition log. Keys 1–7 jump between states.

## Deploy

1. Import the repository into [Vercel](https://vercel.com/new); the framework preset is Vite.
2. Add **Upstash for Redis** from the Vercel Marketplace and connect it to the project. It sets the `KV_REST_API_*` variables the rate limiter reads.
3. Set `ANTHROPIC_API_KEY` in the project's environment variables.
4. Optionally tune the limits with `PULSE_LIMIT_HOURLY` (default 15), `PULSE_LIMIT_DAILY` (40) and `PULSE_LIMIT_GLOBAL_DAILY` (400).
5. Set a monthly spend limit for the API key's workspace in the Anthropic Console. That is the real ceiling on cost.

## License

[MIT](LICENSE)
