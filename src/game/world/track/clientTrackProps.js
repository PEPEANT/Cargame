import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { CAR_RACE_TRACK_BLUEPRINT, getTrackPropPack } from "./trackBlueprint.js";

const LOADER = new GLTFLoader();
const missingPrefabWarnings = new Set();

const DEFAULT_LAYOUT = Object.freeze([
  {
    key: "pylon",
    count: 30,
    bothSides: true,
    start: 0,
    end: 0.18,
    lateralOffset: 12.4,
    yOffset: 0.06,
    maxVisibleDistance: 150
  },
  {
    key: "flagCheckers",
    count: 4,
    bothSides: false,
    side: 1,
    start: 0,
    end: 0.04,
    lateralOffset: 10.2,
    yOffset: 0.02,
    maxVisibleDistance: 130
  },
  {
    key: "lightRed",
    count: 16,
    bothSides: true,
    start: 0.06,
    end: 0.9,
    lateralOffset: 14.8,
    yOffset: 0.02,
    maxVisibleDistance: 220
  },
  {
    key: "treeSmall",
    count: 20,
    bothSides: true,
    start: 0.24,
    end: 0.96,
    lateralOffset: 21,
    yOffset: 0,
    scaleRange: [0.9, 1.2],
    maxVisibleDistance: 200
  }
]);

const DEFAULT_VISIBILITY = Object.freeze({
  enabled: true,
  updateHz: 5,
  defaultMaxDistance: 220,
  hysteresis: 16
});

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function fract(value) {
  return value - Math.floor(value);
}

function pseudoRandom(index, salt) {
  return fract(Math.sin(index * 12.9898 + salt * 78.233) * 43758.5453123);
}

function normalizeRootUrl(rootUrl) {
  const value = String(rootUrl || "").trim();
  if (!value) {
    return "";
  }
  return value.endsWith("/") ? value : `${value}/`;
}

function extractFirstMesh(scene) {
  let first = null;
  scene?.traverse?.((node) => {
    if (!first && node?.isMesh && node?.geometry) {
      first = node;
    }
  });
  return first;
}

function cloneMeshMaterial(material) {
  if (Array.isArray(material)) {
    return material.map((entry) => (entry?.clone ? entry.clone() : entry)).filter(Boolean);
  }
  return material?.clone ? material.clone() : material;
}

function resolveLayout(pack, options = {}) {
  const fromOptions = Array.isArray(options?.layout) ? options.layout : null;
  if (fromOptions && fromOptions.length > 0) {
    return fromOptions;
  }
  const fromPack = Array.isArray(pack?.layout) ? pack.layout : null;
  if (fromPack && fromPack.length > 0) {
    return fromPack;
  }
  return DEFAULT_LAYOUT;
}

function resolveVisibility(pack, options = {}) {
  const fromPack = pack?.visibility && typeof pack.visibility === "object" ? pack.visibility : {};
  const fromOptions = options?.visibility && typeof options.visibility === "object" ? options.visibility : {};
  const merged = {
    enabled: fromOptions?.enabled ?? fromPack?.enabled ?? DEFAULT_VISIBILITY.enabled,
    updateHz: Number(fromOptions?.updateHz ?? fromPack?.updateHz ?? DEFAULT_VISIBILITY.updateHz),
    defaultMaxDistance: Number(
      fromOptions?.defaultMaxDistance ?? fromPack?.defaultMaxDistance ?? DEFAULT_VISIBILITY.defaultMaxDistance
    ),
    hysteresis: Number(fromOptions?.hysteresis ?? fromPack?.hysteresis ?? DEFAULT_VISIBILITY.hysteresis)
  };
  return {
    enabled: merged.enabled !== false,
    updateHz: Math.max(1, Number.isFinite(merged.updateHz) ? merged.updateHz : DEFAULT_VISIBILITY.updateHz),
    defaultMaxDistance: Number.isFinite(merged.defaultMaxDistance) ? merged.defaultMaxDistance : Infinity,
    hysteresis: Math.max(0, Number.isFinite(merged.hysteresis) ? merged.hysteresis : DEFAULT_VISIBILITY.hysteresis)
  };
}

async function loadPrefabSource(rootUrl, fileName) {
  const url = `${normalizeRootUrl(rootUrl)}${String(fileName || "").trim()}`;
  if (!url) {
    return null;
  }
  const gltf = await LOADER.loadAsync(url);
  const mesh = extractFirstMesh(gltf?.scene);
  if (!mesh?.geometry) {
    return null;
  }
  const geometry = mesh.geometry.clone();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return {
    geometry,
    material: cloneMeshMaterial(mesh.material)
  };
}

function sampleFrame(curve, progress, frame = {}) {
  const point = frame.point || new THREE.Vector3();
  const tangent = frame.tangent || new THREE.Vector3();
  const normal = frame.normal || new THREE.Vector3();
  curve.getPointAt(progress, point);
  curve.getTangentAt(progress, tangent);
  tangent.y = 0;
  if (tangent.lengthSq() <= 1e-9) {
    tangent.set(0, 0, 1);
  } else {
    tangent.normalize();
  }
  normal.set(tangent.z, 0, -tangent.x).normalize();
  frame.point = point;
  frame.tangent = tangent;
  frame.normal = normal;
  return frame;
}

function resolveMaxVisibleDistance(entry, visibility) {
  const explicit = Number(entry?.maxVisibleDistance);
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  const fallback = Number(visibility?.defaultMaxDistance);
  if (Number.isFinite(fallback) && fallback > 0) {
    return fallback;
  }
  return Infinity;
}

function buildInstancedPrefabMesh(source, curve, entry, visibility) {
  const anchors = Math.max(1, Math.trunc(Number(entry?.count) || 1));
  const bothSides = entry?.bothSides !== false;
  const sideCount = bothSides ? 2 : 1;
  const mesh = new THREE.InstancedMesh(source.geometry, source.material, anchors * sideCount);
  mesh.name = `race-track-prop-${String(entry?.key || "unknown")}`;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  // Instanced mesh bounds can be under-estimated across wide tracks; avoid pop/disappear.
  mesh.frustumCulled = false;

  const start = clamp01(entry?.start);
  const end = clamp01(entry?.end);
  const span = end >= start ? end - start : 1 - start + end;
  const lateralOffset = Math.max(0.2, Number(entry?.lateralOffset) || 10);
  const yOffset = Number(entry?.yOffset) || 0;
  const yawOffset = Number(entry?.yawOffset) || 0;
  const scaleRange = Array.isArray(entry?.scaleRange) ? entry.scaleRange : [1, 1];
  const scaleMin = Math.max(0.3, Number(scaleRange?.[0]) || 1);
  const scaleMax = Math.max(scaleMin, Number(scaleRange?.[1]) || scaleMin);
  const singleSide = Number(entry?.side) >= 0 ? 1 : -1;

  const matrix = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);
  const position = new THREE.Vector3();
  const frame = {};
  let writeIndex = 0;

  const boundsMin = new THREE.Vector3(Infinity, Infinity, Infinity);
  const boundsMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

  for (let index = 0; index < anchors; index += 1) {
    const alpha = anchors <= 1 ? 0 : index / (anchors - 1);
    const progress = clamp01(start + alpha * span);
    sampleFrame(curve, progress, frame);
    const yaw = Math.atan2(frame.tangent.x, frame.tangent.z) + yawOffset;
    rotation.setFromEuler(new THREE.Euler(0, yaw, 0, "YXZ"));
    const baseScale = THREE.MathUtils.lerp(scaleMin, scaleMax, pseudoRandom(index + 1, 0.37));
    for (let sideIndex = 0; sideIndex < sideCount; sideIndex += 1) {
      const side = bothSides ? (sideIndex === 0 ? -1 : 1) : singleSide;
      const jitter = THREE.MathUtils.lerp(-0.6, 0.6, pseudoRandom(index + 1, side * 1.31));
      position.copy(frame.point).addScaledVector(frame.normal, lateralOffset * side + jitter);
      position.y += yOffset;
      const sideScale = baseScale * THREE.MathUtils.lerp(0.94, 1.06, pseudoRandom(index + 1, side * 2.11));
      scale.set(sideScale, sideScale, sideScale);
      matrix.compose(position, rotation, scale);
      mesh.setMatrixAt(writeIndex, matrix);
      boundsMin.min(position);
      boundsMax.max(position);
      writeIndex += 1;
    }
  }
  mesh.instanceMatrix.needsUpdate = true;

  if (
    Number.isFinite(boundsMin.x) &&
    Number.isFinite(boundsMin.y) &&
    Number.isFinite(boundsMin.z) &&
    Number.isFinite(boundsMax.x) &&
    Number.isFinite(boundsMax.y) &&
    Number.isFinite(boundsMax.z)
  ) {
    const center = boundsMin.clone().add(boundsMax).multiplyScalar(0.5);
    const radius = Math.max(1, center.distanceTo(boundsMax) + 4);
    const maxDistance = resolveMaxVisibleDistance(entry, visibility);
    if (Number.isFinite(maxDistance)) {
      mesh.userData.visibilityRange = {
        center: [center.x, center.y, center.z],
        radius,
        maxDistance
      };
    }
  }

  return mesh;
}

export async function buildTrackPropInstancesFromPack(track = CAR_RACE_TRACK_BLUEPRINT, curve, options = {}) {
  if (!curve) {
    return null;
  }
  const pack = getTrackPropPack(track);
  if (!pack?.rootUrl || !pack?.prefabs || typeof pack.prefabs !== "object") {
    return null;
  }

  const layout = resolveLayout(pack, options);
  const visibility = resolveVisibility(pack, options);
  const group = new THREE.Group();
  group.name = "race-track-props-group";
  group.userData.visibility = visibility;

  for (const entry of layout) {
    const key = String(entry?.key || "").trim();
    const fileName = String(pack?.prefabs?.[key] || "").trim();
    if (!key || !fileName) {
      continue;
    }
    if (Math.max(0, Math.trunc(Number(entry?.count) || 0)) <= 0) {
      continue;
    }
    try {
      const source = await loadPrefabSource(pack.rootUrl, fileName);
      if (!source?.geometry || !source?.material) {
        continue;
      }
      const mesh = buildInstancedPrefabMesh(source, curve, entry, visibility);
      mesh.userData.prefabKey = key;
      group.add(mesh);
    } catch (error) {
      const warnKey = `${key}:${fileName}`;
      if (!missingPrefabWarnings.has(warnKey) && typeof console !== "undefined" && typeof console.warn === "function") {
        missingPrefabWarnings.add(warnKey);
        console.warn(
          `[track-props] failed to load prefab "${fileName}" for key "${key}" from ${pack.rootUrl}: ${
            String(error?.message ?? error)
          }`
        );
      }
      // Skip missing or malformed assets; road generation must remain stable.
    }
  }

  return group.children.length > 0 ? group : null;
}
