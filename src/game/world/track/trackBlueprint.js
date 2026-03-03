import { GAME_CONSTANTS } from "../../config/gameConstants.js";

const DEFAULT_CHECKPOINT_PROGRESS = Object.freeze([
  0.04, 0.1, 0.16, 0.22, 0.28, 0.34, 0.4, 0.46, 0.52, 0.58, 0.64, 0.7, 0.76, 0.82, 0.88, 0.94
]);

const TRACK_PROP_PREFABS = Object.freeze({
  roadStraight: "roadStraight.gltf",
  roadStraightLong: "roadStraightLong.gltf",
  roadCornerSmall: "roadCornerSmall.gltf",
  roadCornerLarge: "roadCornerLarge.gltf",
  roadCurved: "roadCurved.gltf",
  roadSplit: "roadSplit.gltf",
  roadStart: "roadStart.gltf",
  roadStartPositions: "roadStartPositions.gltf",
  roadPitEntry: "roadPitEntry.gltf",
  roadPitStraight: "roadPitStraight.gltf",
  roadPitGarage: "roadPitGarage.gltf",
  barrierRed: "barrierRed.gltf",
  barrierWhite: "barrierWhite.gltf",
  barrierWall: "barrierWall.gltf",
  rail: "rail.gltf",
  pylon: "pylon.gltf",
  flagCheckers: "flagCheckers.gltf",
  pitsGarage: "pitsGarage.gltf",
  pitsOffice: "pitsOffice.gltf",
  grandStand: "grandStand.gltf",
  grandStandCovered: "grandStandCovered.gltf",
  tent: "tent.gltf",
  tentLong: "tentLong.gltf",
  treeSmall: "treeSmall.gltf",
  treeLarge: "treeLarge.gltf",
  grass: "grass.gltf",
  fenceStraight: "fenceStraight.gltf",
  fenceCurved: "fenceCurved.gltf",
  overhead: "overhead.gltf",
  lightRed: "lightRed.gltf"
});

const TRACK_PROP_LAYOUT = Object.freeze([
  {
    key: "pylon",
    count: 30,
    bothSides: true,
    start: 0.0,
    end: 0.18,
    lateralOffset: 12.4,
    yOffset: 0.06,
    maxVisibleDistance: 150
  },
  {
    key: "flagCheckers",
    count: 4,
    bothSides: false,
    side: 1,
    start: 0.0,
    end: 0.04,
    lateralOffset: 10.2,
    yOffset: 0.02,
    maxVisibleDistance: 130
  },
  {
    key: "lightRed",
    count: 16,
    bothSides: true,
    start: 0.06,
    end: 0.9,
    lateralOffset: 14.8,
    yOffset: 0.02,
    maxVisibleDistance: 220
  },
  {
    key: "treeSmall",
    count: 20,
    bothSides: true,
    start: 0.24,
    end: 0.96,
    lateralOffset: 21,
    yOffset: 0,
    scaleRange: [0.9, 1.2],
    maxVisibleDistance: 200
  },
  {
    key: "treeLarge",
    count: 10,
    bothSides: true,
    start: 0.3,
    end: 0.9,
    lateralOffset: 28,
    yOffset: 0,
    scaleRange: [0.82, 1.08],
    maxVisibleDistance: 260
  }
]);

export const CAR_RACE_TRACK_BLUEPRINT = Object.freeze({
  id: "car-race-alpha-track",
  name: "Car Race Alpha Track",
  spawnHub: {
    keepExistingFlow: true,
    semanticRole: "pit-garage-safe-zone",
    spawn: [0, GAME_CONSTANTS.PLAYER_HEIGHT, -86],
    portalPosition: [44, 0.08, 14],
    portalRadius: 4.4,
    startGridPlatform: {
      enabled: true,
      center: [0, 0.52, -24],
      size: [54, 1.04, 34],
      materialTag: "concrete-lowpoly"
    },
    safety: {
      collisionProtection: true,
      speedLimitKph: 30,
      invulnerable: true
    }
  },
  layout: {
    alphaTopology: "main-loop-plus-shortcut",
    preserveOutsideHub: ["track", "guardrail", "service-road"],
    serviceRoad: {
      enabled: true,
      role: "return-to-track"
    }
  },
  assetPacks: {
    trackProps: {
      provider: "kenney-racing-kit",
      version: "1.2",
      format: "gltf",
      rootUrl: "/assets/tracks/oss/kenney-racing-kit/gltf/",
      lowPoly: true,
      prefabs: TRACK_PROP_PREFABS,
      layout: TRACK_PROP_LAYOUT,
      visibility: {
        enabled: true,
        updateHz: 5,
        defaultMaxDistance: 220,
        hysteresis: 16
      }
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
  road: {
    baseHalfWidth: 7.6,
    baseThickness: 0.34,
    shoulderWidth: 1.1,
    startWideSeconds: 10,
    startWideProgressSpan: 0.12,
    startWideHalfWidth: 9.8
  },
  centerlinePoints: [
    [0, 0, -24],
    [34, 0, -18],
    [70, 0, 6],
    [94, 0, 38],
    [92, 0, 76],
    [62, 0, 104],
    [18, 0, 114],
    [-26, 0, 108],
    [-66, 0, 86],
    [-98, 0, 48],
    [-108, 0, 2],
    [-94, 0, -40],
    [-60, 0, -70],
    [-16, 0, -84],
    [28, 0, -78],
    [66, 0, -58],
    [88, 0, -22],
    [82, 0, 14],
    [58, 0, 36],
    [22, 0, 38],
    [-10, 0, 24],
    [-22, 0, 2],
    [-14, 0, -16],
    [0, 0, -24]
  ],
  shortcuts: [
    {
      id: "shortcut-alpha-1",
      enterProgress: 0.18,
      exitProgress: 0.36,
      points: [
        [82, 0, 18],
        [90, 0, 44],
        [78, 0, 68],
        [52, 0, 82],
        [26, 0, 78],
        [14, 0, 54],
        [18, 0, 38]
      ]
    }
  ],
  progressCheckpoints: DEFAULT_CHECKPOINT_PROGRESS.map((progress, index) => ({
    id: `cp-${String(index + 1).padStart(2, "0")}`,
    progress
  })),
  collider: {
    segmentLength: 7,
    boxWidth: 16.2,
    boxHeight: 2.6,
    centerY: 1.2
  },
  boundary: {
    enabled: true,
    useInvisibleWalls: true,
    // Keep racers inside race world while preserving service lanes.
    minX: -128,
    maxX: 112,
    minZ: -102,
    maxZ: 126,
    wallMargin: 0.75
  },
  respawn: {
    yOffset: 0.6,
    headingFromTangent: true,
    invulnerableSeconds: 2,
    pocketLateralOffset: 0,
    backtrackProgress: 0.004
  },
  raceRules: {
    autoSeatOnSpawn: true,
    seatAssignment: {
      modeDefault: "auto",
      allowManualOption: true,
      autoSeatDelaySeconds: 4,
      autoSeatOnReachVehicle: true,
      autoSeatReachRadius: 3.2
    },
    parkedCarsFollowParticipants: true,
    wrongWayThresholdProgress: 0.02,
    maxForwardProgressStep: 0.24,
    antiCheat: {
      enabled: true,
      maxDistanceFromCenterline: 28,
      // Backtracking should reset quickly to the last validated checkpoint pocket.
      resetWrongWayDelta: 0.05,
      resetWrongWayStrikes: 1,
      resetCuttingStrikes: 2,
      resetCooldownMs: 2200
    }
  },
  physicsPolicy: {
    engine: "rapier",
    staticTerrainCollider: "segmented-trimesh",
    staticTerrainNotes: "use trimesh for static terrain only; split into sectors when map grows",
    dynamicVehicleCollider: "simple-compound",
    dynamicVehicleShapes: ["box", "capsule"],
    dynamicVehicleNotes: "avoid trimesh on dynamic cars for 50-vehicle server stability"
  },
  performance: {
    roadSteps: 220,
    startWideSteps: 120,
    guardrailPostCount: 180,
    lampPostCount: 56,
    signCount: 24
  },
  networkInterest: {
    sectorCount: 12,
    nearRadius: 96,
    nearHz: 20,
    midRadius: 192,
    midHz: 12,
    farHz: 10,
    edgeHz: 10
  }
});

export function getCenterlinePoints(track = CAR_RACE_TRACK_BLUEPRINT) {
  return Array.isArray(track?.centerlinePoints) ? track.centerlinePoints : [];
}

export function getTrackCheckpointIds(track = CAR_RACE_TRACK_BLUEPRINT) {
  const checkpoints = Array.isArray(track?.progressCheckpoints) ? track.progressCheckpoints : [];
  return checkpoints.map((point) => String(point?.id ?? "").trim()).filter(Boolean);
}

export function getTrackCheckpointProgressValues(track = CAR_RACE_TRACK_BLUEPRINT) {
  const checkpoints = Array.isArray(track?.progressCheckpoints) ? track.progressCheckpoints : [];
  return checkpoints
    .map((point) => Number(point?.progress))
    .filter((progress) => Number.isFinite(progress))
    .map((progress) => {
      const clamped = progress % 1;
      return clamped < 0 ? clamped + 1 : clamped;
    })
    .sort((left, right) => left - right);
}

export function getTrackPropPack(track = CAR_RACE_TRACK_BLUEPRINT) {
  return track?.assetPacks?.trackProps ?? null;
}
