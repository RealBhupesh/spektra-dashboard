"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { LAB_STEPS } from "@/lib/seed";
import { type EnvRow, type EnvState, fmtMin, fmtUsd, seatOf } from "./ui";

/* Needs attention: the instructor's to-do list, failures first. */
export function AttentionQueue({
  everyone,
  selectedId,
  onSelect,
  onReprovision,
  pending,
}: {
  everyone: EnvRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onReprovision: (id: string) => void;
  pending: Set<string>;
}) {
  const items = useMemo(() => {
    const failed = everyone.filter((r) => r.state === "failed").sort((a, b) => b.onStepMinutes - a.onStepMinutes);
    const stuck = everyone.filter((r) => r.stuck).sort((a, b) => b.onStepMinutes - a.onStepMinutes);
    return [...failed, ...stuck];
  }, [everyone]);
  const nFailed = items.filter((r) => r.state === "failed").length;

  return (
    <section className="panel flex min-h-0 flex-col" aria-label="Needs attention">
      <div className="panel-head">
        <h2 className="panel-title">Needs attention</h2>
        <span className="panel-meta tnum">
          {nFailed} failed, {items.length - nFailed} stuck
        </span>
      </div>
      {items.length === 0 ? (
        <p className="border-t border-line px-4 py-6 text-[12.5px] text-muted">Nobody needs help right now.</p>
      ) : (
        <ul className="overflow-y-auto" style={{ maxHeight: 400 }}>
          {items.map((r) => {
            const failed = r.state === "failed";
            return (
              <li key={r.id} className="li-row !py-0" data-selected={selectedId === r.id || undefined}>
                <button className="flex min-w-0 flex-1 items-center gap-3 py-2.5 text-left" onClick={() => onSelect(r.id)}>
                  <span className="seat-ref">{seatOf(r.id)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-ink">{r.learnerName}</span>
                    <span className={`block truncate text-[12px] ${failed ? "text-failed" : "text-muted"}`}>
                      {failed ? r.failureReason ?? "Environment failed" : `Step ${r.step}, ${LAB_STEPS[r.step - 1] ?? ""}`}
                    </span>
                  </span>
                </button>
                {failed ? (
                  <button
                    className="btn btn-sm btn-danger"
                    disabled={pending.has(r.id)}
                    onClick={() => onReprovision(r.id)}
                    aria-label={`Fix ${r.learnerName}'s PC by reprovisioning it`}
                  >
                    {pending.has(r.id) ? "Working…" : "Fix"}
                  </button>
                ) : (
                  <span className="tnum shrink-0 text-[12.5px] font-medium text-stuck">{fmtMin(r.onStepMinutes)}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* Where the class is: not started → each step → finished. */
export function StepFunnel({
  everyone,
  activeStep,
  onSelectStep,
}: {
  everyone: EnvRow[];
  activeStep: number | null;
  onSelectStep: (step: number | null) => void;
}) {
  const total = everyone[0]?.totalSteps ?? 12;
  const { cols, notStarted, finished, max } = useMemo(() => {
    const cols = Array.from({ length: total }, (_, i) => ({ step: i + 1, working: 0, stuck: 0, failed: 0 }));
    let notStarted = 0;
    let finished = 0;
    for (const r of everyone) {
      if (r.state === "deprovisioned") finished++;
      else if (r.state === "ready" || r.state === "provisioning" || r.step < 1) notStarted++;
      else {
        const c = cols[Math.min(r.step, total) - 1];
        if (r.state === "failed") c.failed++;
        else if (r.stuck) c.stuck++;
        else c.working++;
      }
    }
    return { cols, notStarted, finished, max: Math.max(1, ...cols.map((c) => c.working + c.stuck + c.failed)) };
  }, [everyone, total]);

  return (
    <section className="panel flex min-w-0 flex-col" aria-label="Learners by lab step">
      <div className="panel-head">
        <div>
          <h2 className="panel-title">Learners by step</h2>
          <p className="panel-meta">Click a step to highlight those seats.</p>
        </div>
        <div className="flex items-center gap-3 text-[12px] text-muted">
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block size-2 rounded-[2px]" style={{ background: "var(--line-strong)" }} /> Working
          </span>
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block size-2 rounded-[2px]" style={{ background: "var(--stuck)" }} /> Stuck
          </span>
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block size-2 rounded-[2px]" style={{ background: "var(--failed)" }} /> Failed
          </span>
        </div>
      </div>
      <div className="flex items-end gap-4 px-4 pb-4 pt-2">
        <Tally label="Not started" n={notStarted} />
        <div className="flex h-32 min-w-0 flex-1 items-end gap-1 border-b border-line" role="group" aria-label="Learners currently on each step">
          {cols.map((c) => {
            const n = c.working + c.stuck + c.failed;
            const on = activeStep === c.step;
            return (
              <button
                key={c.step}
                onClick={() => onSelectStep(on ? null : c.step)}
                aria-pressed={on}
                title={`Step ${c.step}: ${LAB_STEPS[c.step - 1]}`}
                className="group relative flex min-w-0 flex-1 flex-col items-center justify-end self-stretch"
                style={{ opacity: activeStep !== null && !on ? 0.35 : 1 }}
              >
                <span className="tnum mb-1 text-[11px] text-muted">{n || ""}</span>
                <span className="sr-only">{` learners on step ${c.step}${c.stuck ? `, ${c.stuck} stuck` : ""}${c.failed ? `, ${c.failed} failed` : ""}`}</span>
                <span aria-hidden className="flex w-full max-w-7 flex-col-reverse group-hover:opacity-80" style={{ height: `${(n / max) * 100}%` }}>
                  {c.working > 0 && <span style={{ flex: c.working, background: "var(--line-strong)" }} />}
                  {c.stuck > 0 && <span style={{ flex: c.stuck, background: "var(--stuck)" }} />}
                  {c.failed > 0 && <span style={{ flex: c.failed, background: "var(--failed)" }} />}
                </span>
                <span className={`tnum absolute -bottom-5 text-[11px] ${on ? "font-semibold text-ink" : "text-muted"}`}>{c.step}</span>
              </button>
            );
          })}
        </div>
        <Tally label="Finished" n={finished} />
      </div>
      <div className="h-4" />
    </section>
  );
}

function Tally({ label, n }: { label: string; n: number }) {
  return (
    <div className="w-[72px] shrink-0 pb-1">
      <div className="tnum text-[22px] font-semibold leading-7 tracking-tight text-ink">{n}</div>
      <div className="text-[12px] text-muted">{label}</div>
    </div>
  );
}

/* Highest spend so far. */
export function TopSpenders({ everyone, onSelect }: { everyone: EnvRow[]; onSelect: (id: string) => void }) {
  const top = useMemo(() => everyone.slice().sort((a, b) => b.spendUsd - a.spendUsd).slice(0, 5), [everyone]);
  const max = top[0]?.spendUsd || 1;
  return (
    <section className="panel flex min-w-0 flex-col" aria-label="Highest spend">
      <div className="panel-head">
        <h2 className="panel-title">Highest spend</h2>
        <span className="panel-meta">per PC</span>
      </div>
      <ul>
        {top.map((r) => (
          <li key={r.id}>
            <button className="li-row" onClick={() => onSelect(r.id)}>
              <span className="seat-ref">{seatOf(r.id)}</span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-[13px] text-ink">{r.learnerName}</span>
                  <span className="tnum text-[13px] text-ink">{fmtUsd(r.spendUsd)}</span>
                </span>
                <span className="mt-1.5 block h-[3px] bg-surface-3">
                  <span className="block h-full" style={{ width: `${(r.spendUsd / max) * 100}%`, background: "var(--ramp-spend)" }} />
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* Live activity: transitions observed since this page opened. */
export interface Transition {
  id: string;
  learnerName: string;
  to: EnvState;
  failureReason: string | null;
  at: number;
}

const TRANSITION_COPY: Record<EnvState, (fr: string | null) => string> = {
  failed: (fr) => `PC failed${fr ? `: ${fr}` : ""}`,
  ready: () => "PC is ready",
  provisioning: () => "PC is being reprovisioned",
  in_use: () => "started the lab",
  deprovisioned: () => "finished the lab",
};

export function ActivityPulse({ transitions, onSelect }: { transitions: Transition[]; onSelect: (id: string) => void }) {
  const [events, setEvents] = useState<(Transition & { key: string })[]>([]);
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const fresh: (Transition & { key: string })[] = [];
    for (const t of transitions) {
      const key = `${t.id}->${t.to}@${t.at}`;
      if (seenRef.current.has(key)) continue;
      seenRef.current.add(key);
      fresh.push({ ...t, key });
    }
    if (fresh.length) setEvents((cur) => [...fresh, ...cur].slice(0, 12));
  }, [transitions]);

  return (
    <section className="panel flex min-h-0 min-w-0 flex-col" aria-label="Recent activity">
      <div className="panel-head">
        <h2 className="panel-title">Recent activity</h2>
        <span className="panel-meta">since you opened this page</span>
      </div>
      {events.length === 0 ? (
        <p className="border-t border-line px-4 py-5 text-[12.5px] text-muted">Nothing has changed yet. New failures and finishes show up here.</p>
      ) : (
        <ul className="overflow-y-auto" style={{ maxHeight: 240 }}>
          {events.map((e) => (
            <li key={e.key}>
              <button className="li-row !py-2" onClick={() => onSelect(e.id)}>
                <span className="tnum w-11 shrink-0 whitespace-nowrap text-[11.5px] text-muted">
                  {new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12.5px]">
                  <span className="text-ink">{e.learnerName}</span>{" "}
                  <span className={e.to === "failed" ? "text-failed" : "text-muted"}>{TRANSITION_COPY[e.to](e.failureReason)}</span>
                </span>
                <span className="seat-ref text-right">{seatOf(e.id)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
