import { GAME_CONSTANTS } from "../../../config/gameConstants.js";

export const CAR_RACE_ALPHA_PACK = {
  id: "car-race-alpha",
  name: "Car Race Alpha",
  world: {
    centerBillboard: {
      lines: ["CAR RACE ALPHA", "MAX 50 PLAYERS"]
    },
    spectatorStands: {
      ads: {
        enabled: false
      }
    },
    race: {
      enabled: true,
      maxParticipants: 50,
      parkedCarsFollowParticipants: true,
      autoSeatOnSpawn: true,
      alphaTopology: "main-loop-plus-shortcut",
      focus: "hub-keep-race-world-rebuild",
      spawnHub: {
        keepExistingFlow: true,
        semanticRole: "pit-garage-safe-zone",
        spawn: [0, GAME_CONSTANTS.PLAYER_HEIGHT, -86],
        portalEffect: "keep-existing",
        startGridPlatform: {
          enabled: true,
          center: [0, 0.52, -24],
          size: [54, 1.04, 34]
        },
        safety: {
          collisionProtection: true,
          speedLimitKph: 30,
          invulnerable: true
        }
      },
      startGrid: {
        anchor: [0, 0.06, -24],
        forward: [0, 0, 1],
        right: [1, 0, 0],
        columns: 10,
        laneSpacing: 3.8,
        rowSpacing: 6.2
      },
      openingFlow: {
        laneWidenSeconds: 10,
        laneWidenSecondsMin: 8,
        laneWidenSecondsMax: 12,
        targetLaneCount: 5
      },
      seatAssignment: {
        modeDefault: "auto",
        allowManualOption: true,
        autoSeatDelaySeconds: 4,
        autoSeatOnReachVehicle: true,
        autoSeatReachRadius: 3.2
      },
      networkInterest: {
        sectorCount: 12,
        nearHz: 20,
        midHz: 12,
        farHz: 10
      },
      physicsPolicy: {
        engine: "rapier",
        staticTerrainCollider: "segmented-trimesh",
        dynamicVehicleCollider: "simple-compound",
        dynamicVehicleShapes: ["box", "capsule"]
      }
    },
    postProcessing: {
      exposure: 1.02
    }
  }
};
