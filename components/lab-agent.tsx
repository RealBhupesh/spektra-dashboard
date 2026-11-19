"use client";
import { useRef, useState, useEffect } from "react";
import { seatOf } from "./ui";
type Action = { kind: "reprovision"; ids: string[]; label?: string };
interface Result {
  reply: string;
  now?: number;
  source?: string;
  degraded?: boolean;
  proposedActions?: Action[];
  executedActions?: {
    kind: string;
    id: string;
    ok: boolean;
    resultingState?: string;
    skippedReason?: string;
    error?: string;
  }[];
  actionsAppended?: { id: string; at: number }[];
  refreshRequired?: boolean;
  suggestedFilter?: {filter:Record<string,unknown>;description:string[]}|null;
  error?: string;
}
interface Line {
  role: "user" | "agent";
  text: string;
  result?: Result;
}
export function LabAgent({
  sessionId,
  selectedId,
  onRefresh,
  onFilter,
  onClose,
}: {
  sessionId: string | null | undefined;
  selectedId: string | null;
  onRefresh: (actions?: { id: string; at: number }[]) => void;
  onClose: () => void;
  onFilter: (filter:Record<string,unknown>,description:string[]) => void;
}) {
  const [lines, setLines] = useState<Line[]>([
      {
        role: "agent",
        text: "I can inspect the live workshop simulation, explain a selected PC, and reprovision failed labs you ask me to fix. No real devices are connected.",
      },
    ]),
    [text, setText] = useState(""),
    [busy, setBusy] = useState(false);
  const conversation = useRef<HTMLDivElement>(null);
  const inFlight=useRef(false);
  const bottom = useRef<HTMLDivElement>(null),
    controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    const el=conversation.current;if(el)el.scrollTop=el.scrollHeight;
  }, [lines, busy]);
  useEffect(() => {
    const el=conversation.current;if(!el)return;
    const observer=new ResizeObserver(()=>{el.scrollTop=el.scrollHeight;});
    observer.observe(el);return()=>observer.disconnect();
  },[]);
  async function send(message: string, confirm?: Action) {
    if (inFlight.current || sessionId === undefined) return;
    inFlight.current=true;
    setText("");
    setBusy(true);
    setLines((l) => [
      ...l,
      {
        role: "user",
        text: confirm
          ? `Confirm: reprovision ${confirm.ids.length} failed simulated PC${confirm.ids.length === 1 ? "" : "s"}.`
          : message,
      },
    ]);
    const c = new AbortController();
    controller.current = c;
    const timeout = setTimeout(() => c.abort(), 30000);
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(sessionId ? { "x-demo-session": sessionId } : {}),
        },
        body: JSON.stringify({
          message,
          selectedId: selectedId ?? undefined,
          ...(confirm ? { confirm } : {}),
        }),
        signal: c.signal,
      });
      const data = (await res.json()) as Result;
      if (!res.ok) throw Error(data.error || `Request failed (${res.status}).`);
      if (!data.reply) throw Error("No response received.");
      setLines((l) => [
        ...l,
        { role: "agent", text: data.reply, result: data },
      ]);
      if (data.refreshRequired) onRefresh(data.actionsAppended);
    } catch (e) {
      setLines((l) => [
        ...l,
        {
          role: "agent",
          text: `I could not complete that request. ${e instanceof Error ? e.message : "Try again."} No success is assumed. Refresh the workshop to check its current state.`,
        },
      ]);
      onRefresh();
    } finally {
      clearTimeout(timeout);
      inFlight.current=false;
      setBusy(false);
    }
  }
  return (
    <section className="lab-agent" aria-label="Workshop AI agent">
      <header>
        <div>
          <span className="agent-orb">✳</span>
          <div>
            <h2>Workshop copilot</h2>
            <p>Simulation-only control center</p>
          </div>
        </div>
        <button onClick={onClose} aria-label="Close copilot">
          ×
        </button>
      </header>
      <div className="agent-context">
        {selectedId
          ? `Focused on seat ${seatOf(selectedId)} · ${selectedId}`
          : "Entire workshop · 120 simulated PCs"}
      </div>
      <div ref={conversation} className="agent-conversation" aria-live="polite">
        {lines.map((l, i) => (
          <article key={i} className={`agent-line agent-line-${l.role}`}>
            <small>
              {l.role === "user"
                ? "YOU"
                : l.result?.source === "llm"
                  ? "AI · LIVE SIMULATION"
                  : l.result?.degraded
                    ? "LOCAL ASSISTANT · LIVE SIMULATION"
                    : l.result?.executedActions?.length
                      ? "SIMULATION ACTION RECEIPT"
                      : l.result ? "LOCAL ASSISTANT · LIVE SIMULATION" : "WORKSHOP COPILOT"}
            </small>
            <p>{l.text}</p>
            {l.result?.now&&<span className="agent-fallback">Snapshot at {new Date(l.result.now).toLocaleTimeString()}</span>}
            {l.result?.executedActions?.map((a, j) => (
              <div className="agent-executed" key={`executed-${j}`}>
                <b>
                  {seatOf(a.id)} · {a.id}
                </b>
                <span>
                  {a.ok
                    ? `Restarting · ${a.resultingState ?? "provisioning"}`
                    : (a.skippedReason ??
                      `Not applied: ${a.error ?? "unknown error"}`)}
                </span>
              </div>
            ))}
            {l.result?.degraded && (
              <span className="agent-fallback">
                Local fallback, model unavailable or not configured.
              </span>
            )}
            {l.result?.suggestedFilter && <div className="agent-action"><span>Highlight matching PCs</span><p>{l.result.suggestedFilter.description.join(" · ")}</p><button className="btn" onClick={()=>onFilter(l.result!.suggestedFilter!.filter,l.result!.suggestedFilter!.description)}>Apply room filter</button></div>}
            {l.result?.proposedActions?.map((a, j) => (
              <div className="agent-action" key={j}>
                <span>
                  {a.label ??
                    `Reprovision ${a.ids.length} simulated failed labs`}
                </span>
                <p>
                  Resets selected failed labs to step 1. Simulated billing
                  continues.
                </p>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    send("Confirm the proposed simulated repair.", a)
                  }
                >
                  Confirm simulated repair
                </button>
              </div>
            ))}
          </article>
        ))}
        {busy && (
          <p className="agent-thinking" role="status">
            Checking the simulation…
          </p>
        )}
        <div ref={bottom} />
      </div>
      {lines.length < 3 && (
        <div className="agent-suggestions">
          {[
            "How many PCs are off and on?",
            "What needs attention?",
            ...(selectedId ? ["What is happening on this PC?"] : []),
          ].map((q) => (
            <button key={q} disabled={busy} onClick={() => send(q)}>
              {q} ↗
            </button>
          ))}
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) send(text.trim());
        }}
      >
        <label htmlFor="agent-message" className="sr-only">
          Message workshop copilot
        </label>
        <textarea
          id="agent-message"
          value={text}
          maxLength={500}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask about the room or request a simulated fix…"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (text.trim()) send(text.trim());
            }
          }}
        />
        <button
          disabled={busy || !text.trim() || sessionId === undefined}
          aria-label="Send to copilot"
        >
          ↑
        </button>
      </form>
      <footer>
        Uses current simulation state. Fixes are limited to failed lab
        reprovisioning.
      </footer>
    </section>
  );
}
