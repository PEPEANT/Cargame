import { allocateCarsToPlayers } from "../spawn/vehicleSpawnPlanner.js";

export function createVehicleSeatAssignments(playerIds, parkedCars, options = {}) {
  const strict = options.strict !== false;
  const normalizedPlayers = Array.isArray(playerIds)
    ? playerIds.map((id) => String(id ?? "").trim()).filter(Boolean)
    : [];
  const assignments = allocateCarsToPlayers(normalizedPlayers, parkedCars);

  if (strict && assignments.length !== normalizedPlayers.length) {
    throw new Error(
      `vehicle assignment mismatch: players=${normalizedPlayers.length}, assignments=${assignments.length}`
    );
  }

  return assignments.map((item) => ({
    playerId: item.playerId,
    vehicleId: item.vehicleId,
    seat: "driver",
    slotIndex: item.slotIndex,
    spawn: item.spawn,
    seatPosition: item.seatPosition,
    headingRadians: Number(item?.headingRadians) || 0
  }));
}
