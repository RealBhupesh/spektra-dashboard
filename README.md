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
seeded deterministically on first boot (120 environments) and then drifts
server-side, so the screen keeps moving while you watch.

## What is where

- `app/api/session` - session aggregates (active, failures, spend, avg completion)
- `app/api/environments` - server-side filtering, sorting, and enrichment
- `app/api/environments/[id]/reprovision` - the one state-changing action
- `app/api/nl-filter` - the AI-native natural-language filter
- `lib/store.ts` - seeded dataset, drift engine, billing accrual, persistence
- `lib/filters.ts` - the single filter/sort pipeline every client path shares
- `lib/nlparser.ts` - offline compiler from plain English to a structured query

## The AI-native feature

The filter box compiles plain English ("everyone stuck on step 4 over 20 min")
into the same structured query the manual controls produce. It is never the
only way to filter: the state toggles, search, and sort below it do the same
job by hand.

Canonical phrasings never touch a model: a deterministic compiler handles
them exactly, offline, with zero setup. Free-form phrasing goes to a real
model when one is configured. Tested locally with Ollama + qwen2.5:0.5b
(free, runs on CPU):

```bash
ollama pull qwen2.5:0.5b
LLM_BASE_URL=http://127.0.0.1:11434/v1 \
LLM_API_KEY=ollama \
LLM_MODEL=qwen2.5:0.5b \
npm run dev
```

Any OpenAI-compatible endpoint works the same way (hosted free tiers
included); a larger model understands loose phrasing better than a 0.5B one.

Honest limitation from the actual qwen2.5:0.5b test: the model round-trips
and its output validates, but at 0.5B it is often confidently off-topic, so
the intent cross-check below abstains on many free-form queries rather than
showing a wrong suggestion. The model tier is real and verified end-to-end;
its usefulness scales with model size, and the abstention path is what makes
a small model safe to ship.

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

- `/` focuses the AI filter
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

`scripts/e2e.mjs` drives a real browser: risk ordering, the NL filter,
manual filters, reprovision reflected on next poll, keyboard shortcuts,
empty / loading / error states, and a 390px mobile pass.

`scripts/axe-check.mjs` is an optional axe-core audit of the four key
states (default, detail strip open, failed filter, NL filter applied).
It needs a dev-only `npm i --no-save axe-core`; nothing is added to
package.json. Current result: 0 violations in all four states.

## AI-use disclosure

This project was built on 2026-11-17 with an AI coding assistant
generating the source, tests, and documentation from the assignment brief.
On 2026-11-18 the visual system was redesigned from a design review by
Claude (Opus 5.5): its critique identified the real weaknesses (healthy rows
out-shouting failures, palette leaking outside the token file, no sticky
table header, sub-3:1 input boundaries, decorative skeleton motion), and the
token file and component classes here implement that review.

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

`recordings/demo-75s.mp4` - 75 seconds under live load: the dense 120-row
table drifting with the stuck cohort visible, the offline-compiled
"stuck over 20 minutes" filter returning the 22 stuck environments, the
FAILED chip, a reprovision reflected on the next poll, and the "who is
costing the most" spend sort. Re-record with
`node scripts/record-demo.mjs` against a running server.

Fixture note: the recording starts from a fresh seeded session (delete
`.data/state.json` and restart). The seed deliberately pre-ages about 22%
of in-use environments 20-65 minutes into their current step
(`lib/seed.ts`), so stuck states are present from the first load; nothing
in the video is claimed as observed real-world elapsed time. Stuck learners
recover on their own 15-45 minutes later, and learners can stall again on
later steps (8% of step advances draw a 22-42 minute step), so the stuck
signal recurs instead of going dark after the seeded cohort resolves.
