# Decisions

**Data model.** One `Environment` per learner: id, name, state
(provisioning / ready / in_use / failed / deprovisioned), step progress
(`step` of 12, `stepStartedAt`), billing (`ratePerHour`, accrued
`runtimeMinutes`), and a per-learner expected step duration. Spend is always
computed as `rate x runtime`, never stored, so drift and mutations can never
desync it. The 120 seats are generated from a fixed seed (identical every
first boot), persisted to `.data/state.json`, and drifted on each server
tick: provisioning completes or fails, learners start, steps advance at the
learner's own pace, completed labs deprovision. Billing keeps accruing on
failed environments because a broken VM is still provisioned.

The seed pre-ages about 22% of in-use learners 20-65 minutes into a step so
the stuck signal is exercised from the first load; they recover on their
own. Stuck is not a one-shot fixture, though: 8% of step advances draw a
22-42 minute expected step, so learners stall again later and the stuck
rail keeps meaning something hours into a session. Without that, stuck
could only ever come from the seed cohort and the signal went dark after
about two hours.

**Billing is true wall-clock, with no cap.** Each tick bills the full
elapsed time since the previous tick, however long the gap: lab VMs keep
costing money while nobody is watching the dashboard. The same rule covers
server restarts and downtime: `lastTickAt` is persisted to
`.data/state.json`, so when the server comes back after being down, the
first tick accrues the whole offline interval. The consequence of choosing
this over a capped tick: a dashboard left unpolled for hours shows hours of
new spend, which is the honest model of how lab billing works. Persistence
is best-effort and throttled to about one write per 2 seconds, so an
ungraceful crash can lose at most ~2s of accrual. Verified by test: a 75s
gap bills 75s (measured 99.6% after tick timing slack), a restart mid-gap
bills the full gap, and a synthetic 3-hour idle period (state file edited
to age `lastTickAt`) bills 180.1 minutes.

**Why the logic is server-side.** The brief's interactions only hold up if
the server owns them. Filtering and sorting 120 rows, spend math, and the
session aggregates run in the API routes against the same store the mutation
endpoint writes to, so a reprovision is reflected on the very next poll.
Drift lives server-side too: multiple open tabs see one consistent world,
and the client stays a thin polling view. Manual controls and the AI filter
compile to one shared `FilterQuery` and run through one pipeline
(`lib/filters.ts`), so the two paths can never disagree.

**How the AI feature fails safely.** The NL filter has three tiers. Tier 1
is a deterministic compiler for the canonical phrasings (states, "stuck",
step numbers, minutes, percentages, spend, names); it is exact about what it
matched and needs no model. Tier 2 is an optional LLM behind any
OpenAI-compatible endpoint, tested locally with Ollama + qwen2.5:0.5b. Model
output is strictly validated (known keys, sane ranges, degenerate values
dropped), then cross-checked against the query's own intent words: output
that ignores what the request is about (say, a progress question answered
with a state filter) is rejected with a plain abstention message instead of
shown. Surviving output is described in plain language and applied only when
the instructor confirms, because a small local model can still be wrong.
Tier 3 is the manual filter bar, always fully functional. Model down, slow,
or unparseable: the endpoint says so, nothing changes, and a notice suggests
phrasings that work. The dashboard never depends on a model.

**What's next.** Real CloudLabs API behind the same routes; per-step
timestamps so "stuck" compares a learner to cohort medians instead of a fixed
20 minutes; WebSocket push instead of polling; audit log of instructor
actions; auth so two instructors can share a session view.
