import { CAR_RACE_TRACK_BLUEPRINT, getCenterlinePoints } from "../../game/world/track/trackBlueprint.js";
import { buildFixedColliderSegments } from "../../game/world/track/centerlineProgress.js";

export function buildRaceColliderLayout(track = CAR_RACE_TRACK_BLUEPRINT) {
  const centerlinePoints = getCenterlinePoints(track);
  const colliderConfig = track?.collider ?? {};
  const segments = buildFixedColliderSegments(centerlinePoints, colliderConfig);
  return {
    trackId: String(track?.id ?? "unknown-track"),
    segmentCount: segments.length,
    segments
  };
}

