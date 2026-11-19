# CloudLabs Workshop Operations Dashboard

An instructor dashboard for a simulated Azure workshop with 120 learners. The interactive 3D floor shows 120 stable workstations, and the risk-sorted table makes failures and stalled learners quick to scan. Color distinguishes status, while the Spend and Progress maps use neutral tones.

## Run locally

Use Node.js 18.18 or later. Verification used Node 22.

```sh
npm ci
npm run dev
```

Open http://localhost:3000. For a production build, run `npm run build` and `npm start`. The app starts with seeded data and works without accounts, Azure resources, or API credentials.

## Use the dashboard

- The **Floor map** shows the full room. Hover or focus a seat for a summary, or open it for step-by-step progress, spend, and reprovisioning. Filters highlight matching seats in place. Search accepts a learner name or seat such as `B7`.
- **All learners** opens the dense table. Status buttons, search, sort, and **More filters** also work when the optional model is unavailable.
- The summary reports active PCs, failures, estimated spend, and average progress. The app polls every four seconds and replays simulated state changes and billing on the server.
- `/` focuses the plain-English filter, arrows move between seats or table rows, `r` reprovisions a focused failed environment, and `Esc` closes the details panel.

**Start isolated demo** opens a freshly seeded cohort. Actions apply to that demo, and reloading the tab keeps the same demo. **Start new demo** selects a fresh cohort. **Return to shared** restores the original shared session. An isolated demo expires after 24 hours. The API rejects expired sessions and the dashboard offers a fresh demo or the shared session. Expired records remain in their storage namespace.

Local persistence stores the simulation start time and reprovision actions under `.data/`. Set `WORKSHOP_DATA_DIR` to point a local server at a separate data directory. Deployments configured with the existing private Vercel Blob storage path can use the same persistence interface. See [DECISIONS.md](DECISIONS.md).

## Plain-English filters

Try `everyone stuck on step 4 over 20 min`, `failed learner named Priya`, or `under 25%`. The offline compiler applies supported phrases directly. `Over` and `under` exclude the threshold. `At least` and `at most` include it. Unsupported, contradictory, or out-of-range constraints can produce a notice with manual alternatives.

An optional OpenAI-compatible model can suggest interpretations of freer phrasing. Configure `LLM_BASE_URL`, `LLM_MODEL`, and the provider's `LLM_API_KEY` on the server for a supported local or private-network endpoint. For Groq, supply an authorized server-side `GROQ_API_KEY` and, optionally, `GROQ_MODEL`. Leave these variables unset for offline mode. A configured provider receives the submitted filter text.

The route validates the full response and checks recognizable constraints in the request. The dashboard shows the proposed filter and applies it only after confirmation. The check covers supported fields and explicit phrasing, and a proposal can still misunderstand free-form text. Provider errors and timeouts leave manual controls available.

## Verification and evidence

See [VERIFICATION.md](VERIFICATION.md) for the exact commands, results, and screenshot checklist. The `shot-*` files and `recordings/demo-75s.mp4` are legacy captures; `final-*` and `hosted-*` are current evidence. `scripts/shoot-stills.mjs` captures the current dashboard into `screenshots/final-*.png` and checks the full 120-row or 120-seat load before taking the dense captures.

## AI-use disclosure

An AI coding assistant generated the initial source, tests, and documentation on 2026-11-17. On 2026-11-18, a design review by Claude (Opus 5.5) flagged noisy healthy rows, inconsistent color tokens, a missing sticky table header, weak input boundaries, and decorative skeleton motion. The project dropped the generic gradient cards and chart, decorative motion, and client-side mock data. The later Claude-assisted redesign introduced the cinema-style floor map and PC details panel.

An earlier read-only Codex review inspected polling, aggregates, simulation billing, filter semantics, keyboard targeting, and model configuration. This completion pass used personal Codex with `gpt-6.2-sol` at `ultra` reasoning (a final documentation wrap used `high`) to harden filter compilation and model validation, fix a stale-response race, strengthen snapshot and demo isolation, revise contrast, and extend verification. Executed checks and remaining gaps are listed in [VERIFICATION.md](VERIFICATION.md).


## Spatial workshop and copilot

See [Spatial workshop and PC control center](docs/spatial-workshop.md) for camera controls, keyboard/list fallback, stable seat mapping, mobile behavior and verification limits. See [Agent interface](docs/agent-interface.md) for the simulation-only conversation and action contract.

The room is real runtime geometry, not a generated background image. It adds the Three.js dependency, but does not require an external 3D asset or account. No real Azure resource or personal computer is controlled.
