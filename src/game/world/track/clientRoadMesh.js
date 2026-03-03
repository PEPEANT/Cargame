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

function sampleCurveFrame(curve, progress, frame = {}) {
  const point = frame.point || new THREE.Vector3();
  const tangent = frame.tangent || new THREE.Vector3();
  const normal = frame.normal || new THREE.Vector3();
  const t = Math.max(0, Math.min(1, Number(progress) || 0));
  curve.getPointAt(t, point);
  curve.getTangentAt(t, tangent);
  tangent.y = 0;
  if (tangent.lengthSq() < 1e-9) {
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

  const frame = {};
  const matrix = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);
  let writeIndex = 0;
  for (let index = 0; index < postCount; index += 1) {
    const progress = index / postCount;
    sampleCurveFrame(curve, progress, frame);
    for (const side of [-1, 1]) {
      matrix.compose(
        new THREE.Vector3(
          frame.point.x + frame.normal.x * lateralOffset * side,
          frame.point.y + postHeight * 0.5,
          frame.point.z + frame.normal.z * lateralOffset * side
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

function buildLampPostInstances(curve, options = {}) {
  const lampCount = Math.max(12, Math.trunc(Number(options.lampCount) || 56));
  const halfWidth = Math.max(2, Number(options.halfWidth) || 7.6);
  const shoulderWidth = Math.max(0.4, Number(options.shoulderWidth) || 1.1);
  const offset = Math.max(1.4, Number(options.lampOffset) || 6.1);
  const lateralOffset = halfWidth + shoulderWidth + offset;
  const postHeight = Math.max(2.2, Number(options.postHeight) || 4.8);
  const postRadius = Math.max(0.05, Number(options.postRadius) || 0.11);
  const headWidth = Math.max(0.25, Number(options.headWidth) || 0.56);
  const headHeight = Math.max(0.12, Number(options.headHeight) || 0.24);
  const headDepth = Math.max(0.12, Number(options.headDepth) || 0.24);
  const instanceCount = lampCount * 2;

  const postGeometry = new THREE.CylinderGeometry(postRadius, postRadius, postHeight, 6, 1, false);
  const headGeometry = new THREE.BoxGeometry(headWidth, headHeight, headDepth);
  const postMaterial =
    options.postMaterial ||
    new THREE.MeshStandardMaterial({
      color: 0x798491,
      roughness: 0.84,
      metalness: 0.2
    });
  const headMaterial =
    options.headMaterial ||
    new THREE.MeshStandardMaterial({
      color: 0xffe8b0,
      emissive: 0x4f3a15,
      emissiveIntensity: 0.35,
      roughness: 0.52,
      metalness: 0.06
    });

  const postMesh = new THREE.InstancedMesh(postGeometry, postMaterial, instanceCount);
  postMesh.name = options.postName || "race-lamp-posts";
  postMesh.castShadow = false;
  postMesh.receiveShadow = true;

  const headMesh = new THREE.InstancedMesh(headGeometry, headMaterial, instanceCount);
  headMesh.name = options.headName || "race-lamp-heads";
  headMesh.castShadow = false;
  headMesh.receiveShadow = true;

  const frame = {};
  const matrix = new THREE.Matrix4();
  const scale = new THREE.Vector3(1, 1, 1);
  const rotation = new THREE.Quaternion();
  let writeIndex = 0;

  for (let index = 0; index < lampCount; index += 1) {
    const alpha = lampCount <= 1 ? 0 : index / (lampCount - 1);
    const progress = 0.04 + alpha * 0.92;
    sampleCurveFrame(curve, progress, frame);
    const yaw = Math.atan2(frame.tangent.x, frame.tangent.z);
    rotation.setFromEuler(new THREE.Euler(0, yaw, 0, "YXZ"));
    for (const side of [-1, 1]) {
      const jitter = (Math.sin((index + 1) * 1.713 + side * 0.43) * 0.5) * 0.42;
      const baseX = frame.point.x + frame.normal.x * (lateralOffset * side + jitter);
      const baseZ = frame.point.z + frame.normal.z * (lateralOffset * side + jitter);
      const baseY = frame.point.y;

      matrix.compose(new THREE.Vector3(baseX, baseY + postHeight * 0.5, baseZ), rotation, scale);
      postMesh.setMatrixAt(writeIndex, matrix);

      matrix.compose(
        new THREE.Vector3(
          baseX + frame.normal.x * side * 0.22,
          baseY + postHeight - headHeight * 0.5,
          baseZ + frame.normal.z * side * 0.22
        ),
        rotation,
        scale
      );
      headMesh.setMatrixAt(writeIndex, matrix);
      writeIndex += 1;
    }
  }

  postMesh.instanceMatrix.needsUpdate = true;
  headMesh.instanceMatrix.needsUpdate = true;

  const group = new THREE.Group();
  group.name = options.groupName || "race-lamp-group";
  group.add(postMesh, headMesh);
  return group;
}

function buildTrackSignInstances(curve, options = {}) {
  const signCount = Math.max(8, Math.trunc(Number(options.signCount) || 24));
  const halfWidth = Math.max(2, Number(options.halfWidth) || 7.6);
  const shoulderWidth = Math.max(0.4, Number(options.shoulderWidth) || 1.1);
  const offset = Math.max(0.6, Number(options.signOffset) || 3.4);
  const lateralOffset = halfWidth + shoulderWidth + offset;
  const poleHeight = Math.max(1.2, Number(options.poleHeight) || 2.5);
  const poleRadius = Math.max(0.04, Number(options.poleRadius) || 0.08);
  const panelWidth = Math.max(0.6, Number(options.panelWidth) || 1.6);
  const panelHeight = Math.max(0.4, Number(options.panelHeight) || 0.92);
  const panelDepth = Math.max(0.05, Number(options.panelDepth) || 0.09);
  const instanceCount = signCount * 2;

  const poleGeometry = new THREE.CylinderGeometry(poleRadius, poleRadius, poleHeight, 6, 1, false);
  const panelGeometry = new THREE.BoxGeometry(panelWidth, panelHeight, panelDepth);
  const poleMaterial =
    options.poleMaterial ||
    new THREE.MeshStandardMaterial({
      color: 0x5c6269,
      roughness: 0.86,
      metalness: 0.08
    });
  const panelMaterial =
    options.panelMaterial ||
    new THREE.MeshStandardMaterial({
      color: 0x3f7ca7,
      roughness: 0.75,
      metalness: 0.02
    });

  const poleMesh = new THREE.InstancedMesh(poleGeometry, poleMaterial, instanceCount);
  poleMesh.name = options.poleName || "race-sign-poles";
  poleMesh.castShadow = false;
  poleMesh.receiveShadow = true;

  const panelMesh = new THREE.InstancedMesh(panelGeometry, panelMaterial, instanceCount);
  panelMesh.name = options.panelName || "race-sign-panels";
  panelMesh.castShadow = false;
  panelMesh.receiveShadow = true;

  const frame = {};
  const matrix = new THREE.Matrix4();
  const scale = new THREE.Vector3(1, 1, 1);
  const rotation = new THREE.Quaternion();
  const centerDirection = new THREE.Vector3();
  let writeIndex = 0;

  for (let index = 0; index < signCount; index += 1) {
    const alpha = signCount <= 1 ? 0 : index / (signCount - 1);
    const progress = 0.06 + alpha * 0.88;
    sampleCurveFrame(curve, progress, frame);
    for (const side of [-1, 1]) {
      const jitter = (Math.sin((index + 1) * 2.011 + side * 1.07) * 0.5) * 0.5;
      const baseX = frame.point.x + frame.normal.x * (lateralOffset * side + jitter);
      const baseZ = frame.point.z + frame.normal.z * (lateralOffset * side + jitter);
      const baseY = frame.point.y;

      matrix.compose(new THREE.Vector3(baseX, baseY + poleHeight * 0.5, baseZ), rotation, scale);
      poleMesh.setMatrixAt(writeIndex, matrix);

      centerDirection.copy(frame.normal).multiplyScalar(-side);
      const panelYaw = Math.atan2(centerDirection.x, centerDirection.z);
      rotation.setFromEuler(new THREE.Euler(0, panelYaw, 0, "YXZ"));
      matrix.compose(
        new THREE.Vector3(
          baseX + centerDirection.x * 0.08,
          baseY + poleHeight - panelHeight * 0.5,
          baseZ + centerDirection.z * 0.08
        ),
        rotation,
        scale
      );
      panelMesh.setMatrixAt(writeIndex, matrix);
      writeIndex += 1;
    }
  }

  poleMesh.instanceMatrix.needsUpdate = true;
  panelMesh.instanceMatrix.needsUpdate = true;

  const group = new THREE.Group();
  group.name = options.groupName || "race-sign-group";
  group.add(poleMesh, panelMesh);
  return group;
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

  if (options.enableLampPosts !== false) {
    const lampPosts = buildLampPostInstances(baseCurve, {
      lampCount: options.lampPostCount || perf.lampPostCount || 56,
      halfWidth: Number(options.baseHalfWidth) || Number(road.baseHalfWidth) || 7.6,
      shoulderWidth: Number(road.shoulderWidth) || 1.1
    });
    group.add(lampPosts);
  }

  if (options.enableTrackSigns !== false) {
    const signs = buildTrackSignInstances(baseCurve, {
      signCount: options.signCount || perf.signCount || 24,
      halfWidth: Number(options.baseHalfWidth) || Number(road.baseHalfWidth) || 7.6,
      shoulderWidth: Number(road.shoulderWidth) || 1.1
    });
    group.add(signs);
  }

  return {
    group,
    curve: baseCurve,
    baseRoadMesh,
    startWideMesh
  };
}
