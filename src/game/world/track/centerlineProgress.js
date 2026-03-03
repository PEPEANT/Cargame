function toVec3(raw) {
  if (Array.isArray(raw)) {
    return {
      x: Number(raw[0]) || 0,
      y: Number(raw[1]) || 0,
      z: Number(raw[2]) || 0
    };
  }
  if (raw && typeof raw === "object") {
    return {
      x: Number(raw.x) || 0,
      y: Number(raw.y) || 0,
      z: Number(raw.z) || 0
    };
  }
  return { x: 0, y: 0, z: 0 };
}

function add(left, right) {
  return {
    x: left.x + right.x,
    y: left.y + right.y,
    z: left.z + right.z
  };
}

function subtract(left, right) {
  return {
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z
  };
}

function scale(value, factor) {
  return {
    x: value.x * factor,
    y: value.y * factor,
    z: value.z * factor
  };
}

function dot(left, right) {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function length(value) {
  return Math.hypot(value.x, value.y, value.z);
}

function distance(left, right) {
  return length(subtract(left, right));
}

function clamp01(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function normalizeProgress(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return 0;
  }
  const mod = value % 1;
  return mod < 0 ? mod + 1 : mod;
}

export function normalizeCenterlinePoints(points) {
  const source = Array.isArray(points) ? points : [];
  const normalized = source.map((point) => toVec3(point));
  if (normalized.length < 2) {
    return normalized;
  }
  const first = normalized[0];
  const last = normalized[normalized.length - 1];
  const closed = distance(first, last) <= 1e-4;
  if (!closed) {
    normalized.push({ ...first });
  }
  return normalized;
}

export function buildCenterlineMetrics(points) {
  const normalized = normalizeCenterlinePoints(points);
  if (normalized.length < 2) {
    return {
      points: normalized,
      segmentLengths: [],
      cumulative: [0],
      totalLength: 0
    };
  }

  const segmentLengths = [];
  const cumulative = [0];
  for (let index = 0; index < normalized.length - 1; index += 1) {
    const start = normalized[index];
    const end = normalized[index + 1];
    const segmentLength = Math.max(1e-6, distance(start, end));
    segmentLengths.push(segmentLength);
    cumulative.push(cumulative[cumulative.length - 1] + segmentLength);
  }

  return {
    points: normalized,
    segmentLengths,
    cumulative,
    totalLength: cumulative[cumulative.length - 1]
  };
}

export function projectPointToCenterlineProgress(point, metricsOrPoints) {
  const metrics =
    metricsOrPoints && typeof metricsOrPoints === "object" && "totalLength" in metricsOrPoints
      ? metricsOrPoints
      : buildCenterlineMetrics(metricsOrPoints);
  if (!metrics?.points || metrics.points.length < 2 || metrics.totalLength <= 0) {
    return {
      progress: 0,
      distance: 0,
      segmentIndex: 0,
      distanceAlong: 0
    };
  }

  const target = toVec3(point);
  let best = {
    distanceSq: Number.POSITIVE_INFINITY,
    progress: 0,
    distance: 0,
    segmentIndex: 0,
    distanceAlong: 0
  };

  for (let index = 0; index < metrics.points.length - 1; index += 1) {
    const start = metrics.points[index];
    const end = metrics.points[index + 1];
    const segment = subtract(end, start);
    const segmentLenSq = Math.max(1e-9, dot(segment, segment));
    const local = subtract(target, start);
    const t = clamp01(dot(local, segment) / segmentLenSq);
    const projected = add(start, scale(segment, t));
    const delta = subtract(target, projected);
    const distanceSq = dot(delta, delta);
    if (distanceSq >= best.distanceSq) {
      continue;
    }

    const distanceAlong = metrics.cumulative[index] + metrics.segmentLengths[index] * t;
    best = {
      distanceSq,
      distance: Math.sqrt(distanceSq),
      segmentIndex: index,
      distanceAlong,
      progress: normalizeProgress(distanceAlong / Math.max(1e-6, metrics.totalLength))
    };
  }

  return {
    progress: best.progress,
    distance: best.distance,
    segmentIndex: best.segmentIndex,
    distanceAlong: best.distanceAlong
  };
}

export function buildFixedColliderSegments(points, options = {}) {
  const metrics = buildCenterlineMetrics(points);
  if (!metrics.points || metrics.points.length < 2 || metrics.totalLength <= 0) {
    return [];
  }

  const targetLength = Math.max(1, Number(options.segmentLength) || 7);
  const colliderWidth = Math.max(2, Number(options.boxWidth) || 16);
  const colliderHeight = Math.max(0.6, Number(options.boxHeight) || 2.6);
  const centerY = Number(options.centerY) || 1.2;
  const segments = [];

  for (let index = 0; index < metrics.points.length - 1; index += 1) {
    const segmentStart = metrics.points[index];
    const segmentEnd = metrics.points[index + 1];
    const rawLength = metrics.segmentLengths[index];
    const chunkCount = Math.max(1, Math.ceil(rawLength / targetLength));
    const delta = subtract(segmentEnd, segmentStart);

    for (let chunk = 0; chunk < chunkCount; chunk += 1) {
      const startT = chunk / chunkCount;
      const endT = (chunk + 1) / chunkCount;
      const midT = (startT + endT) * 0.5;
      const chunkStart = add(segmentStart, scale(delta, startT));
      const chunkEnd = add(segmentStart, scale(delta, endT));
      const chunkCenter = add(segmentStart, scale(delta, midT));
      const chunkLength = Math.max(0.2, distance(chunkStart, chunkEnd));
      const headingRadians = Math.atan2(chunkEnd.x - chunkStart.x, chunkEnd.z - chunkStart.z);
      const progressStart =
        (metrics.cumulative[index] + rawLength * startT) / Math.max(1e-6, metrics.totalLength);
      const progressEnd =
        (metrics.cumulative[index] + rawLength * endT) / Math.max(1e-6, metrics.totalLength);

      segments.push({
        segmentIndex: segments.length,
        center: {
          x: chunkCenter.x,
          y: centerY,
          z: chunkCenter.z
        },
        size: {
          x: colliderWidth,
          y: colliderHeight,
          z: chunkLength
        },
        headingRadians,
        progressStart: normalizeProgress(progressStart),
        progressEnd: normalizeProgress(progressEnd)
      });
    }
  }

  return segments;
}

export function unwrapProgressDelta(previousProgress, nextProgress) {
  const prev = normalizeProgress(previousProgress);
  const next = normalizeProgress(nextProgress);
  let delta = next - prev;
  if (delta > 0.5) {
    delta -= 1;
  } else if (delta < -0.5) {
    delta += 1;
  }
  return delta;
}

export function createCheckpointProgressPlan(progressValues) {
  const source = Array.isArray(progressValues) ? progressValues : [];
  const normalized = source
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .map((value) => normalizeProgress(value))
    .sort((left, right) => left - right);
  return normalized;
}

