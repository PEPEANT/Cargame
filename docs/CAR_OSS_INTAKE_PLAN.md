# Car Rebuild Open Source Intake Plan

## 1) Intake Principles

1. Only use OSS with clear licenses.
2. Keep `SOURCE` and `LICENSE` trace per asset/package.
3. Prioritize stable and widely-used libraries first.
4. Integrate in phases (physics -> map assets -> polish).

## 2) Runtime OSS (Priority)

1. `@dimforge/rapier3d-compat`
- Purpose: vehicle and collision physics foundation.
- Intake phase: Phase 1 (vehicle prototype).

2. `three-mesh-bvh`
- Purpose: faster raycast and mesh collision queries for big track maps.
- Intake phase: Phase 1/2.

3. Existing `socket.io` stack (already in repo)
- Purpose: authoritative multiplayer transport.
- Intake phase: keep and extend for race state.

## 3) Content OSS (Map + Vehicle Assets)

1. Vehicle packs:
- Kenney car assets as first candidate.
- Keep low-poly and medium-poly variants for perf tiers.

2. Track props:
- Guardrails, signs, barriers, pit props from permissive asset packs.

3. Environment:
- CC0 textures and HDRI (road/asphalt/concrete/sky).

## 3.1) Imported Baseline (2026-03-03)

1. Vehicles
- Neon Town (OpenGameArt / leonkin, CC0)
- Imported: `public/assets/vehicles/oss/neontown/car.glb`, `taxi.glb`

2. Track props
- Neon Town (OpenGameArt / leonkin, CC0)
- Imported: `public/assets/tracks/oss/neontown/ground.glb`, `lamp.glb`, `traffic-light.glb`
- Kenney Racing Kit (1.2, CC0)
- Imported subset: `public/assets/tracks/oss/kenney-racing-kit/gltf/*.gltf`, `*.bin`, and required textures

3. Textures
- ambientCG `Grass001` (CC0) + `Ground055S` (CC0)
- three.js examples `waternormals.jpg` (MIT)
- Imported under `public/assets/textures/oss/`

## 4) Intake Checklist Per Source

1. Verify license text and commercial use conditions.
2. Record upstream URL and retrieval date.
3. Save original license files into repo under asset folder.
4. Convert assets into engine-ready format (naming, scale, pivots).
5. Add `SOURCE.txt` and changelog note for each imported bundle.
6. Add `CREDITS.md` per bundle (or explicit README credits section).

## 5) Folder Targets for OSS

1. `public/assets/vehicles/oss/`
2. `public/assets/tracks/oss/`
3. `public/assets/textures/oss/`
4. `public/assets/audio/oss/`

Each folder will include:
- `SOURCE.txt`
- `LICENSE.txt` (original upstream license text)
- `CREDITS.md`
- Optional conversion notes

## 6) Risk Controls

1. License ambiguity -> block import.
2. Too-heavy models -> auto-generate low LOD chain.
3. Untrusted formats/scripts -> sanitize before commit.
4. Runtime regressions -> benchmark before and after import.
5. Enforce intake gate using `npm run verify:map-assets`.
