"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type EnvState = "provisioning" | "ready" | "in_use" | "failed" | "deprovisioned";

interface EnvRow {
  id: string;
  learnerName: string;
  learnerEmail: string;
  state: EnvState;
  step: number;
  totalSteps: number;
  failureReason: string | null;
  ratePerHour: number;
  runtimeMinutes: number;
  spendUsd: number;
  progressPct: number;
  onStepMinutes: number;
  stuck: boolean;
}

interface Summary {
  sessionName: string;
  sessionStartedAt: number;
  now: number;
  total: number;
  active: number;
  failures: number;
  avgCompletionPct: number;
  estimatedSpend: number;
  byState: Record<EnvState, number>;
  stuckCount: number;
}

interface NLApplied {
  text: string;
  description: string[];
  source: string;
  degraded: boolean;
  filter: Record<string, unknown>;
}

const STATE_META: Record<EnvState, { label: string; color: string; bg: string }> = {
  failed: { label: "FAILED", color: "var(--failed)", bg: "var(--failed-bg)" },
  in_use: { label: "IN USE", color: "var(--ink-2)", bg: "var(--gray-3)" },
  provisioning: { label: "PROV.", color: "var(--info)", bg: "var(--info-bg)" },
  ready: { label: "READY", color: "var(--ok)", bg: "var(--ok-bg)" },
  deprovisioned: { label: "DONE", color: "var(--muted)", bg: "var(--gray-3)" },
};

const POLL_MS = 4000;

function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
function fmtMin(min: number): string {
  if (min < 1) return "<1m";
  if (min < 60) return `${Math.floor(min)}m`;
  return `${Math.floor(min / 60)}h ${String(Math.floor(min % 60)).padStart(2, "0")}m`;
}

function StatusChip({ state, stuck }: { state: EnvState; stuck: boolean }) {
  const meta = STATE_META[state];
  return (
    <span className="status" data-st={stuck ? "stuck" : state} aria-label={stuck ? "stuck" : meta.label}>
      <span aria-hidden className="glyph" />
      <span className="status-text">{stuck ? "STUCK" : meta.label}</span>
    </span>
  );
}

export default function Dashboard() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [rows, setRows] = useState<EnvRow[]>([]);
  const [filteredCount, setFilteredCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);

  // Filters
  const [stateFilter, setStateFilter] = useState<EnvState[]>([]);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState("risk");
  const [nlText, setNlText] = useState("");
  const [nlApplied, setNlApplied] = useState<NLApplied | null>(null);
  const [nlError, setNlError] = useState<string | null>(null);
  const [nlBusy, setNlBusy] = useState(false);
  const [nlSuggestion, setNlSuggestion] = useState<{
    text: string;
    description: string[];
    filter: Record<string, unknown>;
  } | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusIdx, setFocusIdx] = useState(-1);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Set<string>>(new Set());
  const prevStates = useRef<Map<string, string>>(new Map());
  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([]);
  const nlRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Manual controls always work. With an AI/NL filter applied they merge
  // over it (same shared FilterQuery server-side): manual state chips replace
  // NL states, search replaces NL name search. An NL result that compiles to a
  // sort (e.g. "who is costing the most") presets the sort control, which the
  // instructor can then override like any manual choice.
  const params = useMemo(() => {
    const p = new URLSearchParams();
    const f = (nlApplied?.filter ?? {}) as Record<string, unknown>;
    for (const k of ["step", "minStepMinutes", "minProgressPct", "maxProgressPct", "minSpend"]) {
      if (typeof f[k] === "number") p.set(k, String(f[k]));
    }
    if (f.stuck === true) p.set("stuck", "1");
    const states = stateFilter.length ? stateFilter.join(",") : Array.isArray(f.states) ? (f.states as string[]).join(",") : "";
    if (states) p.set("states", states);
    const q = search.trim() || (typeof f.q === "string" ? f.q : "");
    if (q) p.set("q", q);
    p.set("sort", sortBy);
    if (sortBy === "spend" || sortBy === "stepMinutes" || sortBy === "progress") p.set("order", "desc");
    return p;
  }, [stateFilter, search, sortBy, nlApplied]);

  const poll = useCallback(async () => {
    try {
      const [sRes, eRes] = await Promise.all([
        fetch("/api/session", { cache: "no-store" }),
        fetch(`/api/environments?${params.toString()}`, { cache: "no-store" }),
      ]);
      if (!sRes.ok || !eRes.ok) throw new Error(`server ${sRes.status}/${eRes.status}`);
      const s = (await sRes.json()) as Summary;
      const e = await eRes.json();
      const nextRows = e.environments as EnvRow[];

      // Mark rows whose state changed since the previous poll.
      const changed = new Set<string>();
      for (const r of nextRows) {
        // Compare the derived status, not the raw state: stuck is a
        // threshold crossing (in_use + 20 min), not a state, so a state-only
        // compare never flashes the event this console exists to catch.
        const st = r.stuck ? "stuck" : r.state;
        const prev = prevStates.current.get(r.id);
        if (prev && prev !== st) changed.add(r.id);
        prevStates.current.set(r.id, st);
      }
      if (changed.size) {
        setFlash(changed);
        window.setTimeout(() => setFlash(new Set()), 1000);
      }
      setSummary(s);
      setRows(nextRows);
      setFilteredCount(e.filtered);
      setFetchError(null);
      setLastOkAt(Date.now());
      setLoading(false);
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "network error");
      setLoading(false);
    }
  }, [params]);

  useEffect(() => {
    setLoading(true);
    poll();
    const t = window.setInterval(poll, POLL_MS);
    return () => window.clearInterval(t);
  }, [poll]);

  const reprovision = useCallback(async (id: string) => {
    setPending((p) => new Set(p).add(id));
    try {
      const res = await fetch(`/api/environments/${id}/reprovision`, { method: "POST" });
      if (!res.ok) throw new Error(`server ${res.status}`);
      await poll();
    } catch {
      setFetchError("reprovision failed; will retry on next poll");
    } finally {
      setPending((p) => {
        const n = new Set(p);
        n.delete(id);
        return n;
      });
    }
  }, [poll]);

  const applyNL = useCallback(async () => {
    const text = nlText.trim();
    if (!text) return;
    setNlBusy(true);
    setNlError(null);
    try {
      const res = await fetch("/api/nl-filter", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`server ${res.status}`);
      const data = await res.json();
      if (!data.ok) {
        setNlError(data.message ?? "Could not understand that filter.");
      } else {
        const f = (data.filter ?? {}) as Record<string, unknown>;
        if (data.requiresConfirmation) {
          // Model-compiled: show the plain-language reading first, apply on confirm.
          setNlSuggestion({ text, description: data.description ?? [], filter: f });
        } else {
          setNlApplied({
            text,
            description: data.description ?? [],
            source: data.source,
            degraded: !!data.degraded,
            filter: f,
          });
          if (data.degraded && data.message) setNlError(data.message);
          if (typeof f.sort === "string") setSortBy(f.sort);
          setNlText("");
        }
      }
    } catch {
      setNlError("AI filter unavailable right now. Manual filters below still work.");
    } finally {
      setNlBusy(false);
    }
  }, [nlText]);

  const clearNL = useCallback(() => {
    setNlApplied(null);
    setNlSuggestion(null);
    setNlError(null);
  }, []);

  // Keyboard: "/" focuses the AI filter, arrows move row focus, r reprovisions, Esc clears.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement)?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (ev.key === "/" && !typing) {
        ev.preventDefault();
        nlRef.current?.focus();
        return;
      }
      if (typing) {
        if (ev.key === "Escape") (ev.target as HTMLElement).blur();
        return;
      }
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        setFocusIdx((i) => {
          const next = ev.key === "ArrowDown" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
          rowRefs.current[next]?.focus();
          return next;
        });
      } else if (ev.key === "r" && focusIdx >= 0) {
        const row = rows[focusIdx];
        if (row && row.state === "failed" && !pending.has(row.id)) reprovision(row.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, focusIdx, pending, reprovision]);

  rowRefs.current = [];
  const toggleState = (s: EnvState) =>
    setStateFilter((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  const elapsed = summary ? fmtClock(Date.now() - summary.sessionStartedAt) : "-";
  const selected = rows.find((r) => r.id === selectedId) ?? null;

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-line bg-surface">
        <div className="mx-auto flex min-h-12 max-w-[1440px] flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 sm:px-5">
          <h1 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">CloudLabs Workshop Ops</h1>
          <span className="truncate text-[12px] text-muted">{summary?.sessionName ?? "loading session"}</span>
          <div className="ml-auto flex items-center gap-6">
            <span className="live" data-stale={fetchError ? "true" : undefined} aria-live="polite">
              <span aria-hidden className="live-dot" />
              {fetchError ? "Stale" : "Live"}
            </span>
            <span className="label flex items-baseline gap-2">
              Elapsed <span className="tnum font-mono text-[13px] font-semibold normal-case tracking-normal text-ink">{elapsed}</span>
            </span>
            <span className="label flex items-baseline gap-2">
              Est. spend{" "}
              <span className="tnum text-[20px] leading-6 font-semibold normal-case tracking-[-0.02em] text-ink">
                ${summary ? summary.estimatedSpend.toFixed(2) : "-"}
              </span>
            </span>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-[1440px] flex-col gap-4 px-4 py-4 sm:px-5 lg:flex-row lg:gap-5">
        {/* Left rail: session aggregates */}
        <aside className="w-full lg:sticky lg:top-16 lg:w-[220px] lg:shrink-0 lg:self-start">
          <section>
            <h2 className="label mb-2">Session</h2>
            <dl className="divide-y divide-line border-y border-line">
              {([
                ["Active", summary ? `${summary.active} / ${summary.total}` : "-", undefined],
                ["Failures", summary ? String(summary.failures) : "-", summary && summary.failures > 0 ? "failed" : undefined],
                ["Stuck 20m+", summary ? String(summary.stuckCount) : "-", summary && summary.stuckCount > 0 ? "stuck" : undefined],
                ["Avg completion", summary ? `${summary.avgCompletionPct}%` : "-", undefined],
              ] as const).map(([k, v, tone]) => (
                <div key={k} data-st={tone} className="flex h-8 items-center justify-between">
                  <dt className="text-[12px] text-ink-2">{k}</dt>
                  <dd className="rail-value tnum">{v}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="mt-6">
            <h2 className="label mb-2">Environments by state</h2>
            {summary && (
              <>
                <div className="hist" role="img" aria-label="State distribution">
                  {(Object.keys(STATE_META) as EnvState[]).map((s) =>
                    summary.byState[s] > 0 ? (
                      <div key={s} className="hist-seg" data-st={s} style={{ flexGrow: summary.byState[s] }} />
                    ) : null
                  )}
                </div>
                <ul className="mt-3 space-y-1">
                  {(Object.keys(STATE_META) as EnvState[]).map((s) => (
                    <li key={s} className="flex h-6 items-center justify-between">
                      <StatusChip state={s} stuck={false} />
                      <span className="tnum text-[12px] font-medium text-ink">{summary.byState[s]}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>

          <p className="mt-6 text-[11px] leading-4 text-muted">
            Polling every {POLL_MS / 1000}s.
            {lastOkAt ? " Last update " + new Date(lastOkAt).toLocaleTimeString() + "." : ""}
            {" "}Keys: <kbd className="kbd">/</kbd> filter,{" "}
            <kbd className="kbd">↑↓</kbd> rows,{" "}
            <kbd className="kbd">r</kbd> reprovision.
          </p>
        </aside>

        {/* Main */}
        <main className="min-w-0 flex-1">
          {/* Natural-language filter */}
          <div className="surface p-3">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  ref={nlRef}
                  value={nlText}
                  onChange={(e) => setNlText(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && applyNL()}
                  placeholder='Ask in plain words, e.g. "everyone stuck on step 4 over 20 min"'
                  aria-label="Natural language filter"
                  className="control h-9 w-full pr-9 text-[13px]"
                />
                <span aria-hidden data-key="/" className="kbd-hint pointer-events-none absolute right-2 top-1/2 -translate-y-1/2" />
              </div>
              <button
                onClick={applyNL}
                disabled={nlBusy || !nlText.trim()}
                className="btn btn-primary h-9 px-3"
              >
                {nlBusy ? "Compiling" : "Apply"}
              </button>
              {nlApplied && (
                <button onClick={clearNL} className="btn h-9 px-3">
                  Clear filter
                </button>
              )}
            </div>
            {nlSuggestion && (
              <div className="note-info mt-2 flex flex-wrap items-center gap-2">
                <span>
                  <span className="font-semibold">AI model suggests:</span>{" "}
                  {nlSuggestion.description.join("; ") || "no filter"} for &ldquo;{nlSuggestion.text}&rdquo;
                </span>
                <button
                  onClick={() => {
                    setNlApplied({
                      text: nlSuggestion.text,
                      description: nlSuggestion.description,
                      source: "llm",
                      degraded: false,
                      filter: nlSuggestion.filter,
                    });
                    setNlSuggestion(null);
                    if (typeof nlSuggestion.filter.sort === "string") setSortBy(nlSuggestion.filter.sort);
                    setNlText("");
                  }}
                  className="btn btn-sm btn-primary"
                >
                  Apply
                </button>
                <button
                  onClick={() => setNlSuggestion(null)}
                  className="btn btn-sm"
                >
                  Dismiss
                </button>
              </div>
            )}
            {nlApplied && (
              <p className="mt-2 text-[12px] text-ink-2">
                <span className="font-semibold text-ink">{nlApplied.source === "llm" ? "AI filter:" : "Filter:"}</span> {nlApplied.text}
                {nlApplied.description.length > 0 && (
                  <span className="text-muted"> ( {nlApplied.description.join("; ")} )</span>
                )}
                <span className="text-muted">
                  {" "}compiled {nlApplied.source === "llm" ? "by the AI model, confirmed by you" : "by the offline compiler, no model used"}
                  {(stateFilter.length > 0 || search.trim()) && "; combined with your manual filters"}
                </span>
              </p>
            )}
            {nlError && (
              <p role="alert" className="note-warn mt-2">
                {nlError}
              </p>
            )}
          </div>

          {/* Manual filter bar */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {(Object.keys(STATE_META) as EnvState[]).map((s) => {
              const on = stateFilter.includes(s);
              return (
                <button
                  key={s}
                  onClick={() => toggleState(s)}
                  aria-pressed={on}
                  data-st={s}
                  className="chip"
                >
                  <span aria-hidden className="glyph" />
                  {STATE_META[s].label}
                  <span className="chip-count tnum">{summary ? summary.byState[s] : ""}</span>
                </button>
              );
            })}
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search learner"
              aria-label="Search learner"
              className="control h-7 w-44 text-[12px]"
            />
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              aria-label="Sort by"
              className="control h-7 pr-6 text-[12px]"
            >
              <option value="risk">Sort: risk first</option>
              <option value="name">Sort: name</option>
              <option value="progress">Sort: progress</option>
              <option value="spend">Sort: spend</option>
              <option value="stepMinutes">Sort: longest on step</option>
            </select>
            <span className="ml-auto text-[11px] text-muted">
              <span className="tnum">{filteredCount}</span> of <span className="tnum">{summary?.total ?? 120}</span> shown
            </span>
          </div>

          {fetchError && (
            <div role="alert" className="banner-error mt-3">
              <span>Live data unavailable ({fetchError}). Showing last good snapshot.</span>
              <button onClick={poll} className="btn btn-sm btn-danger">
                Retry now
              </button>
            </div>
          )}

          {/* Dense table */}
          <div className="ops-scroll surface mt-3">
            <table className="ops-table" aria-busy={loading}>
              <colgroup>
                <col style={{ width: 96 }} />
                <col />
                <col style={{ width: 168 }} />
                <col style={{ width: 88 }} />
                <col style={{ width: 96 }} />
                <col style={{ width: 128 }} />
              </colgroup>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Learner</th>
                  <th>Progress</th>
                  <th className="text-right">On step</th>
                  <th className="text-right">Spend</th>
                  <th className="text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {loading &&
                  Array.from({ length: 18 }).map((_, i) => (
                    <tr key={`sk-${i}`}>
                      <td colSpan={6}>
                        <div className="skeleton" style={{ width: `${55 + ((i * 37) % 40)}%` }} />
                      </td>
                    </tr>
                  ))}
                {!loading && rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-10 text-center text-[13px] text-ink-2">
                      No environments match these filters.
                      <button
                        onClick={() => {
                          setStateFilter([]);
                          setSearch("");
                          clearNL();
                        }}
                        className="btn ml-2"
                      >
                        Clear all filters
                      </button>
                    </td>
                  </tr>
                )}
                {!loading &&
                  rows.map((r, i) => {
                    const isSel = selectedId === r.id;
                    const isPending = pending.has(r.id);
                    return (
                      <tr
                        key={r.id}
                        ref={(el) => {
                          rowRefs.current[i] = el;
                        }}
                        tabIndex={0}
                        data-st={r.stuck ? "stuck" : r.state}
                        data-selected={isSel || undefined}
                        onFocus={() => setFocusIdx(i)}
                        onClick={() => setSelectedId(isSel ? null : r.id)}
                        onKeyDown={(e) => {
                          if (e.target !== e.currentTarget) return; // Enter on the Reprovision button stays on the button
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setSelectedId(isSel ? null : r.id);
                          }
                        }}
                        className={flash.has(r.id) ? "row-flash" : undefined}
                      >
                        <td><StatusChip state={r.state} stuck={r.stuck} /></td>
                        <td>
                          <div className="flex min-w-0 items-baseline gap-2">
                            <span className="truncate font-medium text-ink">{r.learnerName}</span>
                            <span className="shrink-0 font-mono text-[11px] text-muted">{r.id}</span>
                          </div>
                          {r.state === "failed" && r.failureReason && (
                            <div className="row-reason" title={r.failureReason}>{r.failureReason}</div>
                          )}
                        </td>
                        <td>
                          <div className="flex items-center gap-2">
                            <div className="meter">
                              <div className="meter-fill" style={{ width: `${r.progressPct}%` }} />
                            </div>
                            <span className="tnum font-mono text-[11px] text-ink-2">
                              {r.step}/{r.totalSteps}
                            </span>
                          </div>
                        </td>
                        <td className={`tnum cell-num ${r.stuck ? "font-semibold text-stuck" : "text-ink-2"}`}>
                          {r.state === "in_use" || r.state === "failed" ? fmtMin(r.onStepMinutes) : <span className="dash">-</span>}
                        </td>
                        <td className="tnum cell-num text-ink">${r.spendUsd.toFixed(2)}</td>
                        <td className="text-right">
                          {r.state === "failed" && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                reprovision(r.id);
                              }}
                              disabled={isPending}
                              className="btn btn-sm btn-danger"
                            >
                              {isPending ? "Reprovisioning" : "Reprovision"}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>

          {/* Detail strip for the selected row */}
          {selected && (
            <section className="surface mt-3 flex flex-wrap items-start gap-x-8 gap-y-3 p-4 text-[12px]"
              data-st={selected.stuck ? "stuck" : selected.state}>
              <div>
                <div className="text-[15px] font-semibold text-ink">{selected.learnerName}</div>
                <div className="text-muted">{selected.learnerEmail}</div>
              </div>
              <div>
                <div className="label">State</div>
                <StatusChip state={selected.state} stuck={selected.stuck} />
                {selected.failureReason && (
                  <div className="mt-1 max-w-[40ch] text-[11px] text-failed">{selected.failureReason}</div>
                )}
              </div>
              <div>
                <div className="label">Progress</div>
                <div className="tnum text-[15px] font-semibold text-ink">
                  {selected.step}/{selected.totalSteps} ({selected.progressPct}%)
                </div>
              </div>
              <div>
                <div className="label">Spend</div>
                <div className="tnum text-[15px] font-semibold text-ink">${selected.spendUsd.toFixed(2)}</div>
                <div className="font-mono text-[11px] text-muted">
                  ${selected.ratePerHour.toFixed(2)}/h, {fmtMin(selected.runtimeMinutes)} runtime
                </div>
              </div>
              {selected.state === "failed" && (
                <button
                  onClick={() => reprovision(selected.id)}
                  disabled={pending.has(selected.id)}
                  className="btn btn-danger ml-auto h-8 px-3"
                >
                  {pending.has(selected.id) ? "Reprovisioning" : "Reprovision environment"}
                </button>
              )}
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
