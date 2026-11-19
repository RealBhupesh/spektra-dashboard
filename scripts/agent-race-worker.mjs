// Worker for the concurrent-confirm race tests in agent-test.mjs. Each
// worker has its own module registry (its own persistence cache), so workers
// against one shared WORKSHOP_DATA_DIR behave like separate server
// instances.
//
// Modes (workerData.preload):
//   false - confirm the target(s) immediately.
//   true  - first load state into this instance's cache (a plain status
//           question), report the observed stateVersion as "ready", then
//           wait for the parent's "go" before confirming. This pins the
//           instance's cached global log length at preload time, so the
//           parent can make two instances confirm from UNEQUAL cached
//           global lengths.
import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";

process.env.WORKSHOP_DATA_DIR = workerData.dir;
// Hold the refresh window open so a preloaded cache stays stale for the
// whole test: the idempotency key, not a lucky fresh read, is what must
// protect the second request.
process.env.PERSIST_REFRESH_MS = "60000";

const require = createRequire(import.meta.url);
const { NextRequest } = await import("next/server.js");
const { POST: agentPOST } = require("../.next/server/app/api/agent/route.js").routeModule.userland;

const post = (payload, lane) => agentPOST(new NextRequest("http://localhost/api/agent", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-forwarded-for": `10.7.${lane}.7`,
    "x-demo-session": workerData.demoId,
  },
  body: JSON.stringify(payload),
}));

const go = new Promise((resolve) => {
  if (!workerData.preload) resolve();
  else parentPort.once("message", resolve);
});

try {
  if (workerData.preload) {
    const warm = await post({ message: "status?" }, workerData.lane);
    parentPort.postMessage({ phase: "ready", stateVersion: (await warm.json()).stateVersion });
  }
  await go;
  const ids = Array.isArray(workerData.targetIds) ? workerData.targetIds : [workerData.targetId];
  const res = await post({ confirm: { kind: "reprovision", ids } }, workerData.lane);
  parentPort.postMessage({ phase: "done", status: res.status, body: await res.json().catch(() => null) });
} catch (err) {
  parentPort.postMessage({ phase: "done", status: 0, body: null, error: String(err) });
}
