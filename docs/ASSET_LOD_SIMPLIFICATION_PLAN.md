# Asset LOD / Simplification Plan

## Purpose

Prevent server/client performance collapse when third-party racing assets are imported.

## 1) Intake Budget (Initial)

1. Vehicle visual mesh (L0): target <= 25k triangles.
2. Vehicle mid LOD (L1): target <= 10k triangles.
3. Vehicle far LOD (L2): target <= 3k triangles.
4. Track prop meshes (cones/barriers/posts): low-poly preferred, repeated with instancing.

## 2) Physics Separation

1. Visual mesh and physics mesh must be separate.
2. Dynamic cars use primitive colliders (box/capsule/compound), not full mesh colliders.
3. Static map can use trimesh only where needed; prefer segmented simplified collision hulls.

## 3) Network / Update Budget

1. Server authoritative state broadcast target: 10-20 Hz.
2. Nearby entities: up to 20 Hz.
3. Mid/far entities: reduced cadence with interpolation on client.
4. Client must smooth state via interpolation/extrapolation.

## 4) Import Gate

An asset bundle must not be marked complete unless:

1. `SOURCE.txt` includes URL, retrieval date, exact imported files.
2. `LICENSE.txt` contains original upstream license text.
3. `CREDITS.md` lists attribution fields.
4. LOD/simplification notes are added when any file exceeds budget.

## 5) Current Intake Note (2026-03-03)

1. Kenney Racing Kit intake is limited to low-poly track subset in `public/assets/tracks/oss/kenney-racing-kit/gltf`.
2. Full raw dump is kept only in local intake cache and excluded from git; runtime wiring is limited to curated low-poly subset.
3. If additional heavy meshes are promoted into repository/runtime, add explicit LOD chain before enabling in production map.
