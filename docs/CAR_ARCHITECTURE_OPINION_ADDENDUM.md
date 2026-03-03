# Car Rebuild Opinion Addendum

This addendum captures practical design opinions to reduce rework risk during the car-game rebuild.

## 1) Map Concept (World Identity)

1. Keep spawn hub and portal UX exactly as-is, but reinterpret hub as pit/garage safe zone.
2. Outside hub, remove arena-style logic and keep only race-space primitives:
- main track
- shortcut branch
- guardrails
- service/return road
3. Portal-open flow should transition to `spawn -> run to assigned car -> seat`.
4. Seat policy should be configurable:
- default: automatic seat (delay or reach-distance)
- optional: manual seat interaction mode
5. Alpha target should stay constrained:
- one main loop
- one shortcut
- 4-5 lane widened start window for first 8-12 seconds

## 2) Architecture Choice

1. Keep server-authoritative movement and race state.
2. Track blueprint (`centerlinePoints`) is single source of truth for both:
- client visual road generation
- server progress/collider logic
3. Keep race flow layers separated:
- room/portal admission
- race session roster + car-seat assignment
- movement/progress/lap validation

## 3) Concurrency Design (50 Players)

1. Cap active participants at 50 per room; overflow stays spectator/wait queue.
2. Keep AOI update policy distance/sector based:
- near: high cadence
- mid/far: reduced cadence
3. Use delta snapshots for remote actors and reserve reliable events for:
- checkpoint
- lap
- finish/ranking

## 4) Anti-Cheat Policy

1. Reject impossible movement with server-side limits:
- max speed
- max acceleration
- teleport distance clamp
2. Race authority is progress-based, not circle-only checkpoints.
3. Flag and penalize suspicious progression:
- wrong-way deltas
- excessive forward step (possible cutting)
- off-track drift beyond centerline threshold

## 5) Physics Direction

1. Keep Rapier as core physics backend.
2. Static terrain: use trimesh only for static world geometry, and split into sectors when size grows.
3. Dynamic vehicles: use simple colliders (box/capsule/compound), not trimesh.
4. For 50 concurrent cars, prioritize simplified dynamic collider sets for stable server step cost.
5. Ship in two steps:
- alpha: stable arcade handling + robust collision bounds
- beta: richer handling tuning (grip/slip, suspension, damage, etc.)
6. Prioritize deterministic server step consistency over visual fidelity.

## 6) Networking Direction

1. Local: responsive input + smooth interpolation.
2. Remote: delta-driven interpolation + short extrapolation with AOI cadence control.
3. Server state broadcast target: 10-20 Hz (near sector up to 20 Hz).
4. Mid/far sectors can use reduced cadence while keeping client-side smoothing.
5. Server emits explicit race events:
- `race:progress`
- `race:lap`
- `race:score`

## 7) Track Building Approach

1. Build road mesh on client from CatmullRom centerline + extrude.
2. Build fixed box collider segments on server from same centerline.
3. Keep checkpoint order from centerline projection progress.
4. Respawn should use progress anchor + tangent heading.
5. Prefer low-poly map geometry + instancing for repeated assets.

## 8) Remote Mismatch Guardrail

Never start major edits before validating origin and branch:

```bash
npm run verify:remote
git branch --show-current
```

Expected:

1. `origin` points to `PEPEANT/Cargame`.
2. Work is on isolated rebuild branch (for example `car-rebuild`), not direct hot edits on legacy branch.

## 9) Remote Mismatch Response

If `origin` is not `PEPEANT/Cargame`, stop feature work immediately and fix remote first.

```bash
git remote -v
git remote set-url origin https://github.com/PEPEANT/Cargame.git
npm run verify:remote
git branch --show-current
```

After correction:

1. Confirm branch is still `car-rebuild` (or another isolated rebuild branch).
2. Re-run smoke checks before any push.
