# Target File Structure (Car Rebuild)

```text
.
|- docs/
|  |- CAR_REBUILD_MASTER_PLAN.md
|  |- CAR_MAP_REBUILD_PLAN.md
|  |- CAR_OSS_INTAKE_PLAN.md
|  `- CAR_TARGET_STRUCTURE.md
|- src/
|  `- game/
|     |- content/
|     |  `- packs/
|     |     `- car-race-alpha/
|     |        `- pack.js
|     |- modes/
|     |  `- race/
|     |     |- RaceSessionDefaults.js
|     |     `- README.md
|     |- network/
|     |  `- race/
|     |     `- README.md
|     |- vehicle/
|     |  |- spawn/
|     |  |  `- vehicleSpawnPlanner.js
|     |  |- seat/
|     |  |  `- vehicleSeatAllocator.js
|     |  `- README.md
|     `- world/
|        `- track/
|           |- centerlineProgress.js
|           |- clientRoadMesh.js
|           |- trackBlueprint.js
|           `- README.md
|- src/
|  `- server/
|     `- race/
|        |- centerlineColliderLayout.js
|        `- progressJudge.js
|- public/
|  `- assets/
|     |- vehicles/oss/
|     |  `- SOURCE.txt
|     |- tracks/oss/
|     |  `- SOURCE.txt
|     `- textures/oss/
|        `- SOURCE.txt
`- scripts/
   `- preview-race-grid.mjs
```

## Migration Strategy

1. Keep current runtime running while adding race modules in parallel.
2. Introduce race mode via feature flag / content pack switch.
3. Move OX-specific logic behind mode boundaries after race mode is stable.
4. Keep spawn+portal API contracts unchanged during migration.
