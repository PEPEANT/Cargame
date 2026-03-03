import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { io } from "socket.io-client";

const skipBuild = process.argv.includes("--skip-build");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: options.stdio ?? "pipe",
      env: options.env ?? process.env
    });

    let stdout = "";
    let stderr = "";

    if (child.stdout) {
      child.stdout.on("data", (data) => {
        stdout += String(data);
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (data) => {
        stderr += String(data);
      });
    }

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `Command failed (${command} ${args.join(" ")}):\n${stderr || stdout || `exit ${code}`}`
          )
        );
      }
    });
  });
}

function runNpm(args) {
  if (process.platform === "win32") {
    return run("cmd.exe", ["/d", "/s", "/c", `npm ${args.join(" ")}`]);
  }
  return run("npm", args);
}

async function waitFor(fn, timeoutMs = 6000, stepMs = 30) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fn()) {
      return;
    }
    await sleep(stepMs);
  }
  throw new Error("Timed out waiting for condition");
}

function emitAck(socket, event, payload = undefined) {
  return new Promise((resolve) => {
    if (payload === undefined) {
      socket.emit(event, (response = {}) => resolve(response));
      return;
    }
    socket.emit(event, payload, (response = {}) => resolve(response));
  });
}

async function checkSyntax() {
  const files = [
    "src/main.js",
    "src/game/index.js",
    "src/game/ui/HUD.js",
    "src/game/runtime/GameRuntime.js",
    "src/game/config/gameConstants.js",
    "src/game/content/registry.js",
    "src/game/content/schema.js",
    "src/game/content/packs/baseVoidPack.js",
    "src/game/content/packs/base-void/pack.js",
    "src/game/content/packs/car-race-alpha/pack.js",
    "src/game/content/packs/template/pack.template.js",
    "src/game/modes/race/RaceSessionDefaults.js",
    "src/game/vehicle/spawn/vehicleSpawnPlanner.js",
    "src/game/vehicle/seat/vehicleSeatAllocator.js",
    "src/game/world/track/trackBlueprint.js",
    "src/game/world/track/centerlineProgress.js",
    "src/game/world/track/clientRoadMesh.js",
    "src/server/race/centerlineColliderLayout.js",
    "src/server/race/progressJudge.js",
    "src/game/utils/device.js",
    "src/game/utils/math.js",
    "src/game/utils/threeUtils.js",
    "scripts/audit-ox.mjs",
    "scripts/preview-race-grid.mjs",
    "scripts/verify-map-assets.mjs",
    "scripts/world-audit.mjs",
    "server.js"
  ];
  for (const file of files) {
    await run(process.execPath, ["--check", file]);
  }
}

async function checkSocketServer() {
  const port = 3101 + Math.floor(Math.random() * 2000);
  const server = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let serverReady = false;
  let serverFailed = false;
  let bootLog = "";

  if (server.stdout) {
    server.stdout.on("data", (data) => {
      const line = String(data);
      bootLog += line;
      if (line.includes("Chat server running on")) {
        serverReady = true;
      }
      if (line.includes("failed")) {
        serverFailed = true;
      }
    });
  }

  if (server.stderr) {
    server.stderr.on("data", (data) => {
      bootLog += String(data);
    });
  }

  let c1 = null;
  let c2 = null;

  try {
    await waitFor(() => serverReady || serverFailed, 6000);
    assert(serverReady, `Server failed to boot:\n${bootLog}`);

    c1 = io(`http://localhost:${port}`, {
      transports: ["websocket"],
      timeout: 5000,
      reconnection: true,
      reconnectionAttempts: 8,
      reconnectionDelay: 120
    });
    c2 = io(`http://localhost:${port}`, {
      transports: ["websocket"],
      timeout: 5000,
      reconnection: true,
      reconnectionAttempts: 8,
      reconnectionDelay: 120
    });

    await Promise.all([waitFor(() => c1.connected, 6000), waitFor(() => c2.connected, 6000)]);

    let roomPlayerCount = 0;
    let receivedSync = false;

    c2.on("player:sync", (payload) => {
      if (payload?.id === c1.id && Number.isFinite(payload?.state?.x)) {
        receivedSync = true;
      }
    });
    c2.on("player:delta", (payload = {}) => {
      const updates = Array.isArray(payload?.updates) ? payload.updates : [];
      for (const update of updates) {
        if (String(update?.id ?? "") !== String(c1.id ?? "")) {
          continue;
        }
        if (Array.isArray(update?.p) && update.p.length >= 3) {
          receivedSync = true;
          return;
        }
      }
    });

    c1.on("room:list", (rooms) => {
      const first = Array.isArray(rooms) ? rooms[0] : null;
      roomPlayerCount = Number(first?.count) || 0;
    });

    c1.emit("player:sync", {
      x: 12,
      y: 1.72,
      z: -6,
      yaw: 0.8,
      pitch: -0.12
    });
    c1.emit("room:list");

    await waitFor(() => receivedSync, 5000);
    await waitFor(() => roomPlayerCount >= 2, 5000);

    let controller = c1;
    let setTargetAck = await emitAck(c1, "portal:set-target", {
      targetUrl: "https://example.com/race"
    });
    if (!setTargetAck?.ok) {
      controller = c2;
      setTargetAck = await emitAck(c2, "portal:set-target", {
        targetUrl: "https://example.com/race"
      });
    }
    assert(setTargetAck?.ok === true, `portal:set-target failed: ${JSON.stringify(setTargetAck)}`);

    let openAck = await emitAck(controller, "portal:lobby-open");
    assert(openAck?.ok === true, `portal:lobby-open failed: ${JSON.stringify(openAck)}`);

    // Admission start can fail when no waiting players; this is acceptable in smoke mode.
    const startAck = await emitAck(controller, "portal:lobby-start");
    if (startAck?.ok !== true && startAck?.error !== "no players waiting admission") {
      throw new Error(`portal:lobby-start failed: ${JSON.stringify(startAck)}`);
    }

    c2.disconnect();
    c1.emit("room:list");

    await waitFor(() => roomPlayerCount <= 1, 5000);
  } finally {
    c1?.disconnect();
    c2?.disconnect();
    if (!server.killed) {
      server.kill();
    }
    await sleep(120);
  }
}

async function main() {
  console.log("[verify] syntax checks...");
  await checkSyntax();

  if (!skipBuild) {
    console.log("[verify] production build...");
    const buildResult = await runNpm(["run", "build"]);
    if (buildResult.stdout) {
      process.stdout.write(buildResult.stdout);
    }
    if (buildResult.stderr) {
      process.stderr.write(buildResult.stderr);
    }
  }

  console.log("[verify] socket sync smoke...");
  await checkSocketServer();

  console.log("[verify] all checks passed");
}

main().catch((error) => {
  console.error("[verify] failed");
  console.error(String(error?.stack ?? error));
  process.exit(1);
});
