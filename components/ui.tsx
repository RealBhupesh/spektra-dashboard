// Shared client-side types, formatters, and small primitives.
import type { ReactNode } from "react";

export type EnvState = "provisioning" | "ready" | "in_use" | "failed" | "deprovisioned";
export type SeatStatus = EnvState | "stuck";

export interface EnvRow {
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
  stepDurationMin?: number;
  stuck: boolean;
}

export interface Summary {
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

// Plain words a newcomer can read without a glossary.
export const STATE_META: Record<SeatStatus, { label: string; plain: string }> = {
  failed: { label: "Failed", plain: "The PC crashed. Reprovision it to unblock the learner." },
  stuck: { label: "Stuck", plain: "PC is fine, but the learner hasn't moved on in 20+ minutes." },
  in_use: { label: "In use", plain: "Learner is working through the lab." },
  provisioning: { label: "Starting", plain: "PC is being set up." },
  ready: { label: "Ready", plain: "PC is on. The learner hasn't started yet." },
  deprovisioned: { label: "Finished", plain: "Lab complete. PC is switched off and no longer billing." },
};

export const CHIP_ORDER: EnvState[] = ["failed", "in_use", "provisioning", "ready", "deprovisioned"];

export const seatStatus = (r: Pick<EnvRow, "state" | "stuck">): SeatStatus => (r.stuck ? "stuck" : r.state);

// Seat assignment: learners sat down in arrival order, not grouped by state,
// so ids are spread over the room with a fixed bijection (37 is coprime with
// 120, 13 is its inverse mod 120). Stable across polls, reloads, and servers.
export const SEATS_PER_ROW = 12;
const ROOM = 120;
const SPREAD = 37;
const SPREAD_INV = 13;
export function seatIndex(id: string): number {
  const n = Number(id.replace(/\D/g, "")) - 1;
  if (!Number.isFinite(n) || n < 0) return -1;
  return n < ROOM ? (n * SPREAD) % ROOM : n;
}
export function seatOf(id: string): string {
  const p = seatIndex(id);
  if (p < 0) return "?";
  return `${String.fromCharCode(65 + Math.floor(p / SEATS_PER_ROW))}${(p % SEATS_PER_ROW) + 1}`;
}
export function idOfSeat(seat: string): string | null {
  const m = /^([A-Za-z])(\d{1,2})$/.exec(seat.trim());
  if (!m) return null;
  const col = Number(m[2]);
  const row = m[1].toUpperCase().charCodeAt(0) - 65;
  if (col < 1 || col > SEATS_PER_ROW || row < 0 || row >= ROOM / SEATS_PER_ROW) return null;
  const p = row * SEATS_PER_ROW + col - 1;
  return `env-${String(((p * SPREAD_INV) % ROOM) + 1).padStart(3, "0")}`;
}

export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
export function fmtMin(min: number): string {
  if (min < 1) return "<1m";
  if (min < 60) return `${Math.floor(min)}m`;
  return `${Math.floor(min / 60)}h ${String(Math.floor(min % 60)).padStart(2, "0")}m`;
}
export const fmtUsd = (n: number) => `$${n.toFixed(2)}`;

export function StatusChip({ state, stuck }: { state: EnvState; stuck: boolean }) {
  const st = stuck ? "stuck" : state;
  return (
    <span className="status" data-st={st}>
      <span aria-hidden className="glyph" />
      <span className="status-text">{STATE_META[st].label}</span>
    </span>
  );
}

function I({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}
type IP = { size?: number };
export const Icon = {
  X: (p: IP) => (
    <I {...p}>
      <path d="M6 6l12 12M18 6 6 18" />
    </I>
  ),
  Sun: (p: IP) => (
    <I {...p}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </I>
  ),
  Moon: (p: IP) => (
    <I {...p}>
      <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
    </I>
  ),
  Search: (p: IP) => (
    <I {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </I>
  ),
};

// One quiet line of observed poll history. Nothing is drawn until two real
// samples exist; it never invents a trend.
export function Sparkline({ values, label }: { values: number[]; label: string }) {
  const W = 96;
  const H = 24;
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const d = values
    .map((v, i) => `${i ? "L" : "M"}${((i / (values.length - 1)) * W).toFixed(1)},${(H - 2 - ((v - min) / span) * (H - 4)).toFixed(1)}`)
    .join(" ");
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}, trend since this page opened`}>
      <path d={d} fill="none" stroke="var(--faint)" strokeWidth="1.25" strokeLinejoin="round" />
    </svg>
  );
}
