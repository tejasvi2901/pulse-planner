import { useCallback, useEffect, useState } from 'react'

import type { PlanProposal } from '../../shared/agentProtocol'
import { emptyPlan, type DayPlan } from '../../shared/planner'

/*
 * The day plan lives only in this browser (localStorage). It is sent to the
 * server with each request so Pulse can read it, but never stored there.
 */

const KEY = 'pulse.plan.v1'

export function todayString(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function nowString(d = new Date()) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Storage can be unavailable (private mode, blocked site data); the app still works without it. */
export function readStored<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

export function writeStored(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Ignore quota and access errors.
  }
}

function loadPlan(): DayPlan {
  const today = todayString()
  const stored = readStored<DayPlan>(KEY)
  if (!stored) return emptyPlan(today)
  if (stored.date === today) return stored
  // A new day: carry over unfinished tasks, clear the schedule.
  return { ...emptyPlan(today), dayStart: stored.dayStart, dayEnd: stored.dayEnd, tasks: stored.tasks.filter((t) => !t.done) }
}

export function usePlan() {
  const [plan, setPlan] = useState<DayPlan>(loadPlan)

  useEffect(() => writeStored(KEY, plan), [plan])

  const toggleDone = useCallback((taskId: string) => {
    setPlan((p) => ({ ...p, tasks: p.tasks.map((t) => (t.id === taskId ? { ...t, done: !t.done } : t)) }))
  }, [])

  const removeTask = useCallback((taskId: string) => {
    setPlan((p) => ({ ...p, tasks: p.tasks.filter((t) => t.id !== taskId), blocks: p.blocks.filter((b) => b.taskId !== taskId) }))
  }, [])

  const removeBlock = useCallback((blockId: string) => {
    setPlan((p) => ({ ...p, blocks: p.blocks.filter((b) => b.id !== blockId) }))
  }, [])

  /** Adopt an approved proposal. */
  const adopt = useCallback((proposal: PlanProposal) => {
    setPlan((p) => ({ ...p, tasks: proposal.tasks, blocks: proposal.blocks }))
  }, [])

  const reset = useCallback(() => {
    setPlan((p) => ({ ...emptyPlan(todayString()), dayStart: p.dayStart, dayEnd: p.dayEnd }))
  }, [])

  return { plan, toggleDone, removeTask, removeBlock, adopt, reset }
}

export type PlanApi = ReturnType<typeof usePlan>
