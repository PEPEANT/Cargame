# Map Asset Source Status

## Rule

Every map/vehicle asset must be tagged as:

1. `open-source`
2. `self-made`

No untagged asset is allowed in release.

## Current Intake Table

| Asset Group | Source Type | Upstream / Owner | Status | Notes |
| --- | --- | --- | --- | --- |
| Track props pack | open-source | Neon Town (OpenGameArt / leonkin) | imported | `ground.glb`, `lamp.glb`, `traffic-light.glb` imported under `public/assets/tracks/oss/neontown` |
| Vehicle base pack | open-source | Neon Town (OpenGameArt / leonkin) | imported | `car.glb`, `taxi.glb` imported under `public/assets/vehicles/oss/neontown` |
| Asphalt/ground textures | open-source | ambientCG + three.js examples | imported | Grass001/Ground055S (CC0) + `waternormals.jpg` (MIT) under `public/assets/textures/oss` |
| Vehicle/prop alternatives | open-source | Kenney Racing Kit (1.2) | imported | low-poly track subset imported under `public/assets/tracks/oss/kenney-racing-kit/gltf` with `SOURCE/LICENSE/CREDITS` updated |
| Sky/HDR alternatives | open-source | Poly Haven (CC0) | candidate | import only after `SOURCE/LICENSE/CREDITS` set is prepared |
| Track spline layout | self-made | Cargame internal | drafting | to be authored in repo |
| Checkpoint layout | self-made | Cargame internal | drafting | 16-20 gates planned |
| Spawn hub bridge visuals | self-made | Cargame internal | planned | keep flow, new look |

## Intake Guardrails

1. If license scope is unclear, stop import and keep status as `pending`.
2. Every OSS bundle must include:
- `SOURCE.txt` (URL + retrieval date + imported file list)
- `LICENSE.txt` (original license text)
- `CREDITS.md` (attribution list)
3. Use `docs/ASSET_LOD_SIMPLIFICATION_PLAN.md` for heavy model simplification/LOD notes.

## Verification Commands

1. `npm run verify:map-assets`
2. `npm run audit:ox`
