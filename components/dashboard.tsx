"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { LAB_STEPS } from "@/lib/seed";
import { FloorMap, type ColorMode } from "./floor-map";
import { ActivityPulse, AttentionQueue, StepFunnel, TopSpenders, type Transition } from "./ops-graphics";
import {
  CHIP_ORDER,
  type EnvRow,
  type EnvState,
  type SeatStatus,
  type Summary,
  Icon,
  STATE_META,
  Sparkline,
  StatusChip,
  fmtClock,
  fmtMin,
  fmtUsd,
  idOfSeat,
  seatOf,
  seatStatus,
} from "./ui";

interface NLApplied {
  text: string;
  description: string[];
  source: string;
  degraded: boolean;
  filter: Record<string, unknown>;
}

type View = "floor" | "table";

const POLL_MS = 4000;
const HISTORY = 45;
const EMPTY_ADV = { stuck: false, step: "", minStepMinutes: "", minProgressPct: "", maxProgressPct: "", minSpend: "" };

export default function Dashboard() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [transitions, setTransitions] = useState<Transition[]>([]);
  const [rows, setRows] = useState<EnvRow[]>([]);
  const [everyone, setEveryone] = useState<EnvRow[]>([]);
  const [filteredCount, setFilteredCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  const [history, setHistory] = useState<{ t: number; spend: number; attention: number }[]>([]);
  const [, setTick] = useState(0);

  const [view, setView] = useState<View>("floor");
  const [mode, setMode] = useState<ColorMode>("status");
  const [theme, setTheme] = useState<"light" | "dark">("light");

  const [stateFilter, setStateFilter] = useState<EnvState[]>([]);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState("risk");
  const [nlText, setNlText] = useState("");
  const [nlApplied, setNlApplied] = useState<NLApplied | null>(null);
  const [nlError, setNlError] = useState<string | null>(null);
  const [nlBusy, setNlBusy] = useState(false);
  const [nlSuggestion, setNlSuggestion] = useState<{ text: string; description: string[]; filter: Record<string, unknown> } | null>(null);

  // Advanced manual controls: the same predicates the NL filter compiles to,
  // so no filtering capability depends on the natural-language feature.
  const [advOpen, setAdvOpen] = useState(false);
  const [adv, setAdv] = useState(EMPTY_ADV);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Set<string>>(new Set());
  const prevStates = useRef<Map<string, string>>(new Map());
  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([]);
  const nlRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get("view");
    if (v === "table" || v === "floor") setView(v);
    const attr = document.documentElement.dataset.theme;
    setTheme(attr === "dark" || attr === "light" ? attr : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  const switchView = (v: View) => {
    setView(v);
    const u = new URL(window.location.href);
    if (v === "floor") u.searchParams.delete("view");
    else u.searchParams.set("view", v);
    window.history.replaceState(null, "", u);
  };
  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("ops-theme", next);
    } catch {
      /* private mode: theme still applies for this visit */
    }
  };

  // Manual controls always work. With a natural-language filter applied they
  // merge over it (same shared FilterQuery server-side): manual state chips
  // replace the filter's states, search replaces its name search, and any
  // advanced control replaces the same field from the filter.
  const params = useMemo(() => {
    const p = new URLSearchParams();
    const f = (nlApplied?.filter ?? {}) as Record<string, unknown>;
    for (const k of ["step", "minStepMinutes", "minProgressPct", "maxProgressPct", "minSpend"] as const) {
      const manual = adv[k].trim();
      if (manual !== "" && Number.isFinite(Number(manual))) p.set(k, manual);
      else if (typeof f[k] === "number") {
        p.set(k, String(f[k]));
        const excl = { step: null, minStepMinutes: "minStepMinutesExclusive", minProgressPct: "minProgressExclusive", maxProgressPct: "maxProgressExclusive", minSpend: "minSpendExclusive" }[k];
        if (excl && f[excl] === true) p.set(excl, "1");
      }
    }
    if (adv.stuck || f.stuck === true) p.set("stuck", "1");
    const states = stateFilter.length ? stateFilter.join(",") : Array.isArray(f.states) ? (f.states as string[]).join(",") : "";
    if (states) p.set("states", states);
    // A seat label ("B7") searches for the PC in that seat.
    const typed = search.trim();
    const q = (typed && (idOfSeat(typed) ?? typed)) || (typeof f.q === "string" ? f.q : "");
    if (q) p.set("q", q);
    p.set("sort", sortBy);
    if (sortBy === "spend" || sortBy === "stepMinutes" || sortBy === "progress") p.set("order", "desc");
    return p;
  }, [stateFilter, search, sortBy, nlApplied, adv]);

  const hasFilter = useMemo(() => [...params.keys()].some((k) => k !== "sort" && k !== "order"), [params]);

  // Superseded responses are discarded: a slow earlier poll must never
  // overwrite fresher rows.
  const pollSeq = useRef(0);
  const poll = useCallback(async () => {
    const seq = ++pollSeq.current;
    try {
      // Rows, the whole room and the summary come from one snapshot, so
      // every panel always agrees.
      const eRes = await fetch(`/api/environments?${params.toString()}&include=all`, { cache: "no-store" });
      if (!eRes.ok) throw new Error(`server ${eRes.status}`);
      const e = await eRes.json();
      if (seq !== pollSeq.current) return;
      const s = e.summary as Summary;
      const nextRows = e.environments as EnvRow[];
      const all = Array.isArray(e.everyone) ? (e.everyone as EnvRow[]) : nextRows;

      // Stuck is a threshold crossing, not a state: compare derived status.
      const changed = new Set<string>();
      for (const r of all) {
        const st = seatStatus(r);
        const prev = prevStates.current.get(r.id);
        if (prev && prev !== st) changed.add(r.id);
        prevStates.current.set(r.id, st);
      }
      if (changed.size) {
        setFlash(changed);
        window.setTimeout(() => setFlash(new Set()), 1000);
      }
      setSummary(s);
      setTransitions(Array.isArray(e.transitions) ? (e.transitions as Transition[]) : []);
      setRows(nextRows);
      setEveryone(all);
      setFilteredCount(e.filtered);
      setHistory((h) =>
        h.length && h[h.length - 1].t === s.now ? h : [...h, { t: s.now, spend: s.estimatedSpend, attention: s.failures + s.stuckCount }].slice(-HISTORY),
      );
      setFetchError(null);
      setLastOkAt(Date.now());
      setLoading(false);
    } catch (err) {
      if (seq !== pollSeq.current) return;
      setFetchError(err instanceof Error ? err.message : "network error");
      setLoading(false);
    }
  }, [params]);

  useEffect(() => {
    poll();
    const t = window.setInterval(poll, POLL_MS);
    return () => window.clearInterval(t);
  }, [poll]);

  const [actionError, setActionError] = useState<{ id: string; message: string } | null>(null);
  const reprovision = useCallback(
    async (id: string) => {
      setPending((p) => new Set(p).add(id));
      setActionError(null);
      try {
        const res = await fetch(`/api/environments/${id}/reprovision`, { method: "POST" });
        if (!res.ok) throw new Error(`server ${res.status}`);
        await poll();
      } catch {
        setActionError({ id, message: `Reprovision of ${id} (seat ${seatOf(id)}) failed.` });
      } finally {
        setPending((p) => {
          const n = new Set(p);
          n.delete(id);
          return n;
        });
      }
    },
    [poll],
  );

  const applyNL = useCallback(async () => {
    const text = nlText.trim();
    if (!text) return;
    setNlBusy(true);
    setNlError(null);
    try {
      const res = await fetch("/api/nl-filter", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
      if (!res.ok) throw new Error(`server ${res.status}`);
      const data = await res.json();
      if (!data.ok) {
        setNlError(data.message ?? "Could not understand that filter.");
      } else {
        const f = (data.filter ?? {}) as Record<string, unknown>;
        if (data.requiresConfirmation) {
          setNlSuggestion({ text, description: data.description ?? [], filter: f });
        } else {
          setNlApplied({ text, description: data.description ?? [], source: data.source, degraded: !!data.degraded, filter: f });
          if (data.degraded && data.message) setNlError(data.message);
          if (typeof f.sort === "string") setSortBy(f.sort);
          setNlText("");
        }
      }
    } catch {
      setNlError("Natural-language filter unavailable right now. Manual filters below still work.");
    } finally {
      setNlBusy(false);
    }
  }, [nlText]);

  const clearNL = useCallback(() => {
    setNlApplied(null);
    setNlSuggestion(null);
    setNlError(null);
  }, []);
  const clearAll = () => {
    setStateFilter([]);
    setSearch("");
    setAdv(EMPTY_ADV);
    clearNL();
  };

  // Keyboard: "/" focuses the filter, arrows move table rows, r reprovisions
  // the focused PC (row or seat), Esc closes the detail panel.
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
      if (ev.key === "Escape") {
        setSelectedId(null);
        return;
      }
      if (view === "table" && (ev.key === "ArrowDown" || ev.key === "ArrowUp")) {
        ev.preventDefault();
        const cur = rowRefs.current.findIndex((r) => r === document.activeElement);
        const next = ev.key === "ArrowDown" ? Math.min(rows.length - 1, cur + 1) : Math.max(0, cur - 1);
        rowRefs.current[next]?.focus();
      } else if (ev.key === "r") {
        // Resolve by the focused element's stable id; polls reorder rows.
        const id = (document.activeElement as HTMLElement | null)?.dataset?.envId;
        const row = id ? everyone.find((r) => r.id === id) ?? rows.find((r) => r.id === id) : undefined;
        if (row && row.state === "failed" && !pending.has(row.id)) reprovision(row.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, everyone, pending, reprovision, view]);

  rowRefs.current = [];
  const toggleState = (s: EnvState) => setStateFilter((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  const statusFilter = useMemo(() => {
    const set = new Set<SeatStatus>(stateFilter);
    if (adv.stuck) set.add("stuck");
    return set;
  }, [stateFilter, adv.stuck]);
  const toggleStatus = (s: SeatStatus) => (s === "stuck" ? setAdv((a) => ({ ...a, stuck: !a.stuck })) : toggleState(s));

  const advActive =
    (adv.stuck ? 1 : 0) + (["step", "minStepMinutes", "minProgressPct", "maxProgressPct", "minSpend"] as const).filter((k) => adv[k] !== "").length;
  const matched = useMemo(() => (hasFilter ? new Set(rows.map((r) => r.id)) : null), [hasFilter, rows]);
  const selected = everyone.find((r) => r.id === selectedId) ?? rows.find((r) => r.id === selectedId) ?? null;
  const elapsed = summary ? fmtClock(Date.now() - summary.sessionStartedAt) : "–";
  const burn = everyone.filter((r) => r.state !== "deprovisioned").reduce((s, r) => s + r.ratePerHour, 0);
  const attention = summary ? summary.failures + summary.stuckCount : 0;

  return (
    <div className="min-h-screen">
      <header className="topbar sticky top-0 z-30">
        <div className="mx-auto flex h-12 max-w-[1480px] items-center gap-6 px-4 sm:px-6">
          <h1 className="shrink-0 text-[14px] font-semibold tracking-[-0.01em] text-ink">CloudLabs</h1>
          <nav className="hidden items-center gap-5 sm:flex" role="tablist" aria-label="View">
            <button role="tab" className="tab" aria-selected={view === "floor"} onClick={() => switchView("floor")}>
              Floor map
            </button>
            <button role="tab" className="tab" aria-selected={view === "table"} onClick={() => switchView("table")}>
              All learners
            </button>
          </nav>
          <div className="ml-auto flex items-center gap-4">
            <span className="live" data-stale={fetchError ? "true" : undefined} aria-live="polite">
              <span aria-hidden className="live-dot" />
              {fetchError ? "Reconnecting" : "Live"}
            </span>
            <span className="tnum hidden text-[12px] text-muted md:inline">{elapsed} elapsed</span>
            <span className="tnum text-[12px] text-muted">
              <span className="text-ink">{summary ? fmtUsd(summary.estimatedSpend) : "–"}</span> spent
            </span>
            <button className="icon-btn" onClick={toggleTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
              {theme === "dark" ? <Icon.Sun size={15} /> : <Icon.Moon size={15} />}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1480px] px-4 pb-12 pt-6 sm:px-6">
        <div className="mb-5">
          <div className="text-[12.5px] text-muted">Live workshop</div>
          <div className="mt-0.5 text-[20px] font-semibold tracking-[-0.015em] text-ink">{summary?.sessionName ?? "Loading session…"}</div>
        </div>

        {/* Stats */}
        <div className="command-band panel stats">
          <Stat
            label="PCs switched on"
            value={summary ? `${summary.active}` : "–"}
            suffix={summary ? ` of ${summary.total}` : undefined}
            sub={
              summary ? (
                <>
                  <div className="stackbar" aria-hidden>
                    {(["in_use", "failed", "provisioning", "ready", "deprovisioned"] as const).map((s) =>
                      summary.byState[s] > 0 ? <span key={s} data-st={s} style={{ flex: summary.byState[s] }} /> : null,
                    )}
                  </div>
                  <div className="stat-sub tnum">
                    {summary.byState.in_use} in use, {summary.byState.ready} ready, {summary.byState.deprovisioned} finished
                  </div>
                </>
              ) : null
            }
          />
          <Stat
            label="Need help"
            value={summary ? String(attention) : "–"}
            valueClass={attention > 0 ? "text-failed" : undefined}
            trend={<Sparkline values={history.map((h) => h.attention)} label="Learners needing help" />}
            sub={summary ? <div className="stat-sub tnum">{summary.failures} PCs failed, {summary.stuckCount} learners stuck 20m+</div> : null}
          />
          <Stat
            label="Average progress"
            value={summary ? `${summary.avgCompletionPct}%` : "–"}
            sub={
              summary ? (
                <>
                  <div className="mt-2.5 h-1 bg-surface-3">
                    <div className="h-full" style={{ width: `${summary.avgCompletionPct}%`, background: "var(--ink-2)" }} />
                  </div>
                  <div className="stat-sub tnum">{summary.byState.deprovisioned} learners finished all 12 steps</div>
                </>
              ) : null
            }
          />
          <Stat
            label="Spent so far"
            value={summary ? fmtUsd(summary.estimatedSpend) : "–"}
            trend={<Sparkline values={history.map((h) => h.spend)} label="Spend" />}
            sub={everyone.length ? <div className="stat-sub tnum">{fmtUsd(burn)} per hour right now</div> : null}
          />
        </div>

        {/* Filters */}
        <div className="mt-6 flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <input
              ref={nlRef}
              value={nlText}
              onChange={(e) => setNlText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && applyNL()}
              placeholder='Filter in plain English, e.g. "stuck on step 4 over 20 min"'
              aria-label="Natural language filter"
              className="control h-9 w-full pr-24"
            />
            <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1">
              {nlApplied && (
                <button onClick={clearNL} className="btn btn-sm border-transparent">
                  Clear filter
                </button>
              )}
              <button onClick={applyNL} disabled={nlBusy || !nlText.trim()} className="btn btn-sm btn-primary">
                {nlBusy ? "…" : "Apply"}
              </button>
            </div>
          </div>
          <div className="relative">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint">
              <Icon.Search size={14} />
            </span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Name or seat, e.g. B7"
              aria-label="Search learner"
              className="control h-9 w-full pl-8 lg:w-56"
            />
          </div>
        </div>

        {nlSuggestion && (
          <div className="note-info mt-2 flex flex-wrap items-center gap-2">
            <span className="text-ink-2">
              <span className="font-medium text-ink">Suggested reading:</span> {nlSuggestion.description.join("; ") || "no filter"} for &ldquo;{nlSuggestion.text}&rdquo;
            </span>
            <span className="ml-auto flex gap-2">
              <button
                onClick={() => {
                  setNlApplied({ text: nlSuggestion.text, description: nlSuggestion.description, source: "llm", degraded: false, filter: nlSuggestion.filter });
                  setNlSuggestion(null);
                  if (typeof nlSuggestion.filter.sort === "string") setSortBy(nlSuggestion.filter.sort);
                  setNlText("");
                }}
                className="btn btn-sm btn-primary"
              >
                Apply
              </button>
              <button onClick={() => setNlSuggestion(null)} className="btn btn-sm">
                Dismiss
              </button>
            </span>
          </div>
        )}
        {nlApplied && (
          <p className="note-info mt-2 text-ink-2">
            <span className="font-medium text-ink">{nlApplied.source === "llm" ? "AI filter:" : "Filter:"}</span> {nlApplied.text}
            {nlApplied.description.length > 0 && <span className="text-muted"> ( {nlApplied.description.join("; ")} )</span>}
            <span className="text-muted">
              {" "}compiled {nlApplied.source === "llm" ? "by the AI model, confirmed by you" : "by the offline compiler, no model used"}
              {stateFilter.length > 0 && Array.isArray(nlApplied.filter.states)
                ? "; your state buttons override the filter's states"
                : search.trim() && typeof nlApplied.filter.q === "string"
                  ? "; your search overrides the filter's name"
                  : (stateFilter.length > 0 || search.trim()) && "; combined with your manual filters"}
            </span>
          </p>
        )}
        {nlError && (
          <p role="alert" className="note-warn mt-2">
            {nlError}
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {CHIP_ORDER.map((s) => (
            <button key={s} onClick={() => toggleState(s)} aria-pressed={stateFilter.includes(s)} data-st={s} className="chip">
              <span aria-hidden className="glyph" />
              {STATE_META[s].label}
              <span className="chip-count tnum">{summary ? summary.byState[s] : ""}</span>
            </button>
          ))}
          {view === "table" && (
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} aria-label="Sort by" className="control h-[30px] text-[12.5px]">
              <option value="risk">Sort: needs help first</option>
              <option value="name">Sort: name</option>
              <option value="progress">Sort: progress</option>
              <option value="spend">Sort: spend</option>
              <option value="stepMinutes">Sort: longest on step</option>
            </select>
          )}
          <button onClick={() => setAdvOpen((v) => !v)} aria-expanded={advOpen} className="btn btn-sm h-[30px]">
            More filters{advActive > 0 ? ` (${advActive})` : ""}
          </button>
          {advActive > 0 && (
            <button onClick={() => setAdv(EMPTY_ADV)} className="btn btn-sm h-[30px] border-transparent">
              Reset
            </button>
          )}
          <span className="tnum ml-auto text-[12px] text-muted">
            {filteredCount} of {summary?.total ?? 120} {view === "floor" && hasFilter ? "highlighted" : "shown"}
          </span>
        </div>

        {advOpen && (
          <div className="panel mt-2 flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 text-[12.5px] text-ink-2">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={adv.stuck} onChange={(e) => setAdv((a) => ({ ...a, stuck: e.target.checked }))} />
              Stuck 20m+ only
            </label>
            <label className="flex items-center gap-1.5">
              On step
              <input type="number" min={1} max={12} value={adv.step} onChange={(e) => setAdv((a) => ({ ...a, step: e.target.value }))} aria-label="On step" className="control h-7 w-16 text-[12px]" />
            </label>
            <label className="flex items-center gap-1.5">
              On step at least
              <input type="number" min={0} value={adv.minStepMinutes} onChange={(e) => setAdv((a) => ({ ...a, minStepMinutes: e.target.value }))} aria-label="Minutes on current step" className="control h-7 w-16 text-[12px]" />
              min
            </label>
            <label className="flex items-center gap-1.5">
              Progress
              <input type="number" min={0} max={100} value={adv.minProgressPct} onChange={(e) => setAdv((a) => ({ ...a, minProgressPct: e.target.value }))} aria-label="Minimum progress percent" className="control h-7 w-16 text-[12px]" />
              to
              <input type="number" min={0} max={100} value={adv.maxProgressPct} onChange={(e) => setAdv((a) => ({ ...a, maxProgressPct: e.target.value }))} aria-label="Maximum progress percent" className="control h-7 w-16 text-[12px]" />
              %
            </label>
            <label className="flex items-center gap-1.5">
              Spend at least $
              <input type="number" min={0} step="0.5" value={adv.minSpend} onChange={(e) => setAdv((a) => ({ ...a, minSpend: e.target.value }))} aria-label="Minimum spend" className="control h-7 w-20 text-[12px]" />
            </label>
          </div>
        )}

        {actionError && (
          <div role="alert" className="banner-error mt-3">
            <span>{actionError.message} The action was not applied; polling only refreshes data.</span>
            <span className="flex gap-2">
              <button onClick={() => reprovision(actionError.id)} className="btn btn-sm btn-danger">
                Retry reprovision
              </button>
              <button onClick={() => setActionError(null)} className="btn btn-sm">
                Dismiss
              </button>
            </span>
          </div>
        )}
        {fetchError && (
          <div role="alert" className="banner-error mt-3">
            <span>Live data unavailable ({fetchError}). Showing last good snapshot.</span>
            <button onClick={poll} className="btn btn-sm btn-danger">
              Retry now
            </button>
          </div>
        )}

        <div className="seg mt-4 sm:hidden" role="tablist" aria-label="View (mobile)">
          <button role="tab" aria-selected={view === "floor"} onClick={() => switchView("floor")}>
            Floor map
          </button>
          <button role="tab" aria-selected={view === "table"} onClick={() => switchView("table")}>
            All learners
          </button>
        </div>

        <div className="mt-4">
          {view === "floor" ? (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
              <div className="flex min-w-0 flex-col gap-4">
                <FloorMap
                  everyone={everyone}
                  matched={matched}
                  mode={mode}
                  onModeChange={setMode}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  loading={loading}
                  flash={flash}
                  statusFilter={statusFilter}
                  onToggleStatus={toggleStatus}
                />
                {!loading && hasFilter && rows.length === 0 && (
                  <div className="panel flex flex-wrap items-center justify-center gap-3 px-4 py-4 text-[13px] text-ink-2">
                    No environments match these filters.
                    <button onClick={clearAll} className="btn btn-sm">
                      Clear all filters
                    </button>
                  </div>
                )}
                <StepFunnel
                  everyone={everyone}
                  activeStep={adv.step === "" ? null : Number(adv.step)}
                  onSelectStep={(step) => setAdv((a) => ({ ...a, step: step === null ? "" : String(step) }))}
                />
              </div>
              <div className="flex min-w-0 flex-col gap-4">
                <AttentionQueue everyone={everyone} selectedId={selectedId} onSelect={setSelectedId} onReprovision={reprovision} pending={pending} />
                <TopSpenders everyone={everyone} onSelect={setSelectedId} />
                <ActivityPulse transitions={transitions} onSelect={setSelectedId} />
              </div>
            </div>
          ) : (
            <div className="ops-scroll panel">
              <table className="ops-table" aria-busy={loading}>
                <colgroup>
                  <col style={{ width: 120 }} />
                  <col />
                  <col style={{ width: 170 }} />
                  <col style={{ width: 96 }} />
                  <col style={{ width: 96 }} />
                  <col style={{ width: 130 }} />
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
                    Array.from({ length: 14 }).map((_, i) => (
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
                        <button onClick={clearAll} className="btn btn-sm ml-2">
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
                          data-env-id={r.id}
                          data-st={seatStatus(r)}
                          data-selected={isSel || undefined}
                          onClick={() => setSelectedId(isSel ? null : r.id)}
                          onKeyDown={(e) => {
                            if (e.target !== e.currentTarget) return;
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setSelectedId(isSel ? null : r.id);
                            }
                          }}
                          className={flash.has(r.id) ? "row-flash" : undefined}
                        >
                          <td>
                            <StatusChip state={r.state} stuck={r.stuck} />
                          </td>
                          <td>
                            <div className="flex min-w-0 items-baseline gap-2">
                              <span className="truncate text-ink">{r.learnerName}</span>
                              <span className="shrink-0 font-mono text-[11px] text-muted">{r.id}</span>
                              <span className="seat-ref w-auto">· {seatOf(r.id)}</span>
                            </div>
                            {r.state === "failed" && r.failureReason && (
                              <div className="row-reason" title={r.failureReason}>
                                {r.failureReason}
                              </div>
                            )}
                          </td>
                          <td>
                            <div className="flex items-center gap-2.5">
                              <div className="meter">
                                <div className="meter-fill" style={{ width: `${r.progressPct}%` }} />
                              </div>
                              <span className="tnum text-[12px] text-muted">
                                {r.step}/{r.totalSteps}
                              </span>
                            </div>
                          </td>
                          <td className={`tnum cell-num ${r.stuck ? "font-medium text-stuck" : "text-ink-2"}`}>
                            {r.state === "in_use" || r.state === "failed" ? fmtMin(r.onStepMinutes) : <span className="dash">–</span>}
                          </td>
                          <td className="tnum cell-num text-ink">{fmtUsd(r.spendUsd)}</td>
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
          )}

          <p className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted">
            <span>
              Updates every {POLL_MS / 1000}s{lastOkAt ? `, last at ${new Date(lastOkAt).toLocaleTimeString()}` : ""}
            </span>
            <span className="flex items-center gap-1.5">
              <kbd className="kbd">/</kbd> filter
            </span>
            <span className="flex items-center gap-1.5">
              <kbd className="kbd">↑</kbd>
              <kbd className="kbd">↓</kbd> move
            </span>
            <span className="flex items-center gap-1.5">
              <kbd className="kbd">r</kbd> reprovision
            </span>
            <span className="flex items-center gap-1.5">
              <kbd className="kbd">esc</kbd> close
            </span>
          </p>
        </div>
      </main>

      {selected && <PcPanel row={selected} pending={pending.has(selected.id)} onClose={() => setSelectedId(null)} onReprovision={reprovision} />}
    </div>
  );
}

function Stat({
  label,
  value,
  suffix,
  valueClass,
  trend,
  sub,
}: {
  label: string;
  value: string;
  suffix?: string;
  valueClass?: string;
  trend?: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <section className="stat" aria-label={label}>
      <div className="stat-label">{label}</div>
      <div className="flex items-end justify-between gap-3">
        <div className={`stat-value ${valueClass ?? "text-ink"}`}>
          {value}
          {suffix && <span className="text-[14px] font-normal tracking-normal text-muted">{suffix}</span>}
        </div>
        {trend && <div className="pb-1">{trend}</div>}
      </div>
      {sub}
    </section>
  );
}

function PcPanel({ row, pending, onClose, onReprovision }: { row: EnvRow; pending: boolean; onClose: () => void; onReprovision: (id: string) => void }) {
  const st = seatStatus(row);
  const active = row.state === "in_use" || row.state === "failed";
  const stepState = (i: number): "done" | "current" | "todo" => {
    if (row.state === "deprovisioned") return "done";
    if (!active) return "todo";
    if (i < row.step - 1) return "done";
    if (i === row.step - 1) return "current";
    return "todo";
  };

  return (
    <section className="drawer" data-st={st} aria-label={`Details for ${row.learnerName}`}>
      <div className="flex items-start gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="text-[12px] text-muted">
            Seat {seatOf(row.id)} · <span className="font-mono">{row.id}</span>
          </div>
          <div className="mt-0.5 truncate text-[17px] font-semibold tracking-[-0.01em] text-ink">{row.learnerName}</div>
          <div className="truncate text-[12.5px] text-muted">{row.learnerEmail}</div>
        </div>
        <button className="icon-btn -mr-1.5" onClick={onClose} aria-label="Close details">
          <Icon.X />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        <StatusChip state={row.state} stuck={row.stuck} />
        <p className="mt-1 text-[12.5px] text-muted">{STATE_META[st].plain}</p>

        {row.state === "failed" && (
          <div className="mt-4 rounded-md border border-line p-3">
            <div className="text-[13px] font-medium text-failed">{row.failureReason ?? "Environment failed"}</div>
            <p className="mt-1 text-[12.5px] text-muted">Reprovisioning gives the learner a fresh PC, starting again from step 1. Billing continues.</p>
            <button onClick={() => onReprovision(row.id)} disabled={pending} className="btn btn-danger-solid mt-3 w-full">
              {pending ? "Reprovisioning…" : "Reprovision environment"}
            </button>
          </div>
        )}
        {row.stuck && (
          <div className="note-warn mt-4">
            On this step for {fmtMin(row.onStepMinutes)}. Steps usually take 3 to 8 minutes, so a quick check-in may help.
          </div>
        )}

        <dl className="mt-5 grid grid-cols-3 border-y border-line py-3">
          {[
            ["Spent", fmtUsd(row.spendUsd)],
            ["Rate", `${fmtUsd(row.ratePerHour)}/h`],
            ["Runtime", fmtMin(row.runtimeMinutes)],
          ].map(([k, v]) => (
            <div key={k}>
              <dt className="text-[12px] text-muted">{k}</dt>
              <dd className="tnum mt-0.5 text-[15px] font-medium text-ink">{v}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-5 flex items-baseline justify-between">
          <h2 className="text-[13px] font-semibold text-ink">Lab steps</h2>
          <span className="tnum text-[12px] text-muted">{row.progressPct}% complete</span>
        </div>
        <ol className="mt-2" aria-label="Lab steps">
          {LAB_STEPS.slice(0, row.totalSteps).map((name, i) => {
            const s = stepState(i);
            return (
              <li key={i} className="step" data-state={s}>
                <span className="step-n">{s === "done" ? "✓" : i + 1}</span>
                <span className="min-w-0 flex-1">
                  {name}
                  {s === "current" && (
                    <span className={`ml-1.5 text-[12px] font-normal ${row.stuck ? "text-stuck" : row.state === "failed" ? "text-failed" : "text-muted"}`}>
                      {row.state === "failed" ? "failed here" : `${fmtMin(row.onStepMinutes)} so far`}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
