import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'

/*
 * Keeps a public deployment from draining the owner's API key.
 * Three limits, checked in order: per visitor per hour, per visitor per day,
 * and a global daily cap across everyone. With Upstash Redis configured (the
 * Vercel Marketplace integration sets KV_REST_API_* or UPSTASH_REDIS_REST_*)
 * the limits are shared across all serverless instances; otherwise they fall
 * back to in-memory counters, which are fine for local development only.
 *
 * The real ceiling on cost is the spend limit set in the Anthropic Console.
 */

const num = (v: string | undefined, fallback: number) => (v && Number(v) > 0 ? Number(v) : fallback)

export const LIMITS = {
  perHour: num(process.env.PULSE_LIMIT_HOURLY, 15),
  perDay: num(process.env.PULSE_LIMIT_DAILY, 40),
  globalPerDay: num(process.env.PULSE_LIMIT_GLOBAL_DAILY, 400),
}

export interface LimitResult {
  ok: boolean
  /** Seconds until the blocking limit resets. */
  retryAfter: number
  scope?: 'hour' | 'day' | 'global'
}

interface Limiter {
  limit(key: string): Promise<{ success: boolean; reset: number }>
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** Fixed-window counters in this process's memory. */
function memoryLimiter(max: number, windowMs: number): Limiter {
  const windows = new Map<string, { start: number; count: number }>()
  return {
    async limit(key) {
      const now = Date.now()
      let w = windows.get(key)
      if (!w || now - w.start >= windowMs) {
        w = { start: now, count: 0 }
        windows.set(key, w)
      }
      if (windows.size > 10_000) windows.clear() // crude memory bound
      const success = w.count < max
      if (success) w.count++
      return { success, reset: w.start + windowMs }
    },
  }
}

function createLimiters(): { hour: Limiter; day: Limiter; global: Limiter; shared: boolean } {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN
  if (url && token) {
    const redis = new Redis({ url, token })
    const make = (max: number, window: `${number} h` | `${number} d`, prefix: string) =>
      new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(max, window), prefix, analytics: false })
    return {
      hour: make(LIMITS.perHour, '1 h', 'pulse:hour'),
      day: make(LIMITS.perDay, '1 d', 'pulse:day'),
      global: make(LIMITS.globalPerDay, '1 d', 'pulse:global'),
      shared: true,
    }
  }
  if (process.env.VERCEL_ENV === 'production') {
    console.warn('[rateLimit] No Redis configured: falling back to per-instance memory limits.')
  }
  return {
    hour: memoryLimiter(LIMITS.perHour, HOUR),
    day: memoryLimiter(LIMITS.perDay, DAY),
    global: memoryLimiter(LIMITS.globalPerDay, DAY),
    shared: false,
  }
}

let limiters: ReturnType<typeof createLimiters> | null = null

/** `globalOnly` skips the per-visitor limits but still counts towards the global daily cap. */
export async function checkLimits(visitor: string, { globalOnly = false } = {}): Promise<LimitResult> {
  limiters ??= createLimiters()
  const checks: [LimitResult['scope'], Limiter, string][] = [
    ...(globalOnly ? [] : ([
      ['hour', limiters.hour, visitor],
      ['day', limiters.day, visitor],
    ] as [LimitResult['scope'], Limiter, string][])),
    ['global', limiters.global, 'all'],
  ]
  for (const [scope, limiter, key] of checks) {
    const { success, reset } = await limiter.limit(key)
    if (!success) return { ok: false, scope, retryAfter: Math.max(1, Math.ceil((reset - Date.now()) / 1000)) }
  }
  return { ok: true, retryAfter: 0 }
}

/** Best-effort visitor id from the platform's forwarding headers. */
export function visitorId(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return forwarded || request.headers.get('x-real-ip') || 'unknown'
}

export function limitMessage(result: LimitResult): string {
  const wait =
    result.retryAfter >= 3600
      ? `about ${Math.round(result.retryAfter / 3600)} hour${result.retryAfter >= 5400 ? 's' : ''}`
      : `about ${Math.max(1, Math.round(result.retryAfter / 60))} minute${result.retryAfter >= 90 ? 's' : ''}`
  switch (result.scope) {
    case 'global':
      return `Pulse has helped a lot of people today and reached its daily limit. Please try again in ${wait}.`
    case 'day':
      return `You've reached today's limit for planning with Pulse. Please try again in ${wait}.`
    default:
      return `That's a lot of planning in one hour. Please try again in ${wait}.`
  }
}
