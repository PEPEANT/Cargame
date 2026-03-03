import RAPIER from "@dimforge/rapier3d-compat";

const ROOM_PHYSICS = new Map();
const DEFAULT_FIXED_STEP_SECONDS = 1 / 60;
const DEFAULT_COLLIDER_HALF_EXTENTS = Object.freeze({
  x: 1.05,
  y: 0.55,
  z: 2.2
});
const DEFAULT_LINEAR_DAMPING = 2.8;
const DEFAULT_ANGULAR_DAMPING = 4.2;
const GROUND_HALF_SIZE = 2048;
const GROUND_HALF_HEIGHT = 1;
const VEHICLE_CENTER_Y_OFFSET = DEFAULT_COLLIDER_HALF_EXTENTS.y + 0.04;

let rapierReady = false;
let rapierInitError = null;
let rapierInitStartedAt = Date.now();

const rapierInitPromise = RAPIER.init()
  .then(() => {
    rapierReady = true;
    rapierInitError = null;
  })
  .catch((error) => {
    rapierReady = false;
    rapierInitError = error;
  });

function toFiniteNumber(value, fallback) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function normalizeHalfExtents(config = {}) {
  return {
    x: Math.max(0.45, toFiniteNumber(config?.x, DEFAULT_COLLIDER_HALF_EXTENTS.x)),
    y: Math.max(0.25, toFiniteNumber(config?.y, DEFAULT_COLLIDER_HALF_EXTENTS.y)),
    z: Math.max(0.9, toFiniteNumber(config?.z, DEFAULT_COLLIDER_HALF_EXTENTS.z))
  };
}

function normalizeYawRadians(value) {
  const yaw = toFiniteNumber(value, 0);
  return Math.atan2(Math.sin(yaw), Math.cos(yaw));
}

function yawToQuaternion(yawRadians) {
  const half = normalizeYawRadians(yawRadians) * 0.5;
  return {
    x: 0,
    y: Math.sin(half),
    z: 0,
    w: Math.cos(half)
  };
}

function ensureRoomContext(roomCode, options = {}) {
  const key = String(roomCode ?? "").trim();
  if (!key) {
    return null;
  }
  if (ROOM_PHYSICS.has(key)) {
    return ROOM_PHYSICS.get(key);
  }
  if (!rapierReady) {
    return null;
  }

  const gravityY = Math.min(0, toFiniteNumber(options?.gravityY, -9.81));
  const world = new RAPIER.World({ x: 0, y: gravityY, z: 0 });

  const groundBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, -GROUND_HALF_HEIGHT, 0)
  );
  const groundColliderDesc = RAPIER.ColliderDesc.cuboid(
    GROUND_HALF_SIZE,
    GROUND_HALF_HEIGHT,
    GROUND_HALF_SIZE
  );
  groundColliderDesc.setFriction(1.05);
  groundColliderDesc.setRestitution(0);
  world.createCollider(groundColliderDesc, groundBody);

  const context = {
    roomCode: key,
    world,
    vehicles: new Map(),
    fixedStepSeconds: Math.max(1 / 120, toFiniteNumber(options?.fixedStepSeconds, DEFAULT_FIXED_STEP_SECONDS)),
    accumulatorSeconds: 0,
    totalSteps: 0,
    lastStepAt: 0,
    lastSyncAt: 0
  };
  ROOM_PHYSICS.set(key, context);
  return context;
}

function resetVehicleRigidBody(entry, spawn = {}, headingRadians = 0) {
  if (!entry?.body) {
    return;
  }
  const x = toFiniteNumber(spawn?.x, 0);
  const y = toFiniteNumber(spawn?.y, 0) + VEHICLE_CENTER_Y_OFFSET;
  const z = toFiniteNumber(spawn?.z, 0);
  entry.body.setTranslation({ x, y, z }, true);
  entry.body.setRotation(yawToQuaternion(headingRadians), true);
  entry.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  entry.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
}

function createVehicleRigidBody(world, assignment = {}, options = {}) {
  const halfExtents = normalizeHalfExtents(options?.halfExtents);
  const spawn = assignment?.spawn ?? assignment?.seatPosition ?? {};
  const headingRadians = toFiniteNumber(assignment?.headingRadians, 0);

  const bodyDesc = RAPIER.RigidBodyDesc.dynamic();
  bodyDesc.setCanSleep(true);
  bodyDesc.setLinearDamping(toFiniteNumber(options?.linearDamping, DEFAULT_LINEAR_DAMPING));
  bodyDesc.setAngularDamping(toFiniteNumber(options?.angularDamping, DEFAULT_ANGULAR_DAMPING));
  bodyDesc.setEnabledRotations(false, true, false);
  const body = world.createRigidBody(bodyDesc);

  const colliderDesc = RAPIER.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z);
  colliderDesc.setFriction(Math.max(0.2, toFiniteNumber(options?.friction, 1.08)));
  colliderDesc.setRestitution(Math.max(0, toFiniteNumber(options?.restitution, 0)));
  world.createCollider(colliderDesc, body);

  const entry = {
    body,
    vehicleId: String(assignment?.vehicleId ?? ""),
    playerId: String(assignment?.playerId ?? ""),
    halfExtents
  };
  resetVehicleRigidBody(entry, spawn, headingRadians);
  return entry;
}

function normalizeAssignments(sessionDraft = {}) {
  const raw = Array.isArray(sessionDraft?.seatAssignments) ? sessionDraft.seatAssignments : [];
  return raw
    .map((entry) => ({
      vehicleId: String(entry?.vehicleId ?? "").trim(),
      playerId: String(entry?.playerId ?? "").trim(),
      spawn: entry?.spawn ?? null,
      seatPosition: entry?.seatPosition ?? null,
      headingRadians: toFiniteNumber(entry?.headingRadians, 0)
    }))
    .filter((entry) => entry.vehicleId.length > 0);
}

export function getRapierVehiclePhysicsRuntime() {
  return {
    ready: rapierReady,
    initializing: !rapierReady && rapierInitError == null,
    initStartedAt: rapierInitStartedAt,
    initError: rapierInitError ? String(rapierInitError?.message ?? rapierInitError) : null,
    roomCount: ROOM_PHYSICS.size
  };
}

export function clearRoomVehiclePhysics(roomCode) {
  const key = String(roomCode ?? "").trim();
  if (!key) {
    return;
  }
  const context = ROOM_PHYSICS.get(key);
  if (!context) {
    return;
  }
  for (const entry of context.vehicles.values()) {
    try {
      context.world.removeRigidBody(entry.body);
    } catch {
      // ignore stale rigid body remove errors
    }
  }
  context.vehicles.clear();
  ROOM_PHYSICS.delete(key);
}

export function syncRoomVehiclePhysicsAssignments(roomCode, sessionDraft = {}, options = {}) {
  const key = String(roomCode ?? "").trim();
  if (!key) {
    return { ok: false, reason: "room-code-missing" };
  }
  if (!rapierReady) {
    return { ok: false, reason: rapierInitError ? "rapier-init-failed" : "rapier-not-ready" };
  }

  const assignments = normalizeAssignments(sessionDraft);
  const context = ensureRoomContext(key, options);
  if (!context) {
    return { ok: false, reason: "room-context-failed" };
  }

  const desiredVehicleIds = new Set(assignments.map((entry) => entry.vehicleId));
  for (const [vehicleId, entry] of context.vehicles) {
    if (!desiredVehicleIds.has(vehicleId)) {
      context.world.removeRigidBody(entry.body);
      context.vehicles.delete(vehicleId);
    }
  }

  for (const assignment of assignments) {
    const existing = context.vehicles.get(assignment.vehicleId);
    if (!existing) {
      const created = createVehicleRigidBody(context.world, assignment, options);
      context.vehicles.set(assignment.vehicleId, created);
      continue;
    }
    existing.playerId = assignment.playerId;
    resetVehicleRigidBody(existing, assignment.spawn ?? assignment.seatPosition ?? {}, assignment.headingRadians);
  }

  context.lastSyncAt = Date.now();
  return {
    ok: true,
    reason: "synced",
    vehicleCount: context.vehicles.size,
    assignmentCount: assignments.length
  };
}

export function stepRoomVehiclePhysics(roomCode, deltaSeconds) {
  const key = String(roomCode ?? "").trim();
  if (!key || !rapierReady) {
    return null;
  }
  const context = ROOM_PHYSICS.get(key);
  if (!context || context.vehicles.size <= 0) {
    return null;
  }

  const delta = Math.max(0, Math.min(0.2, toFiniteNumber(deltaSeconds, 0)));
  if (delta <= 0) {
    return null;
  }

  context.accumulatorSeconds = Math.max(0, context.accumulatorSeconds + delta);
  let stepped = 0;
  while (context.accumulatorSeconds >= context.fixedStepSeconds && stepped < 8) {
    context.world.timestep = context.fixedStepSeconds;
    context.world.step();
    context.accumulatorSeconds -= context.fixedStepSeconds;
    context.totalSteps += 1;
    stepped += 1;
  }
  if (stepped > 0) {
    context.lastStepAt = Date.now();
  }
  return {
    roomCode: key,
    stepped,
    vehicleCount: context.vehicles.size,
    totalSteps: context.totalSteps,
    fixedStepSeconds: context.fixedStepSeconds
  };
}

export function sampleRoomVehicleStates(roomCode, options = {}) {
  const key = String(roomCode ?? "").trim();
  if (!key) {
    return [];
  }
  const context = ROOM_PHYSICS.get(key);
  if (!context) {
    return [];
  }
  const max = Math.max(1, Math.trunc(toFiniteNumber(options?.limit, 128)));
  const states = [];
  for (const [vehicleId, entry] of context.vehicles) {
    if (!entry?.body) {
      continue;
    }
    const t = entry.body.translation();
    const q = entry.body.rotation();
    const v = entry.body.linvel();
    states.push({
      vehicleId,
      playerId: entry.playerId,
      x: Number(toFiniteNumber(t?.x, 0).toFixed(3)),
      y: Number((toFiniteNumber(t?.y, 0) - VEHICLE_CENTER_Y_OFFSET).toFixed(3)),
      z: Number(toFiniteNumber(t?.z, 0).toFixed(3)),
      yaw: Number((2 * Math.atan2(toFiniteNumber(q?.y, 0), toFiniteNumber(q?.w, 1))).toFixed(4)),
      vx: Number(toFiniteNumber(v?.x, 0).toFixed(3)),
      vz: Number(toFiniteNumber(v?.z, 0).toFixed(3)),
      sleeping: entry.body.isSleeping() === true
    });
    if (states.length >= max) {
      break;
    }
  }
  return states;
}

export function getRoomVehiclePhysicsTelemetry(roomCode) {
  const key = String(roomCode ?? "").trim();
  const runtime = getRapierVehiclePhysicsRuntime();
  if (!key) {
    return {
      ready: runtime.ready,
      vehicleCount: 0,
      lastStepAt: 0,
      lastSyncAt: 0
    };
  }
  const context = ROOM_PHYSICS.get(key);
  if (!context) {
    return {
      ready: runtime.ready,
      vehicleCount: 0,
      lastStepAt: 0,
      lastSyncAt: 0
    };
  }
  return {
    ready: runtime.ready,
    vehicleCount: context.vehicles.size,
    fixedStepSeconds: context.fixedStepSeconds,
    lastStepAt: Number(context.lastStepAt || 0),
    lastSyncAt: Number(context.lastSyncAt || 0),
    totalSteps: Number(context.totalSteps || 0)
  };
}

export async function waitForRapierVehiclePhysicsReady() {
  await rapierInitPromise;
  return getRapierVehiclePhysicsRuntime();
}
