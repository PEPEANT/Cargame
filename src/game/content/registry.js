import { BASE_VOID_PACK as BASE_VOID_PACK_SOURCE } from "./packs/base-void/pack.js";
import { CAR_RACE_ALPHA_PACK as CAR_RACE_ALPHA_PACK_SOURCE } from "./packs/car-race-alpha/pack.js";
import { normalizeContentPack, validateContentPackShape } from "./schema.js";

function assertPackShape(pack, label = "Content pack", options = {}) {
  const errors = validateContentPackShape(pack, options);
  if (errors.length > 0) {
    throw new Error(`${label} is invalid: ${errors.join("; ")}`);
  }
}

assertPackShape(BASE_VOID_PACK_SOURCE, "Base content pack", { requireSections: true });
assertPackShape(CAR_RACE_ALPHA_PACK_SOURCE, "Car race content pack");
const BASE_VOID_PACK = normalizeContentPack(BASE_VOID_PACK_SOURCE, BASE_VOID_PACK_SOURCE);
const CAR_RACE_ALPHA_PACK = normalizeContentPack(CAR_RACE_ALPHA_PACK_SOURCE, BASE_VOID_PACK);
const DEFAULT_CONTENT_PACK_ID = CAR_RACE_ALPHA_PACK.id;
const contentPackRegistry = new Map([
  [BASE_VOID_PACK.id, BASE_VOID_PACK],
  [CAR_RACE_ALPHA_PACK.id, CAR_RACE_ALPHA_PACK]
]);

export function registerContentPack(pack) {
  assertPackShape(pack);
  const next = normalizeContentPack(pack, BASE_VOID_PACK);
  contentPackRegistry.set(next.id, next);
  return next;
}

export function getContentPack(id = DEFAULT_CONTENT_PACK_ID) {
  const key = String(id ?? DEFAULT_CONTENT_PACK_ID).trim();
  if (!key || key === BASE_VOID_PACK.id) {
    return CAR_RACE_ALPHA_PACK;
  }
  return contentPackRegistry.get(key) ?? CAR_RACE_ALPHA_PACK;
}

export function listContentPacks() {
  return [CAR_RACE_ALPHA_PACK];
}

export { BASE_VOID_PACK, CAR_RACE_ALPHA_PACK, DEFAULT_CONTENT_PACK_ID };
