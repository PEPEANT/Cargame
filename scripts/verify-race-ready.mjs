import { spawn } from "node:child_process";

const skipLoad50 = process.argv.includes("--skip-load50");
const includeBuild = !process.argv.includes("--skip-build");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "pipe"
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr, code });
        return;
      }
      reject(
        new Error(
          `command failed (${command} ${args.join(" ")}):\n${stderr || stdout || `exit ${code}`}`
        )
      );
    });
  });
}

function runNpmScript(scriptName) {
  if (process.platform === "win32") {
    return run("cmd.exe", ["/d", "/s", "/c", `npm run ${scriptName} --silent`]);
  }
  return run("npm", ["run", scriptName, "--silent"]);
}

async function main() {
  const steps = [
    { key: "verify:remote", title: "origin guard" },
    { key: "audit:ox:strict", title: "OX strict audit" },
    { key: "verify:map-assets", title: "OSS license/credits audit" },
    { key: "verify:race-allocation", title: "N:N race allocation" },
    { key: "check:smoke", title: "socket smoke check" },
    { key: "check:gateway", title: "gateway redirect/health check" },
    { key: "check:scaleout", title: "multi-gateway routing check" }
  ];

  if (includeBuild) {
    steps.push({ key: "build", title: "production build" });
  }
  if (!skipLoad50) {
    steps.push({ key: "check:load50", title: "50-client load check" });
  }

  const report = [];
  for (const step of steps) {
    const startedAt = Date.now();
    console.log(`[race-ready] start: ${step.key} (${step.title})`);
    const result = await runNpmScript(step.key);
    const durationMs = Date.now() - startedAt;
    report.push({
      step: step.key,
      title: step.title,
      durationMs
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    if (output) {
      console.log(output);
    }
    console.log(`[race-ready] ok: ${step.key} (${durationMs}ms)`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        steps: report
      },
      null,
      2
    )
  );
}

main().catch((error) => {
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
});
