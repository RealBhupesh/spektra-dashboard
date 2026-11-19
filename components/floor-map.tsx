"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { LAB_STEPS } from "@/lib/seed";
import { type EnvRow, type SeatStatus, SEATS_PER_ROW, STATE_META, StatusChip, fmtMin, fmtUsd, seatIndex, seatOf, seatStatus } from "./ui";

export type ColorMode = "status" | "spend" | "progress";

const LEGEND_ORDER: SeatStatus[] = ["in_use", "stuck", "failed", "ready", "provisioning", "deprovisioned"];
const rampFill = (pct: number) => `color-mix(in srgb, var(--seat-ramp-end) ${pct}%, var(--seat-ramp-start))`;

// Isometric lab. Seat (col c, row r) lands on a diamond lattice: columns run
// down-right, rows run down-left. Row A is the back bench. The lattice keeps
// every monitor clear of its neighbours, so all 120 PCs stay readable at once.
const W = 40;
const H = 23;
const COLS = SEATS_PER_ROW;
const RF = 1.3; // bench pitch: leaves room for chairs between benches
const OX = 0;
const OY = 0;
const P = (c: number, r: number): [number, number] => [OX + (c - r) * W, OY + (c + r) * H];
const pts = (a: [number, number][]) => a.map((p) => p.join(",")).join(" ");

// Flat screen coordinates (24 x 16) are skewed onto the iso plane with
// matrix(1, .5, 0, 1): x' = x, y' = y + x / 2.
const SW = 25;
const SH = 15.6;

function Face({ st, mode, pct, ramp }: { st: SeatStatus; mode: ColorMode; pct: number; ramp?: string }) {
  const status = mode === "status";
  let fill = "var(--surface)";
  let stroke = "none";
  let dash: string | undefined;
  if (!status) fill = ramp ?? "var(--surface)";
  else if (st === "failed") fill = "var(--failed)";
  else if (st === "stuck") fill = "var(--stuck)";
  else if (st === "deprovisioned") fill = "var(--off)";
  else if (st === "in_use") fill = "url(#hatch)";
  else if (st === "ready") stroke = "var(--ready)";
  else if (st === "provisioning") {
    stroke = "var(--booting)";
    dash = "3 2";
  }
  const mark = status ? "var(--seat-failure-text)" : "var(--ink)";
  return (
    <g>
      <rect width={SW} height={SH} fill="var(--surface)" />
      <rect width={SW} height={SH} fill={fill} stroke={stroke} strokeWidth={stroke === "none" ? 0 : 2.4} strokeDasharray={dash} />
      {st === "failed" && <path d="M8 4 L16 12 M16 4 L8 12" stroke={mark} strokeWidth="2.2" fill="none" strokeLinecap="square" />}
      {st === "stuck" && (
        <g stroke={status ? "#1d1300" : "var(--ink)"} strokeWidth="2.4" fill="none">
          <path d="M12 3.5 V9.5" />
          <path d="M12 12 V12.6" />
        </g>
      )}
      {st === "deprovisioned" && <path d="M7.5 8.5 L10.8 11.5 L16.5 4.8" stroke="var(--ink-2)" strokeWidth="2" fill="none" />}
      {status && st === "in_use" && <rect x="0" y={SH - 3.4} width={(SW * pct) / 100} height="3.4" fill="var(--ink)" />}
    </g>
  );
}

const SC = 1.12;
const quad = (cx: number, cy: number, a: [number, number], b: [number, number]): [number, number][] => [
  [cx + a[0] + b[0], cy + a[1] + b[1]],
  [cx - a[0] + b[0], cy - a[1] + b[1]],
  [cx - a[0] - b[0], cy - a[1] - b[1]],
  [cx + a[0] - b[0], cy + a[1] - b[1]],
];
// rr is the bench's real row coordinate (row index x RF).
// Keyboard: a plate with a thin front edge, four staggered key rows and a
// space bar. u runs along the long axis, t across it.
function Keyboard({ kx, ky }: { kx: number; ky: number }) {
  const kA: [number, number] = [(W / 4.4) * 1.28, (H / 4.4) * 1.28];
  const kB: [number, number] = [(-W / 4.4 / 1.5) * 0.78, (H / 4.4 / 1.5) * 0.78];
  const plate = quad(kx, ky, kA, kB);
  const at = (u: number, t: number): [number, number] => [kx + kA[0] * u + kB[0] * t, ky + kA[1] * u + kB[1] * t];
  const ts = [-0.8, -0.4, 0, 0.4, 0.8];
  let d = "";
  for (const t of ts) d += `M${at(-0.88, t).join(" ")} L${at(0.88, t).join(" ")} `;
  for (let i = 0; i < 4; i++) {
    const mid = (ts[i] + ts[i + 1]) / 2;
    const half = 0.17;
    const stagger = [0, 0.05, 0.09, 0][i];
    const cols = i === 3 ? [-0.52, 0.34] : Array.from({ length: 11 }, (_, j) => -0.88 + stagger + (j * 1.76) / 11 + 0.08);
    for (const u of cols) d += `M${at(u, mid - half).join(" ")} L${at(u, mid + half).join(" ")} `;
  }
  const lip = [plate[0], plate[1], [plate[1][0], plate[1][1] + 1.8], [plate[0][0], plate[0][1] + 1.8]] as [number, number][];
  return (
    <g>
      <polygon className="pc-line" points={pts(lip)} fill="var(--surface-3)" />
      <polygon className="pc-line" points={pts(plate)} fill="var(--surface)" />
      <path className="pc-key" d={d} fill="none" />
    </g>
  );
}

// Slim tower with a front panel: drive slots and a power button.
function Tower({ x, y }: { x: number; y: number }) {
  const ex: [number, number] = [0.87 * 7.5, 0.5 * 7.5];
  const ey: [number, number] = [-0.87 * 5.5, 0.5 * 5.5];
  const h = 16;
  const T0: [number, number] = [x, y];
  const P1: [number, number] = [x + ex[0], y + ex[1]];
  const P2: [number, number] = [x + ex[0] + ey[0], y + ex[1] + ey[1]];
  const P3: [number, number] = [x + ey[0], y + ey[1]];
  const up = (q: [number, number], k = h): [number, number] => [q[0], q[1] - k];
  const fp = (u: number, v: number): [number, number] => [P3[0] + (P2[0] - P3[0]) * u, P3[1] + (P2[1] - P3[1]) * u - v];
  return (
    <g>
      <polygon className="pc-line" points={pts([P3, P2, up(P2), up(P3)])} fill="var(--surface)" />
      <polygon className="pc-line" points={pts([P2, P1, up(P1), up(P2)])} fill="var(--surface-3)" />
      <polygon className="pc-line" points={pts([up(T0), up(P1), up(P2), up(P3)])} fill="var(--surface)" />
      <path className="pc-key" d={`M${fp(0.16, 11.5).join(" ")} L${fp(0.84, 11.5).join(" ")} M${fp(0.16, 9.2).join(" ")} L${fp(0.84, 9.2).join(" ")}`} fill="none" />
      <circle cx={fp(0.3, 4)[0]} cy={fp(0.3, 4)[1]} r="1" fill="none" stroke="var(--ink)" strokeWidth="0.8" />
    </g>
  );
}

// rr is the bench's real row coordinate (row index x RF).
function Pc({ c, rr, st, mode, pct, ramp }: { c: number; rr: number; st: SeatStatus; mode: ColorMode; pct: number; ramp?: string }) {
  const [bx, by] = P(c, rr - 0.14);
  const [kx, ky] = P(c, rr + 0.2);
  const [tx, ty] = P(c + 0.42, rr - 0.3);
  const fw = SW * SC;
  const fh = SH * SC;
  const ox = bx - fw / 2;
  const oy = by - 9 - fh - fw / 4 - 2;
  const A: [number, number] = [W / 4.4, H / 4.4];
  const B: [number, number] = [-W / 4.4 / 1.5, H / 4.4 / 1.5];
  const foot = quad(bx, by, [A[0] * 1.1, A[1] * 1.1], [B[0] * 0.75, B[1] * 0.75]);
  const mouse = quad(kx + A[0] * 1.2 * 1.62, ky + A[1] * 1.2 * 1.62, [2.6, 1.5], [-1.6, 0.9]);
  return (
    <g>
      <polygon points={pts([[bx - fw / 2 - 5, oy - 5], [bx + fw / 2 + 5, oy + fw / 2 - 5], [bx + fw / 2 + 5, by + 9], [kx - 14, ky + 8], [bx - fw / 2 - 5, oy + fh + 5]])} fill="transparent" />
      <path className="pc-cable" d={`M${bx + 3} ${by - 1} Q${bx + 10} ${by + 5} ${tx + 2} ${ty + 4}`} fill="none" />
      <Keyboard kx={kx} ky={ky} />
      <polygon className="pc-line pc-thin" points={pts(mouse)} fill="var(--surface)" />
      <polygon className="pc-line" points={pts(foot)} fill="var(--surface)" />
      <path className="pc-line" d={`M${bx - 3} ${by - 9} L${bx - 3.6} ${by - 0.6} M${bx + 3} ${by - 9} L${bx + 3.6} ${by - 0.6}`} fill="none" />
      <g transform={`translate(${ox} ${oy}) matrix(${SC} ${SC / 2} 0 ${SC} 0 0)`}>
        <rect className="pc-bezel" x="-2.6" y="-2.6" width={SW + 5.2} height={SH + 6.4} rx="1.2" fill="var(--surface)" />
        <Face st={st} mode={mode} pct={pct} ramp={ramp} />
        <circle cx={SW - 1.5} cy={SH + 2.1} r="0.75" fill="var(--ink)" />
      </g>
    </g>
  );
}

// Flat swatch for the legend: the same face the PC shows, so the key and the
// room can never disagree.
function LegendSwatch({ s }: { s: SeatStatus }) {
  return (
    <svg aria-hidden width="26" height="18" viewBox="-3 -3 30 22" className="shrink-0">
      <defs>
        <pattern id={`lg-${s}`} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="5" height="5" fill="var(--surface)" />
          <rect width="1.4" height="5" fill="var(--line-strong)" />
        </pattern>
      </defs>
      <rect x="-2" y="-2" width={SW + 4} height={SH + 4} fill="var(--surface)" stroke="var(--ink)" strokeWidth="1.2" />
      <g>
        <Face st={s} mode="status" pct={60} />
      </g>
    </svg>
  );
}

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
  onOpenTable,
  stale,
  lastOkAt,
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
  onOpenTable?: () => void;
  stale?: boolean;
  lastOkAt?: number | null;
}) {
  const seats = useMemo(() => everyone.slice().sort((a, b) => seatIndex(a.id) - seatIndex(b.id)), [everyone]);
  const maxSpend = useMemo(() => Math.max(0.01, ...seats.map((s) => s.spendUsd)), [seats]);
  const counts = useMemo(() => {
    const c: Record<SeatStatus, number> = { failed: 0, stuck: 0, in_use: 0, provisioning: 0, ready: 0, deprovisioned: 0 };
    for (const s of seats) c[seatStatus(s)]++;
    return c;
  }, [seats]);

  const [view, setView] = useState({ k: 1, cx: 0, cy: 0, init: false });
  const innerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // On a narrow screen start in the middle of the lab, not at its blank left corner.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = Math.max(0, (el.scrollWidth - el.clientWidth) / 2);
  }, []);
  const svgRef = useRef<SVGSVGElement>(null);
  const [tip, setTip] = useState<{ id: string; x: number; y: number; below: boolean } | null>(null);
  const showTip = (id: string, el: Element) => {
    const host = innerRef.current;
    if (!host) return;
    const h = host.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const x = Math.max(116, Math.min(h.width - 116, r.left - h.left + r.width / 2));
    const below = r.top - h.top < 180;
    setTip({ id, x, y: below ? r.bottom - h.top + 8 : r.top - h.top - 8, below });
  };

  const rows = seats.length === 0 ? 10 : Math.ceil(seats.length / COLS);
  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      zoomAt(curRef.current.k * 1.5);
      return;
    }
    if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      zoomAt(curRef.current.k / 1.5);
      return;
    }
    if (e.key === "0") {
      e.preventDefault();
      zoomAt(1);
      return;
    }
    if (e.shiftKey && e.key.startsWith("Arrow") && curRef.current.k > 1) {
      e.preventDefault();
      const st = 80;
      panBy(e.key === "ArrowLeft" ? st : e.key === "ArrowRight" ? -st : 0, e.key === "ArrowUp" ? st : e.key === "ArrowDown" ? -st : 0);
      return;
    }
    const t = (e.target as Element).closest("[data-idx]") as HTMLElement | null;
    const idx = Number(t?.dataset.idx);
    if (!t || !Number.isFinite(idx)) return;
    // Arrows follow the screen: right/left walk along the bench, down/up change bench.
    const delta = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLS, ArrowUp: -COLS }[e.key];
    if (delta === undefined) return;
    e.preventDefault();
    const next = Math.max(0, Math.min(seats.length - 1, idx + delta));
    innerRef.current?.querySelector<SVGElement>(`[data-idx="${next}"]`)?.focus();
  };
  const activate = (e: KeyboardEvent<SVGGElement>, id: string) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setTip(null);
      onSelect(selectedId === id ? null : id);
    }
  };
  const tipRow = tip ? seats.find((s) => s.id === tip.id) : null;
  const rowsR = (rows - 1) * RF + 1.2;
  const floor = [P(-1.1, -0.9), P(COLS + 0.1, -0.9), P(COLS + 0.1, rowsR + 1.1), P(-1.1, rowsR + 1.1)];
  const xs = floor.map((p) => p[0]);
  const ys = floor.map((p) => p[1]);
  const vb = { x: Math.min(...xs) - 12, y: Math.min(...ys) - 54, w: Math.max(...xs) - Math.min(...xs) + 24, h: Math.max(...ys) - Math.min(...ys) + 80 };
  const KMAX = 4;
  const clampView = (k: number, cx: number, cy: number) => {
    const kk = Math.max(1, Math.min(KMAX, k));
    const w = vb.w / kk;
    const h = vb.h / kk;
    return {
      k: kk,
      cx: kk === 1 ? vb.x + vb.w / 2 : Math.max(vb.x + w / 2, Math.min(vb.x + vb.w - w / 2, cx)),
      cy: kk === 1 ? vb.y + vb.h / 2 : Math.max(vb.y + h / 2, Math.min(vb.y + vb.h - h / 2, cy)),
      init: true,
    };
  };
  const cur = view.init ? clampView(view.k, view.cx, view.cy) : clampView(1, 0, 0);
  const vw = vb.w / cur.k;
  const vh = vb.h / cur.k;
  const viewBox = `${cur.cx - vw / 2} ${cur.cy - vh / 2} ${vw} ${vh}`;
  const curRef = useRef(cur);
  curRef.current = cur;
  const vbRef = useRef(vb);
  vbRef.current = vb;
  const gesture = useRef<{ pts: Map<number, { x: number; y: number }>; moved: boolean; startX: number; startY: number; pinch: number } | null>(null);
  if (!gesture.current) gesture.current = { pts: new Map(), moved: false, startX: 0, startY: 0, pinch: 0 };
  const apply = (fn: (c: typeof cur, v: typeof vb) => { k: number; cx: number; cy: number }) => {
    setTip(null);
    setView((old) => {
      void old;
      const n = fn(curRef.current, vbRef.current);
      const c = curRef.current;
      const kk = Math.max(1, Math.min(KMAX, n.k));
      const w = vbRef.current.w / kk;
      const h = vbRef.current.h / kk;
      const r = {
        k: kk,
        cx: kk === 1 ? vbRef.current.x + vbRef.current.w / 2 : Math.max(vbRef.current.x + w / 2, Math.min(vbRef.current.x + vbRef.current.w - w / 2, n.cx)),
        cy: kk === 1 ? vbRef.current.y + vbRef.current.h / 2 : Math.max(vbRef.current.y + h / 2, Math.min(vbRef.current.y + vbRef.current.h - h / 2, n.cy)),
        init: true,
      };
      curRef.current = { ...c, ...r };
      return r;
    });
  };
  // Zoom to newK, keeping the point under (px,py) (client px) fixed.
  const zoomAt = (newK: number, px?: number, py?: number) =>
    apply((c, v) => {
      const svg = svgRef.current;
      if (!svg) return { k: newK, cx: c.cx, cy: c.cy };
      const r = svg.getBoundingClientRect();
      const fx = px === undefined ? 0.5 : (px - r.left) / r.width;
      const fy = py === undefined ? 0.5 : (py - r.top) / r.height;
      const w0 = v.w / c.k;
      const h0 = v.h / c.k;
      const ax = c.cx - w0 / 2 + fx * w0;
      const ay = c.cy - h0 / 2 + fy * h0;
      const kk = Math.max(1, Math.min(KMAX, newK));
      return { k: kk, cx: ax - (fx - 0.5) * (v.w / kk), cy: ay - (fy - 0.5) * (v.h / kk) };
    });
  const panBy = (dxPx: number, dyPx: number) =>
    apply((c, v) => {
      const svg = svgRef.current;
      const r = svg?.getBoundingClientRect();
      if (!r || c.k === 1) return c;
      return { k: c.k, cx: c.cx - (dxPx / r.width) * (v.w / c.k), cy: c.cy - (dyPx / r.height) * (v.h / c.k) };
    });
  // Wheel needs a non-passive listener so Ctrl+wheel can zoom without zooming the whole page.
  // Plain wheel only pans once the lab is zoomed in, so the page still scrolls normally at Fit.
  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomAt(curRef.current.k * Math.exp(-e.deltaY * 0.0025), e.clientX, e.clientY);
      } else if (curRef.current.k > 1) {
        e.preventDefault();
        panBy(-e.deltaX, -e.deltaY);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onPointerDown = (e: React.PointerEvent) => {
    pointerDown.current = true;
    const g = gesture.current!;
    g.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.pts.size === 1) {
      g.moved = false;
      g.startX = e.clientX;
      g.startY = e.clientY;
    }
    if (g.pts.size === 2) {
      const [a, b] = [...g.pts.values()];
      g.pinch = Math.hypot(a.x - b.x, a.y - b.y);
      g.moved = true;
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current!;
    const prev = g.pts.get(e.pointerId);
    if (!prev) return;
    const now = { x: e.clientX, y: e.clientY };
    if (g.pts.size === 2) {
      g.pts.set(e.pointerId, now);
      const [a, b] = [...g.pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (g.pinch > 0 && d > 0) zoomAt(curRef.current.k * (d / g.pinch), (a.x + b.x) / 2, (a.y + b.y) / 2);
      g.pinch = d;
      return;
    }
    g.pts.set(e.pointerId, now);
    if (curRef.current.k <= 1) return;
    if (!g.moved && Math.hypot(now.x - g.startX, now.y - g.startY) > 5) {
      g.moved = true;
      try {
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
      } catch {}
    }
    if (g.moved) panBy(now.x - prev.x, now.y - prev.y);
  };
  const onPointerEnd = (e: React.PointerEvent) => {
    const g = gesture.current!;
    if (g.pts.size <= 1) setTimeout(() => (pointerDown.current = false), 0);
    g.pts.delete(e.pointerId);
    if (g.pts.size === 0) setTimeout(() => (g.moved = false), 0);
  };
  const swallowClickAfterDrag = (e: React.MouseEvent) => {
    if (gesture.current!.moved) {
      e.stopPropagation();
      e.preventDefault();
    }
  };
  // Keyboard focus only: a pointer press must never pan the view, or the world
  // shifts under the cursor before the click lands and the click misses the PC.
  const pointerDown = useRef(false);
  const revealFocused = (e: React.FocusEvent) => {
    const t = (e.target as Element).closest?.("[data-idx]");
    const svg = svgRef.current;
    if (!t || !svg || curRef.current.k <= 1 || pointerDown.current) return;
    const r = svg.getBoundingClientRect();
    const q = t.getBoundingClientRect();
    const m = 6; // only pan when the PC is actually (nearly) out of view
    let dx = 0;
    let dy = 0;
    if (q.left < r.left + m) dx = r.left + m - q.left;
    else if (q.right > r.right - m) dx = r.right - m - q.right;
    if (q.top < r.top + m) dy = r.top + m - q.top;
    else if (q.bottom > r.bottom - m) dy = r.bottom - m - q.bottom;
    if (dx || dy) panBy(dx, dy);
  };
  const letters = Array.from({ length: rows }, (_, i) => String.fromCharCode(65 + i));

  return (
    <section className="panel flex min-w-0 flex-col" aria-label="Lab floor map">
      <div className="panel-head flex-wrap items-center">
        <div>
          <h2 className="panel-title">Lab floor</h2>
          <p className="panel-meta">Each PC is one learner&apos;s. Hover for details, click to open. Ctrl + scroll or pinch to zoom, drag to pan, + / - / 0 on the keyboard.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
        <div className="seg" role="group" aria-label="Zoom lab">
          <button onClick={() => zoomAt(cur.k / 1.5)} disabled={cur.k <= 1} aria-label="Zoom out" title="Zoom out (-)">
            &minus;
          </button>
          <button onClick={() => zoomAt(cur.k * 1.5)} disabled={cur.k >= KMAX} aria-label="Zoom in" title="Zoom in (+)">
            +
          </button>
          <button onClick={() => zoomAt(1)} aria-pressed={cur.k === 1} title="Fit the whole lab (0)">
            Fit
          </button>
        </div>
        <div className="seg" role="group" aria-label="Color seats by">
          {(["status", "spend", "progress"] as const).map((m) => (
            <button key={m} aria-pressed={mode === m} onClick={() => onModeChange(m)}>
              {m === "status" ? "Status" : m === "spend" ? "Spend" : "Progress"}
            </button>
          ))}
        </div>
        </div>
      </div>

      {(stale || matched !== null) && (
        <div role="status" className="flex flex-col gap-0.5 border-t border-line px-4 py-2 text-[12.5px] text-ink-2">
          {stale && (
            <span data-stale-note>
              {lastOkAt ? `Showing the last snapshot from ${new Date(lastOkAt).toLocaleTimeString()}.` : "No snapshot loaded yet."} PCs may be out of date until the connection returns.
            </span>
          )}
          {matched !== null && (
            <span data-filter-note>
              {matched.size === 0 ? "No PCs match these filters, so all 120 are dimmed." : `${matched.size} of ${seats.length} PCs match and stay bright.`} Needs attention and the summary count all {seats.length}, not just the filtered PCs.
            </span>
          )}
        </div>
      )}

      {onOpenTable && (
        <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-2.5 text-[12.5px] text-ink-2 sm:hidden">
          <span>The lab is drawn for wide screens. On a phone the list is easier to scan.</span>
          <button className="btn btn-sm shrink-0" onClick={onOpenTable}>
            Open list
          </button>
        </div>
      )}

      <div ref={scrollRef} className="floor">
        <div
          ref={innerRef}
          className="floor-inner"
          data-zoom={cur.k.toFixed(2)}
          data-zoomed={cur.k > 1}
          onKeyDown={onGridKey}
          onMouseLeave={() => setTip(null)}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onClickCapture={swallowClickAfterDrag}
          onFocusCapture={revealFocused}
        >
          <svg ref={svgRef} viewBox={viewBox} className="iso" role="group" aria-label="Lab PCs, bench A at the back">
            <defs>
              <pattern id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="5" height="5" fill="var(--surface)" />
                <rect width="1.4" height="5" fill="var(--line-strong)" />
              </pattern>
            </defs>

            {/* room: floor outline and the instructor desk */}
            <g aria-hidden>
              <polygon points={pts(floor)} fill="var(--surface-2)" stroke="var(--line-2)" strokeDasharray="5 4" />
              <polygon className="pc-bench" points={pts([P(3.6, rowsR + 0.0), P(8.4, rowsR + 0.0), P(8.4, rowsR + 0.6), P(3.6, rowsR + 0.6)])} />
              <polygon className="pc-bench" points={pts([P(3.6, rowsR + 0.6), P(8.4, rowsR + 0.6), [P(8.4, rowsR + 0.6)[0], P(8.4, rowsR + 0.6)[1] + 9], [P(3.6, rowsR + 0.6)[0], P(3.6, rowsR + 0.6)[1] + 9]])} />
              <text x={P(6, rowsR + 0.3)[0]} y={P(6, rowsR + 0.3)[1] + 4} className="pc-note" textAnchor="middle">
                INSTRUCTOR
              </text>
            </g>

            {/* seat numbers along the back wall */}
            <g aria-hidden>
              {Array.from({ length: COLS }).map((_, c) => (
                <text key={c} x={P(c, -0.85)[0] + 6} y={P(c, -0.85)[1] - 20} className="pc-note" textAnchor="middle">
                  {c + 1}
                </text>
              ))}
            </g>

            {letters.map((letter, r) => {
              const rr = r * RF;
              const bench = [P(-0.6, rr - 0.4), P(COLS - 0.4, rr - 0.4), P(COLS - 0.4, rr + 0.4), P(-0.6, rr + 0.4)];
              const front = [bench[3], bench[2], [bench[2][0], bench[2][1] + 12], [bench[3][0], bench[3][1] + 12]] as [number, number][];
              const legs = [bench[3], bench[2]].map((q, i) => (i === 0 ? `M${q[0] + 6} ${q[1] + 10} v18` : `M${q[0] - 6} ${q[1] + 10} v18`)).join(" ");
              return (
                <g key={letter}>
                  <g aria-hidden>
                    <path className="pc-bench" d={legs} fill="none" />
                    <polygon className="pc-bench" points={pts(front)} />
                    <path className="pc-bench pc-edge" d={`M${front[0][0]} ${front[0][1] + 4} L${front[1][0]} ${front[1][1] + 4}`} fill="none" />
                    <polygon className="pc-bench" points={pts(bench)} />
                    <text x={P(-0.6, rr)[0] - 10} y={P(-0.6, rr)[1] + 4} className="pc-row" textAnchor="end">
                      {letter}
                    </text>
                  </g>
                  {Array.from({ length: COLS }).map((__, c) => {
                    const row = seats[r * COLS + c];
                    const idx = r * COLS + c;
                    if (!row) return loading ? <g key={c} aria-hidden className="pc-skel skeleton"><Pc c={c} rr={rr} st="ready" mode="progress" pct={0} ramp="var(--surface-3)" /></g> : null;
                    const st = seatStatus(row);
                    const t = mode === "spend" ? row.spendUsd / maxSpend : row.progressPct / 100;
                    const ramp = mode === "status" ? undefined : rampFill(Math.round(t * 100));
                    return (
                      <Fragment key={row.id}>
                      <g
                        className={`pc${flash.has(row.id) ? " pc-flash" : ""}`}
                        role="button"
                        tabIndex={0}
                        data-idx={idx}
                        data-env-id={row.id}
                        data-st={st}
                        data-mode={mode}
                        data-dim={(matched !== null && !matched.has(row.id)) || undefined}
                        data-selected={selectedId === row.id || undefined}
                        aria-label={`Bench ${letter} seat ${c + 1}, ${row.learnerName}, ${STATE_META[st].label}${row.failureReason ? `: ${row.failureReason}` : ""}, ${row.progressPct}% done, ${fmtUsd(row.spendUsd)} spent`}
                        aria-pressed={selectedId === row.id}
                        onClick={() => {
                          setTip(null);
                          onSelect(selectedId === row.id ? null : row.id);
                        }}
                        onKeyDown={(e) => activate(e, row.id)}
                        onMouseEnter={(e) => showTip(row.id, e.currentTarget)}
                        onFocus={(e) => showTip(row.id, e.currentTarget)}
                        onBlur={() => setTip(null)}
                      >
                        <Pc c={c} rr={rr} st={st} mode={mode} pct={row.progressPct} ramp={ramp} />
                      </g>
                      </Fragment>
                    );
                  })}
                  <g aria-hidden pointerEvents="none">
                    {seats.slice(r * COLS, r * COLS + COLS).length === COLS || loading
                      ? Array.from({ length: COLS }).map((__, c) => {
                          const [tx, ty] = P(c + 0.42, rr - 0.3);
                          return <Tower key={`t${c}`} x={tx} y={ty} />;
                        })
                      : null}
                  </g>
                </g>
              );
            })}
          </svg>

          {tip && tipRow && <SeatCard row={tipRow} x={tip.x} y={tip.y} below={tip.below} />}
        </div>
      </div>

      <p className="px-4 pb-2 text-[12px] text-muted sm:hidden">Scroll sideways to see the whole lab, or use All learners for a list.</p>
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
            <span className="ml-auto">{mode === "spend" ? "Darker screen = more spent so far" : "Darker screen = further through the 12 steps"}</span>
          </div>
        )}
      </div>
    </section>
  );
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
