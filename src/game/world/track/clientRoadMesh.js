import * as THREE from "three";
import { CAR_RACE_TRACK_BLUEPRINT, getCenterlinePoints } from "./trackBlueprint.js";

function toVector3(raw) {
  const point = Array.isArray(raw) ? raw : [0, 0, 0];
  return new THREE.Vector3(Number(point[0]) || 0, Number(point[1]) || 0, Number(point[2]) || 0);
}

function buildCurve(points) {
  const vectors = points.map((point) => toVector3(point));
  return new THREE.CatmullRomCurve3(vectors, true, "catmullrom", 0.25);
}

function buildCurveSlice(curve, startProgress, endProgress, sampleCount = 60) {
  const points = [];
  const start = Math.max(0, Math.min(1, Number(startProgress) || 0));
  const end = Math.max(start + 0.001, Math.min(1, Number(endProgress) || 1));
  for (let index = 0; index <= sampleCount; index += 1) {
    const alpha = index / sampleCount;
    const progress = start + (end - start) * alpha;
    points.push(curve.getPointAt(progress));
  }
  return new THREE.CatmullRomCurve3(points, false, "catmullrom", 0.25);
}

function buildExtrudedRoadMesh(curve, options = {}) {
  const halfWidth = Math.max(2, Number(options.halfWidth) || 7.6);
  const thickness = Math.max(0.02, Number(options.thickness) || 0.34);
  const steps = Math.max(120, Math.trunc(Number(options.steps) || 460));
  const material =
    options.material ||
    new THREE.MeshStandardMaterial({
      color: 0x34393e,
      roughness: 0.92,
      metalness: 0.08,
      side: THREE.DoubleSide
    });
  const sampleCount = Math.max(64, steps);
  const positionArray = new Float32Array((sampleCount + 1) * 2 * 3);
  const normalArray = new Float32Array((sampleCount + 1) * 2 * 3);
  const uvArray = new Float32Array((sampleCount + 1) * 2 * 2);
  const indexArray = new Uint32Array(sampleCount * 6);

  const point = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const left = new THREE.Vector3();
  const right = new THREE.Vector3();

  for (let i = 0; i <= sampleCount; i += 1) {
    const t = i / sampleCount;
    curve.getPointAt(t, point);
    curve.getTangentAt(t, tangent);
    tangent.y = 0;
    if (tangent.lengthSq() < 1e-9) {
      tangent.set(0, 0, 1);
    } else {
      tangent.normalize();
    }
    normal.set(tangent.z, 0, -tangent.x).normalize();
    left.copy(point).addScaledVector(normal, halfWidth);
    right.copy(point).addScaledVector(normal, -halfWidth);
    left.y += thickness;
    right.y += thickness;

    const vBase = i * 2;
    const pOffset = vBase * 3;
    positionArray[pOffset] = left.x;
    positionArray[pOffset + 1] = left.y;
    positionArray[pOffset + 2] = left.z;
    positionArray[pOffset + 3] = right.x;
    positionArray[pOffset + 4] = right.y;
    positionArray[pOffset + 5] = right.z;

    normalArray[pOffset] = 0;
    normalArray[pOffset + 1] = 1;
    normalArray[pOffset + 2] = 0;
    normalArray[pOffset + 3] = 0;
    normalArray[pOffset + 4] = 1;
    normalArray[pOffset + 5] = 0;

    const uvOffset = vBase * 2;
    uvArray[uvOffset] = 0;
    uvArray[uvOffset + 1] = t;
    uvArray[uvOffset + 2] = 1;
    uvArray[uvOffset + 3] = t;
  }

  for (let i = 0; i < sampleCount; i += 1) {
    const v = i * 2;
    const next = (i + 1) * 2;
    const indexOffset = i * 6;
    indexArray[indexOffset] = v;
    indexArray[indexOffset + 1] = next;
    indexArray[indexOffset + 2] = v + 1;
    indexArray[indexOffset + 3] = v + 1;
    indexArray[indexOffset + 4] = next;
    indexArray[indexOffset + 5] = next + 1;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positionArray, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normalArray, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvArray, 2));
  geometry.setIndex(new THREE.BufferAttribute(indexArray, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.name = options.name || "race-road";
  return mesh;
}

function buildGuardrailPostInstances(curve, options = {}) {
  const postCount = Math.max(48, Math.trunc(Number(options.postCount) || 180));
  const halfWidth = Math.max(2, Number(options.halfWidth) || 7.6);
  const shoulderWidth = Math.max(0.4, Number(options.shoulderWidth) || 1.1);
  const offset = Math.max(0.2, Number(options.guardrailOffset) || 0.8);
  const lateralOffset = halfWidth + shoulderWidth + offset;
  const postHeight = Math.max(0.6, Number(options.postHeight) || 1.45);
  const postThickness = Math.max(0.06, Number(options.postThickness) || 0.18);
  const instanceCount = postCount * 2;
  const geometry = new THREE.BoxGeometry(postThickness, postHeight, postThickness);
  const material =
    options.material ||
    new THREE.MeshStandardMaterial({
      color: 0xaab4bf,
      roughness: 0.82,
      metalness: 0.22
    });
  const mesh = new THREE.InstancedMesh(geometry, material, instanceCount);
  mesh.name = options.name || "race-guardrail-posts";
  mesh.castShadow = false;
  mesh.receiveShadow = true;

  const point = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const matrix = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);
  let writeIndex = 0;
  for (let index = 0; index < postCount; index += 1) {
    const progress = index / postCount;
    curve.getPointAt(progress, point);
    curve.getTangentAt(progress, tangent);
    tangent.y = 0;
    if (tangent.lengthSq() < 1e-9) {
      tangent.set(0, 0, 1);
    } else {
      tangent.normalize();
    }
    normal.set(tangent.z, 0, -tangent.x).normalize();
    for (const side of [-1, 1]) {
      matrix.compose(
        new THREE.Vector3(
          point.x + normal.x * lateralOffset * side,
          point.y + postHeight * 0.5,
          point.z + normal.z * lateralOffset * side
        ),
        rotation,
        scale
      );
      mesh.setMatrixAt(writeIndex, matrix);
      writeIndex += 1;
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

export function buildRoadMeshesFromCenterline(track = CAR_RACE_TRACK_BLUEPRINT, options = {}) {
  const centerlinePoints = getCenterlinePoints(track);
  if (!Array.isArray(centerlinePoints) || centerlinePoints.length < 4) {
    return null;
  }

  const road = track?.road ?? {};
  const perf = track?.performance ?? {};
  const baseCurve = buildCurve(centerlinePoints);
  const group = new THREE.Group();
  group.name = "race-road-group";

  const baseRoadMesh = buildExtrudedRoadMesh(baseCurve, {
    halfWidth: Number(options.baseHalfWidth) || Number(road.baseHalfWidth) || 7.6,
    thickness: Number(options.baseThickness) || Number(road.baseThickness) || 0.34,
    steps: options.steps || Math.max(96, Math.trunc(Number(perf.roadSteps) || 220)),
    name: "race-road-main",
    material: options.baseMaterial
  });
  group.add(baseRoadMesh);

  const wideSpan = Math.max(0.04, Math.min(0.3, Number(road.startWideProgressSpan) || 0.12));
  const startWideCurve = buildCurveSlice(baseCurve, 0, wideSpan, 90);
  const startWideMesh = buildExtrudedRoadMesh(startWideCurve, {
    halfWidth: Number(options.startWideHalfWidth) || Number(road.startWideHalfWidth) || 9.8,
    thickness: Number(options.baseThickness) || Number(road.baseThickness) || 0.34,
    steps: Math.max(56, Math.trunc(Number(perf.startWideSteps) || 120)),
    name: "race-road-start-wide",
    material:
      options.startWideMaterial ||
      new THREE.MeshStandardMaterial({
        color: 0x3f444a,
        roughness: 0.9,
        metalness: 0.06
      })
  });
  startWideMesh.renderOrder = 2;
  group.add(startWideMesh);

  if (options.enableGuardrailPosts !== false) {
    const guardrailPosts = buildGuardrailPostInstances(baseCurve, {
      postCount: options.guardrailPostCount || perf.guardrailPostCount || 180,
      halfWidth: Number(options.baseHalfWidth) || Number(road.baseHalfWidth) || 7.6,
      shoulderWidth: Number(road.shoulderWidth) || 1.1,
      material: options.guardrailMaterial
    });
    group.add(guardrailPosts);
  }

  return {
    group,
    curve: baseCurve,
    baseRoadMesh,
    startWideMesh
  };
}
