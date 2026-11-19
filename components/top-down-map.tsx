"use client";

import { useImperativeHandle, useRef, useState, type Ref } from "react";
import { STATE_META, seatIndex, seatOf, seatStatus, type EnvRow, type SeatStatus } from "./ui";

const WIDTH = 760;
const HEIGHT = 600;
const FIT = { x: 0, y: 0, scale: 1 };
const symbols: Record<SeatStatus, string> = {
  failed: "!", stuck: "…", ready: "✓", provisioning: "↻", in_use: "▶", deprovisioned: "−",
};

export interface MapNavigation {
  home: () => void;
  zoom: (factor: number) => void;
}

function position(index: number) {
  const row = Math.floor(index / 12);
  const column = index % 12;
  return {
    x: 70 + column * 49 + (column >= 6 ? 38 : 0),
    y: 57 + row * 46 + (row >= 5 ? 36 : 0),
  };
}

function constrain(x: number, y: number, scale: number) {
  return {
    x: Math.max(0, Math.min(WIDTH * (1 - scale), x)),
    y: Math.max(0, Math.min(HEIGHT * (1 - scale), y)),
    scale,
  };
}

export function TopDownMap({
  navigation, everyone, selectedId, matched, onSelect, tint,
}: {
  navigation: Ref<MapNavigation>;
  everyone: EnvRow[];
  selectedId: string | null;
  matched: Set<string> | null;
  onSelect: (id: string | null) => void;
  tint: (row: EnvRow) => string;
}) {
  const [view, setView] = useState(FIT);
  const [focusIndex, setFocusIndex] = useState(() => selectedId ? seatIndex(selectedId) : 0);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const seats = everyone.slice().sort((a, b) => seatIndex(a.id) - seatIndex(b.id));

  useImperativeHandle(navigation, () => ({
    home: () => setView(FIT),
    zoom: (factor) => setView((current) => {
      const scale = Math.max(0.24, Math.min(1, current.scale * factor));
      return constrain(
        current.x + WIDTH * (current.scale - scale) / 2,
        current.y + HEIGHT * (current.scale - scale) / 2,
        scale,
      );
    }),
  }), []);

  return (
    <svg
      ref={svg}
      className="top-down-map"
      viewBox={`${view.x} ${view.y} ${WIDTH * view.scale} ${HEIGHT * view.scale}`}
      role="group"
      aria-label="Top-down lab map. Use arrow keys to move between seats, and Enter or Space to select."
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0) return;
        suppressClick.current = false;
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start || start.id !== event.pointerId || view.scale === 1) return;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        if (!start.moved && Math.hypot(dx, dy) < 6) return;
        const pixelsPerUnit = event.currentTarget.getScreenCTM()?.a;
        if (!pixelsPerUnit) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { ...start, x: event.clientX, y: event.clientY, moved: true };
        suppressClick.current = true;
        setView((current) => constrain(
          current.x - dx / pixelsPerUnit, current.y - dy / pixelsPerUnit, current.scale,
        ));
      }}
      onPointerUp={() => { drag.current = null; }}
      onPointerCancel={() => { drag.current = null; }}
      onPointerLeave={() => { if (!drag.current?.moved) drag.current = null; }}
      onKeyDown={(event) => {
        const source = (event.target as Element).closest("[data-idx]");
        if (!source) return;
        const index = Number(source.getAttribute("data-idx"));
        const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -12, ArrowDown: 12 }[event.key];
        if (offset === undefined) return;
        event.preventDefault();
        const next = index + offset;
        if (next < 0 || next >= 120 ||
            (Math.abs(offset) === 1 && Math.floor(next / 12) !== Math.floor(index / 12))) return;
        svg.current?.querySelector<SVGGElement>(`[data-idx="${next}"]`)?.focus();
      }}
    >
      <g aria-hidden="true">
        <rect x="22" y="22" width="716" height="556" rx="16" fill="#1d2933" stroke="#475866" strokeWidth="2" />
        <path d="M378 45v512M48 300h664" stroke="#121b24" strokeWidth="32" />
        <path d="M378 58v484M55 300h650" stroke="#405464" strokeDasharray="4 7" />
        {Array.from({ length: 10 }, (_, index) => (
          <text key={index} x="47" y={position(index * 12).y + 17} className="map-bench">
            {String.fromCharCode(65 + index)}
          </text>
        ))}
      </g>
      {seats.map((row) => {
        const index = seatIndex(row.id);
        const { x, y } = position(index);
        const status = seatStatus(row);
        const dimmed = matched !== null && !matched.has(row.id);
        const selected = row.id === selectedId;
        const label = `${seatOf(row.id)} · ${row.learnerName} · ${STATE_META[status].label} · ${row.progressPct}% complete · $${row.spendUsd.toFixed(2)} spent${dimmed ? " · Outside current filters" : ""}`;
        const select = () => onSelect(selected ? null : row.id);
        return (
          <g
            key={row.id}
            transform={`translate(${x} ${y})`}
            className="map-pc"
            role="button"
            tabIndex={index === focusIndex ? 0 : -1}
            aria-pressed={selected}
            aria-label={label}
            data-env-id={row.id}
            data-idx={index}
            data-seat={seatOf(row.id)}
            data-st={status}
            data-dim={dimmed}
            onFocus={() => {
              setFocusIndex(index);
              setView((current) => {
                if (x >= current.x && x + 42 <= current.x + WIDTH * current.scale &&
                    y >= current.y && y + 37 <= current.y + HEIGHT * current.scale) return current;
                return constrain(x + 21 - WIDTH * current.scale / 2, y + 18 - HEIGHT * current.scale / 2, current.scale);
              });
            }}
            onClick={() => { if (!suppressClick.current) select(); }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              if (!event.repeat) select();
            }}
          >
            <title>{label}</title>
            <rect className="map-pc-outline" width="42" height="36" rx="5" />
            <g className="map-pc-content" aria-hidden="true">
              <rect x="4" y="4" width="34" height="15" rx="3" fill="#101820" />
              <rect x="5" y="5" width="32" height="13" rx="2" fill={tint(row)} data-map-screen="" />
              <rect x="10" y="27" width="22" height="5" rx="2" fill="#738697" />
              <text x="21" y="26" className="map-seat-label">{seatOf(row.id)}</text>
              <rect x="16" y="5" width="10" height="13" rx="2" fill="#131f29" />
              <text x="21" y="15" className="map-seat-symbol">{symbols[status]}</text>
            </g>
          </g>
        );
      })}
    </svg>
  );
}
