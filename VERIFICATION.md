# Verification

Verified locally and on the existing production deployment on November 18, 2026, through 22:45 IST. Published to personal GitHub main and https://spektra-dashboard.vercel.app. No employer submission has been made.

## Executed checks

| Check | Result |
| --- | --- |
| `npm run build` | Passed, production compilation and type checks. |
| `npm run test:sim` | 50/50 passed: deterministic simulation, billing, future-action exclusion, progress and compiler constraints. |
| `node --test scripts/nl-route-test.mjs` | 24/24 passed against the compiled handler with a test-only mocked provider, including nine-second timeout, malformed/partial output, explicit constraints and recovery with confirmation. |
| `node scripts/two-instance-test.mjs` | 18/18 passed, including reconciliation during 20 concurrent reads, cross-instance actions, failed persistence, isolated demos, restart and expiry. |
| `npm run test:e2e` | 38/38 passed against a local production server. Includes the stale NL response regression, real mutation, reload persistence, loading/error/empty states and mobile overflow. |
| `node scripts/axe-check.mjs` | 22 browser states audited, zero violations. Covers both themes, table/detail/filter states, floor Status/Spend/Progress and filtered seats. |
| `node scripts/axe-check.mjs --palette` | 636 computed color pairs passed; minimum 4.56:1. |
| Live Groq | Actual server-side requests returned model suggestions for low progress and step 4 plus low progress. A browser check showed the suggestion without applying it, then applied it only after confirmation. No key is included in source or screenshots. |
| `git diff --check` | Passed. |

These checks are evidence for the exercised cases, not a claim that all possible language or production failures are handled. Model interpretations can still be wrong. Vague phrases can produce different proposed thresholds; those remain visible and require confirmation. No-provider and failed-provider behavior are tested separately from the real Groq calls.

## Submission evidence

Current captures in `screenshots/final-*.png` include the full desktop floor, dense 120-row table, PC detail, both themes, Spend mode, loading, error, empty, model fallback, actual Groq confirmation, and full-page 390px/320px mobile views. The full cohort was loaded before dense captures. Desktop floor/detail, dark Spend, Groq confirmation and mobile pixels were inspected. At narrow widths the floor is an internally horizontally scrollable room; there is no page-level horizontal overflow at 390px or 320px.

The seeded cohort, activity and spend are simulated. The displayed early runtime/spend includes seeded history, not newly observed Azure use. The hosted private Blob path was exercised in production: creation of separate demos, reprovisioning in one, fresh reads preserving that action, unchanged failed state in the other, and an unchanged shared-session anchor. The hosted 38-check browser suite also verified tab-reload persistence. Local multi-instance tests use separate processes and a shared temporary file store; a forced production cold-start was not induced. The shared public session has not been reset. Isolated demos expire after 24 hours but stored records are not automatically deleted; production use would need authenticated access, distributed abuse controls and retention cleanup.

The older `shot-*` images and `recordings/demo-75s.mp4` are legacy evidence, not proof of the final source. Current screenshots satisfy the assignment's recording-or-screenshots requirement.

## Dependency review

The initial install reported seven advisory-affected entries. A clean regenerated lockfile now resolves PostCSS 8.5.33 through an override, Zod 4.6.7 through a scoped CLI-config override, and supported Sharp 0.35.5. `npm audit` reports zero vulnerabilities as of November 18, 2026. The framework stays on Next 15.5.29. A fresh production build, all 50 simulation, 24 route, 18 persistence and 38 browser checks, plus the 22-state axe audit, passed after this dependency cleanup. This is a point-in-time dependency scan, not a guarantee against unknown vulnerabilities.

## Hosted release checks

The same 38 browser checks passed against the production URL. The 22-state axe audit also passed with zero violations on the hosted app. Independent hosted API checks created two isolated demos, reprovisioned a failed PC in one and verified that the other demo and shared session were unaffected. The public shared cohort was not reset.

Real hosted Groq calls returned confirmation-required suggestions. In the browser, a step-4/low-progress suggestion left all seats unchanged before confirmation, then applied only after the confirmation button was clicked. That particular interpretation produced no matches, correctly shown as an empty filtered state. Repeating vague low-progress language sometimes produced the safe manual-control fallback rather than a model suggestion; the model is optional and nondeterministic.

The hosted floor, detail panel, Groq confirmation and applied filter, dark Spend view and 390px mobile capture were visually inspected. `screenshots/hosted-*.png` contains this release evidence. There was no page-level mobile overflow. The source and screenshots contain no provider key. The initial application release was commit `bb0c9f3d87adeace268ae99c0eb6d603dd78a406`; this verification update changes documentation and evidence only.

## Pending quota patch (prepared and tested locally, not released)

Motivation: the hosted store's Hobby advanced-operation allowance was nearing its limit. Operation classes drove the changes: uploads and list are advanced operations; metadata reads (head) and downloads are simple operations. Anchors are known keys, so anchor reads now use head; action discovery still needs list because append keys are random per write and a manifest would be read-modify-write, losing the append-only no-lost-update property. Writes remain one advanced operation each.

Behavior changes: isolated demo sessions use the same per-instance refresh cache as the shared session (default 30-second window; cross-instance actions surface within it, same-instance writes are immediate). Polls embed the action log; the client discards any snapshot that lacks an action it already confirmed (inclusion of the exact action, not a count) and holds the row's pending state until some instance serves it. Polling runs only while the tab is visible; a page opened into a background tab makes no requests until first visible, then polls immediately.

Accepted limits at demo scale: every poll carries the full action log (tens of bytes per action; production would page it or send a membership proof). An out-of-band store reset while a tab holds a confirmed action leaves that row pending until the session changes or the tab reloads; gating state is in-memory only, so a reload always reconciles. Caching bounds store traffic rather than eliminating it: about one advanced operation per refresh window per active instance while visible.

Checks, all local: type check and production build clean; `node scripts/quota-patch-test.mjs` 37/37 (stubbed Blob SDK with exact per-call operation counts, outage and expiry semantics); `node scripts/two-instance-test.mjs` 24/24 (two OS processes, real route handlers, cross-instance stale and catch-up inclusion); `npm run test:sim` 50/50; `npm run test:e2e` 38/38 in the final run (its ready-env no-op check is time-conditional: it self-skips when no ready environment exists at run time, and it ran and passed in earlier same-day runs, 39 total then); `node scripts/e2e-stale-instance.mjs` 9/9 (browser polls deterministically answered with a pre-action snapshot via request interception; pending holds, the button never re-arms, first live poll confirms); `node scripts/e2e-hidden-mount.mjs` 7/7 (hidden-at-mount makes zero requests; visible polls immediately). The browser suites ran against a local production build; this patch was not exercised against the live deployment.
