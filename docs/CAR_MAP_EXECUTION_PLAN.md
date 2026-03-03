# Car Map Execution Plan

## 1) Map Identity

1. Spawn hub remains as the entry zone.
2. Everything outside spawn hub becomes race-only space.
3. Alpha target is fixed: one main loop + one shortcut.
4. Core map data source is `centerlinePoints` (not static zone meshes).
5. Spawn hub keeps portal effects and is reinterpreted as pit/garage.
6. Spawn hub is placed on/adjacent to start-grid platform for short run-in to cars.

## 2) Geometry Milestones

## M1: Blockout
- Road width, lane count, safety walls, pit lane.
- Start grid (10 x 5) and spectator lane.
- Keep only track/guardrail/service-road outside hub.

## M2: Race Logic Anchors
- Progress-based checkpoints in strict order.
- Respawn pocket per checkpoint.
- Cut prevention based on centerline projection progress.
- Boarding flow: portal opens -> players run to assigned cars.
- Seat default: auto-seat by delay or reach-distance trigger.
- Seat option: manual-seat selectable mode.

## M3: Playability
- Add elevation changes and high-speed sections.
- Add invisible race boundary walls (server-authoritative clamp).
- Add respawn pockets anchored to last validated checkpoint progress.
- Start phase (first 8-12 seconds) widened to 4-5 lanes for 50-player congestion control.

## M4: Art/Performance
- LOD-aware props.
- Track texture tiling and light setup.
- Mobile fallback meshes/materials.
- Client road mesh generated from CatmullRom centerline + Extrude path.
- Prefer low-poly geometry for static map primitives.
- Use instancing for repeated props (guardrail posts, cones, barriers, lamps).

## 3) Performance Target

1. 50 racers in one room.
2. Stable tick/render under load profile.
3. No massive FPS collapse from map mesh complexity.
4. Distance/sector interest management for update rate control.

## 4) Acceptance

1. Full lap validated by progress checkpoints.
2. Respawn always returns to safe driving lane.
3. Spawn/portal flow still works before race start.
4. Start burst is stable with widened lane phase.
5. Anti-cheat reset works for severe off-track distance, repeated wrong-way, and repeated cutting.
