import { execSync, spawn } from "node:child_process";

function getWindowsProcessCommandLine(processId) {
  try {
    const output = execSync(
      `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"ProcessId=${processId}\\").CommandLine"`,
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }
    );
    return String(output || "").trim();
  } catch {
    return "";
  }
}

function getWindowsPortOwners(port) {
  const output = execSync("netstat -ano", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  const owners = new Map();
  const lines = String(output || "").split(/\r?\n/);
  for (const line of lines) {
    if (!line.includes("LISTENING") || !line.includes(`:${port}`)) {
      continue;
    }
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) {
      continue;
    }
    const localAddress = parts[1];
    const pidRaw = parts[parts.length - 1];
    const processId = Number(pidRaw);
    if (!Number.isFinite(processId)) {
      continue;
    }
    if (owners.has(processId)) {
      continue;
    }
    owners.set(processId, {
      port,
      processId,
      localAddress,
      commandLine: getWindowsProcessCommandLine(processId)
    });
  }
  return Array.from(owners.values());
}

function getUnixPortOwners(port) {
  try {
    const output = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const lines = String(output || "")
      .split(/\r?\n/)
      .slice(1)
      .filter(Boolean);
    return lines.map((line) => {
      const cols = line.trim().split(/\s+/);
      return {
        port,
        processId: Number(cols[1] || 0),
        localAddress: cols[8] || "",
        commandLine: cols[0] || ""
      };
    });
  } catch {
    return [];
  }
}

function getPortOwners(port) {
  if (process.platform === "win32") {
    return getWindowsPortOwners(port);
  }
  return getUnixPortOwners(port);
}

function preflightPortCheck() {
  if (String(process.env.DEV_ALL_IGNORE_PORT_CHECK || "").trim() === "1") {
    return;
  }
  const requiredPorts = [
    { port: 5173, role: "client (vite)" },
    { port: 3001, role: "gateway" }
  ];
  const conflicts = requiredPorts.flatMap((entry) =>
    getPortOwners(entry.port).map((owner) => ({ ...owner, role: entry.role }))
  );

  if (conflicts.length === 0) {
    return;
  }

  process.stderr.write("[dev-all] Required ports are already in use.\n");
  for (const conflict of conflicts) {
    const commandInfo = conflict.commandLine ? ` cmd=${conflict.commandLine}` : "";
    process.stderr.write(
      `[dev-all] port ${conflict.port} (${conflict.role}) pid=${conflict.processId} addr=${conflict.localAddress}${commandInfo}\n`
    );
  }
  process.stderr.write(
    "[dev-all] Stop conflicting processes first, then retry. Set DEV_ALL_IGNORE_PORT_CHECK=1 to bypass this guard.\n"
  );
  process.exit(1);
}

function run(name, command, args) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    stdio: "pipe",
    env: process.env
  });

  const prefix = `[${name}]`;
  child.stdout?.on("data", (data) => {
    process.stdout.write(`${prefix} ${String(data)}`);
  });
  child.stderr?.on("data", (data) => {
    process.stderr.write(`${prefix} ${String(data)}`);
  });
  child.on("exit", (code) => {
    process.stdout.write(`${prefix} exited (${code ?? "null"})\n`);
    if (!closing && typeof code === "number" && code !== 0) {
      process.stderr.write(`${prefix} failed, shutting down other process.\n`);
      shutdown(code);
    }
  });

  return child;
}

const shell = process.platform === "win32" ? "cmd.exe" : "sh";
const runCmd = (script) => (process.platform === "win32" ? ["/d", "/s", "/c", script] : ["-lc", script]);

preflightPortCheck();

const client = run("client", shell, runCmd("npm run dev"));
const server = run("server", shell, runCmd("npm run dev:server"));

let closing = false;
let exitCode = 0;
function shutdown(code = 0) {
  if (closing) {
    return;
  }
  closing = true;
  exitCode = code;

  if (!client.killed) {
    client.kill();
  }
  if (!server.killed) {
    server.kill();
  }

  setTimeout(() => process.exit(exitCode), 200);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
