# Spatial workshop and PC control center

The floor view is a real Three.js scene with 120 independently selectable workstations. Each station has a desk, tower, monitor, stand, keyboard, mouse and chair. Furniture and keyboard keys are instanced; shadows are computed once and the scene renders on camera or data changes, not continuously while idle. Screen materials update from the same environment snapshot as the table and summary.

## Navigation

- Left-drag to pan, right-drag to orbit, scroll to zoom. On touch screens, one finger pans and two fingers pinch/orbit.
- Click a workstation to focus its camera and open the PC control center. A selected-seat label and desk outline identify the target.
- Use Entire lab to clear focus. Fit resets camera framing without discarding the selected learner. The minimap can focus any seat.
- Browse seats exposes a readable keyboard-accessible seat list. Arrow keys move through it, Enter selects, and the existing `r` shortcut reprovisions a focused failed PC.
- All learners remains the full table, including manual filters, sorting, actions and no-match/error handling.
- If WebGL is unavailable, the floor view provides a clear fallback to All learners. Every learner and action remains available there.

## Stable identities

The existing `seatIndex` permutation is unchanged. Room positions split the existing 12-column, 10-bench layout into two column groups and two row groups, with circulation aisles between them. These spatial offsets do not rename or reassign any seat. For example, env-002 remains D2.

## Progressive detail

Summary and filters remain outside the room. Needs attention, recent activity, step distribution and highest spend are opened on demand from the dock. The PC inspector and workshop copilot replace each other, rather than overlapping the canvas with multiple rails. On phones these become bottom sheets, while the room remains explorable and the readable list remains available.

The PC control center shows current simulated state, step, dwell time, progress, billing/runtime and all lab steps. The executable control is the existing failed-lab reprovision action. There is no real-device connection, OS command interface, network access or arbitrary execution.

## Conversation

The workshop copilot uses POST /api/agent. It sends the current isolated-demo header and selected stable environment ID. Model Q&A, local fallback and deterministic action receipts are labeled separately. Responses show their snapshot time. Proposed repairs can be confirmed; the UI prevents concurrent duplicate submits in one mounted conversation and displays per-ID outcomes. Restarting/provisioning is not presented as a completed recovery.

Successful actions pass their appended log events into the existing client inclusion-proof gate. A poll cannot roll the UI back to an instance that has not yet observed a confirmed action. Conversations reset when switching between the shared session and an isolated demo. The server still owns validation, allowed actions, rate limiting and durable execution.

## Verification scope

Local checks cover the original table/NL/action workflow, stable spatial seat mapping, accessible seat navigation, single-inspector behavior, local fallback Q&A, a real simulated restart in an isolated local demo, append-log inclusion, 320/390px page overflow, viewport-height receipt readability and the no-WebGL table fallback. Keyboard-height screenshots use a resized desktop test viewport, not a physical phone keyboard. No real provider traffic is needed for these checks.
