import { buildParkedVehicleGrid } from "../src/game/vehicle/spawn/vehicleSpawnPlanner.js";

const requestedCount = Math.trunc(Number(process.argv[2] ?? 50));
const participantCount = Number.isFinite(requestedCount) ? requestedCount : 50;
const parkedCars = buildParkedVehicleGrid({
  participantCount,
  origin: [0, 0.06, -24],
  forward: [0, 0, 1],
  right: [1, 0, 0],
  columns: 10,
  laneSpacing: 3.8,
  rowSpacing: 6.2
});

console.log(
  JSON.stringify(
    {
      participantCount,
      parkedCarCount: parkedCars.length,
      firstThree: parkedCars.slice(0, 3),
      lastThree: parkedCars.slice(-3)
    },
    null,
    2
  )
);

