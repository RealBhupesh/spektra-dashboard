# CloudLabs Workshop Operations Dashboard

An instructor dashboard for a simulated Azure workshop with 120 learners. The 2D and 3D floor maps show the same 120 stable workstations, and the risk-sorted table makes failures and stalled learners quick to scan. Color distinguishes status, while the Spend and Progress maps use neutral tones.

## Run locally

Use Node.js 18.18 or later. Verification used Node 22.

```sh
npm ci
npm run dev
```

Open http://localhost:3000. For a production build, run `npm run build` and `npm start`. The app starts with seeded data and works without accounts, Azure resources, or API credentials.

## Use the dashboard

- The **Floor map** shows the full room. Switch between the top-down 2D map and the 3D room independently of **Status**, **Spend**, or **Progress** coloring. Filters dim seats outside the current results, and those seats remain selectable. Search accepts a learner name or seat such as `B7`.
- **All learners** opens the dense table. Status buttons, search, sort, and **More filters** also work when the optional model is unavailable.
- The summary reports active PCs, failures, estimated spend, and average progress. The app polls every four seconds and replays simulated state changes and billing on the server.
- `/` focuses the plain-English filter, arrows move between seats or table rows, `r` reprovisions a focused failed environment, and `Esc` closes the details panel.

**Start fresh demo** opens a freshly seeded, isolated cohort. **Start guided demo** opens a new isolated cohort and offers a short walkthrough of the existing simulated reprovision action. The guide reports the simulator’s observed state and can be closed at any time. Both buttons require a click. Reloading the tab restores the isolated session. **Return to shared** opens the original shared workshop. Isolated changes stay in their own session. Isolated sessions expire after 24 hours and their records remain in their storage namespace.

Production stores the session start time and append-only reprovision actions in Neon Postgres. The app selects configured SQL first, then optional legacy private Vercel Blob, then local files. Local files default to `.data/`, with `WORKSHOP_DATA_DIR` available to override the directory. See [DECISIONS.md](DECISIONS.md).

## Plain-English filters

Try `everyone stuck on step 4 over 20 min`, `failed learner named Priya`, or `under 25%`. The offline compiler applies supported phrases directly. `Over` and `under` exclude the threshold. `At least` and `at most` include it. Unsupported, contradictory, or out-of-range constraints can produce a notice with manual alternatives.

An optional OpenAI-compatible model can suggest interpretations of freer phrasing. Configure `LLM_BASE_URL`, `LLM_MODEL`, and the provider's `LLM_API_KEY` on the server for a supported local or private-network endpoint. For Groq, supply an authorized server-side `GROQ_API_KEY` and, optionally, `GROQ_MODEL`. Leave these variables unset for offline mode. A configured provider receives the submitted filter text.

The route validates the full response and checks recognizable constraints in the request. The dashboard shows the proposed filter and applies it only after confirmation. The check covers supported fields and explicit phrasing, and a proposal can still misunderstand free-form text. Provider errors and timeouts leave manual controls available.

## Verification and evidence

See [VERIFICATION.md](VERIFICATION.md) for the exact commands, results, and screenshot checklist. The screenshots and recording capture earlier dashboard versions. `scripts/shoot-stills.mjs` captures the current dashboard into `screenshots/final-*.png` and checks the full 120-row or 120-seat load before taking the dense captures.

## AI-use disclosure

An AI coding assistant generated substantial portions of the source code, tests, and documentation under the project author’s direction. The author rejected generic dashboard and template treatments and directed the design toward illustrated PCs and a navigable workshop lab.

Personal Codex implemented the top-down 2D map, explicit fresh-demo entry, guided demo, and loading states, along with regression tests.

## Spatial workshop and copilot

See [Spatial workshop and PC control center](docs/spatial-workshop.md) for camera controls, keyboard/list fallback, stable seat mapping, mobile behavior and verification limits. See [Agent interface](docs/agent-interface.md) for the simulation-only conversation and action contract.

The room is real runtime geometry, not a generated background image. It adds the Three.js dependency, but does not require an external 3D asset or account. No real Azure resource or personal computer is controlled.
