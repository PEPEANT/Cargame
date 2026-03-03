# Car System Plan

## 1) Core Rules

1. Cars are spawned parked on track.
2. Car count equals participant count.
3. Default seat mode is automatic boarding after assignment (`delay or reach-distance`).
4. Optional seat mode is manual boarding (server-validated).
5. Standard race mode is 1 player per car.

## 2) Vehicle Stack

1. Input layer: accelerate, brake, steer, handbrake.
2. Physics layer: rigid-body and wheel constraints.
- static terrain: trimesh (segmented for large maps)
- dynamic vehicles: simple compound colliders (box/capsule), no dynamic trimesh
3. Net layer: server-authoritative state + client interpolation.
4. Race layer: centerline progress, checkpoint order, lap, finish rank.

## 3) Networking

1. Authoritative server snapshots for vehicle transform and velocity.
2. Sector-based relevance updates to reduce 50-player cost.
3. Reconnect support for reclaiming assigned car if race is active.
4. Target state send rate 10-20 Hz with AOI tiers (near up to 20 Hz).
5. Client handles interpolation/extrapolation for remote smoothing.
6. Seat flow events:
- `race:seat:assigned` (assignment + mode + timing)
- `race:seat:board` (manual board request)
- `race:seat:boarded` (manual board confirmed)

## 4) Safety/Anti-abuse

1. Anti-cut enforcement through progress projection (centerline).
2. Wrong-way detection through progress delta direction.
3. Invalid teleport correction.
4. Spawn protection after respawn.
5. Penalty reset to last validated checkpoint on severe anomaly:
- centerline distance too large
- wrong-way / backtracking delta beyond threshold
- repeated cutting jumps
6. Invisible boundary walls clamp racers inside race world bounds.
7. Respawn pocket uses centerline anchor + small backtrack progress offset.

## 5) Build Order

1. Parking grid + seat assignment (scaffold done).
2. Centerline data + client road extrusion + server collider segments.
3. Progress-based checkpoint/lap judge.
4. Vehicle physics and control sync.
5. UI/UX for countdown, lap, ranking.
