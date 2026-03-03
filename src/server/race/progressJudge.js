import {
  createCheckpointProgressPlan,
  normalizeCenterlinePoints,
  unwrapProgressDelta
} from "../../game/world/track/centerlineProgress.js";
import {
  CAR_RACE_TRACK_BLUEPRINT,
  getCenterlinePoints,
  getTrackCheckpointProgressValues
} from "../../game/world/track/trackBlueprint.js";

function normalizeProgress(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return 0;
  }
  const mod = value % 1;
  return mod < 0 ? mod + 1 : mod;
}

function sortedCheckpointList(track) {
  return createCheckpointProgressPlan(getTrackCheckpointProgressValues(track));
}

function nextCheckpointUnwrapped(checkpoints, nextCheckpointIndex, unwrappedCursor) {
  const base = checkpoints[nextCheckpointIndex] ?? 0;
  let candidate = base;
  while (candidate <= unwrappedCursor + 1e-9) {
    candidate += 1;
  }
  return candidate;
}

export function createProgressState(seed = {}) {
  return {
    lap: Math.max(0, Math.trunc(Number(seed?.lap) || 0)),
    lastProgress: normalizeProgress(seed?.lastProgress),
    unwrappedProgress: Number(seed?.unwrappedProgress) || 0,
    nextCheckpointIndex: Math.max(0, Math.trunc(Number(seed?.nextCheckpointIndex) || 0))
  };
}

export function validateTrackForProgress(track = CAR_RACE_TRACK_BLUEPRINT) {
  const centerlinePoints = normalizeCenterlinePoints(getCenterlinePoints(track));
  const checkpoints = sortedCheckpointList(track);
  return {
    ok: centerlinePoints.length >= 4 && checkpoints.length >= 3,
    centerlinePointCount: centerlinePoints.length,
    checkpointCount: checkpoints.length
  };
}

export function judgeProgressTransition(state, nextProgressRaw, options = {}) {
  const track = options.track ?? CAR_RACE_TRACK_BLUEPRINT;
  const rules = track?.raceRules ?? {};
  const checkpoints = sortedCheckpointList(track);
  if (checkpoints.length <= 0) {
    return {
      state: createProgressState(state),
      events: [],
      forwardDelta: 0
    };
  }

  const current = createProgressState(state);
  const nextProgress = normalizeProgress(nextProgressRaw);
  const forwardDelta = unwrapProgressDelta(current.lastProgress, nextProgress);
  const wrongWayThreshold = Math.max(0.005, Number(rules.wrongWayThresholdProgress) || 0.02);
  const maxForwardStep = Math.max(0.08, Number(rules.maxForwardProgressStep) || 0.24);
  const events = [];
  let nextState = { ...current, lastProgress: nextProgress };

  if (forwardDelta < -wrongWayThreshold) {
    events.push({
      type: "wrong-way",
      delta: forwardDelta
    });
    nextState.unwrappedProgress += forwardDelta;
    return {
      state: nextState,
      events,
      forwardDelta
    };
  }

  if (forwardDelta > maxForwardStep) {
    events.push({
      type: "possible-cutting",
      delta: forwardDelta
    });
  }

  nextState.unwrappedProgress += Math.max(0, forwardDelta);
  const traversalStart = current.unwrappedProgress;
  const traversalEnd = nextState.unwrappedProgress;
  let checkpointIndex = current.nextCheckpointIndex;
  let lap = current.lap;
  let cursor = traversalStart;
  let safety = 0;

  while (cursor < traversalEnd - 1e-9 && safety < checkpoints.length + 8) {
    safety += 1;
    let checkpointProgress = nextCheckpointUnwrapped(checkpoints, checkpointIndex, cursor);
    if (checkpointProgress > traversalEnd + 1e-9) {
      break;
    }

    events.push({
      type: "checkpoint",
      checkpointIndex,
      progress: checkpoints[checkpointIndex]
    });
    checkpointIndex += 1;
    if (checkpointIndex >= checkpoints.length) {
      checkpointIndex = 0;
      lap += 1;
      events.push({
        type: "lap",
        lap
      });
    }
    cursor = checkpointProgress;
  }

  nextState = {
    ...nextState,
    lap,
    nextCheckpointIndex: checkpointIndex
  };

  return {
    state: nextState,
    events,
    forwardDelta
  };
}

