# Decisions

**Data model: derived state, persisted actions.** One `Environment` per
learner: id, name, state (provisioning / ready / in_use / failed /
deprovisioned), step progress, billing (`ratePerHour` x accrued
`runtimeMinutes`), expected step duration. The 120 seats come from a fixed
seed; every later transition is drawn from a per-environment deterministic
stream, so the entire simulation is a pure function of (seed, session start,
reprovision log, now) — `lib/replay.ts`. Only the session anchor and the
operator's reprovision actions are persisted (`lib/persistence.ts`): local
files in development, Vercel Blob in the hosted demo. The log is
append-only - one object per action, never rewritten - so two instances
acting at once cannot lose each other's writes, and every warm instance
re-reads and merges the shared log on a short refresh window, so one
instance's action appears everywhere within seconds. A server restart, a
serverless cold start, or a brand-new instance replays the identical
timeline; there is no database to lose. A write that cannot be stored
fails the request visibly instead of pretending to save.
Spend is computed as rate x runtime, never stored.

Billing accrues segment by segment during replay, so it stops at the exact
simulated deprovision time and keeps accruing through hours of nobody
polling — the honest model of lab VMs. Verified by `scripts/sim-test.mjs`:
identical inputs give byte-identical state, no deprovisioned environment
accrues further runtime, a logged reprovision starts a new deterministic
life, and the seeded stuck cohort is present from first load (about 22% of
in-use learners pre-aged 20-65 minutes; 8% of later steps draw a 22-42
minute duration so the stuck signal recurs instead of going dark).

**Why the logic is server-side.** Filtering, sorting, spend math, and
session aggregates run in the API routes; each response computes rows and
summary from one snapshot at one `now`, so the rail and the table can never
disagree, and a reprovision is reflected on the very next poll. Manual
controls and the natural-language filter compile to one shared
`FilterQuery` through one pipeline (`lib/filters.ts`), including strict vs
inclusive thresholds ("under 25%" excludes a learner at exactly 25%).
Progress counts completed steps: entering step 12 reads 92%, not 100%.

**How the AI feature fails safely.** The one AI-native feature is the
natural-language filter, in three tiers. Tier 1 is a deterministic offline
compiler for the canonical phrasings. It abstains rather than guesses:
negation ("not failed") is refused with guidance, unknown words are named
back, and an unparseable name after "named" is an abstain, never a silently
dropped clause. Tier 2 is an optional local model (tested with Ollama +
qwen2.5:0.5b); only loopback/private endpoints are honored, per the brief's
free/local constraint. Model output is strictly validated (bounds, integer
steps, consistent ranges), cross-checked against the query's intent words,
described in plain language, and applied only on instructor confirmation.
Tier 3 is the manual bar: state chips, search, sort, and an advanced panel
that exposes every predicate the filter compiles to (stuck, step, minutes,
progress range, spend) — no capability depends on a model. Model down,
slow, or invalid: the endpoint says so and the dashboard is unaffected.

**What's next.** Auth and an audit log of instructor actions (the public
demo ships with best-effort per-IP rate limiting on the mutation and filter
endpoints instead); real CloudLabs API behind the same routes; cohort-median
stuck detection instead of a fixed 20 minutes; WebSocket push instead of
polling.
