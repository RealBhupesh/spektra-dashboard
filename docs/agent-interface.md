# Agent interface contract v2 — POST /api/agent

Scope: simulation only. The single executable action kind is `reprovision` of an
environment currently in state `failed`, through the existing store (durable
append-only log, session-scoped). No other mutation surface exists.

## Domain vocabulary (matches the existing UI)

- **off** = `deprovisioned`: finished labs, switched off, no longer billing
  (components/ui.tsx labels this state "Finished" / "PC is switched off"; the
  floor map paints it `--off`). Off PCs are NOT repair targets; the simulation
  has no operation to switch them back on.
- **failed** = broken but still ON and billing. Failed is the only state
  `reprovision` applies to. Replies never call a failed PC "off".
- **not off / on** = `active` (everything except deprovisioned), which
  includes failed billable PCs.

## Request

Headers: `content-type: application/json`, optional `x-demo-session: <uuid>`
(identical semantics to the existing routes: reads and actions land in that
session scope; without it, the shared session).

```json
{
  "message": "how many PCs are off?",
  "selectedId": "env-042",
  "confirm": { "kind": "reprovision", "ids": ["env-007", "env-013"] }
}
```

- `message` string, required unless `confirm` is present. Trimmed length 1..500.
- `selectedId` optional. Must match `^env-\d{3}$` and exist, else
  404 `{"error":"unknown_selected"}`.
- `confirm` optional. Echo of a previously returned proposed action that the
  user approved in the UI. `kind` must be `"reprovision"`, else
  400 `{"error":"unknown_action_kind"}`. `ids`: array of 1..25 unique
  `env-###` strings, else 400 `{"error":"bad_request"}` or
  `{"error":"too_many_actions"}`. Confirmation never calls the provider and
  costs nothing; execution is always revalidated against live state.

## Response 200

```json
{
  "ok": true,
  "reply": "7 of 120 PCs are failed right now.",
  "source": "llm",
  "degraded": false,
  "now": 1763545200000,
  "stateVersion": 4,
  "stateVersionAfter": 4,
  "summary": {
    "sessionName": "AZ-104 Administrator Workshop, Nov cohort",
    "sessionStartedAt": 1763541600000,
    "now": 1763545200000,
    "total": 120,
    "active": 110,
    "failures": 7,
    "avgCompletionPct": 46,
    "estimatedSpend": 182.34,
    "byState": { "provisioning": 5, "ready": 12, "in_use": 86, "failed": 7, "deprovisioned": 10 },
    "stuckCount": 9
  },
  "selected": null,
  "suggestedFilter": null,
  "proposedActions": [],
  "executedActions": [],
  "actionsAppended": [],
  "refreshRequired": false
}
```

- `source` / `degraded` matrix:
  | source | degraded | meaning |
  | --- | --- | --- |
  | `"llm"` | `false` | the model classified the intent; every fact in `reply` was rendered server-side from the snapshot |
  | `"local"` | `false` | full-capability deterministic answer (confident local parse) or an execution receipt |
  | `"local"` | `true` | degraded: the message needed the model and it was unavailable — the UI labels this visibly as the local fallback, never as model output |
- `stateVersion` = the actual action-log length read from the store before
  this request. `stateVersionAfter` = the actual action-log length read back
  from the store after any executions — never `stateVersion + own append
  count` arithmetic. Concurrent writers (other clients, other agent requests)
  are therefore visible: `stateVersionAfter - stateVersion` may exceed this
  request's own `actionsAppended.length`. Same monotone-version contract as
  the other routes.
- `summary`: exactly the `SessionSummary` shape returned by `GET /api/session`.
- `refreshRequired`: true iff at least one action executed OK. The client then
  refetches environments and holds pending state until a poll includes the
  appended action (existing inclusion-proof contract).

### `selected` (enriched environment, same shape as `/api/environments` rows)

```json
{
  "id": "env-042",
  "learnerName": "Riya Sharma",
  "learnerEmail": "riya.sharma42@workshop.example.com",
  "state": "failed",
  "step": 6,
  "totalSteps": 12,
  "stepStartedAt": 1763543800000,
  "startedAt": 1763541600000,
  "runtimeMinutes": 63.2,
  "ratePerHour": 2.14,
  "failureReason": "Agent heartbeat lost",
  "stepDurationMin": 4.7,
  "spendUsd": 2.25,
  "progressPct": 42,
  "onStepMinutes": 31.4,
  "stuck": false
}
```

### `suggestedFilter` (or null)

```json
{
  "filter": { "states": ["failed"], "sort": "risk" },
  "description": ["state is " + "failed"]
}
```

`filter` is a validated `FilterQuery` from the same pipeline as
`/api/nl-filter` (local compiler or validated model output); `description` is
the plain-language `string[]` for display. The UI may apply it to the room
immediately or show it as a suggestion; that choice belongs to the UI.

### `proposedActions` items

```json
{ "kind": "reprovision", "ids": ["env-007", "env-013"], "label": "Restart 2 failed environments" }
```

- Every id in `ids` was in state `failed` at proposal time (verified against
  the same snapshot that grounds the reply).
- The UI renders `label` (or its own copy) with a confirm control; on approval
  it re-posts `{ "confirm": { "kind", "ids" } }`.

### `executedActions` items — per-id actual result, never blanket success

```json
{ "kind": "reprovision", "id": "env-007", "learnerName": "Riya Sharma", "ok": true, "resultingState": "provisioning" }
{ "kind": "reprovision", "id": "env-013", "learnerName": "Om Patel", "ok": false, "skippedReason": "already in_use (recovered on its own)" }
{ "kind": "reprovision", "id": "env-021", "learnerName": "Dev Nair", "ok": false, "error": "persist_failed" }
```

- `resultingState` is the store's recomputed state after the append, and is
  `"provisioning"` on success — a restart in progress, not a recovered PC.
  Reply text says "restarting / now provisioning", never "fixed".
- `skippedReason` when the environment was no longer failed at execution time
  (concurrent recovery); `error` when the durable append failed.
- `actionsAppended`: `[{ "id": "env-007", "at": 1763545200123 }]` — the
  inclusion proof, identical to the reprovision route's `action`.

## Model protocol (when a provider is configured)

No model prose reaches a reply, ever. The model receives a compact fact
sheet (counts, failed ids, selected PC) for grounding and returns strict
JSON used ONLY for classification:

```json
{ "intent": "status", "suggestFilter": false, "proposeRestartIds": [] }
```

- `intent`: one of a fixed enum (`status`, `failed_counts`, `failed_list`,
  `mixed_off_failed`, `off_counts`, `stuck`, `spend`, `progress`,
  `active_counts`, `selected_detail`, `attention`, `help`, `unknown`). The
  server renders the reply for that intent from the computed snapshot — the
  numbers and names in the reply never come from the model.
- Any free-text field the model returns (a `remark`, a `note`, anything) is
  ignored, not sanitized. A plausible-sounding false claim needs no digits,
  names or markdown to be wrong, so none is ever prefixed to a reply.
- `proposeRestartIds`: verified against currently-failed known ids; unknown
  or not-failed ids are dropped server-side.
- Invalid intent, malformed JSON or a provider error falls back to the local
  responder with `degraded: true`.

Confident local parses (explicit count/status/spend/progress/stuck/active
questions, directives) never call the model at all.

## Mixed off/failed handling

- A question mentioning both off and failed ("how many are off, any
  failures?") answers BOTH counts in one reply, plus the working remainder.
- A directive spanning both scopes ("fix the failed and off PCs") restarts
  the failed ones and discloses in the same reply that the off PCs were
  excluded (off = finished, no switch-back-on operation exists).

## When execution happens

- Immediately, only when the user's own message is an unambiguous directive
  resolved by a server-side matcher (e.g. "restart the failed ones", "fix this
  PC" with `selectedId`). Negated ("don't restart...") or ambiguous ("fix it"
  with no target, multiple name matches) never executes — it answers or
  proposes instead. The model's output can propose; it can never execute.
- Via `confirm`, always revalidated: ids must still be `failed` at execution
  time, dedupe, max 25 per request.
- Store-level idempotency: the durable
  append key is derived from the environment id and its PER-TARGET observed
  epoch - the number of prior restarts of that environment in the log the
  decision observed. Two concurrent restarts of the same PC decided from
  the same per-target history share one key even when the racers' cached
  global log lengths differ (unrelated events for other PCs do not change
  the key), so exactly one wins the store. The loser reloads fresh state
  and reports a truthful skip (`skippedReason: "already provisioning (not
  failed)"`), never a second restart and never a false receipt. State is
  evaluated at the log's newest event, so a concurrently appended restart
  stamped later than the request's `now` is never treated as future. Event
  files from before this change (`<at>-<id>-<uuid>.json`) are counted from
  their stored values, so old and new key shapes coexist. Server-side
  in-flight UI guards alone cannot provide this across instances.

## Errors (existing `{error}` shape)

| status | error |
| --- | --- |
| 400 | `bad_request`, `empty_message`, `message_too_long`, `unknown_action_kind`, `too_many_actions` |
| 404 | `unknown_selected`, `demo_not_found` |
| 410 | `demo_expired` |
| 429 | `rate_limited` (20 msg/min/IP; 30 executions/min/IP) |
| 503 | `persist_unavailable` |

## Example exchanges

Count question (confident local parse — the model is not called):

```json
→ { "message": "how many pcs are off and how many are not off?" }
← { "ok": true, "reply": "10 of 120 PCs are off (finished labs - deprovisioned, no longer billing); 110 are not off. Of the ones on, 7 are failed - say \"restart the failed ones\" and I'll restart them.", "source": "local", "degraded": false, "summary": { "...": "as above" }, "proposedActions": [], "executedActions": [], "refreshRequired": false, "...": "..." }
```

Ambiguous question (model classifies; the reply is entirely server-rendered):

```json
→ { "message": "so what's the vibe in here then?" }
← { "ok": true, "reply": "Cohort status: 71 in use, 18 ready, 8 provisioning, 12 failed, 11 deprovisioned (of 120). ...", "source": "llm", "degraded": false, "...": "..." }
```

Mixed-scope directive (off targets disclosed as excluded):

```json
→ { "message": "fix the failed and off pcs" }
← { "ok": true, "reply": "Restarting 12 failed environments - they are now provisioning, not yet recovered. The 10 off (finished) PCs can't be restarted - excluded, because off means deprovisioned and only failed environments can be restarted.", "source": "local", "degraded": false, "executedActions": ["..."], "refreshRequired": true, "...": "..." }
```

Directive with immediate execution:

```json
→ { "message": "restart the failed ones" }
← { "ok": true, "reply": "Restarting 7 failed environments - they are now provisioning, not yet recovered.", "source": "local", "degraded": false,
     "executedActions": [{ "kind": "reprovision", "id": "env-007", "learnerName": "Riya Sharma", "ok": true, "resultingState": "provisioning" }],
     "actionsAppended": [{ "id": "env-007", "at": 1763545200123 }],
     "stateVersion": 4, "stateVersionAfter": 5, "refreshRequired": true, "...": "..." }
```

Proposal then confirm:

```json
→ { "message": "can you fix the stuck PCs?" }
← { "ok": true, "reply": "9 learners are stuck on the same step for 20+ minutes. Stuck is not a failure - want me to watch them, or restart only the 7 that actually failed?",
     "proposedActions": [{ "kind": "reprovision", "ids": ["env-007", "..."], "label": "Restart 7 failed environments" }], "executedActions": [], "refreshRequired": false, "...": "..." }
→ { "confirm": { "kind": "reprovision", "ids": ["env-007"] } }
← { "ok": true, "reply": "Restarted env-007 (Riya Sharma) - now provisioning.", "source": "local", "degraded": false,
     "executedActions": [{ "kind": "reprovision", "id": "env-007", "learnerName": "Riya Sharma", "ok": true, "resultingState": "provisioning" }],
     "refreshRequired": true, "...": "..." }
```

Local fallback (provider missing or failing on a message that needed it) —
`source: "local"`, `degraded: true`; UI labels it as the local responder:

```json
→ { "message": "so what's the vibe in here then?" }
← { "ok": true, "reply": "Here's where things stand: 12 failed, 22 stuck, 109 active of 120. Ask me about failures, stuck learners, spend, progress or a specific PC.", "source": "local", "degraded": true, "...": "..." }
```
