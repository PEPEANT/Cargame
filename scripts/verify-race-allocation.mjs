import { createRaceSessionDraft } from "../src/game/modes/race/RaceSessionDefaults.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function buildParticipantIds(count) {
  return Array.from({ length: count }, (_, index) => `p-${String(index + 1).padStart(3, "0")}`);
}

function verifyCase(count) {
  const participantIds = buildParticipantIds(count);
  const draft = createRaceSessionDraft({
    roomCode: "CR-VERIFY",
    participantIds,
    maxParticipants: 50
  });

  const parkedCars = Array.isArray(draft?.parkedCars) ? draft.parkedCars : [];
  const seatAssignments = Array.isArray(draft?.seatAssignments) ? draft.seatAssignments : [];
  const uniqueVehicleIds = new Set(seatAssignments.map((entry) => String(entry?.vehicleId ?? "").trim()));
  const uniquePlayerIds = new Set(seatAssignments.map((entry) => String(entry?.playerId ?? "").trim()));

  assert(draft.participantCount === count, `participantCount mismatch (expected ${count}, got ${draft.participantCount})`);
  assert(parkedCars.length === count, `parkedCars mismatch (expected ${count}, got ${parkedCars.length})`);
  assert(seatAssignments.length === count, `seatAssignments mismatch (expected ${count}, got ${seatAssignments.length})`);
  assert(draft.carsMatchParticipants === true, "carsMatchParticipants must be true");
  assert(uniqueVehicleIds.size === count, `vehicleId uniqueness mismatch (${uniqueVehicleIds.size}/${count})`);
  assert(uniquePlayerIds.size === count, `playerId uniqueness mismatch (${uniquePlayerIds.size}/${count})`);

  return {
    count,
    participantCount: draft.participantCount,
    parkedCarCount: parkedCars.length,
    seatAssignmentCount: seatAssignments.length,
    carsMatchParticipants: draft.carsMatchParticipants
  };
}

function run() {
  const cases = [1, 5, 17, 50];
  const results = cases.map((count) => verifyCase(count));
  console.log(
    JSON.stringify(
      {
        ok: true,
        cases: results
      },
      null,
      2
    )
  );
}

try {
  run();
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: String(error?.message ?? error)
      },
      null,
      2
    )
  );
  process.exitCode = 1;
}
