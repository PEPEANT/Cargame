import { buildParkedVehicleGrid, normalizeRacerCount } from "../../vehicle/spawn/vehicleSpawnPlanner.js";
import { createVehicleSeatAssignments } from "../../vehicle/seat/vehicleSeatAllocator.js";
import { CAR_RACE_TRACK_BLUEPRINT, getTrackCheckpointIds } from "../../world/track/trackBlueprint.js";

export const RACE_SESSION_DEFAULTS = Object.freeze({
  maxParticipants: 50,
  minParticipants: 1,
  countdownSeconds: 8,
  lapCount: 3,
  seatModeDefault: "auto"
});

export const RACE_SEAT_DEFAULTS = Object.freeze({
  modeDefault: RACE_SESSION_DEFAULTS.seatModeDefault,
  autoSeatDelaySeconds: 4,
  autoSeatOnReachVehicle: true,
  autoSeatReachRadius: 3.2
});

function normalizeSeatMode(rawMode, fallback = RACE_SESSION_DEFAULTS.seatModeDefault) {
  const value = String(rawMode ?? fallback)
    .trim()
    .toLowerCase();
  return value === "manual" ? "manual" : "auto";
}

export function createRaceSessionDraft(payload = {}) {
  const participantIds = Array.isArray(payload.participantIds)
    ? payload.participantIds.map((id) => String(id ?? "").trim()).filter(Boolean)
    : [];
  const track = payload.track ?? CAR_RACE_TRACK_BLUEPRINT;
  const count = normalizeRacerCount(participantIds.length, {
    min: RACE_SESSION_DEFAULTS.minParticipants,
    max: Math.min(
      Number(payload.maxParticipants) || RACE_SESSION_DEFAULTS.maxParticipants,
      RACE_SESSION_DEFAULTS.maxParticipants
    )
  });

  const startGrid = track?.startGrid ?? {};
  const parkedCars = buildParkedVehicleGrid({
    participantCount: count,
    origin: startGrid.anchor,
    forward: startGrid.forward,
    right: startGrid.right,
    columns: startGrid.columns,
    laneSpacing: startGrid.laneSpacing,
    rowSpacing: startGrid.rowSpacing
  });
  const seededParticipants = participantIds.slice(0, count);
  const seatAssignments = createVehicleSeatAssignments(seededParticipants, parkedCars, { strict: false });
  const seatRules = track?.raceRules?.seatAssignment ?? track?.seatAssignment ?? {};
  const seatMode = normalizeSeatMode(payload.seatMode ?? seatRules.modeDefault ?? RACE_SEAT_DEFAULTS.modeDefault);
  const autoSeatOnSpawn = seatMode !== "manual";
  const autoSeatDelaySeconds = Math.max(
    0,
    Math.min(12, Number(seatRules.autoSeatDelaySeconds) || RACE_SEAT_DEFAULTS.autoSeatDelaySeconds)
  );
  const autoSeatOnReachVehicle =
    seatRules.autoSeatOnReachVehicle !== false && RACE_SEAT_DEFAULTS.autoSeatOnReachVehicle !== false;
  const autoSeatReachRadius = Math.max(1.6, Number(seatRules.autoSeatReachRadius) || RACE_SEAT_DEFAULTS.autoSeatReachRadius);
  const spawnHub = track?.spawnHub ?? {};
  const startGridPlatform = spawnHub?.startGridPlatform ?? {};

  return {
    roomCode: String(payload.roomCode ?? "").trim(),
    phase: "staging",
    maxParticipants: RACE_SESSION_DEFAULTS.maxParticipants,
    participantCount: seededParticipants.length,
    parkedCarCount: parkedCars.length,
    carsMatchParticipants: parkedCars.length === seededParticipants.length,
    countdownSeconds: Math.max(3, Number(payload.countdownSeconds) || RACE_SESSION_DEFAULTS.countdownSeconds),
    lapCount: Math.max(1, Math.trunc(Number(payload.lapCount) || RACE_SESSION_DEFAULTS.lapCount)),
    checkpointIds: getTrackCheckpointIds(track),
    spawnHubMode: track?.spawnHub?.semanticRole ?? "pit-garage-safe-zone",
    seatAssignment: {
      defaultMode: normalizeSeatMode(seatRules.modeDefault),
      mode: seatMode,
      allowManualOption: seatRules.allowManualOption !== false,
      autoSeatOnSpawn,
      autoSeatDelaySeconds,
      autoSeatOnReachVehicle,
      autoSeatReachRadius
    },
    playerToCarFlow: {
      portalFlow: spawnHub?.keepExistingFlow === false ? "custom" : "keep-existing",
      spawnHubOnStartGridPlatform: startGridPlatform?.enabled !== false,
      runToAssignedCar: true,
      seatTrigger: autoSeatOnSpawn ? "delay-or-reach" : "manual-use"
    },
    autoSeatOnSpawn,
    startWideSeconds: Math.max(8, Math.min(12, Number(track?.road?.startWideSeconds) || 10)),
    networkInterest: {
      sectorCount: Math.max(6, Math.trunc(Number(track?.networkInterest?.sectorCount) || 12)),
      nearRadius: Math.max(40, Number(track?.networkInterest?.nearRadius) || 96),
      nearHz: Math.max(10, Number(track?.networkInterest?.nearHz) || 20),
      midRadius: Math.max(60, Number(track?.networkInterest?.midRadius) || 192),
      midHz: Math.max(10, Number(track?.networkInterest?.midHz) || 12),
      farHz: Math.max(10, Number(track?.networkInterest?.farHz) || 10)
    },
    physicsPolicy: {
      engine: String(track?.physicsPolicy?.engine ?? "rapier"),
      staticTerrainCollider: String(track?.physicsPolicy?.staticTerrainCollider ?? "segmented-trimesh"),
      dynamicVehicleCollider: String(track?.physicsPolicy?.dynamicVehicleCollider ?? "simple-compound"),
      dynamicVehicleShapes: Array.isArray(track?.physicsPolicy?.dynamicVehicleShapes)
        ? track.physicsPolicy.dynamicVehicleShapes.map((shape) => String(shape))
        : ["box", "capsule"]
    },
    parkedCars,
    seatAssignments
  };
}
