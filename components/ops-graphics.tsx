"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type EnvState = "provisioning" | "ready" | "in_use" | "failed" | "deprovisioned";

interface EnvRow {
  id: string;
  learnerName: string;
  state: EnvState;
  step: number;
  totalSteps: number;
  failureReason: string | null;
  spendUsd: number;
  progressPct: number;
  onStepMinutes: number;
  stuck: boolean;
}

interface Summary {
  total: number;
  active: number;
  failures: number;
  avgCompletionPct: number;
  estimatedSpend: number;
  byState: Record<EnvState, number>;
  stuckCount: number;
}

const STATE_META: Record<EnvState, { label: string; color: string }> = {
  failed: { label: "Failed", color: "var(--failed)" },
  in_use: { label: "In use", color: "#5b6472" },
  provisioning: { label: "Provisioning", color: "var(--info)" },
  ready: { label: "Ready", color: "var(--ok)" },
  deprovisioned: { label: "Done", color: "#c9ced6" },
};

const RING_ORDER: EnvState[] = ["failed", "in_use", "provisioning", "ready", "deprovisioned"];

/* ------------------------------------------------------------------ */
/* Session health: state ring + the four numbers an instructor scans   */
/* ------------------------------------------------------------------ */

export function SessionHealth({
  summary,
  stateFilter,
  onToggleState,
}: {
  summary: Summary | null;
  stateFilter: EnvState[];
  onToggleState: (s: EnvState) => void;
}) {
  const R = 62;
  const C = 2 * Math.PI * R;
  const total = summary?.total ?? 0;

  // Build arc segments with 2px gaps between non-trivial slices.
  const segs = useMemo(() => {
    if (!summary || total === 0) return [];
    let acc = 0;
    return RING_ORDER.filter((s) => summary.byState[s] > 0).map((s) => {
      const frac = summary.byState[s] / total;
      const start = acc;
      acc += frac;
      return { s, frac, start, n: summary.byState[s] };
    });
  }, [summary, total]);

  return (
    <section className="surface flex flex-col p-4" aria-label="Session health">
      <div className="flex items-center gap-4">
        <div className="relative shrink-0">
          <svg width="148" height="148" viewBox="0 0 148 148" role="img" aria-label="Environment states">
            <circle cx="74" cy="74" r={R} fill="none" stroke="var(--gray-2)" strokeWidth="14" />
            {segs.map(({ s, frac, start }) => {
              const len = Math.max(frac * C - 2.5, frac > 0 ? 2 : 0);
              const on = stateFilter.length === 0 || stateFilter.includes(s);
              return (
                <circle
                  key={s}
                  cx="74"
                  cy="74"
                  r={R}
                  fill="none"
                  stroke={STATE_META[s].color}
                  strokeWidth={stateFilter.includes(s) ? 18 : 14}
                  strokeDasharray={`${len} ${C - len}`}
                  strokeDashoffset={-start * C + C / 4}
                  strokeLinecap="butt"
                  opacity={on ? 1 : 0.18}
                  style={{ cursor: "pointer", transition: "opacity 150ms, stroke-width 150ms" }}
                  onClick={() => onToggleState(s)}
                >
                  <title>
                    {STATE_META[s].label}: {summary!.byState[s]} - click to filter
                  </title>
                </circle>
              );
            })}
          </svg>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span
              className="tnum text-[30px] font-semibold leading-8"
              style={{ color: summary && summary.failures > 0 ? "var(--failed)" : "var(--ink)" }}
            >
              {summary ? summary.failures : "-"}
            </span>
            <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted">failed</span>
            <span className="tnum mt-0.5 text-[10px] text-muted">of {summary?.total ?? "-"}</span>
          </div>
        </div>

        <dl className="grid min-w-0 flex-1 grid-cols-2 gap-x-3 gap-y-2.5">
          {(
            [
              ["Active", summary ? `${summary.active}/${summary.total}` : "-", undefined],
              ["Stuck 20m+", summary ? String(summary.stuckCount) : "-", summary && summary.stuckCount > 0 ? "var(--warn)" : undefined],
              ["Avg done", summary ? `${summary.avgCompletionPct}%` : "-", undefined],
              ["Est. spend", summary ? `$${summary.estimatedSpend.toFixed(2)}` : "-", undefined],
            ] as const
          ).map(([k, v, c]) => (
            <div key={k}>
              <dt className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted">{k}</dt>
              <dd className="tnum text-[16px] font-semibold leading-5" style={c ? { color: c } : undefined}>
                {v}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 border-t border-line pt-2.5">
        {RING_ORDER.map((s) => {
          const n = summary?.byState[s] ?? 0;
          if (n === 0) return null;
          const on = stateFilter.includes(s);
          return (
            <button
              key={s}
              onClick={() => onToggleState(s)}
              aria-pressed={on}
              className="flex items-center gap-1.5 text-[11px]"
            >
              <span
                aria-hidden
                className="inline-block size-2 rounded-full"
                style={{ background: STATE_META[s].color, opacity: stateFilter.length === 0 || on ? 1 : 0.3 }}
              />
              <span className="text-ink-2">{STATE_META[s].label}</span>
              <span className="tnum font-medium text-ink">{n}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Step heatmap: where the cohort sits, where it burns time            */
/* ------------------------------------------------------------------ */

export interface StepBucket {
  step: number;
  count: number;
  failed: number;
  stuck: number;
  maxOnStep: number;
}

export function StepHeatmap({
  steps,
  activeStep,
  onSelectStep,
}: {
  steps: StepBucket[];
  activeStep: number | null;
  onSelectStep: (step: number | null) => void;
}) {
  const maxCount = Math.max(1, ...steps.map((s) => s.count));
  // Heat = longest anyone has sat on that step, capped at 90 min.
  const maxHeat = Math.max(30, ...steps.map((s) => s.maxOnStep));

  return (
    <section className="surface flex min-w-0 flex-col p-4" aria-label="Cohort by lab step">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">Cohort by lab step</h2>
        <span className="hidden text-[10px] text-muted sm:block">bar = learners - red = failed, amber = long dwell</span>
      </div>
      <div className="flex h-28 items-end gap-[6px]" role="group" aria-label="Steps">
        {steps.map((s) => {
          const heat = s.maxOnStep / maxHeat;
          // Body color: calm gray, amber when someone dwells long.
          const body = heat > 0.66 ? "#d97706" : heat > 0.4 ? "#e8a33d" : "var(--gray-4)";
          const on = activeStep === s.step;
          const dim = activeStep !== null && !on;
          const totalH = Math.max((s.count / maxCount) * 100, s.count ? 6 : 0);
          const failedPct = s.count ? (s.failed / s.count) * 100 : 0;
          return (
            <button
              key={s.step}
              onClick={() => onSelectStep(on ? null : s.step)}
              aria-pressed={on}
              className="group flex min-w-0 flex-1 flex-col items-center justify-end gap-1 self-stretch"
            >
              <span className="tnum text-[10px] font-medium leading-3" style={{ color: s.count ? "var(--ink)" : "var(--gray-4)" }}>
                {s.count || ""}
              </span>
              <span className="sr-only">
                {` learners on step ${s.step}${s.failed ? `, ${s.failed} failed` : ""}${s.stuck ? `, ${s.stuck} stuck` : ""}. Click to filter.`}
              </span>
              <span
                aria-hidden
                className="flex w-full flex-col-reverse overflow-hidden rounded-[3px]"
                style={{
                  height: `${totalH}%`,
                  minHeight: s.count ? 5 : 2,
                  background: s.count ? undefined : "var(--gray-2)",
                  opacity: dim ? 0.3 : 1,
                  outline: on ? "2px solid var(--ink)" : "none",
                  outlineOffset: 1,
                  transition: "opacity 150ms",
                }}
              >
                <span className="w-full" style={{ height: `${100 - failedPct}%`, background: body }} />
                {failedPct > 0 && <span className="w-full" style={{ height: `${failedPct}%`, background: "var(--failed)" }} />}
              </span>
              <span className="tnum text-[9px] leading-3 text-muted">{s.step}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Activity pulse: transitions observed since this view opened         */
/* ------------------------------------------------------------------ */

export interface Transition {
  id: string;
  learnerName: string;
  to: EnvState;
  failureReason: string | null;
  at: number;
}

interface PulseEvent {
  key: string;
  at: number;
  name: string;
  text: string;
  tone: EnvState;
}

const TRANSITION_COPY: Record<EnvState, (failureReason: string | null) => string> = {
  failed: (fr) => `failed${fr ? ` - ${fr}` : ""}`,
  ready: () => "environment ready",
  provisioning: () => "reprovisioning",
  in_use: () => "started the lab",
  deprovisioned: () => "completed the lab",
};

export function ActivityPulse({ transitions, pollMs }: { transitions: Transition[]; pollMs: number }) {
  const [events, setEvents] = useState<PulseEvent[]>([]);
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const fresh: PulseEvent[] = [];
    for (const t of transitions) {
      const key = `${t.id}->${t.to}`;
      if (seenRef.current.has(key)) continue;
      seenRef.current.add(key);
      fresh.push({
        key,
        at: t.at,
        name: t.learnerName,
        text: TRANSITION_COPY[t.to](t.failureReason),
        tone: t.to,
      });
    }
    if (fresh.length) {
      setEvents((cur) => [...fresh, ...cur].slice(0, 9));
    }
  }, [transitions]);

  return (
    <section className="surface flex min-w-0 flex-col p-4" aria-label="Live activity">
      <div className="mb-2.5 flex items-baseline justify-between gap-2">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">Live activity</h2>
        <span className="text-[10px] text-muted">since opened, polled {pollMs / 1000}s</span>
      </div>
      {events.length === 0 ? (
        <p className="text-[12px] leading-5 text-muted">
          No transitions observed yet. Failures, completions and recoveries appear here as polls land.
        </p>
      ) : (
        <ul className="pulse-list -mr-1 flex-1 space-y-1.5 overflow-y-auto pr-1">
          {events.map((e) => (
            <li key={e.key} className="flex items-baseline gap-2 text-[12px] leading-5">
              <span aria-hidden className="mt-[7px] inline-block size-1.5 shrink-0 rounded-full" style={{ background: STATE_META[e.tone].color }} />
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium text-ink">{e.name}</span>{" "}
                <span style={{ color: e.tone === "failed" ? "var(--failed)" : "var(--ink-2)" }}>{e.text}</span>
              </span>
              <span className="tnum shrink-0 text-[10px] text-muted">
                {new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
