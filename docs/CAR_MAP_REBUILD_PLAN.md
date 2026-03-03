# Car Map Rebuild Plan (Map-First)

## Goal

Replace almost the entire arena with a race world while keeping:

1. Existing spawn and portal admission flow.
2. Spawn hub as pit/garage safe zone.
3. Auto-seat assignment after spawn.
4. `participants == spawned cars`.

## 1) Fixed Alpha Structure

## A. Spawn Hub (Keep flow, change meaning)

1. Existing spawn point becomes pit/garage.
2. Portal arrival effect remains unchanged.
3. Hub is used for join/rejoin/spectate/wait.
4. Spawn hub sits on/near start-grid platform to reduce run distance to cars.
5. Hub safety rules:
- collision protection
- speed cap
- temporary invulnerability

## B. Race World (Major replacement)

1. Outside hub, keep only:
- track
- guardrails
- service return road
2. Alpha map scope:
- one main loop
- one shortcut
3. Keep branch complexity low for 50-player stability.

## 2) Core Data Model

1. Track source of truth is `centerlinePoints`.
2. Client generates road mesh from centerline:
- `CatmullRomCurve3` + `ExtrudeGeometry`.
3. Server builds fixed box collider segments from the same centerline.
4. Checkpoint/lap logic is progress-based:
- no circle-radius-only checkpoint authority
- use centerline projection progress

## 3) Capacity-first Rules (50 racers)

1. Start grid: 10 columns x 5 rows.
2. First 8-12 seconds after start: 4-5 lane width burst.
3. 16-20 progress checkpoints.
4. Respawn per checkpoint with safe heading.
5. Boarding mode:
- default auto-seat (delay or reach-distance trigger)
- optional manual-seat mode for custom servers

## 4) Networking Rules

1. Server-authoritative vehicle state.
2. Interest management by distance/sector:
- near vehicles high-frequency
- far vehicles lower-frequency

## 5) Acceptance

1. Old OX-centered arena is not primary play map.
2. Full lap is validated by ordered progress checkpoints.
3. 50 participants can spawn with 50 parked cars and auto-seat.
4. Spawn/portal flow remains compatible.

## 6) Current Build Status (2026-03-03)

1. Centerline-driven road mesh and start-wide mesh are active in client runtime.
2. Guardrail posts are generated with instancing.
3. Kenney Racing Kit track props are intake-complete and wired to runtime as instanced prefabs:
- pylon
- treeSmall
- lightRed
- flagCheckers
4. Track props now use distance-based visibility culling (update 5Hz + hysteresis) to reduce GPU load for 50-player sessions.
5. Track prop pack is declared in `trackBlueprint` (`assetPacks.trackProps`) so map rebuild can iterate without hardcoding file paths in runtime.
