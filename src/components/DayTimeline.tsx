import { useEffect, useState } from 'react'

import { blockMinutes, sortBlocks, toMinutes, type Block, type Task } from '../../shared/planner'
import { nowString, type PlanApi } from '../planner/usePlan'
import './DayTimeline.css'

const PRIORITY_LABEL = { must: 'Must', should: 'Should', could: 'Could' } as const

function useNow() {
  const [now, setNow] = useState(nowString)
  useEffect(() => {
    const id = window.setInterval(() => setNow(nowString()), 30_000)
    return () => window.clearInterval(id)
  }, [])
  return now
}

function formatDate(date: string) {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
}

function BlockRow({ block, task, past, planApi }: { block: Block; task?: Task; past: boolean; planApi: PlanApi }) {
  const done = task?.done ?? false
  // Taller rows for longer blocks, so the day reads at a glance.
  const height = Math.min(120, Math.max(44, blockMinutes(block) * 0.75))
  return (
    <li className={`block block--${block.kind}${done ? ' is-done' : ''}${past ? ' is-past' : ''}`} style={{ minHeight: height }}>
      <span className="block__time">
        {block.start}
        <span className="block__end">{block.end}</span>
      </span>
      <div className="block__card">
        {task ? (
          <label className="block__check">
            <input type="checkbox" checked={done} onChange={() => planApi.toggleDone(task.id)} />
            <span className="block__title">{block.title}</span>
          </label>
        ) : (
          <span className="block__title">{block.title}</span>
        )}
        <span className="block__meta">
          {block.kind === 'event' ? 'Appointment' : block.kind === 'break' ? 'Break' : `${blockMinutes(block)} min`}
          {task?.due && ` · due ${task.due}`}
        </span>
        <button
          type="button"
          className="block__remove"
          aria-label={`Remove ${block.title}`}
          onClick={() => (task ? planApi.removeTask(task.id) : planApi.removeBlock(block.id))}
        >
          ×
        </button>
      </div>
    </li>
  )
}

export function DayTimeline({ planApi, onNewDay }: { planApi: PlanApi; onNewDay: () => void }) {
  const { plan } = planApi
  const now = useNow()
  const nowMin = toMinutes(now)
  const blocks = sortBlocks(plan.blocks)
  const tasksById = new Map(plan.tasks.map((t) => [t.id, t]))
  const scheduledIds = new Set(blocks.map((b) => b.taskId).filter(Boolean))
  const unscheduled = plan.tasks.filter((t) => !scheduledIds.has(t.id))
  const openCount = plan.tasks.filter((t) => !t.done).length
  const nowIndex = blocks.findIndex((b) => toMinutes(b.end) > nowMin)
  const empty = blocks.length === 0 && plan.tasks.length === 0

  return (
    <section className="day" aria-label="Your day">
      <header className="day__header">
        <div>
          <h2 className="day__title">{formatDate(plan.date)}</h2>
          <p className="day__sub">
            {plan.dayStart}–{plan.dayEnd}
            {plan.tasks.length > 0 && ` · ${openCount} of ${plan.tasks.length} tasks open`}
          </p>
        </div>
        {!empty && (
          <button type="button" className="day__reset" onClick={onNewDay}>
            New day
          </button>
        )}
      </header>

      <div className="day__body">
        {empty ? (
          <div className="day__empty">
            <p>No plan yet.</p>
            <p>Tell Pulse what's on your plate today. It will plan your day and ask before changing anything.</p>
          </div>
        ) : (
          <>
            <ol className="timeline">
              {blocks.map((b, i) => (
                <BlockRowWithNow
                  key={b.id}
                  showNow={i === nowIndex && toMinutes(b.start) > nowMin}
                  now={now}
                  block={b}
                  task={b.taskId ? tasksById.get(b.taskId) : undefined}
                  past={toMinutes(b.end) <= nowMin}
                  planApi={planApi}
                />
              ))}
              {nowIndex === -1 && blocks.length > 0 && <NowLine now={now} />}
            </ol>

            {unscheduled.length > 0 && (
              <div className="unscheduled">
                <h3 className="unscheduled__title">Not scheduled</h3>
                <ul>
                  {unscheduled.map((t) => (
                    <li key={t.id} className={t.done ? 'is-done' : undefined}>
                      <label className="block__check">
                        <input type="checkbox" checked={t.done} onChange={() => planApi.toggleDone(t.id)} />
                        <span>{t.title}</span>
                      </label>
                      <span className={`prio prio--${t.priority}`}>{PRIORITY_LABEL[t.priority]}</span>
                      <span className="unscheduled__min">{t.minutes} min</span>
                      <button type="button" className="block__remove" aria-label={`Remove ${t.title}`} onClick={() => planApi.removeTask(t.id)}>
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}

function NowLine({ now }: { now: string }) {
  return (
    <li className="now-line" aria-label={`Now, ${now}`}>
      <span className="now-line__label">{now}</span>
    </li>
  )
}

function BlockRowWithNow({ showNow, now, ...props }: { showNow: boolean; now: string } & Parameters<typeof BlockRow>[0]) {
  return (
    <>
      {showNow && <NowLine now={now} />}
      <BlockRow {...props} />
    </>
  )
}
