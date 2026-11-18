# CloudLabs Workshop Operations Dashboard

One screen for an instructor running a live Azure workshop with 120 learners:
which environments are healthy, who is stuck, what is failing, and what the
session is costing.

Design intent: failures and stuck learners find the instructor, not the other
way around. The table is sorted by risk, density comes before decoration, and
color only ever carries status.

## Setup

Requires Node.js 18.18+ (tested on Node 22).

```bash
npm install
npm run dev        # http://localhost:3000
```

Production:

```bash
npm run build
npm start
```

No external services, accounts, or API keys are required. The dataset is
seeded deterministically (120 environments) and the whole simulation is
replayed deterministically from the seed plus wall-clock time, so the
screen keeps moving while you watch and a restart loses nothing.

## What is where

- `app/api/environments` - one snapshot: filtered rows + session summary
- `app/api/session` - session aggregates alone (active, failures, spend, avg completion)
- `app/api/environments/[id]/reprovision` - the one state-changing action
- `app/api/nl-filter` - the AI-native natural-language filter
- `lib/replay.ts` - deterministic simulation: state = f(seed, clock, reprovision log)
- `lib/persistence.ts` - stores only the session anchor + operator actions (file locally, Vercel Blob when hosted)
- `lib/store.ts` - store facade: compute state, apply reprovision, aggregate
- `lib/filters.ts` - the single filter/sort pipeline every client path shares
- `lib/nlparser.ts` - offline compiler from plain English to a structured query
- `lib/ratelimit.ts` - best-effort per-IP caps on the public POST endpoints

## The AI-native feature

The filter box compiles plain English ("everyone stuck on step 4 over 20 min")
into the same structured query the manual controls produce. It is never the
only way to filter: the state toggles, search, sort, and the advanced panel
(More filters: stuck, step, minutes on step, progress range, spend) expose
every predicate it compiles to, by hand.

The compiler is honest about its limits: negation ("not failed") is refused
with guidance instead of inverted, words it does not know are named back
instead of dropped, and strict vs inclusive thresholds survive
("under 25%" excludes a learner at exactly 25%).

Canonical phrasings never touch a model: a deterministic compiler handles
them exactly, offline, with zero setup. Free-form phrasing goes to a real
model when one is configured. Two model paths, both OpenAI-compatible:

```bash
# Hosted demo: Groq (free tier). Server-side env var only.
GROQ_API_KEY=... npm run dev            # model: openai/gpt-oss-120b

# Or any local server, e.g. Ollama (free, runs on CPU):
ollama pull qwen2.5:0.5b
LLM_BASE_URL=http://127.0.0.1:11434/v1 \
LLM_API_KEY=ollama \
LLM_MODEL=qwen2.5:0.5b \
npm run dev
```

The local path honors only loopback/private-network endpoints, so a hosted
base URL set through `LLM_BASE_URL` is ignored rather than silently sending
instructor queries to an unvetted third party. The hosted demo runs the
model tier on Groq's free tier (openai/gpt-oss-120b); the key lives only as
a server-side env var, and unsetting it drops the demo to the offline
compiler - the brief's required degraded mode - with no code change.
Per-model free-tier limits (1000 requests/min at the time of writing) sit
far above any dashboard traffic. Neither path is required: unset them and
everything still works offline.

Model quality caveat, from testing both sizes: a 0.5B local model is often
confidently off-topic, which the intent cross-check below catches by
abstaining instead of showing a wrong suggestion. A larger model (the 120B
Groq default) compiles loose phrasing correctly far more often. Either way
the same safety contract holds: strict validation, intent cross-check,
plain-language description, instructor confirmation before anything
applies. When the request is vague, the model must invent a number -
"parked on the same lesson for ages" becomes "on current step for 60+ min" -
and that invented threshold is shown in the plain-language description and
waits for the instructor to confirm or dismiss it. No model assumption is
ever applied silently. Two intent hazards never reach the model at all:
negation and cross-category "or" are terminal refusals from the offline
compiler, because a model would happily re-interpret them and invert what
the instructor asked for.

Model output is never applied silently. It is validated against the schema,
then cross-checked against the query's own intent words: output that ignores
what the request is about is rejected with a plain abstention message
instead of shown. Surviving output is described in plain language and
applied only when the instructor confirms, because a small model can still
be wrong. If the model is unreachable,
slow, or returns invalid JSON, the endpoint says so and the manual filters
keep working. If nothing can compile the query, a plain-language notice
suggests phrasings that do work.

## Keyboard

- `/` focuses the filter box
- Arrow keys move through rows
- `r` reprovisions the focused environment when it has failed

## Verification

```bash
npm install
npm run build          # type-checks and compiles
npx playwright install chromium
npm start &            # serve on :3000
npm run test:e2e       # behavioral checks against the running app
```

`scripts/e2e.mjs` drives a real browser (35 checks): risk ordering, the NL
filter (including abstention on negation and unknown words), manual and
advanced filters, summary/rows consistency, strict thresholds, reprovision
reflected on next poll and by the `r` shortcut, empty / loading / error
states, and a 390px mobile pass.

`scripts/sim-test.mjs` (22 checks) exercises the simulation engine and the
offline compiler directly with a fixed clock: cold-start determinism,
billing that stops at the simulated deprovision time, reprovision replay,
stuck cohort presence, and compiler edge cases.

`scripts/axe-check.mjs` is an axe-core audit of the four key states
(default, detail strip open, failed filter, NL filter applied).
Current result: 0 violations in all four states.

## AI-use disclosure

This project was built on 2026-11-17 with an AI coding assistant
generating the source, tests, and documentation from the assignment brief.
On 2026-11-18 the visual system was redesigned from a design review by
Claude (Opus 5.5): its critique identified the real weaknesses (healthy rows
out-shouting failures, palette leaking outside the token file, no sticky
table header, sub-3:1 input boundaries, decorative skeleton motion), and the
token file and component classes here implement that review.

On 2026-11-18 a read-only code review by OpenAI Codex (gpt-6.2-sol) ran
against the repo; its findings (poll races, shared-snapshot aggregates,
long-gap billing, negation and clause-coverage abstention, strict
thresholds, shortcut targeting, model-output bounds, local-only model
configuration) are fixed in this version, with regression checks added to
both test suites for each one.

Where generic AI dashboard output was deliberately avoided, per the brief's
"no AI slop" bar:

- No four-gradient-stat-cards-plus-line-chart layout. Aggregates live in a
  compact side rail so the 120-row table stays the main surface.
- No client-side fake data. State, filtering, spend math, drift, and
  mutations all live behind API routes.
- No gradient or glass styling. Text-labeled status chips, tabular numerals,
  motion only on state changes.

Run it and click through every flow before submitting; a review call will
expect you to explain each file.

## Screenshots

Captured against a live server under the full 120-row load are in
`screenshots/`: the dense risk-sorted view, the detail strip, a 390px
mobile pass, the NL filter applied, the failed-only view, the "costing the
most" spend sort, and the empty state.

## Demo recording

`recordings/demo-75s.mp4` - about 75 seconds under live load on the hosted
deployment: the dense 120-row table drifting with the stuck cohort
visible, the offline-compiled "stuck over 20 minutes" filter returning the
stuck environments, the More filters panel driven manually, the FAILED
chip, a reprovision reflected on the next poll, and the "who is costing
the most" spend sort. Re-record with
`node scripts/record-demo.mjs` against a running server.

## Hosted demo

The app deploys to Vercel (Hobby, free) with no behavior change: the
simulation needs no database because it is recomputed deterministically
from the seed and the clock. The only persisted state is the session anchor
(set as `SESSION_STARTED_AT` at deploy time) and the instructor's
reprovision actions, kept in a private Vercel Blob (free Hobby tier) as an
append-only log - one object per action - so concurrent instances never
overwrite each other. Warm instances re-read and merge the log every 30
seconds (`PERSIST_REFRESH_MS`), polls in between are served from process
memory, and a mutation that cannot be written fails with a visible error
instead of silently reverting on the next cold start. The mutation and
filter endpoints carry best-effort per-IP, per-instance rate limits; the
demo is public and the data is fake.

Fixture note: the recording starts from a fresh seeded session (delete
`.data/` and restart). The seed deliberately pre-ages about 22%
of in-use environments 20-65 minutes into their current step
(`lib/seed.ts`), so stuck states are present from the first load; nothing
in the video is claimed as observed real-world elapsed time. Stuck learners
recover on their own 15-45 minutes later, and learners can stall again on
later steps (8% of step advances draw a 22-42 minute step), so the stuck
signal recurs instead of going dark after the seeded cohort resolves.
