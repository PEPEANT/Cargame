import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const ALLOW_PENDING = process.argv.includes("--allow-pending");

const REQUIRED_DOCS = [
  "docs/CAR_MAP_REBUILD_PLAN.md",
  "docs/CAR_OSS_INTAKE_PLAN.md",
  "docs/MAP_ASSET_SOURCE_STATUS.md"
];

const BUNDLES = [
  { id: "vehicles", dir: "public/assets/vehicles/oss" },
  { id: "tracks", dir: "public/assets/tracks/oss" },
  { id: "textures", dir: "public/assets/textures/oss" }
];

const ASSET_EXTENSIONS = new Set([
  ".glb",
  ".gltf",
  ".fbx",
  ".obj",
  ".mtl",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".ktx2",
  ".hdr",
  ".exr",
  ".bin",
  ".wav",
  ".mp3"
]);

const ASSET_IGNORE_SUBPATHS = [
  "/kenney_racing_kit_1_2_raw/",
  "/kenney-racing-kit-1.2.zip"
];

function toAbsolute(relativePath) {
  return path.resolve(ROOT, relativePath);
}

function toRepoPath(absolutePath) {
  return path.relative(ROOT, absolutePath).replaceAll("\\", "/");
}

async function exists(relativePath) {
  try {
    await fs.access(toAbsolute(relativePath));
    return true;
  } catch {
    return false;
  }
}

async function readTextIfExists(relativePath) {
  if (!(await exists(relativePath))) {
    return "";
  }
  return await fs.readFile(toAbsolute(relativePath), "utf8");
}

async function collectFiles(dirPath, list = []) {
  const absolute = toAbsolute(dirPath);
  const entries = await fs.readdir(absolute, { withFileTypes: true });
  for (const entry of entries) {
    const nextRelative = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(nextRelative, list);
      continue;
    }
    list.push(nextRelative);
  }
  return list;
}

function isAssetFile(relativePath) {
  const ext = path.extname(relativePath).toLowerCase();
  return ASSET_EXTENSIONS.has(ext);
}

function shouldIgnoreAssetFile(relativePath) {
  const normalized = `/${String(relativePath || "").replaceAll("\\", "/")}`;
  return ASSET_IGNORE_SUBPATHS.some((segment) => normalized.includes(segment));
}

async function inspectBundle(bundle) {
  const sourcePath = `${bundle.dir}/SOURCE.txt`;
  const licensePath = `${bundle.dir}/LICENSE.txt`;
  const creditsPath = `${bundle.dir}/CREDITS.md`;
  const errors = [];
  const warnings = [];

  const dirExists = await exists(bundle.dir);
  if (!dirExists) {
    return {
      ...bundle,
      ok: false,
      status: "missing-dir",
      errors: [`missing directory: ${bundle.dir}`],
      warnings,
      sourcePath,
      licensePath,
      creditsPath,
      assetFiles: []
    };
  }

  const allFiles = await collectFiles(bundle.dir);
  const assetFiles = allFiles.filter((file) => isAssetFile(file) && !shouldIgnoreAssetFile(file));

  const sourceExists = await exists(sourcePath);
  const licenseExists = await exists(licensePath);
  const creditsExists = await exists(creditsPath);

  if (!sourceExists) {
    errors.push(`missing SOURCE.txt: ${sourcePath}`);
  }
  if (!licenseExists) {
    errors.push(`missing LICENSE.txt: ${licensePath}`);
  }
  if (!creditsExists) {
    errors.push(`missing CREDITS.md: ${creditsPath}`);
  }

  const sourceText = await readTextIfExists(sourcePath);
  const hasUrl = /https?:\/\//i.test(sourceText);
  const hasRetrievedDate = /retrieved date:\s*\d{4}-\d{2}-\d{2}/i.test(sourceText);
  const pendingImport = /pending_import/i.test(sourceText);

  if (sourceExists && !hasUrl) {
    errors.push(`${sourcePath} missing source URL`);
  }
  if (sourceExists && !hasRetrievedDate) {
    errors.push(`${sourcePath} missing retrieved date (YYYY-MM-DD)`);
  }

  if (assetFiles.length <= 0) {
    warnings.push(`${bundle.dir} has no imported asset files yet`);
  }
  if (assetFiles.length > 0 && pendingImport) {
    errors.push(`${sourcePath} still marked PENDING_IMPORT while asset files exist`);
  }

  const complete = errors.length === 0 && assetFiles.length > 0;
  const pending = errors.length === 0 && assetFiles.length === 0;
  return {
    ...bundle,
    ok: complete || (ALLOW_PENDING && pending),
    status: complete ? "complete" : pending ? "pending" : "invalid",
    errors,
    warnings,
    sourcePath,
    licensePath,
    creditsPath,
    assetFiles: assetFiles.map((file) => toRepoPath(toAbsolute(file))).sort()
  };
}

async function run() {
  const docChecks = [];
  for (const file of REQUIRED_DOCS) {
    docChecks.push({
      file,
      exists: await exists(file)
    });
  }

  const docErrors = docChecks.filter((item) => !item.exists).map((item) => `missing doc: ${item.file}`);
  const bundles = [];
  for (const bundle of BUNDLES) {
    bundles.push(await inspectBundle(bundle));
  }

  const bundleErrors = bundles.flatMap((bundle) => bundle.errors.map((error) => `[${bundle.id}] ${error}`));
  const bundleWarnings = bundles.flatMap((bundle) =>
    bundle.warnings.map((warning) => `[${bundle.id}] ${warning}`)
  );

  const completedBundles = bundles.filter((bundle) => bundle.status === "complete").length;
  const pendingBundles = bundles.filter((bundle) => bundle.status === "pending").length;
  const invalidBundles = bundles.filter((bundle) => bundle.status === "invalid" || bundle.status === "missing-dir")
    .length;

  const ok = docErrors.length === 0 && bundleErrors.length === 0 && (ALLOW_PENDING || pendingBundles === 0);

  const report = {
    ok,
    mode: ALLOW_PENDING ? "allow-pending" : "strict",
    docs: docChecks,
    summary: {
      totalBundles: bundles.length,
      completedBundles,
      pendingBundles,
      invalidBundles
    },
    errors: [...docErrors, ...bundleErrors],
    warnings: bundleWarnings,
    bundles
  };

  console.log(JSON.stringify(report, null, 2));
  if (!ok) {
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
