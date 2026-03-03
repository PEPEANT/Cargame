import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const EXPECTED_REMOTE = String(
  process.env.EXPECTED_GIT_ORIGIN ?? "https://github.com/PEPEANT/Cargame.git"
).trim();

function normalizeRemote(url) {
  const raw = String(url ?? "").trim();
  if (!raw) {
    return "";
  }
  return raw
    .replace(/^git@github\.com:/i, "https://github.com/")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

async function main() {
  let current = "";
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
      windowsHide: true
    });
    current = String(stdout ?? "").trim();
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: "failed to read git origin",
          detail: String(error?.message ?? error)
        },
        null,
        2
      )
    );
    process.exit(1);
    return;
  }

  const expectedNormalized = normalizeRemote(EXPECTED_REMOTE);
  const currentNormalized = normalizeRemote(current);
  const ok = expectedNormalized.length > 0 && currentNormalized === expectedNormalized;

  console.log(
    JSON.stringify(
      {
        ok,
        expected: EXPECTED_REMOTE,
        current
      },
      null,
      2
    )
  );

  if (!ok) {
    console.error(
      [
        "origin mismatch detected.",
        `expected: ${EXPECTED_REMOTE}`,
        `current:  ${current}`,
        "fix: git remote set-url origin https://github.com/PEPEANT/Cargame.git"
      ].join("\n")
    );
    process.exit(1);
  }
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
  process.exit(1);
});

