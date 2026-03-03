# Cargame Car Racing Rebuild Master Plan

## 1) Fixed Requirements

1. Existing spawn point flow stays.
2. Existing portal open/admit flow stays.
3. Entire playable map is replaced with a car racing world.
4. Cars are pre-spawned on the track.
5. Car count must always match participant count.
6. After players spawn, each player is auto-assigned to exactly one car.
7. Target concurrency is up to 50 active racers per room.
8. Before major edits or push, `origin` must be verified as `PEPEANT/Cargame`.

## 2) Core Gameplay Flow

1. Player enters room through current lobby/portal pipeline.
2. Player spawns at the existing spawn hub (no change to entry UX).
3. Server builds the race session roster.
4. Server spawns N parked cars for N participants.
5. Server assigns `player -> car` one-to-one.
6. Client receives assigned seat and transitions to driving state.
7. Race starts after countdown and checkpoint validation begins.

## 3) Build Phases

## Phase 0: Foundation (Now)
- Add race planning docs, OSS intake checklist, and target folder structure.
- Add spawn/seat allocation scaffolding to enforce `cars == players`.
- Add track blueprint placeholders and race-session defaults.

## Phase 1: Physics + Vehicle Prototype
- Integrate Rapier 3D for car rigid-bodies and colliders.
- Implement acceleration, braking, steering, and stabilization.
- Add deterministic server-side vehicle step loop.

## Phase 2: Track + Checkpoints
- Replace OX arena-centric geometry with race map geometry.
- Add 16-20 ordered checkpoints + anti-cut validation.
- Add lap counting and finish ranking.

## Phase 3: Multiplayer 50-player Path
- Keep server-authoritative sync.
- Add interest management (distance/sector based updates).
- Extend load test to include vehicle sync + checkpoint events.

## Phase 4: Spawn/Portal Integration
- Reuse current spawn and portal contracts.
- Hook portal admission directly to race session roster.
- Keep overflow users in spectator queue when room is full.

## Phase 5: Release Hardening
- Perf profile on desktop/mobile.
- Crash recovery for mid-race reconnect.
- Race result persistence + admin controls.

## 4) Done Criteria (Initial Milestone)

1. Room accepts up to 50 participants.
2. For any participant count N (1-50), exactly N cars are spawned.
3. Each player gets a unique car assignment and seat.
4. Existing portal and spawn path remains functional.
5. New track map replaces the old arena as primary play space.

## 5) Technical Addendum

Detailed architecture opinions for map concept, concurrency, anti-cheat, physics, networking, and track building are documented in:

- `docs/CAR_ARCHITECTURE_OPINION_ADDENDUM.md`

Repository safety preflight:

```bash
npm run verify:remote
git branch --show-current
```
