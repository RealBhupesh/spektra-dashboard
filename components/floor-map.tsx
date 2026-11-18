"use client";

import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { LAB_STEPS } from "@/lib/seed";
import { type EnvRow, type SeatStatus, SEATS_PER_ROW, STATE_META, StatusChip, fmtMin, fmtUsd, seatIndex, seatOf, seatStatus } from "./ui";

export type ColorMode = "status" | "spend" | "progress";

const LEGEND_ORDER: SeatStatus[] = ["in_use", "stuck", "failed", "ready", "provisioning", "deprovisioned"];
const AISLE_AFTER = 6;
const rampFill = (pct: number) => `color-mix(in srgb, var(--seat-ramp-end) ${pct}%, var(--seat-ramp-start))`;

// A cinema-style seat map: row A is nearest the instructor's screen, an aisle
// splits the room, and each seat is one learner's PC. In Status mode a filled
// seat means someone is working; an outlined seat is on but idle; a grey seat
// is switched off. Red and amber are reserved for the two things that need you.
export function FloorMap({
  everyone,
  matched,
  mode,
  onModeChange,
  selectedId,
  onSelect,
  loading,
  flash,
  statusFilter,
  onToggleStatus,
}: {
  everyone: EnvRow[];
  matched: Set<string> | null;
  mode: ColorMode;
  onModeChange: (m: ColorMode) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  loading: boolean;
  flash: Set<string>;
  statusFilter: Set<SeatStatus>;
  onToggleStatus: (s: SeatStatus) => void;
}) {
  const seats = useMemo(() => everyone.slice().sort((a, b) => seatIndex(a.id) - seatIndex(b.id)), [everyone]);
  const maxSpend = useMemo(() => Math.max(0.01, ...seats.map((s) => s.spendUsd)), [seats]);
  const counts = useMemo(() => {
    const c: Record<SeatStatus, number> = { failed: 0, stuck: 0, in_use: 0, provisioning: 0, ready: 0, deprovisioned: 0 };
    for (const s of seats) c[seatStatus(s)]++;
    return c;
  }, [seats]);

  const innerRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ id: string; x: number; y: number; below: boolean } | null>(null);
  const showTip = (id: string, el: HTMLElement) => {
    const host = innerRef.current;
    if (!host) return;
    const h = host.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const x = Math.max(116, Math.min(h.width - 116, r.left - h.left + r.width / 2));
    const below = r.top - h.top < 180;
    setTip({ id, x, y: below ? r.bottom - h.top + 8 : r.top - h.top - 8, below });
  };

  const rows = seats.length === 0 ? 10 : Math.ceil(seats.length / SEATS_PER_ROW);
  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const idx = Number((e.target as HTMLElement).dataset.idx);
    if (!Number.isFinite(idx)) return;
    const delta = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: SEATS_PER_ROW, ArrowUp: -SEATS_PER_ROW }[e.key];
    if (delta === undefined) return;
    e.preventDefault();
    const next = Math.max(0, Math.min(seats.length - 1, idx + delta));
    innerRef.current?.querySelector<HTMLElement>(`[data-idx="${next}"]`)?.focus();
  };
  const tipRow = tip ? seats.find((s) => s.id === tip.id) : null;

  return (
    <section className="panel flex min-w-0 flex-col" aria-label="Lab floor map">
      <div className="panel-head flex-wrap items-center">
        <div>
          <h2 className="panel-title">Lab floor</h2>
          <p className="panel-meta">Each seat is one learner&apos;s PC. Hover for details, click to open.</p>
        </div>
        <div className="seg" role="group" aria-label="Color seats by">
          {(["status", "spend", "progress"] as const).map((m) => (
            <button key={m} aria-pressed={mode === m} onClick={() => onModeChange(m)}>
              {m === "status" ? "Status" : m === "spend" ? "Spend" : "Progress"}
            </button>
          ))}
        </div>
      </div>

      <div className="floor">
        <div ref={innerRef} className="floor-inner" onKeyDown={onGridKey} onMouseLeave={() => setTip(null)}>
          <div className="screen" aria-hidden>
            <span className="screen-curve" />
            <span className="screen-label">Instructor</span>
          </div>

          <div role="group" aria-label="Seats, row A nearest the instructor">
            {Array.from({ length: rows }).map((_, ri) => {
              const letter = String.fromCharCode(65 + ri);
              const rowSeats = seats.slice(ri * SEATS_PER_ROW, ri * SEATS_PER_ROW + SEATS_PER_ROW);
              return (
                <div key={letter} className="seat-row">
                  <span className="row-label" aria-hidden>
                    {letter}
                  </span>
                  {Array.from({ length: SEATS_PER_ROW }).map((__, si) => {
                    const r = rowSeats[si];
                    const aisle = si === AISLE_AFTER - 1 ? <span className="aisle" aria-hidden /> : null;
                    if (!r) {
                      return (
                        <span key={si} className="contents">
                          <span className={`seat${loading ? " skeleton" : ""}`} aria-hidden />
                          {aisle}
                        </span>
                      );
                    }
                    const st = seatStatus(r);
                    const idx = ri * SEATS_PER_ROW + si;
                    const style: CSSProperties & Record<string, string> = {};
                    if (mode !== "status") {
                      const t = mode === "spend" ? r.spendUsd / maxSpend : r.progressPct / 100;
                      const pct = Math.round(t * 100);
                      style["--ramp-fill"] = rampFill(pct);
                      // In light mode the fill reaches gray 117 at 67%. Both
                      // text choices clear 4.5:1 around the switch point.
                      style["--ramp-text"] = pct >= 68 ? "#ffffff" : "var(--seat-ramp-low-text)";
                    }
                    return (
                      <span key={r.id} className="contents">
                        <button
                          data-idx={idx}
                          data-env-id={r.id}
                          data-st={st}
                          data-mode={mode}
                          data-dim={(matched !== null && !matched.has(r.id)) || undefined}
                          data-selected={selectedId === r.id || undefined}
                          className={`seat${flash.has(r.id) ? " seat-flash" : ""}`}
                          style={style}
                          aria-label={`Row ${letter} seat ${si + 1}, ${r.learnerName}, ${STATE_META[st].label}${r.failureReason ? `: ${r.failureReason}` : ""}, ${r.progressPct}% done, ${fmtUsd(r.spendUsd)} spent`}
                          aria-pressed={selectedId === r.id}
                          onClick={() => onSelect(selectedId === r.id ? null : r.id)}
                          onMouseEnter={(e) => showTip(r.id, e.currentTarget)}
                          onFocus={(e) => showTip(r.id, e.currentTarget)}
                          onBlur={() => setTip(null)}
                        >
                          {si + 1}
                        </button>
                        {aisle}
                      </span>
                    );
                  })}
                  <span className="row-label" aria-hidden>
                    {letter}
                  </span>
                </div>
              );
            })}
          </div>

          {tip && tipRow && <SeatCard row={tipRow} x={tip.x} y={tip.y} below={tip.below} />}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-1 gap-y-1 border-t border-line px-3 py-2.5">
        {mode === "status" ? (
          LEGEND_ORDER.map((s) => {
            const on = statusFilter.has(s);
            return (
              <button
                key={s}
                data-st={s}
                onClick={() => onToggleStatus(s)}
                aria-pressed={on}
                title={STATE_META[s].plain}
                className={`flex items-center gap-2 rounded-md px-2 py-1 text-[12.5px] hover:bg-surface-3 ${on ? "bg-surface-3" : ""}`}
              >
                <LegendSwatch s={s} />
                <span className="text-ink-2">{STATE_META[s].label}</span>
                <span className="tnum text-muted">{counts[s]}</span>
              </button>
            );
          })
        ) : (
          <div className="flex w-full flex-wrap items-center gap-3 px-1 text-[12px] text-muted">
            <span>{mode === "spend" ? "$0" : "0%"}</span>
            <span aria-hidden className="flex h-2 w-48 overflow-hidden rounded-sm border border-line">
              {[0, 25, 50, 75, 100].map((pct) => <span key={pct} className="flex-1" style={{ background: rampFill(pct) }} />)}
            </span>
            <span className="tnum">{mode === "spend" ? fmtUsd(maxSpend) : "100%"}</span>
            <span className="ml-auto">{mode === "spend" ? "Darker seat = more spent so far" : "Darker seat = further through the 12 steps"}</span>
          </div>
        )}
      </div>
    </section>
  );
}

function LegendSwatch({ s }: { s: SeatStatus }) {
  const v: Record<SeatStatus, CSSProperties & Record<string, string>> = {
    in_use: { "--fill": "var(--active)", "--edge": "var(--active)" },
    stuck: { "--fill": "var(--stuck)", "--edge": "var(--stuck)" },
    failed: { "--fill": "var(--failed)", "--edge": "var(--failed)" },
    ready: { "--edge": "var(--ready)" },
    provisioning: { "--edge": "var(--booting)", borderStyle: "dashed" },
    deprovisioned: { "--fill": "var(--off)", "--edge": "var(--off)" },
  };
  return <span aria-hidden className="legend-swatch" style={v[s]} />;
}

function SeatCard({ row, x, y, below }: { row: EnvRow; x: number; y: number; below: boolean }) {
  const st = seatStatus(row);
  const active = row.state === "in_use" || row.state === "failed";
  return (
    <div className="seat-tip" data-st={st} style={{ left: x - 116, top: y, transform: below ? undefined : "translateY(-100%)" }} role="tooltip">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[13px] font-semibold text-ink">{row.learnerName}</span>
        <span className="font-mono text-[11.5px] text-muted">{seatOf(row.id)}</span>
      </div>
      <div className="mt-1.5 flex items-center justify-between">
        <StatusChip state={row.state} stuck={row.stuck} />
        <span className="tnum text-[12.5px] text-ink-2">{fmtUsd(row.spendUsd)}</span>
      </div>
      {row.failureReason && <div className="mt-1.5 text-[12px] text-failed">{row.failureReason}</div>}
      {active && row.step >= 1 && (
        <div className="mt-1.5 text-[12px] leading-4 text-muted">
          Step {row.step} of {row.totalSteps}: <span className="text-ink-2">{LAB_STEPS[row.step - 1]}</span>
          <span className={row.stuck ? " font-medium text-stuck" : ""}> · {fmtMin(row.onStepMinutes)}</span>
        </div>
      )}
      {row.state === "deprovisioned" && <div className="mt-1.5 text-[12px] text-muted">Completed all {row.totalSteps} steps</div>}
      {(row.state === "ready" || row.state === "provisioning") && <div className="mt-1.5 text-[12px] text-muted">Hasn&apos;t started the lab</div>}
    </div>
  );
}
