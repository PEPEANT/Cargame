import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const FAIL_ON_HIT = process.argv.includes("--fail-on-hit");
const FILE_EXTENSIONS = new Set([".js", ".mjs", ".css", ".html", ".md"]);
const SCAN_ROOTS = ["src", "scripts", "server.js", "gateway.js", "index.html", "README.md"];
const IGNORE_DIRS = new Set(["node_modules", "dist", ".git"]);
const SKIP_FILES = new Set(["scripts/audit-ox.mjs"]);
const PATTERNS = [
  { label: "quiz keyword", regex: /quiz/gi },
  { label: "oxArena config", regex: /oxArena/gi },
  { label: "OX branding", regex: /(특이점 OX|OX 퀴즈|ROOM_CODE_PREFIX\s*=\s*\"OX\")/g }
];

async function walk(targetPath, fileList = []) {
  const absolutePath = path.resolve(ROOT, targetPath);
  const stat = await fs.stat(absolutePath);
  if (stat.isFile()) {
    const ext = path.extname(absolutePath).toLowerCase();
    if (FILE_EXTENSIONS.has(ext) || path.basename(absolutePath) === "README.md") {
      fileList.push(absolutePath);
    }
    return fileList;
  }

  const entries = await fs.readdir(absolutePath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && IGNORE_DIRS.has(entry.name)) {
      continue;
    }
    await walk(path.join(absolutePath, entry.name), fileList);
  }
  return fileList;
}

function countPatternHits(text, regex) {
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

async function run() {
  const fileSet = new Set();
  for (const scanRoot of SCAN_ROOTS) {
    try {
      const files = await walk(scanRoot);
      for (const file of files) {
        fileSet.add(file);
      }
    } catch {
      // ignore missing paths
    }
  }

  const files = Array.from(fileSet)
    .filter((file) => {
      const relative = path.relative(ROOT, file).replaceAll("\\", "/");
      return !SKIP_FILES.has(relative);
    })
    .sort((left, right) => left.localeCompare(right));
  const byPattern = PATTERNS.map((pattern) => ({
    label: pattern.label,
    totalHits: 0,
    files: []
  }));

  for (const file of files) {
    const text = await fs.readFile(file, "utf8");
    for (let index = 0; index < PATTERNS.length; index += 1) {
      const pattern = PATTERNS[index];
      const hits = countPatternHits(text, pattern.regex);
      if (hits <= 0) {
        continue;
      }
      byPattern[index].totalHits += hits;
      byPattern[index].files.push({
        file: path.relative(ROOT, file).replaceAll("\\", "/"),
        hits
      });
    }
  }

  const totalHits = byPattern.reduce((sum, pattern) => sum + pattern.totalHits, 0);
  const report = {
    ok: totalHits === 0,
    totalHits,
    byPattern
  };

  console.log(JSON.stringify(report, null, 2));
  if (FAIL_ON_HIT && totalHits > 0) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
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
