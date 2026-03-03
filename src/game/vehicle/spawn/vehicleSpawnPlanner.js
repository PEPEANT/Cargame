const DEFAULT_MAX_RACERS = 50;
const DEFAULT_GRID_COLUMNS = 10;

function clampInt(value, fallback, min, max) {
  const next = Math.trunc(Number(value));
  if (!Number.isFinite(next)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, next));
}

function safeNumber(value, fallback) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function normalizeVec3(raw, fallback) {
  const base = Array.isArray(fallback) ? fallback : [0, 0, 0];
  const source = Array.isArray(raw) ? raw : base;
  return {
    x: safeNumber(source[0], base[0]),
    y: safeNumber(source[1], base[1]),
    z: safeNumber(source[2], base[2])
  };
}

function normalizePlanarDirection(raw, fallback) {
  const candidate = normalizeVec3(raw, fallback);
  const length = Math.hypot(candidate.x, candidate.z);
  if (length < 1e-6) {
    const fallbackVec = normalizeVec3(fallback, [0, 0, 1]);
    const fallbackLength = Math.hypot(fallbackVec.x, fallbackVec.z) || 1;
    return {
      x: fallbackVec.x / fallbackLength,
      y: 0,
      z: fallbackVec.z / fallbackLength
    };
  }
  return {
    x: candidate.x / length,
    y: 0,
    z: candidate.z / length
  };
}

function crossUpAndForward(forward) {
  return {
    x: forward.z,
    y: 0,
    z: -forward.x
  };
}

function createVec3(base, deltaA, scaleA, deltaB, scaleB) {
  return {
    x: base.x + deltaA.x * scaleA + deltaB.x * scaleB,
    y: base.y + deltaA.y * scaleA + deltaB.y * scaleB,
    z: base.z + deltaA.z * scaleA + deltaB.z * scaleB
  };
}

function yawFromForward(forward) {
  return Math.atan2(forward.x, forward.z);
}

export function normalizeRacerCount(rawCount, options = {}) {
  const min = Math.max(1, clampInt(options.min, 1, 1, DEFAULT_MAX_RACERS));
  const max = Math.max(
    min,
    clampInt(options.max, DEFAULT_MAX_RACERS, min, Math.max(min, DEFAULT_MAX_RACERS))
  );
  return clampInt(rawCount, min, min, max);
}

export function buildParkedVehicleGrid(options = {}) {
  const participantCount = normalizeRacerCount(options.participantCount ?? options.players ?? 1, {
    min: 1,
    max: options.maxParticipants ?? DEFAULT_MAX_RACERS
  });
  const origin = normalizeVec3(options.origin, [0, 0, 0]);
  const forward = normalizePlanarDirection(options.forward, [0, 0, 1]);
  const right = normalizePlanarDirection(options.right, crossUpAndForward(forward));
  const columns = clampInt(
    options.columns,
    DEFAULT_GRID_COLUMNS,
    1,
    Math.max(1, Math.min(DEFAULT_GRID_COLUMNS, participantCount))
  );
  const laneSpacing = Math.max(2.4, safeNumber(options.laneSpacing, 3.8));
  const rowSpacing = Math.max(4.2, safeNumber(options.rowSpacing, 6.2));
  const seatOffsetY = Math.max(0.5, safeNumber(options.seatOffsetY, 1.05));
  const headingRadians = yawFromForward(forward);
  const slots = [];

  for (let index = 0; index < participantCount; index += 1) {
    const row = Math.floor(index / columns);
    const indexInRow = index % columns;
    const rowStart = row * columns;
    const carsInRow = Math.min(columns, participantCount - rowStart);
    const lateralCenter = (carsInRow - 1) * 0.5;
    const lateralOffset = (indexInRow - lateralCenter) * laneSpacing;
    const forwardOffset = -row * rowSpacing;
    const position = createVec3(origin, right, lateralOffset, forward, forwardOffset);

    slots.push({
      slotIndex: index,
      vehicleId: `race-car-${String(index + 1).padStart(2, "0")}`,
      position,
      headingRadians,
      state: "parked",
      seat: {
        driver: {
          x: position.x,
          y: position.y + seatOffsetY,
          z: position.z
        }
      }
    });
  }

  return slots;
}

export function allocateCarsToPlayers(playerIds, parkedCars) {
  const players = Array.isArray(playerIds)
    ? playerIds.map((id) => String(id ?? "").trim()).filter(Boolean)
    : [];
  const cars = Array.isArray(parkedCars) ? parkedCars : [];
  const assignmentCount = Math.min(players.length, cars.length);
  const assignments = [];

  for (let index = 0; index < assignmentCount; index += 1) {
    const playerId = players[index];
    const car = cars[index];
    assignments.push({
      playerId,
      slotIndex: Number(car?.slotIndex ?? index),
      vehicleId: String(car?.vehicleId ?? `race-car-${index + 1}`),
      seat: "driver",
      spawn: car?.position ?? { x: 0, y: 0, z: 0 },
      seatPosition: car?.seat?.driver ?? {
        x: Number(car?.position?.x) || 0,
        y: (Number(car?.position?.y) || 0) + 1.05,
        z: Number(car?.position?.z) || 0
      },
      headingRadians: Number(car?.headingRadians) || 0
    });
  }

  return assignments;
}
