# Verification

Verified locally against the completed source on November 18, 2026, around 22:29 IST. No employer submission has been made. This source has not yet been pushed or deployed.

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

The seeded cohort, activity and spend are simulated. The displayed early runtime/spend includes seeded history, not newly observed Azure use. The modified hosted Blob path has not been exercised in production. Local multi-instance tests use separate processes and a shared temporary file store. The shared public session has not been reset. Isolated demos expire after 24 hours but stored records are not automatically deleted; production use would need authenticated access, distributed abuse controls and retention cleanup.

The older `shot-*` images and `recordings/demo-75s.mp4` are legacy evidence, not proof of the final source. Current screenshots satisfy the assignment's recording-or-screenshots requirement.

## Dependency review

The initial install reported seven advisory-affected entries. A clean regenerated lockfile now resolves PostCSS 8.5.33 through an override, Zod 4.6.7 through a scoped CLI-config override, and supported Sharp 0.35.5. `npm audit` reports zero vulnerabilities as of November 18, 2026. The framework stays on Next 15.5.29. A fresh production build, all 50 simulation, 24 route, 18 persistence and 38 browser checks, plus the 22-state axe audit, passed after this dependency cleanup. This is a point-in-time dependency scan, not a guarantee against unknown vulnerabilities.
