import { createServer } from "http";
import { Server } from "socket.io";
import { verifyRoomJoinToken } from "./src/server/roomToken.js";
import {
  createRaceSessionDraft,
  RACE_SEAT_DEFAULTS,
  RACE_SESSION_DEFAULTS
} from "./src/game/modes/race/RaceSessionDefaults.js";
import {
  CAR_RACE_TRACK_BLUEPRINT,
  getCenterlinePoints,
  getTrackCheckpointProgressValues
} from "./src/game/world/track/trackBlueprint.js";
import {
  buildCenterlineMetrics,
  projectPointToCenterlineProgress
} from "./src/game/world/track/centerlineProgress.js";
import { buildRaceColliderLayout } from "./src/server/race/centerlineColliderLayout.js";
import {
  createProgressState,
  judgeProgressTransition,
  validateTrackForProgress
} from "./src/server/race/progressJudge.js";

function parseCorsOrigins(rawValue) {
  const value = String(rawValue ?? "").trim();
  if (!value || value === "*") {
    return "*";
  }

  const list = value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return list.length > 0 ? list : "*";
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

async function probeExistingServer(port) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(`http://localhost:${port}/health`, {
      method: "GET",
      signal: controller.signal,
      headers: { accept: "application/json" }
    });
    if (!response.ok) {
      return false;
    }
    const payload = await response.json().catch(() => null);
    return Boolean(payload?.ok && payload?.service === "reclaim-fps-chat");
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

const ROOM_CODE_PREFIX = "CR";
const ROOM_CODE_RANDOM_LENGTH = 5;
const ENTRY_PARTICIPANT_LIMIT = Math.max(
  1,
  Math.trunc(Number(process.env.ENTRY_PARTICIPANT_LIMIT ?? 50) || 50)
);
const MAX_ROOM_PLAYERS = Math.max(
  ENTRY_PARTICIPANT_LIMIT,
  Math.trunc(Number(process.env.MAX_ROOM_PLAYERS ?? 120) || 120)
);
const MAX_ACTIVE_ROOMS = 24;

const WORKER_SINGLE_ROOM_MODE = process.env.ROOM_WORKER_SINGLE === "1";
const WORKER_ROOM_CODE_RAW = String(process.env.ROOM_CODE ?? "");
const REQUIRE_JOIN_TOKEN = process.env.REQUIRE_JOIN_TOKEN === "1";
const ROOM_JOIN_SECRET = String(process.env.ROOM_JOIN_SECRET ?? "dev-room-secret") || "dev-room-secret";
const ROOM_JOIN_TOKEN_LEEWAY_MS = 8000;
const ROOM_OWNER_KEY = String(process.env.ROOM_OWNER_KEY ?? "").trim();

const SERVER_TICK_RATE = 20;
const SERVER_TICK_INTERVAL_MS = Math.max(30, Math.trunc(1000 / SERVER_TICK_RATE));
const SERVER_DELTA_HEARTBEAT_TICKS = 20;

const ACTIVE_TRACK_BLUEPRINT = CAR_RACE_TRACK_BLUEPRINT;
const TRACK_CENTERLINE_POINTS = getCenterlinePoints(ACTIVE_TRACK_BLUEPRINT);
const TRACK_CENTERLINE_METRICS = buildCenterlineMetrics(TRACK_CENTERLINE_POINTS);
const TRACK_CHECKPOINT_PROGRESS_VALUES = getTrackCheckpointProgressValues(ACTIVE_TRACK_BLUEPRINT);
const TRACK_PROGRESS_VALIDATION = validateTrackForProgress(ACTIVE_TRACK_BLUEPRINT);
const TRACK_COLLIDER_LAYOUT = buildRaceColliderLayout(ACTIVE_TRACK_BLUEPRINT);
const TRACK_INTEREST_CONFIG = ACTIVE_TRACK_BLUEPRINT?.networkInterest ?? {};

function cadenceFromHz(rawHz, fallbackHz) {
  const hz = Number(rawHz);
  const safeHz = Number.isFinite(hz) && hz > 0 ? hz : fallbackHz;
  return Math.max(1, Math.round(SERVER_TICK_RATE / Math.max(1, safeHz)));
}

function buildTrackBoundsFromCenterline(metrics, padding = 24) {
  const points = Array.isArray(metrics?.points) ? metrics.points : [];
  if (points.length <= 0) {
    return {
      minX: -512,
      maxX: 512,
      minZ: -512,
      maxZ: 512
    };
  }
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    const x = Number(point?.x);
    const z = Number(point?.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      continue;
    }
    if (x < minX) {
      minX = x;
    }
    if (x > maxX) {
      maxX = x;
    }
    if (z < minZ) {
      minZ = z;
    }
    if (z > maxZ) {
      maxZ = z;
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minZ) || !Number.isFinite(maxZ)) {
    return {
      minX: -512,
      maxX: 512,
      minZ: -512,
      maxZ: 512
    };
  }
  const safePadding = Math.max(4, Number(padding) || 24);
  return {
    minX: minX - safePadding,
    maxX: maxX + safePadding,
    minZ: minZ - safePadding,
    maxZ: maxZ + safePadding
  };
}

function resolveTrackBoundary(track, metrics) {
  const source = track?.boundary ?? {};
  const auto = buildTrackBoundsFromCenterline(metrics, source?.padding ?? 24);
  const minX = Number.isFinite(Number(source?.minX)) ? Number(source.minX) : auto.minX;
  const maxX = Number.isFinite(Number(source?.maxX)) ? Number(source.maxX) : auto.maxX;
  const minZ = Number.isFinite(Number(source?.minZ)) ? Number(source.minZ) : auto.minZ;
  const maxZ = Number.isFinite(Number(source?.maxZ)) ? Number(source.maxZ) : auto.maxZ;
  return {
    enabled: source?.enabled !== false,
    useInvisibleWalls: source?.useInvisibleWalls !== false,
    wallMargin: Math.max(0, Math.min(6, Number(source?.wallMargin) || 0.75)),
    minX: Math.min(minX, maxX),
    maxX: Math.max(minX, maxX),
    minZ: Math.min(minZ, maxZ),
    maxZ: Math.max(minZ, maxZ)
  };
}

const TRACK_BOUNDARY = resolveTrackBoundary(ACTIVE_TRACK_BLUEPRINT, TRACK_CENTERLINE_METRICS);

const AOI_NEAR_RADIUS = Math.max(40, Number(TRACK_INTEREST_CONFIG?.nearRadius) || 96);
const AOI_MID_RADIUS = Math.max(AOI_NEAR_RADIUS + 24, Number(TRACK_INTEREST_CONFIG?.midRadius) || 192);
const AOI_FAR_RADIUS = Math.max(AOI_MID_RADIUS + 32, Number(TRACK_INTEREST_CONFIG?.farRadius) || 280);
const AOI_NEAR_CADENCE = cadenceFromHz(TRACK_INTEREST_CONFIG?.nearHz, 20);
const AOI_MID_CADENCE = Math.max(AOI_NEAR_CADENCE, cadenceFromHz(TRACK_INTEREST_CONFIG?.midHz, 12));
const AOI_FAR_CADENCE = Math.max(AOI_MID_CADENCE, cadenceFromHz(TRACK_INTEREST_CONFIG?.farHz, 10));
const AOI_EDGE_CADENCE = Math.max(AOI_FAR_CADENCE, cadenceFromHz(TRACK_INTEREST_CONFIG?.edgeHz, 10));
const AOI_NEAR_RADIUS_SQ = AOI_NEAR_RADIUS * AOI_NEAR_RADIUS;
const AOI_MID_RADIUS_SQ = AOI_MID_RADIUS * AOI_MID_RADIUS;
const AOI_FAR_RADIUS_SQ = AOI_FAR_RADIUS * AOI_FAR_RADIUS;
const AOI_BUCKET_CELL_SIZE = Math.max(
  40,
  Number(TRACK_INTEREST_CONFIG?.bucketCellSize) || Math.max(48, Math.round(AOI_MID_RADIUS * 0.75))
);
const AOI_BUCKET_RANGE = Math.max(1, Math.ceil(AOI_FAR_RADIUS / AOI_BUCKET_CELL_SIZE));

const DELTA_POS_SCALE = 100;
const DELTA_ROT_SCALE = 1000;

const SERVER_MAX_MOVE_SPEED = 17.5;
const SERVER_MAX_VERTICAL_SPEED = 24;
const SERVER_MAX_ACCELERATION = 46;
const SERVER_MOVEMENT_MARGIN = 0.4;
const SERVER_MAX_TELEPORT_DISTANCE = 18;
const SERVER_CORRECTION_MIN_DISTANCE = 0.22;
const SERVER_CORRECTION_COOLDOWN_MS = 140;
const TRACK_PROGRESS_READY =
  TRACK_PROGRESS_VALIDATION.ok === true && Number(TRACK_CENTERLINE_METRICS?.totalLength || 0) > 0;
const TRACK_PROGRESS_MAX_DISTANCE = Math.max(
  8,
  Number(ACTIVE_TRACK_BLUEPRINT?.collider?.boxWidth || 16.2) * 0.68
);
const TRACK_PROGRESS_SELF_EMIT_INTERVAL_MS = 180;
const TRACK_PROGRESS_ROOM_EMIT_INTERVAL_MS = 900;
const TRACK_PROGRESS_MIN_DELTA = 0.0025;
const TRACK_RESPAWN_CONFIG = ACTIVE_TRACK_BLUEPRINT?.respawn ?? {};
const TRACK_ANTICHEAT_RULES = ACTIVE_TRACK_BLUEPRINT?.raceRules?.antiCheat ?? {};
const TRACK_ANTICHEAT_ENABLED = TRACK_ANTICHEAT_RULES?.enabled !== false;
const TRACK_ANTICHEAT_MAX_DISTANCE = Math.max(
  TRACK_PROGRESS_MAX_DISTANCE + 6,
  Number(TRACK_ANTICHEAT_RULES?.maxDistanceFromCenterline) || TRACK_PROGRESS_MAX_DISTANCE * 1.85
);
const TRACK_ANTICHEAT_RESET_WRONG_WAY_DELTA = Math.max(
  0.03,
  Number(TRACK_ANTICHEAT_RULES?.resetWrongWayDelta) || 0.075
);
const TRACK_ANTICHEAT_RESET_WRONG_WAY_STRIKES = Math.max(
  1,
  Math.trunc(Number(TRACK_ANTICHEAT_RULES?.resetWrongWayStrikes) || 3)
);
const TRACK_ANTICHEAT_RESET_CUTTING_STRIKES = Math.max(
  1,
  Math.trunc(Number(TRACK_ANTICHEAT_RULES?.resetCuttingStrikes) || 2)
);
const TRACK_ANTICHEAT_RESET_COOLDOWN_MS = Math.max(
  800,
  Math.trunc(Number(TRACK_ANTICHEAT_RULES?.resetCooldownMs) || 2200)
);
const TRACK_RESPAWN_BACKTRACK_PROGRESS = Math.max(
  0,
  Math.min(0.08, Number(TRACK_RESPAWN_CONFIG?.backtrackProgress) || 0.004)
);
const TRACK_RESPAWN_LATERAL_OFFSET = Number(TRACK_RESPAWN_CONFIG?.pocketLateralOffset) || 0;
const TRACK_SPAWN_HUB = ACTIVE_TRACK_BLUEPRINT?.spawnHub ?? {};
const TRACK_SEAT_RULES = ACTIVE_TRACK_BLUEPRINT?.raceRules?.seatAssignment ?? {};
const TRACK_SEAT_ALLOW_MANUAL_OPTION = TRACK_SEAT_RULES?.allowManualOption !== false;
const TRACK_SEAT_DEFAULT_MODE =
  String(TRACK_SEAT_RULES?.modeDefault ?? RACE_SESSION_DEFAULTS.seatModeDefault).trim().toLowerCase() === "manual" &&
  TRACK_SEAT_ALLOW_MANUAL_OPTION
    ? "manual"
    : "auto";

const race_DEFAULT_LOCK_SECONDS = 30;
const race_PREPARE_DELAY_MS = 3000;
const race_AUTO_START_DELAY_MS = 12000;
const race_AUTO_RESTART_DELAY_MS = 9000;
const race_AUTO_START_MIN_PLAYERS = 1;
const race_AUTO_OPEN_LOBBY_ON_END = process.env.race_AUTO_OPEN_LOBBY_ON_END !== "0";
const DEFAULT_PORTAL_TARGET_URL = sanitizePortalTargetUrl(process.env.PORTAL_TARGET_URL ?? "");
const CHAT_HISTORY_MAX_ENTRIES = Math.max(
  20,
  Math.min(200, Math.trunc(Number(process.env.CHAT_HISTORY_MAX_ENTRIES ?? 80) || 80))
);
const BILLBOARD_MEDIA_URL_MAX_LENGTH = 420;
const BILLBOARD_MEDIA_VISUAL_TYPES = new Set(["none", "video", "image"]);
const BILLBOARD_PLAYLIST_MAX_ITEMS = 40;
const ROOM_race_CONFIG_CACHE_LIMIT = Math.max(24, MAX_ACTIVE_ROOMS * 6);

const ADMISSION_SPAWN_Y = 1.72;
const ADMISSION_SPAWN_CENTER_X = 0;
const ADMISSION_SPAWN_CENTER_Z = 14;
const ADMISSION_SPAWN_RING_START = 2.4;
const ADMISSION_SPAWN_RING_STEP = 2.35;
const ADMISSION_SPAWN_PER_RING = 10;
const WORLD_PORTAL_POSITION = Array.isArray(TRACK_SPAWN_HUB?.portalPosition)
  ? TRACK_SPAWN_HUB.portalPosition
  : [44, 0.08, 14];
const WORLD_PORTAL_CENTER_X = Number.isFinite(Number(WORLD_PORTAL_POSITION?.[0]))
  ? Number(WORLD_PORTAL_POSITION[0])
  : 44;
const WORLD_PORTAL_CENTER_Z = Number.isFinite(Number(WORLD_PORTAL_POSITION?.[2]))
  ? Number(WORLD_PORTAL_POSITION[2])
  : 14;
const WORLD_PORTAL_RADIUS = Math.max(2.2, Number(TRACK_SPAWN_HUB?.portalRadius) || 4.4);
const WORLD_PORTAL_EXIT_OFFSET_X = Math.max(
  2.4,
  Math.min(8.6, WORLD_PORTAL_RADIUS * 0.78 + 1.25)
);
const race_SPECTATOR_ARENA_MARGIN = 1.1;
const race_SPECTATOR_ARENA_EXIT_PADDING = 1.4;
const TRACK_PLAY_MIN_X = Number(TRACK_BOUNDARY?.minX) + Number(TRACK_BOUNDARY?.wallMargin || 0);
const TRACK_PLAY_MAX_X = Number(TRACK_BOUNDARY?.maxX) - Number(TRACK_BOUNDARY?.wallMargin || 0);
const TRACK_PLAY_MIN_Z = Number(TRACK_BOUNDARY?.minZ) + Number(TRACK_BOUNDARY?.wallMargin || 0);
const TRACK_PLAY_MAX_Z = Number(TRACK_BOUNDARY?.maxZ) - Number(TRACK_BOUNDARY?.wallMargin || 0);
const race_ARENA_MIN_X = Math.min(TRACK_PLAY_MIN_X, TRACK_PLAY_MAX_X) - race_SPECTATOR_ARENA_MARGIN;
const race_ARENA_MAX_X = Math.max(TRACK_PLAY_MIN_X, TRACK_PLAY_MAX_X) + race_SPECTATOR_ARENA_MARGIN;
const race_ARENA_MIN_Z = Math.min(TRACK_PLAY_MIN_Z, TRACK_PLAY_MAX_Z) - race_SPECTATOR_ARENA_MARGIN;
const race_ARENA_MAX_Z = Math.max(TRACK_PLAY_MIN_Z, TRACK_PLAY_MAX_Z) + race_SPECTATOR_ARENA_MARGIN;
const race_SPECTATOR_SPAWN_CENTER_X = race_ARENA_MIN_X - 10;
const race_SPECTATOR_SPAWN_CENTER_Z = race_ARENA_MIN_Z - 10;
const race_SPECTATOR_SPAWN_MIN_RADIUS = 2.6;
const race_SPECTATOR_SPAWN_MAX_RADIUS = 6.4;

const rooms = new Map();
const roomraceConfigCache = new Map();
let latestraceConfigSnapshot = null;
let playerCount = 0;

function createraceState() {
  return {
    active: false,
    phase: "idle",
    autoMode: false,
    autoFinish: true,
    autoStartsAt: 0,
    autoStartTimer: null,
    hostId: null,
    startedAt: 0,
    prepareEndsAt: 0,
    endedAt: 0,
    lockSeconds: race_DEFAULT_LOCK_SECONDS,
    lockAt: 0,
    lockResolveAt: 0,
    lockTimer: null,
    nextTimer: null,
    seatTimer: null,
    seatScheduledAt: 0
  };
}

function createRoom(code, persistent = false) {
  const room = {
    code,
    hostId: null,
    players: new Map(),
    portalTargetUrl: DEFAULT_PORTAL_TARGET_URL,
    billboardMedia: createDefaultBillboardMediaState(),
    entryGate: {
      portalOpen: false,
      openedAt: 0,
      lastAdmissionAt: 0,
      admissionStartsAt: 0,
      admissionTimer: null,
      pendingAdmissionIds: [],
      nextPriorityIds: []
    },
    chatHistory: [],
    persistent,
    createdAt: Date.now(),
    raceConfig: {
      seatMode: TRACK_SEAT_DEFAULT_MODE,
      endPolicy: {
        autoFinish: true,
        showOppositeBillboard: true
      }
    },
    race: createraceState(),
    tick: 0
  };
  applyCachedraceConfigToRoom(room);
  return room;
}

function sanitizeRoomCode(rawCode) {
  const value = String(rawCode ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "")
    .slice(0, 24);
  return value || null;
}

const WORKER_FIXED_ROOM_CODE =
  sanitizeRoomCode(WORKER_ROOM_CODE_RAW) ?? `${ROOM_CODE_PREFIX}-WORKER`;

function createRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 24; attempt += 1) {
    let suffix = "";
    for (let i = 0; i < ROOM_CODE_RANDOM_LENGTH; i += 1) {
      suffix += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    const code = `${ROOM_CODE_PREFIX}-${suffix}`;
    if (!rooms.has(code)) {
      return code;
    }
  }
  return `${ROOM_CODE_PREFIX}-${Date.now().toString(36).toUpperCase()}`;
}

function createMatchRoom(requestedCode = null, persistent = false) {
  const normalized = sanitizeRoomCode(requestedCode);
  const code = normalized && !rooms.has(normalized) ? normalized : createRoomCode();
  const room = createRoom(code, persistent);
  rooms.set(room.code, room);
  return room;
}

function getRoom(code) {
  const normalized = sanitizeRoomCode(code);
  if (!normalized) {
    return null;
  }
  return rooms.get(normalized) ?? null;
}

function validateJoinTokenForWorker(token) {
  const verified = verifyRoomJoinToken(token, ROOM_JOIN_SECRET);
  if (!verified?.ok) {
    return verified;
  }

  const payload = verified.payload ?? {};
  const roomCode = sanitizeRoomCode(payload.roomCode ?? payload.room);
  if (!roomCode || roomCode !== WORKER_FIXED_ROOM_CODE) {
    return { ok: false, error: "token room mismatch" };
  }

  const exp = Number(payload.exp ?? 0);
  if (!Number.isFinite(exp) || exp <= 0) {
    return { ok: false, error: "token exp missing" };
  }
  if (Date.now() - ROOM_JOIN_TOKEN_LEEWAY_MS > exp) {
    return { ok: false, error: "token expired" };
  }

  return {
    ok: true,
    payload: {
      roomCode,
      name: sanitizeName(payload.name ?? payload.playerName ?? "PLAYER"),
      ownerClaim: payload.owner === true
    }
  };
}

function isRoomJoinable(room) {
  if (!room) {
    return false;
  }
  pruneRoomPlayers(room);
  return room.players.size < MAX_ROOM_PLAYERS;
}

function roomHasOwnerPresence(room) {
  if (!room?.players || room.players.size <= 0) {
    return false;
  }
  for (const player of room.players.values()) {
    if (player?.isOwner === true) {
      return true;
    }
  }
  return false;
}

function findJoinableRoom(preferredCode = null) {
  if (WORKER_SINGLE_ROOM_MODE) {
    const workerRoom =
      getRoom(WORKER_FIXED_ROOM_CODE) ?? createMatchRoom(WORKER_FIXED_ROOM_CODE, true);
    return isRoomJoinable(workerRoom) ? workerRoom : null;
  }

  const preferred = preferredCode ? getRoom(preferredCode) : null;
  if (preferred && isRoomJoinable(preferred)) {
    return preferred;
  }

  const candidates = [];
  for (const room of rooms.values()) {
    if (!room || room.players.size >= MAX_ROOM_PLAYERS) {
      continue;
    }
    candidates.push(room);
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => {
    const leftOwner = roomHasOwnerPresence(left) ? 1 : 0;
    const rightOwner = roomHasOwnerPresence(right) ? 1 : 0;
    if (leftOwner !== rightOwner) {
      return rightOwner - leftOwner;
    }
    const deltaPlayers = right.players.size - left.players.size;
    if (deltaPlayers !== 0) {
      return deltaPlayers;
    }
    return left.createdAt - right.createdAt;
  });

  return candidates[0];
}

if (WORKER_SINGLE_ROOM_MODE && !rooms.has(WORKER_FIXED_ROOM_CODE)) {
  createMatchRoom(WORKER_FIXED_ROOM_CODE, true);
}

function getRoomrace(room) {
  if (!room || typeof room !== "object") {
    return createraceState();
  }
  if (!room.race || typeof room.race !== "object") {
    room.race = createraceState();
  }
  return room.race;
}

function cloneraceConfig(rawConfig = null) {
  const source = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
  const normalizedSeatMode =
    String(source?.seatMode ?? TRACK_SEAT_DEFAULT_MODE).trim().toLowerCase() === "manual" &&
    TRACK_SEAT_ALLOW_MANUAL_OPTION
      ? "manual"
      : "auto";
  return {
    seatMode: normalizedSeatMode,
    endPolicy: {
      autoFinish: source?.endPolicy?.autoFinish !== false,
      showOppositeBillboard: source?.endPolicy?.showOppositeBillboard !== false
    }
  };
}

function trimRoomraceConfigCache() {
  while (roomraceConfigCache.size > ROOM_race_CONFIG_CACHE_LIMIT) {
    const oldestKey = roomraceConfigCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    roomraceConfigCache.delete(oldestKey);
  }
}

function rememberRoomraceConfig(room) {
  if (!room || typeof room !== "object") {
    return;
  }
  const code = sanitizeRoomCode(room.code);
  const snapshot = cloneraceConfig(room.raceConfig);
  if (code) {
    roomraceConfigCache.set(code, snapshot);
    trimRoomraceConfigCache();
  }
  latestraceConfigSnapshot = snapshot;
}

function resolveCachedraceConfigForRoom(roomCode) {
  const code = sanitizeRoomCode(roomCode);
  if (code && roomraceConfigCache.has(code)) {
    return cloneraceConfig(roomraceConfigCache.get(code));
  }
  if (
    latestraceConfigSnapshot &&
    (WORKER_SINGLE_ROOM_MODE || ROOM_OWNER_KEY || roomraceConfigCache.size <= 1)
  ) {
    return cloneraceConfig(latestraceConfigSnapshot);
  }
  return null;
}

function applyCachedraceConfigToRoom(room) {
  if (!room || typeof room !== "object") {
    return;
  }
  const cached = resolveCachedraceConfigForRoom(room.code);
  if (!cached) {
    return;
  }
  room.raceConfig = cached;
}

function ensureRoomraceConfig(room) {
  if (!room || typeof room !== "object") {
    return {
      seatMode: TRACK_SEAT_DEFAULT_MODE,
      endPolicy: { autoFinish: true, showOppositeBillboard: true }
    };
  }
  if (!room.raceConfig || typeof room.raceConfig !== "object") {
    room.raceConfig = {
      seatMode: TRACK_SEAT_DEFAULT_MODE,
      endPolicy: { autoFinish: true, showOppositeBillboard: true }
    };
  }
  if (!room.raceConfig.endPolicy || typeof room.raceConfig.endPolicy !== "object") {
    room.raceConfig.endPolicy = { autoFinish: true, showOppositeBillboard: true };
  }
  room.raceConfig.endPolicy.autoFinish = room.raceConfig.endPolicy.autoFinish !== false;
  room.raceConfig.endPolicy.showOppositeBillboard =
    room.raceConfig.endPolicy.showOppositeBillboard !== false;
  const mode =
    String(room.raceConfig?.seatMode ?? TRACK_SEAT_DEFAULT_MODE).trim().toLowerCase() === "manual" &&
    TRACK_SEAT_ALLOW_MANUAL_OPTION
      ? "manual"
      : "auto";
  room.raceConfig.seatMode = mode;
  return room.raceConfig;
}

function ensureRoomEntryGate(room) {
  if (!room || typeof room !== "object") {
    return {
      portalOpen: false,
      openedAt: 0,
      lastAdmissionAt: 0,
      admissionStartsAt: 0,
      admissionTimer: null,
      pendingAdmissionIds: [],
      nextPriorityIds: []
    };
  }
  if (!room.entryGate || typeof room.entryGate !== "object") {
    room.entryGate = {
      portalOpen: false,
      openedAt: 0,
      lastAdmissionAt: 0,
      admissionStartsAt: 0,
      admissionTimer: null,
      pendingAdmissionIds: [],
      nextPriorityIds: []
    };
  }
  room.entryGate.portalOpen = room.entryGate.portalOpen === true;
  room.entryGate.openedAt = Math.max(0, Math.trunc(Number(room.entryGate.openedAt) || 0));
  room.entryGate.lastAdmissionAt = Math.max(
    0,
    Math.trunc(Number(room.entryGate.lastAdmissionAt) || 0)
  );
  room.entryGate.admissionStartsAt = Math.max(
    0,
    Math.trunc(Number(room.entryGate.admissionStartsAt) || 0)
  );
  room.entryGate.pendingAdmissionIds = normalizeEntryGateQueueIds(
    room,
    room.entryGate.pendingAdmissionIds
  );
  room.entryGate.nextPriorityIds = normalizeEntryGateQueueIds(room, room.entryGate.nextPriorityIds);
  return room.entryGate;
}

function normalizeEntryGateQueueIds(room, rawIds) {
  const ids = Array.isArray(rawIds) ? rawIds : [];
  if (!room?.players || room.players.size <= 0) {
    return [];
  }
  const next = [];
  const seen = new Set();
  for (const rawId of ids) {
    const id = String(rawId ?? "");
    if (!id || seen.has(id)) {
      continue;
    }
    const player = room.players.get(id);
    if (!player || isPlayerHostController(room, player)) {
      continue;
    }
    seen.add(id);
    next.push(id);
  }
  return next;
}

function addNextPriorityPlayer(room, socketId) {
  if (!room || !socketId) {
    return;
  }
  const gate = ensureRoomEntryGate(room);
  const id = String(socketId ?? "");
  const player = room.players.get(id);
  if (!player || isPlayerHostController(room, player)) {
    return;
  }
  if (!Array.isArray(gate.nextPriorityIds)) {
    gate.nextPriorityIds = [];
  }
  if (!gate.nextPriorityIds.includes(id)) {
    gate.nextPriorityIds.push(id);
  }
}

function removeNextPriorityPlayer(room, socketId) {
  if (!room || !socketId) {
    return;
  }
  const gate = ensureRoomEntryGate(room);
  const id = String(socketId ?? "");
  if (!Array.isArray(gate.nextPriorityIds) || !id) {
    return;
  }
  gate.nextPriorityIds = gate.nextPriorityIds.filter((entryId) => entryId !== id);
}

function clearEntryAdmissionTimer(room) {
  const gate = ensureRoomEntryGate(room);
  if (gate.admissionTimer) {
    clearTimeout(gate.admissionTimer);
    gate.admissionTimer = null;
  }
  gate.admissionStartsAt = 0;
  gate.pendingAdmissionIds = [];
}

function sanitizeName(raw) {
  const value = String(raw ?? "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 16);
  return value || "PLAYER";
}

function sanitizePortalTargetUrl(raw) {
  const value = String(raw ?? "").trim();
  if (!value) {
    return "";
  }
  try {
    const target = new URL(value);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return "";
    }
    return target.toString();
  } catch {
    return "";
  }
}

function sanitizeBillboardMediaUrl(raw) {
  const value = String(raw ?? "")
    .trim()
    .slice(0, BILLBOARD_MEDIA_URL_MAX_LENGTH);
  if (!value) {
    return "";
  }
  if (value.startsWith("/")) {
    return value;
  }
  try {
    const target = new URL(value);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return "";
    }
    return target.toString().slice(0, BILLBOARD_MEDIA_URL_MAX_LENGTH);
  } catch {
    return "";
  }
}

function inferBillboardVisualTypeFromUrl(rawUrl) {
  const url = String(rawUrl ?? "").trim().toLowerCase();
  if (!url) {
    return "none";
  }
  if (/\.(mp4|webm|mov|m4v)(\?.*)?$/.test(url)) {
    return "video";
  }
  if (/\.(png|jpe?g|webp|gif|bmp|svg)(\?.*)?$/.test(url)) {
    return "image";
  }
  return "none";
}

function createDefaultBillboardMediaEntry() {
  return {
    visualType: "none",
    visualUrl: "",
    audioUrl: "",
    playlist: [],
    playlistIndex: 0,
    playlistEnabled: false,
    playlistAutoAdvance: true,
    playlistPlaying: true
  };
}

function createDefaultBillboardMediaState() {
  return {
    board1: createDefaultBillboardMediaEntry(),
    board2: createDefaultBillboardMediaEntry()
  };
}

function sanitizeBillboardPlaylistItem(rawItem = {}, fallbackItem = null) {
  const fallback =
    fallbackItem && typeof fallbackItem === "object"
      ? fallbackItem
      : { visualType: "video", visualUrl: "", audioUrl: "" };
  const entry =
    typeof rawItem === "string"
      ? { visualType: "video", visualUrl: rawItem, audioUrl: "" }
      : rawItem && typeof rawItem === "object"
        ? rawItem
        : {};
  const visualUrl = sanitizeBillboardMediaUrl(entry.visualUrl ?? entry.url ?? fallback.visualUrl ?? "");
  if (!visualUrl) {
    return { visualType: "none", visualUrl: "", audioUrl: "" };
  }
  const requestedType = String(entry.visualType ?? entry.type ?? fallback.visualType ?? "video")
    .trim()
    .toLowerCase();
  const inferredType = inferBillboardVisualTypeFromUrl(visualUrl);
  const visualType =
    requestedType === "video" || requestedType === "image"
      ? requestedType
      : inferredType === "video" || inferredType === "image"
        ? inferredType
        : "video";
  const audioUrl = sanitizeBillboardMediaUrl(entry.audioUrl ?? entry.audio ?? fallback.audioUrl ?? "");
  return { visualType, visualUrl, audioUrl };
}

function sanitizeBillboardPlaylist(rawPlaylist = [], fallbackPlaylist = []) {
  const source = Array.isArray(rawPlaylist) ? rawPlaylist : [];
  const fallback = Array.isArray(fallbackPlaylist) ? fallbackPlaylist : [];
  const next = [];
  for (let index = 0; index < source.length; index += 1) {
    if (next.length >= BILLBOARD_PLAYLIST_MAX_ITEMS) {
      break;
    }
    const item = sanitizeBillboardPlaylistItem(source[index], fallback[index]);
    if (!item.visualUrl || item.visualType === "none") {
      continue;
    }
    next.push(item);
  }
  return next;
}

function sanitizeBillboardMediaEntry(rawEntry = {}, fallbackEntry = null, options = {}) {
  const allowPlaylist = options?.allowPlaylist === true;
  const fallback =
    fallbackEntry && typeof fallbackEntry === "object"
      ? fallbackEntry
      : createDefaultBillboardMediaEntry();
  const entry = rawEntry && typeof rawEntry === "object" ? rawEntry : {};
  const requestedType = String(entry.visualType ?? entry.type ?? fallback.visualType ?? "none")
    .trim()
    .toLowerCase();
  const visualType = BILLBOARD_MEDIA_VISUAL_TYPES.has(requestedType)
    ? requestedType
    : String(fallback.visualType ?? "none");
  const visualUrl = sanitizeBillboardMediaUrl(entry.visualUrl ?? entry.url ?? fallback.visualUrl ?? "");
  const audioUrl = sanitizeBillboardMediaUrl(entry.audioUrl ?? entry.audio ?? fallback.audioUrl ?? "");
  const fallbackPlaylist = allowPlaylist ? sanitizeBillboardPlaylist(fallback.playlist ?? []) : [];
  const playlist = allowPlaylist
    ? sanitizeBillboardPlaylist(entry.playlist ?? fallbackPlaylist, fallbackPlaylist)
    : [];
  const rawPlaylistIndex = Number(entry.playlistIndex ?? entry.index ?? fallback.playlistIndex ?? 0);
  let playlistIndex = Number.isFinite(rawPlaylistIndex) ? Math.trunc(rawPlaylistIndex) : 0;
  if (playlist.length > 0) {
    playlistIndex = ((playlistIndex % playlist.length) + playlist.length) % playlist.length;
  } else {
    playlistIndex = 0;
  }
  const playlistEnabled =
    allowPlaylist &&
    (entry.playlistEnabled ?? fallback.playlistEnabled ?? false) === true &&
    playlist.length > 0;
  const playlistAutoAdvance = allowPlaylist
    ? (entry.playlistAutoAdvance ?? fallback.playlistAutoAdvance ?? true) !== false
    : true;
  const playlistPlaying = allowPlaylist
    ? (entry.playlistPlaying ?? fallback.playlistPlaying ?? true) !== false
    : true;
  if (playlistEnabled && playlist.length > 0) {
    const active = playlist[playlistIndex] ?? { visualType: "none", visualUrl: "", audioUrl: "" };
    return {
      visualType: active.visualType,
      visualUrl: active.visualUrl,
      audioUrl: active.audioUrl,
      playlist,
      playlistIndex,
      playlistEnabled: true,
      playlistAutoAdvance,
      playlistPlaying
    };
  }
  if (visualType === "none") {
    return {
      visualType: "none",
      visualUrl: "",
      audioUrl,
      playlist,
      playlistIndex,
      playlistEnabled: false,
      playlistAutoAdvance,
      playlistPlaying
    };
  }
  if (!visualUrl) {
    return {
      visualType: "none",
      visualUrl: "",
      audioUrl,
      playlist,
      playlistIndex,
      playlistEnabled: false,
      playlistAutoAdvance,
      playlistPlaying
    };
  }
  return {
    visualType,
    visualUrl,
    audioUrl,
    playlist,
    playlistIndex,
    playlistEnabled: false,
    playlistAutoAdvance,
    playlistPlaying
  };
}

function sanitizeBillboardMediaEntryForBoard(boardKey, rawEntry = {}, fallbackEntry = null) {
  return sanitizeBillboardMediaEntry(rawEntry, fallbackEntry, {
    allowPlaylist: String(boardKey ?? "").trim().toLowerCase() === "board2"
  });
}

function ensureRoomBillboardMedia(room) {
  if (!room || typeof room !== "object") {
    return createDefaultBillboardMediaState();
  }
  if (!room.billboardMedia || typeof room.billboardMedia !== "object") {
    room.billboardMedia = createDefaultBillboardMediaState();
  }
  room.billboardMedia.board1 = sanitizeBillboardMediaEntryForBoard("board1", room.billboardMedia.board1);
  room.billboardMedia.board2 = sanitizeBillboardMediaEntryForBoard("board2", room.billboardMedia.board2);
  return room.billboardMedia;
}

function sanitizeRoomBillboardMediaPayload(payload = {}, current = null) {
  const baseState =
    current && typeof current === "object"
      ? {
          board1: sanitizeBillboardMediaEntryForBoard("board1", current.board1),
          board2: sanitizeBillboardMediaEntryForBoard("board2", current.board2)
        }
      : createDefaultBillboardMediaState();
  const source = payload && typeof payload === "object" ? payload : {};
  const target = String(source.target ?? source.board ?? "").trim().toLowerCase();
  if (target) {
    if (target !== "board1" && target !== "board2") {
      return { ok: false, error: "invalid billboard target", media: baseState };
    }
    const next = {
      board1: sanitizeBillboardMediaEntryForBoard("board1", baseState.board1),
      board2: sanitizeBillboardMediaEntryForBoard("board2", baseState.board2)
    };
    next[target] = sanitizeBillboardMediaEntryForBoard(
      target,
      source.media ?? source.value ?? source,
      baseState[target]
    );
    return { ok: true, media: next };
  }
  const next = {
    board1: sanitizeBillboardMediaEntryForBoard("board1", source.board1 ?? baseState.board1, baseState.board1),
    board2: sanitizeBillboardMediaEntryForBoard("board2", source.board2 ?? baseState.board2, baseState.board2)
  };
  return { ok: true, media: next };
}

function hasOwnerAccess(ownerKeyRaw) {
  if (!ROOM_OWNER_KEY) {
    return false;
  }
  return String(ownerKeyRaw ?? "").trim() === ROOM_OWNER_KEY;
}

function applySocketOwnerAccess(socket, ownerKeyRaw) {
  if (!socket || typeof socket !== "object") {
    return false;
  }
  if (socket.data?.ownerClaim === true) {
    return true;
  }
  if (hasOwnerAccess(ownerKeyRaw)) {
    socket.data.ownerClaim = true;
    return true;
  }
  return false;
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, num));
}

function sanitizePlayerState(raw = {}) {
  return {
    x: clampNumber(raw.x, -512, 512, 0),
    y: clampNumber(raw.y, 0, 128, 1.75),
    z: clampNumber(raw.z, -512, 512, 0),
    yaw: clampNumber(raw.yaw, -Math.PI, Math.PI, 0),
    pitch: clampNumber(raw.pitch, -1.55, 1.55, 0),
    updatedAt: Date.now()
  };
}

function normalizeTrackProgress(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  const mod = numeric % 1;
  return mod < 0 ? mod + 1 : mod;
}

function wrappedProgressDelta(previousProgress, nextProgress) {
  const previous = normalizeTrackProgress(previousProgress);
  const next = normalizeTrackProgress(nextProgress);
  const direct = Math.abs(next - previous);
  return Math.min(direct, Math.abs(1 - direct));
}

function projectStateToTrackProgress(state = {}) {
  if (!TRACK_PROGRESS_READY) {
    return {
      progress: 0,
      distance: Number.POSITIVE_INFINITY,
      segmentIndex: 0,
      distanceAlong: 0
    };
  }
  return projectPointToCenterlineProgress(
    {
      x: Number(state?.x) || 0,
      y: 0,
      z: Number(state?.z) || 0
    },
    TRACK_CENTERLINE_METRICS
  );
}

function resolveNextTrackCheckpointIndex(progress) {
  if (!Array.isArray(TRACK_CHECKPOINT_PROGRESS_VALUES) || TRACK_CHECKPOINT_PROGRESS_VALUES.length <= 0) {
    return 0;
  }
  const normalized = normalizeTrackProgress(progress);
  for (let index = 0; index < TRACK_CHECKPOINT_PROGRESS_VALUES.length; index += 1) {
    const checkpoint = Number(TRACK_CHECKPOINT_PROGRESS_VALUES[index]);
    if (!Number.isFinite(checkpoint)) {
      continue;
    }
    if (normalized + 1e-9 < checkpoint) {
      return index;
    }
  }
  return 0;
}

function getCheckpointCount() {
  return Array.isArray(TRACK_CHECKPOINT_PROGRESS_VALUES) ? TRACK_CHECKPOINT_PROGRESS_VALUES.length : 0;
}

function normalizeCheckpointIndex(rawIndex) {
  const count = getCheckpointCount();
  if (count <= 0) {
    return 0;
  }
  const index = Math.trunc(Number(rawIndex) || 0);
  const mod = index % count;
  return mod < 0 ? mod + count : mod;
}

function resolveCheckpointProgressByIndex(rawIndex) {
  const count = getCheckpointCount();
  if (count <= 0) {
    return 0;
  }
  const checkpoint = Number(TRACK_CHECKPOINT_PROGRESS_VALUES[normalizeCheckpointIndex(rawIndex)]);
  return normalizeTrackProgress(Number.isFinite(checkpoint) ? checkpoint : 0);
}

function resolvePreviousCheckpointIndex(nextCheckpointIndex) {
  const count = getCheckpointCount();
  if (count <= 0) {
    return 0;
  }
  return normalizeCheckpointIndex(nextCheckpointIndex - 1);
}

function resolveCheckpointAnchorFromProgress(progress) {
  const nextIndex = resolveNextTrackCheckpointIndex(progress);
  const checkpointIndex = resolvePreviousCheckpointIndex(nextIndex);
  return {
    checkpointIndex,
    checkpointProgress: resolveCheckpointProgressByIndex(checkpointIndex)
  };
}

function sampleCenterlineAtProgress(progress, lateralOffset = 0) {
  if (!TRACK_PROGRESS_READY) {
    return {
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      segmentIndex: 0
    };
  }
  const normalized = normalizeTrackProgress(progress);
  const totalLength = Math.max(1e-6, Number(TRACK_CENTERLINE_METRICS?.totalLength) || 0);
  const points = Array.isArray(TRACK_CENTERLINE_METRICS?.points) ? TRACK_CENTERLINE_METRICS.points : [];
  const segmentLengths = Array.isArray(TRACK_CENTERLINE_METRICS?.segmentLengths)
    ? TRACK_CENTERLINE_METRICS.segmentLengths
    : [];
  const cumulative = Array.isArray(TRACK_CENTERLINE_METRICS?.cumulative)
    ? TRACK_CENTERLINE_METRICS.cumulative
    : [0];
  if (points.length < 2 || segmentLengths.length <= 0 || cumulative.length <= 1) {
    return {
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      segmentIndex: 0
    };
  }
  const distanceAlong = normalized * totalLength;
  let segmentIndex = 0;
  while (
    segmentIndex < segmentLengths.length - 1 &&
    Number(cumulative[segmentIndex + 1] || 0) < distanceAlong
  ) {
    segmentIndex += 1;
  }
  const start = points[segmentIndex];
  const end = points[segmentIndex + 1] ?? start;
  const segmentLength = Math.max(1e-6, Number(segmentLengths[segmentIndex]) || 1);
  const segmentStartDistance = Number(cumulative[segmentIndex] || 0);
  const localT = Math.max(0, Math.min(1, (distanceAlong - segmentStartDistance) / segmentLength));
  const forwardX = Number(end?.x || 0) - Number(start?.x || 0);
  const forwardZ = Number(end?.z || 0) - Number(start?.z || 0);
  const forwardLength = Math.max(1e-6, Math.hypot(forwardX, forwardZ));
  const tangentX = forwardX / forwardLength;
  const tangentZ = forwardZ / forwardLength;
  const rightX = tangentZ;
  const rightZ = -tangentX;
  const baseX = Number(start?.x || 0) + forwardX * localT;
  const baseZ = Number(start?.z || 0) + forwardZ * localT;
  return {
    x: Number((baseX + rightX * Number(lateralOffset || 0)).toFixed(3)),
    y: Number(start?.y || 0),
    z: Number((baseZ + rightZ * Number(lateralOffset || 0)).toFixed(3)),
    yaw: Math.atan2(tangentX, tangentZ),
    segmentIndex
  };
}

function buildTrackPenaltyRespawnState(progressState, reason = "track-anti-cheat") {
  const fallbackProgress = normalizeTrackProgress(progressState?.progress);
  const anchorProgress = Number.isFinite(Number(progressState?.lastCheckpointProgress))
    ? normalizeTrackProgress(progressState.lastCheckpointProgress)
    : fallbackProgress;
  const respawnProgress = normalizeTrackProgress(anchorProgress - TRACK_RESPAWN_BACKTRACK_PROGRESS);
  const sampled = sampleCenterlineAtProgress(respawnProgress, TRACK_RESPAWN_LATERAL_OFFSET);
  const yaw = Number.isFinite(Number(sampled?.yaw)) ? Number(sampled.yaw) : 0;
  return sanitizePlayerState({
    x: Number(sampled?.x) || 0,
    y: ADMISSION_SPAWN_Y,
    z: Number(sampled?.z) || 0,
    yaw,
    pitch: -0.03,
    reason
  });
}

function createPlayerTrackProgressState(seed = {}) {
  const base = createProgressState(seed);
  const progress = normalizeTrackProgress(seed?.progress ?? base.lastProgress);
  const checkpointAnchor = resolveCheckpointAnchorFromProgress(progress);
  const lastCheckpointIndex = Number.isFinite(Number(seed?.lastCheckpointIndex))
    ? normalizeCheckpointIndex(seed.lastCheckpointIndex)
    : checkpointAnchor.checkpointIndex;
  const lastCheckpointProgress = Number.isFinite(Number(seed?.lastCheckpointProgress))
    ? normalizeTrackProgress(seed.lastCheckpointProgress)
    : checkpointAnchor.checkpointProgress;
  return {
    lap: Math.max(0, Math.trunc(Number(seed?.lap ?? base.lap) || 0)),
    lastProgress: progress,
    progress,
    unwrappedProgress: Number(seed?.unwrappedProgress ?? base.unwrappedProgress) || 0,
    nextCheckpointIndex: Math.max(
      0,
      Math.trunc(Number(seed?.nextCheckpointIndex ?? base.nextCheckpointIndex) || 0)
    ),
    distanceToCenterline: Math.max(0, Number(seed?.distanceToCenterline) || 0),
    segmentIndex: Math.max(0, Math.trunc(Number(seed?.segmentIndex) || 0)),
    offTrack: seed?.offTrack === true,
    updatedAt: Math.max(0, Math.trunc(Number(seed?.updatedAt) || 0)),
    lastSelfEmitAt: Math.max(0, Math.trunc(Number(seed?.lastSelfEmitAt) || 0)),
    lastRoomEmitAt: Math.max(0, Math.trunc(Number(seed?.lastRoomEmitAt) || 0)),
    lastSelfEmitProgress: normalizeTrackProgress(seed?.lastSelfEmitProgress ?? progress),
    lastRoomEmitProgress: normalizeTrackProgress(seed?.lastRoomEmitProgress ?? progress),
    lastWrongWayAt: Math.max(0, Math.trunc(Number(seed?.lastWrongWayAt) || 0)),
    lastCuttingAt: Math.max(0, Math.trunc(Number(seed?.lastCuttingAt) || 0)),
    lastCheckpointIndex,
    lastCheckpointProgress,
    lastCheckpointAt: Math.max(0, Math.trunc(Number(seed?.lastCheckpointAt) || 0)),
    antiCheatWrongWayStrikes: Math.max(0, Math.trunc(Number(seed?.antiCheatWrongWayStrikes) || 0)),
    antiCheatCuttingStrikes: Math.max(0, Math.trunc(Number(seed?.antiCheatCuttingStrikes) || 0)),
    lastPenaltyResetAt: Math.max(0, Math.trunc(Number(seed?.lastPenaltyResetAt) || 0)),
    lastPenaltyReason: String(seed?.lastPenaltyReason ?? "")
  };
}

function ensurePlayerTrackProgressState(player) {
  if (!player || typeof player !== "object") {
    return createPlayerTrackProgressState();
  }
  if (!player.trackProgress || typeof player.trackProgress !== "object") {
    const projected = projectStateToTrackProgress(player.state ?? {});
    player.trackProgress = createPlayerTrackProgressState({
      lap: 0,
      lastProgress: projected.progress,
      progress: projected.progress,
      unwrappedProgress: projected.progress,
      nextCheckpointIndex: resolveNextTrackCheckpointIndex(projected.progress),
      distanceToCenterline: projected.distance,
      segmentIndex: projected.segmentIndex,
      offTrack: projected.distance > TRACK_PROGRESS_MAX_DISTANCE,
      updatedAt: Date.now()
    });
  }
  return player.trackProgress;
}

function resetPlayerTrackProgressState(player, stateOverride = null, preserveLap = false) {
  if (!player || typeof player !== "object") {
    return createPlayerTrackProgressState();
  }
  const previous = ensurePlayerTrackProgressState(player);
  const nextState = stateOverride ?? player.state ?? sanitizePlayerState();
  const projected = projectStateToTrackProgress(nextState);
  const lap = preserveLap ? Math.max(0, Math.trunc(Number(previous?.lap) || 0)) : 0;
  const progress = normalizeTrackProgress(projected.progress);
  const checkpointAnchor = resolveCheckpointAnchorFromProgress(progress);
  const now = Date.now();
  player.trackProgress = createPlayerTrackProgressState({
    ...previous,
    lap,
    lastProgress: progress,
    progress,
    unwrappedProgress: lap + progress,
    nextCheckpointIndex: resolveNextTrackCheckpointIndex(progress),
    distanceToCenterline: projected.distance,
    segmentIndex: projected.segmentIndex,
    offTrack: projected.distance > TRACK_PROGRESS_MAX_DISTANCE,
    updatedAt: now,
    lastCheckpointIndex: checkpointAnchor.checkpointIndex,
    lastCheckpointProgress: checkpointAnchor.checkpointProgress,
    lastCheckpointAt: now,
    antiCheatWrongWayStrikes: 0,
    antiCheatCuttingStrikes: 0
  });
  return player.trackProgress;
}

function buildRaceProgressPayload(player, events = [], forwardDelta = 0) {
  const progressState = ensurePlayerTrackProgressState(player);
  const safeEvents = Array.isArray(events) ? events : [];
  return {
    id: player?.id ?? null,
    name: player?.name ?? "PLAYER",
    lap: Math.max(0, Math.trunc(Number(progressState?.lap) || 0)),
    progress: Number((normalizeTrackProgress(progressState?.progress)).toFixed(6)),
    nextCheckpointIndex: Math.max(0, Math.trunc(Number(progressState?.nextCheckpointIndex) || 0)),
    distanceToCenterline: Number((Math.max(0, Number(progressState?.distanceToCenterline) || 0)).toFixed(3)),
    segmentIndex: Math.max(0, Math.trunc(Number(progressState?.segmentIndex) || 0)),
    offTrack: progressState?.offTrack === true,
    forwardDelta: Number((Number(forwardDelta) || 0).toFixed(6)),
    events: safeEvents,
    updatedAt: Number(progressState?.updatedAt || Date.now())
  };
}

function maybeEmitPlayerRaceProgress(room, player, sourceSocket = null) {
  if (!TRACK_PROGRESS_READY || !room || !player) {
    return null;
  }
  if (player.admitted !== true || player.alive === false || isPlayerHostModerator(room, player)) {
    return null;
  }

  const progressState = ensurePlayerTrackProgressState(player);
  const race = getRoomrace(room);
  const raceActive = Boolean(race?.active);
  const projected = projectStateToTrackProgress(player.state ?? {});
  const previousOffTrack = progressState.offTrack === true;
  const offTrack = projected.distance > TRACK_PROGRESS_MAX_DISTANCE;
  const now = Date.now();

  let events = [];
  let forwardDelta = 0;

  if (!offTrack) {
    const judged = judgeProgressTransition(progressState, projected.progress, {
      track: ACTIVE_TRACK_BLUEPRINT
    });
    progressState.lap = Math.max(0, Math.trunc(Number(judged?.state?.lap) || 0));
    progressState.lastProgress = normalizeTrackProgress(judged?.state?.lastProgress);
    progressState.progress = progressState.lastProgress;
    progressState.unwrappedProgress = Number(judged?.state?.unwrappedProgress) || progressState.unwrappedProgress;
    progressState.nextCheckpointIndex = Math.max(
      0,
      Math.trunc(Number(judged?.state?.nextCheckpointIndex) || progressState.nextCheckpointIndex)
    );
    events = Array.isArray(judged?.events) ? judged.events : [];
    forwardDelta = Number(judged?.forwardDelta) || 0;
  } else {
    const nextProgress = normalizeTrackProgress(projected.progress);
    progressState.lastProgress = nextProgress;
    progressState.progress = nextProgress;
    progressState.nextCheckpointIndex = resolveNextTrackCheckpointIndex(nextProgress);
  }

  progressState.distanceToCenterline = Math.max(0, Number(projected.distance) || 0);
  progressState.segmentIndex = Math.max(0, Math.trunc(Number(projected.segmentIndex) || 0));
  progressState.offTrack = offTrack;
  progressState.updatedAt = now;

  const latestCheckpointEvent = events
    .filter((entry) => String(entry?.type ?? "") === "checkpoint")
    .at(-1);
  if (latestCheckpointEvent) {
    const checkpointIndex = normalizeCheckpointIndex(latestCheckpointEvent?.checkpointIndex ?? 0);
    progressState.lastCheckpointIndex = checkpointIndex;
    progressState.lastCheckpointProgress = resolveCheckpointProgressByIndex(checkpointIndex);
    progressState.lastCheckpointAt = now;
  }

  if (events.some((entry) => entry?.type === "wrong-way")) {
    progressState.lastWrongWayAt = now;
  }
  if (events.some((entry) => entry?.type === "possible-cutting")) {
    progressState.lastCuttingAt = now;
  }

  const strongWrongWay =
    events.some((entry) => String(entry?.type ?? "") === "wrong-way") &&
    Number(forwardDelta) <= -TRACK_ANTICHEAT_RESET_WRONG_WAY_DELTA;
  if (strongWrongWay) {
    progressState.antiCheatWrongWayStrikes = Math.max(
      0,
      Math.trunc(Number(progressState.antiCheatWrongWayStrikes) || 0)
    ) + 1;
  } else {
    progressState.antiCheatWrongWayStrikes = Math.max(
      0,
      Math.trunc(Number(progressState.antiCheatWrongWayStrikes) || 0) - 1
    );
  }
  const hasCuttingEvent = events.some((entry) => String(entry?.type ?? "") === "possible-cutting");
  if (hasCuttingEvent) {
    progressState.antiCheatCuttingStrikes = Math.max(
      0,
      Math.trunc(Number(progressState.antiCheatCuttingStrikes) || 0)
    ) + 1;
  } else {
    progressState.antiCheatCuttingStrikes = Math.max(
      0,
      Math.trunc(Number(progressState.antiCheatCuttingStrikes) || 0) - 1
    );
  }

  let antiCheatReason = "";
  if (TRACK_ANTICHEAT_ENABLED && raceActive) {
    if (Number(projected.distance) > TRACK_ANTICHEAT_MAX_DISTANCE) {
      antiCheatReason = "distance";
    } else if (
      strongWrongWay &&
      Number(progressState.antiCheatWrongWayStrikes) >= TRACK_ANTICHEAT_RESET_WRONG_WAY_STRIKES
    ) {
      antiCheatReason = "wrong-way";
    } else if (
      hasCuttingEvent &&
      Number(progressState.antiCheatCuttingStrikes) >= TRACK_ANTICHEAT_RESET_CUTTING_STRIKES
    ) {
      antiCheatReason = "cutting";
    }
  }

  if (antiCheatReason) {
    const resetEvent = applyTrackAntiCheatReset(room, player, progressState, antiCheatReason, sourceSocket);
    if (resetEvent) {
      const resetPayload = buildRaceProgressPayload(player, [
        {
          type: "anti-cheat-reset",
          reason: resetEvent.reason,
          at: resetEvent.at
        }
      ]);
      if (sourceSocket) {
        sourceSocket.emit("race:progress:self", resetPayload);
      }
      io.to(room.code).emit("race:progress", {
        ...resetPayload,
        room: room.code
      });
      const refreshed = ensurePlayerTrackProgressState(player);
      refreshed.lastSelfEmitAt = now;
      refreshed.lastRoomEmitAt = now;
      refreshed.lastSelfEmitProgress = resetPayload.progress;
      refreshed.lastRoomEmitProgress = resetPayload.progress;
      return resetPayload;
    }
  }

  const payload = buildRaceProgressPayload(player, events, forwardDelta);
  const roomDelta = wrappedProgressDelta(progressState.lastRoomEmitProgress, payload.progress);
  const selfDelta = wrappedProgressDelta(progressState.lastSelfEmitProgress, payload.progress);
  const offTrackChanged = previousOffTrack !== offTrack;
  const hasNotableEvent =
    offTrackChanged ||
    events.some((entry) =>
      ["checkpoint", "lap", "wrong-way", "possible-cutting"].includes(String(entry?.type ?? ""))
    );

  if (
    sourceSocket &&
    (hasNotableEvent ||
      selfDelta >= TRACK_PROGRESS_MIN_DELTA ||
      now - Number(progressState.lastSelfEmitAt || 0) >= TRACK_PROGRESS_SELF_EMIT_INTERVAL_MS)
  ) {
    sourceSocket.emit("race:progress:self", payload);
    progressState.lastSelfEmitAt = now;
    progressState.lastSelfEmitProgress = payload.progress;
  }

  if (
    hasNotableEvent ||
    (roomDelta >= TRACK_PROGRESS_MIN_DELTA &&
      now - Number(progressState.lastRoomEmitAt || 0) >= TRACK_PROGRESS_ROOM_EMIT_INTERVAL_MS)
  ) {
    io.to(room.code).emit("race:progress", {
      ...payload,
      room: room.code
    });
    progressState.lastRoomEmitAt = now;
    progressState.lastRoomEmitProgress = payload.progress;
  }

  if (events.length > 0) {
    for (const event of events) {
      if (String(event?.type ?? "") !== "lap") {
        continue;
      }
      io.to(room.code).emit("race:lap", {
        room: room.code,
        id: player.id,
        name: player.name,
        lap: Math.max(0, Math.trunc(Number(event?.lap) || progressState.lap || 0)),
        progress: payload.progress,
        at: now
      });
    }
  }

  return payload;
}

function createPlayerNetState(initialState = sanitizePlayerState()) {
  return {
    lastAcceptedAt: Date.now(),
    lastSeq: -1,
    warmupSyncs: 0,
    velocity: { x: 0, y: 0, z: 0 },
    rejectedMoves: 0,
    lastCorrectionAt: 0,
    state: {
      x: Number(initialState.x) || 0,
      y: Number(initialState.y) || 1.75,
      z: Number(initialState.z) || 0
    }
  };
}

function ensurePlayerNetState(player) {
  if (!player || typeof player !== "object") {
    return createPlayerNetState();
  }
  if (!player.net || typeof player.net !== "object") {
    player.net = createPlayerNetState(player.state);
  }
  return player.net;
}

function setPlayerAuthoritativeState(player, nextState = {}) {
  if (!player || typeof player !== "object") {
    return;
  }
  const merged = {
    ...(player.state ?? {}),
    ...nextState
  };
  const sanitized = sanitizePlayerState(merged);
  player.state = sanitized;
  const net = ensurePlayerNetState(player);
  net.state = {
    x: Number(sanitized.x) || 0,
    y: Number(sanitized.y) || ADMISSION_SPAWN_Y,
    z: Number(sanitized.z) || 0
  };
  net.velocity = { x: 0, y: 0, z: 0 };
  net.lastAcceptedAt = Date.now();
  net.warmupSyncs = 0;
  net.lastCorrectionAt = 0;
  if (TRACK_PROGRESS_READY) {
    resetPlayerTrackProgressState(player, sanitized, true);
  }
}

function buildAdmissionSpawnPoint(index, total) {
  const safeTotal = Math.max(1, Math.trunc(Number(total) || 1));
  const safeIndex = Math.max(0, Math.trunc(Number(index) || 0));
  const ring = Math.floor(safeIndex / ADMISSION_SPAWN_PER_RING);
  const slot = safeIndex % ADMISSION_SPAWN_PER_RING;
  const slotsInRing = Math.max(
    1,
    Math.min(ADMISSION_SPAWN_PER_RING, safeTotal - ring * ADMISSION_SPAWN_PER_RING)
  );
  const angle = (slot / slotsInRing) * Math.PI * 2;
  const radius = ADMISSION_SPAWN_RING_START + ring * ADMISSION_SPAWN_RING_STEP;
  return {
    x: Number((ADMISSION_SPAWN_CENTER_X + Math.cos(angle) * radius).toFixed(3)),
    y: ADMISSION_SPAWN_Y,
    z: Number((ADMISSION_SPAWN_CENTER_Z + Math.sin(angle) * radius).toFixed(3))
  };
}

function buildPortalArrivalSpawnPoint() {
  const x = Number((WORLD_PORTAL_CENTER_X - WORLD_PORTAL_EXIT_OFFSET_X).toFixed(3));
  const z = Number(WORLD_PORTAL_CENTER_Z.toFixed(3));
  const yawToArenaCenter = Math.atan2(0 - x, 0 - z);
  return sanitizePlayerState({
    x,
    y: ADMISSION_SPAWN_Y,
    z,
    yaw: yawToArenaCenter,
    pitch: -0.03
  });
}

function hashStringToUnit(rawValue = "") {
  const text = String(rawValue ?? "");
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash / 4294967295;
}

function buildraceSpectatorSpawnPoint(playerId = "") {
  const id = String(playerId ?? "");
  const angle = hashStringToUnit(id) * Math.PI * 2;
  const radiusMix = hashStringToUnit(`${id}:radius`);
  const radius =
    race_SPECTATOR_SPAWN_MIN_RADIUS +
    (race_SPECTATOR_SPAWN_MAX_RADIUS - race_SPECTATOR_SPAWN_MIN_RADIUS) * radiusMix;

  let x = race_SPECTATOR_SPAWN_CENTER_X + Math.cos(angle) * radius;
  let z = race_SPECTATOR_SPAWN_CENTER_Z + Math.sin(angle) * radius;
  const minSpectatorX = race_ARENA_MIN_X - race_SPECTATOR_ARENA_EXIT_PADDING;
  const maxSpectatorZ = race_ARENA_MIN_Z - race_SPECTATOR_ARENA_EXIT_PADDING;
  if (x > minSpectatorX) {
    x = minSpectatorX;
  }
  if (z > maxSpectatorZ) {
    z = maxSpectatorZ;
  }

  return sanitizePlayerState({
    x: Number(x.toFixed(3)),
    y: ADMISSION_SPAWN_Y,
    z: Number(z.toFixed(3)),
    yaw: Math.PI,
    pitch: -0.04
  });
}

function isInsideraceArena(state = {}) {
  const x = Number(state?.x);
  const z = Number(state?.z);
  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    return false;
  }
  return x >= race_ARENA_MIN_X && x <= race_ARENA_MAX_X && z >= race_ARENA_MIN_Z && z <= race_ARENA_MAX_Z;
}

function projectStateOutsideraceArena(state = {}) {
  const current = sanitizePlayerState(state);
  if (!isInsideraceArena(current)) {
    return { corrected: false, state: current };
  }

  const distanceLeft = Math.abs(current.x - race_ARENA_MIN_X);
  const distanceRight = Math.abs(race_ARENA_MAX_X - current.x);
  const distanceBack = Math.abs(current.z - race_ARENA_MIN_Z);
  const distanceFront = Math.abs(race_ARENA_MAX_Z - current.z);
  const minDistance = Math.min(distanceLeft, distanceRight, distanceBack, distanceFront);

  const next = {
    ...current
  };
  if (minDistance === distanceLeft) {
    next.x = race_ARENA_MIN_X - race_SPECTATOR_ARENA_EXIT_PADDING;
  } else if (minDistance === distanceRight) {
    next.x = race_ARENA_MAX_X + race_SPECTATOR_ARENA_EXIT_PADDING;
  } else if (minDistance === distanceBack) {
    next.z = race_ARENA_MIN_Z - race_SPECTATOR_ARENA_EXIT_PADDING;
  } else {
    next.z = race_ARENA_MAX_Z + race_SPECTATOR_ARENA_EXIT_PADDING;
  }
  next.y = ADMISSION_SPAWN_Y;
  return {
    corrected: true,
    state: sanitizePlayerState(next)
  };
}

function shouldEnforceTrackBoundary(room, player) {
  if (!TRACK_BOUNDARY?.enabled || TRACK_BOUNDARY?.useInvisibleWalls === false) {
    return false;
  }
  if (!room || !player) {
    return false;
  }
  const race = getRoomrace(room);
  if (!Boolean(race?.active)) {
    return false;
  }
  if (player?.admitted !== true || player?.alive === false) {
    return false;
  }
  if (isPlayerHostModerator(room, player)) {
    return false;
  }
  return true;
}

function projectStateInsideTrackBoundary(state = {}) {
  const current = sanitizePlayerState(state);
  if (!TRACK_BOUNDARY?.enabled) {
    return { corrected: false, state: current };
  }
  const margin = Math.max(0, Number(TRACK_BOUNDARY?.wallMargin) || 0);
  const minX = Number(TRACK_BOUNDARY?.minX) + margin;
  const maxX = Number(TRACK_BOUNDARY?.maxX) - margin;
  const minZ = Number(TRACK_BOUNDARY?.minZ) + margin;
  const maxZ = Number(TRACK_BOUNDARY?.maxZ) - margin;
  const next = {
    ...current,
    x: Math.max(Math.min(Number(current.x), Math.max(minX, maxX)), Math.min(minX, maxX)),
    z: Math.max(Math.min(Number(current.z), Math.max(minZ, maxZ)), Math.min(minZ, maxZ))
  };
  const corrected =
    Math.abs(Number(next.x) - Number(current.x)) > 1e-6 || Math.abs(Number(next.z) - Number(current.z)) > 1e-6;
  if (!corrected) {
    return { corrected: false, state: current };
  }
  return {
    corrected: true,
    state: sanitizePlayerState(next)
  };
}

function applyTrackAntiCheatReset(room, player, progressState, reason = "anti-cheat", sourceSocket = null) {
  if (!room || !player || !progressState) {
    return null;
  }
  const now = Date.now();
  if (now - Number(progressState.lastPenaltyResetAt || 0) < TRACK_ANTICHEAT_RESET_COOLDOWN_MS) {
    return null;
  }
  const targetState = buildTrackPenaltyRespawnState(progressState, reason);
  setPlayerAuthoritativeState(player, targetState);
  const refreshed = ensurePlayerTrackProgressState(player);
  refreshed.lastPenaltyResetAt = now;
  refreshed.lastPenaltyReason = String(reason ?? "anti-cheat");
  refreshed.antiCheatWrongWayStrikes = 0;
  refreshed.antiCheatCuttingStrikes = 0;
  const correctionSocket = sourceSocket ?? io?.sockets?.sockets?.get(player.id);
  if (correctionSocket) {
    correctionSocket.emit("player:correct", {
      state: player.state,
      reason: `track-anti-cheat:${String(reason ?? "reset")}`
    });
  }
  return {
    reason: String(reason ?? "anti-cheat"),
    at: now,
    progress: Number((normalizeTrackProgress(refreshed.progress)).toFixed(6))
  };
}

function isRestrictedFromraceArena(room, player) {
  if (!room || !player) {
    return false;
  }
  const race = getRoomrace(room);
  const raceActive = Boolean(race?.active);
  if (player.admitted !== true) {
    return true;
  }
  if (player.alive === false) {
    return true;
  }
  return raceActive && isPlayerHostModerator(room, player);
}

function relocatePlayerToSpectatorZone(room, player, reason = "spectator-zone") {
  if (!room || !player) {
    return false;
  }
  const current = sanitizePlayerState(player.state ?? {});
  const target = buildraceSpectatorSpawnPoint(player.id);
  const distance = Math.hypot(
    Number(target.x) - Number(current.x),
    Number(target.y) - Number(current.y),
    Number(target.z) - Number(current.z)
  );
  setPlayerAuthoritativeState(player, target);

  const targetSocket = io?.sockets?.sockets?.get(player.id);
  if (targetSocket && distance >= 0.05) {
    targetSocket.emit("player:correct", {
      state: player.state,
      reason
    });
  }
  return distance >= 0.05;
}

function normalizeVec3Magnitude(x, y, z, maxLength) {
  const length = Math.hypot(x, y, z);
  if (!Number.isFinite(length) || length <= maxLength || maxLength <= 0) {
    return { x, y, z, clamped: false };
  }
  const ratio = maxLength / length;
  return {
    x: x * ratio,
    y: y * ratio,
    z: z * ratio,
    clamped: true
  };
}

function applyAuthoritativeMovement(player, proposedState) {
  const net = ensurePlayerNetState(player);
  const now = Date.now();
  const previousState = player?.state ?? sanitizePlayerState();

  const elapsedMs = Math.max(1, now - Number(net.lastAcceptedAt || now));
  const warmupSyncs = Math.max(0, Math.trunc(Number(net.warmupSyncs) || 0));
  const warmupPhase = warmupSyncs < 3;
  const dtFloor = warmupPhase ? 0.35 : 1 / 60;
  const dt = Math.max(dtFloor, Math.min(0.3, elapsedMs / 1000));

  let dx = Number(proposedState.x) - Number(previousState.x);
  let dy = Number(proposedState.y) - Number(previousState.y);
  let dz = Number(proposedState.z) - Number(previousState.z);
  let clamped = false;

  const horizontalDistance = Math.hypot(dx, dz);
  const allowedHorizontalDistance =
    SERVER_MOVEMENT_MARGIN + SERVER_MAX_MOVE_SPEED * dt + 0.5 * SERVER_MAX_ACCELERATION * dt * dt;

  if (horizontalDistance > allowedHorizontalDistance) {
    const ratio = allowedHorizontalDistance / Math.max(horizontalDistance, 0.0001);
    dx *= ratio;
    dz *= ratio;
    clamped = true;
  }

  const allowedVerticalDistance = SERVER_MOVEMENT_MARGIN + SERVER_MAX_VERTICAL_SPEED * dt;
  if (Math.abs(dy) > allowedVerticalDistance) {
    dy = Math.sign(dy) * allowedVerticalDistance;
    clamped = true;
  }

  const constrained = normalizeVec3Magnitude(dx, dy, dz, SERVER_MAX_TELEPORT_DISTANCE);
  if (constrained.clamped) {
    dx = constrained.x;
    dy = constrained.y;
    dz = constrained.z;
    clamped = true;
  }

  const candidateVelocity = {
    x: dx / dt,
    y: dy / dt,
    z: dz / dt
  };

  const accelX = candidateVelocity.x - Number(net.velocity?.x || 0);
  const accelY = candidateVelocity.y - Number(net.velocity?.y || 0);
  const accelZ = candidateVelocity.z - Number(net.velocity?.z || 0);
  const accelMagnitude = Math.hypot(accelX, accelY, accelZ) / dt;
  const maxAllowedAccel = SERVER_MAX_ACCELERATION * 1.8;
  if (accelMagnitude > maxAllowedAccel) {
    const ratio = maxAllowedAccel / Math.max(accelMagnitude, 0.0001);
    candidateVelocity.x = Number(net.velocity?.x || 0) + accelX * ratio;
    candidateVelocity.y = Number(net.velocity?.y || 0) + accelY * ratio;
    candidateVelocity.z = Number(net.velocity?.z || 0) + accelZ * ratio;
    dx = candidateVelocity.x * dt;
    dy = candidateVelocity.y * dt;
    dz = candidateVelocity.z * dt;
    clamped = true;
  }

  const nextState = {
    x: Number((Number(previousState.x) + dx).toFixed(3)),
    y: Number(Math.max(0, Number(previousState.y) + dy).toFixed(3)),
    z: Number((Number(previousState.z) + dz).toFixed(3)),
    yaw: clampNumber(proposedState.yaw, -Math.PI, Math.PI, Number(previousState.yaw) || 0),
    pitch: clampNumber(proposedState.pitch, -1.55, 1.55, Number(previousState.pitch) || 0),
    updatedAt: now
  };

  net.lastAcceptedAt = now;
  net.warmupSyncs = warmupSyncs + 1;
  net.velocity = {
    x: (nextState.x - Number(previousState.x)) / dt,
    y: (nextState.y - Number(previousState.y)) / dt,
    z: (nextState.z - Number(previousState.z)) / dt
  };
  net.state = {
    x: nextState.x,
    y: nextState.y,
    z: nextState.z
  };
  net.rejectedMoves = clamped ? Number(net.rejectedMoves || 0) + 1 : Math.max(0, Number(net.rejectedMoves || 0) - 0.25);

  const correctionDistance = Math.hypot(
    nextState.x - Number(proposedState.x),
    nextState.y - Number(proposedState.y),
    nextState.z - Number(proposedState.z)
  );

  player.state = nextState;
  return {
    nextState,
    clamped,
    correctionDistance
  };
}

function quantizePosition(value) {
  return Math.round((Number(value) || 0) * DELTA_POS_SCALE);
}

function quantizeRotation(value) {
  return Math.round((Number(value) || 0) * DELTA_ROT_SCALE);
}

function getSocketDeltaCache(socket, roomCode) {
  if (!socket) {
    return null;
  }
  if (!socket.data.deltaCache || typeof socket.data.deltaCache !== "object") {
    socket.data.deltaCache = new Map();
  }
  if (!socket.data.deltaCache.has(roomCode)) {
    socket.data.deltaCache.set(roomCode, new Map());
  }
  return socket.data.deltaCache.get(roomCode);
}

function clearSocketDeltaCache(socket, roomCode = null) {
  if (!socket?.data?.deltaCache || typeof socket.data.deltaCache?.clear !== "function") {
    return;
  }
  if (!roomCode) {
    socket.data.deltaCache.clear();
    return;
  }
  socket.data.deltaCache.delete(roomCode);
}

function resolveAoiCadence(distanceSq) {
  if (distanceSq <= AOI_NEAR_RADIUS_SQ) {
    return AOI_NEAR_CADENCE;
  }
  if (distanceSq <= AOI_MID_RADIUS_SQ) {
    return AOI_MID_CADENCE;
  }
  if (distanceSq <= AOI_FAR_RADIUS_SQ) {
    return AOI_FAR_CADENCE;
  }
  return AOI_EDGE_CADENCE;
}

function toAoiBucketCoord(value) {
  return Math.floor((Number(value) || 0) / AOI_BUCKET_CELL_SIZE);
}

function toAoiBucketKey(cellX, cellZ) {
  return `${cellX}:${cellZ}`;
}

function buildPackedRemoteState(player, state = null) {
  const resolvedState = state ?? player?.state ?? {};
  return {
    id: player?.id ?? null,
    n: player?.name ?? "PLAYER",
    a: player?.alive === false ? 0 : 1,
    px: quantizePosition(resolvedState.x),
    py: quantizePosition(resolvedState.y),
    pz: quantizePosition(resolvedState.z),
    yaw: quantizeRotation(resolvedState.yaw),
    pitch: quantizeRotation(resolvedState.pitch)
  };
}

function emitRoomDeltaSnapshot(room) {
  if (!room || room.players.size <= 1) {
    return;
  }

  room.tick = Number(room.tick || 0) + 1;
  const players = Array.from(room.players.values());
  const activePlayerIds = new Set();
  const playerKinematics = new Map();
  const packedStates = new Map();
  const aoiBuckets = new Map();

  for (const player of players) {
    if (!player?.id) {
      continue;
    }
    const state = player.state ?? sanitizePlayerState();
    const px = Number(state?.x) || 0;
    const pz = Number(state?.z) || 0;
    const cellX = toAoiBucketCoord(px);
    const cellZ = toAoiBucketCoord(pz);
    activePlayerIds.add(player.id);
    playerKinematics.set(player.id, {
      state,
      x: px,
      z: pz,
      cellX,
      cellZ
    });
    packedStates.set(player.id, buildPackedRemoteState(player, state));
    const bucketKey = toAoiBucketKey(cellX, cellZ);
    let bucket = aoiBuckets.get(bucketKey);
    if (!bucket) {
      bucket = [];
      aoiBuckets.set(bucketKey, bucket);
    }
    bucket.push(player.id);
  }

  for (const receiver of players) {
    const socket = io?.sockets?.sockets?.get(receiver.id);
    if (!socket) {
      continue;
    }

    const cache = getSocketDeltaCache(socket, room.code);
    if (!cache) {
      continue;
    }

    const updates = [];
    const removals = [];
    const receiverKinematics = playerKinematics.get(receiver.id);
    if (!receiverKinematics) {
      continue;
    }
    const receiverX = Number(receiverKinematics?.x) || 0;
    const receiverZ = Number(receiverKinematics?.z) || 0;
    const candidateIds = new Set();

    for (let dz = -AOI_BUCKET_RANGE; dz <= AOI_BUCKET_RANGE; dz += 1) {
      for (let dx = -AOI_BUCKET_RANGE; dx <= AOI_BUCKET_RANGE; dx += 1) {
        const bucketKey = toAoiBucketKey(receiverKinematics.cellX + dx, receiverKinematics.cellZ + dz);
        const bucket = aoiBuckets.get(bucketKey);
        if (!bucket || bucket.length <= 0) {
          continue;
        }
        for (const remoteId of bucket) {
          if (remoteId !== receiver.id) {
            candidateIds.add(remoteId);
          }
        }
      }
    }

    for (const remoteId of candidateIds) {
      const remote = room.players.get(remoteId);
      if (!remote) {
        continue;
      }

      const remoteKinematics = playerKinematics.get(remote.id);
      const remoteX = Number(remoteKinematics?.x) || 0;
      const remoteZ = Number(remoteKinematics?.z) || 0;
      const dx = remoteX - receiverX;
      const dz = remoteZ - receiverZ;
      const distanceSq = dx * dx + dz * dz;
      if (distanceSq > AOI_FAR_RADIUS_SQ) {
        continue;
      }
      const cadence = resolveAoiCadence(distanceSq);

      const cached = cache.get(remote.id) ?? null;
      const isHeartbeatDue =
        cached && room.tick - Number(cached.lastTick || 0) >= SERVER_DELTA_HEARTBEAT_TICKS;
      if (cached && !isHeartbeatDue && cadence > 1 && room.tick % cadence !== 0) {
        continue;
      }

      const packed =
        packedStates.get(remote.id) ?? buildPackedRemoteState(remote, remoteKinematics?.state ?? sanitizePlayerState());
      const changed =
        !cached ||
        cached.px !== packed.px ||
        cached.py !== packed.py ||
        cached.pz !== packed.pz ||
        cached.yaw !== packed.yaw ||
        cached.pitch !== packed.pitch ||
        cached.n !== packed.n ||
        cached.a !== packed.a;

      if (!changed && !isHeartbeatDue) {
        continue;
      }

      const delta = { id: packed.id };
      if (!cached || cached.n !== packed.n) {
        delta.n = packed.n;
      }
      if (!cached || cached.a !== packed.a) {
        delta.a = packed.a;
      }
      if (!cached || cached.px !== packed.px || cached.py !== packed.py || cached.pz !== packed.pz) {
        delta.p = [packed.px, packed.py, packed.pz];
      }
      if (!cached || cached.yaw !== packed.yaw || cached.pitch !== packed.pitch) {
        delta.r = [packed.yaw, packed.pitch];
      }
      updates.push(delta);
      cache.set(remote.id, {
        id: packed.id,
        n: packed.n,
        a: packed.a,
        px: packed.px,
        py: packed.py,
        pz: packed.pz,
        yaw: packed.yaw,
        pitch: packed.pitch,
        lastTick: room.tick
      });
    }

    for (const cachedId of Array.from(cache.keys())) {
      if (!activePlayerIds.has(cachedId) || !candidateIds.has(cachedId)) {
        cache.delete(cachedId);
        removals.push(cachedId);
        continue;
      }
      const remoteKinematics = playerKinematics.get(cachedId);
      if (!remoteKinematics) {
        cache.delete(cachedId);
        removals.push(cachedId);
        continue;
      }
      const dx = Number(remoteKinematics.x) - receiverX;
      const dz = Number(remoteKinematics.z) - receiverZ;
      if (dx * dx + dz * dz > AOI_FAR_RADIUS_SQ) {
        cache.delete(cachedId);
        removals.push(cachedId);
      }
    }

    if (updates.length > 0 || removals.length > 0) {
      socket.emit("player:delta", {
        room: room.code,
        tick: room.tick,
        updates,
        removes: removals
      });
    }
  }
}

function tickRooms() {
  for (const room of rooms.values()) {
    pruneRoomPlayers(room);
    if (!room || room.players.size === 0) {
      continue;
    }
    emitRoomDeltaSnapshot(room);
  }
}

function initializePlayerForrace(player, resetScore = true) {
  if (!player || typeof player !== "object") {
    return;
  }

  if (resetScore) {
    player.score = 0;
  } else {
    player.score = Number.isFinite(Number(player.score)) ? Math.max(0, Math.trunc(Number(player.score))) : 0;
  }
  player.alive = true;
  player.lastChoice = null;
  player.lastChoiceReason = null;
  player.seatBoarded = false;
  player.assignedVehicleId = null;
  if (TRACK_PROGRESS_READY) {
    resetPlayerTrackProgressState(player, player.state, false);
  }
}

function isPlayerHostController(room, player) {
  if (!room || !player) {
    return false;
  }
  if (String(player.id ?? "") !== String(room.hostId ?? "")) {
    return false;
  }
  if (!ROOM_OWNER_KEY) {
    return true;
  }
  return player.isOwner === true;
}

function isPlayerHostModerator(room, player) {
  if (!isPlayerHostController(room, player)) {
    return false;
  }
  return player?.hostParticipating !== true;
}

function normalizeHostParticipationState(room) {
  if (!room?.players || room.players.size <= 0) {
    return;
  }
  for (const player of room.players.values()) {
    if (!player) {
      continue;
    }
    if (isPlayerHostController(room, player)) {
      player.hostParticipating = player.hostParticipating === true;
    } else {
      player.hostParticipating = false;
    }
  }
}

function countPlayablePlayers(room) {
  let count = 0;
  for (const player of room?.players?.values?.() ?? []) {
    if (!player) {
      continue;
    }
    if (isPlayerHostModerator(room, player)) {
      continue;
    }
    if (player.admitted !== true) {
      continue;
    }
    count += 1;
  }
  return count;
}

function countWaitingPlayers(room) {
  let count = 0;
  for (const player of room?.players?.values?.() ?? []) {
    if (!player) {
      continue;
    }
    if (isPlayerHostController(room, player)) {
      continue;
    }
    if (player.admitted === true) {
      continue;
    }
    if (player.awaitingAdmission !== true) {
      continue;
    }
    count += 1;
  }
  return count;
}

function collectWaitingPlayers(room) {
  const waiting = [];
  for (const player of room?.players?.values?.() ?? []) {
    if (!player) {
      continue;
    }
    if (isPlayerHostController(room, player)) {
      continue;
    }
    if (player.admitted === true) {
      continue;
    }
    if (player.awaitingAdmission !== true) {
      continue;
    }
    waiting.push(player);
  }
  return waiting;
}

function countSpectatorPlayers(room) {
  let count = 0;
  for (const player of room?.players?.values?.() ?? []) {
    if (!player) {
      continue;
    }
    if (isPlayerHostController(room, player)) {
      continue;
    }
    if (player.admitted === true) {
      continue;
    }
    if (player.awaitingAdmission === true) {
      continue;
    }
    count += 1;
  }
  return count;
}

function collectRaceParticipantIds(room, { includeWaiting = false } = {}) {
  const ids = [];
  for (const player of room?.players?.values?.() ?? []) {
    if (!player) {
      continue;
    }
    if (isPlayerHostModerator(room, player)) {
      continue;
    }
    if (player.admitted !== true && !includeWaiting) {
      continue;
    }
    const id = String(player.id ?? "").trim();
    if (!id) {
      continue;
    }
    ids.push(id);
    if (ids.length >= ENTRY_PARTICIPANT_LIMIT) {
      break;
    }
  }
  return ids;
}

function buildRoomRaceSessionDraft(room, { includeWaiting = false } = {}) {
  if (!room) {
    return createRaceSessionDraft({
      roomCode: "",
      participantIds: [],
      track: ACTIVE_TRACK_BLUEPRINT,
      maxParticipants: ENTRY_PARTICIPANT_LIMIT
    });
  }
  const raceConfig = ensureRoomraceConfig(room);
  return createRaceSessionDraft({
    roomCode: String(room?.code ?? ""),
    participantIds: collectRaceParticipantIds(room, { includeWaiting }),
    track: ACTIVE_TRACK_BLUEPRINT,
    maxParticipants: ENTRY_PARTICIPANT_LIMIT,
    seatMode: raceConfig?.seatMode ?? TRACK_SEAT_DEFAULT_MODE
  });
}

function clearRaceSeatTimer(race) {
  if (!race || typeof race !== "object") {
    return;
  }
  if (race.seatTimer) {
    clearTimeout(race.seatTimer);
    race.seatTimer = null;
  }
  race.seatScheduledAt = 0;
}

function buildSeatStateFromAssignment(assignment = {}) {
  const seatPosition =
    assignment?.seatPosition && typeof assignment.seatPosition === "object"
      ? assignment.seatPosition
      : assignment?.spawn ?? {};
  const headingRadians = Number(assignment?.headingRadians);
  return sanitizePlayerState({
    x: Number(seatPosition?.x) || 0,
    y: Number(seatPosition?.y) || ADMISSION_SPAWN_Y,
    z: Number(seatPosition?.z) || 0,
    yaw: Number.isFinite(headingRadians) ? headingRadians : 0,
    pitch: -0.03
  });
}

function emitSeatAssignmentToPlayer(socket, room, assignment, sessionDraft, extras = {}) {
  if (!socket || !room || !assignment || !sessionDraft) {
    return;
  }
  const seatAssignment = sessionDraft?.seatAssignment ?? {};
  const autoSeatAt = Math.max(0, Math.trunc(Number(extras?.autoSeatAt) || 0));
  socket.emit("race:seat:assigned", {
    room: String(room.code ?? ""),
    reason: String(extras?.reason ?? "seat-assignment"),
    mode: String(seatAssignment?.mode ?? "auto").toLowerCase() === "manual" ? "manual" : "auto",
    allowManualOption: seatAssignment?.allowManualOption !== false,
    autoSeatOnSpawn: seatAssignment?.autoSeatOnSpawn !== false,
    autoSeatDelaySeconds: Math.max(0, Number(seatAssignment?.autoSeatDelaySeconds) || 0),
    autoSeatReachRadius: Math.max(
      1.6,
      Number(seatAssignment?.autoSeatReachRadius) || RACE_SEAT_DEFAULTS.autoSeatReachRadius
    ),
    autoSeatAt,
    autoApplied: extras?.autoApplied === true,
    assignment: {
      playerId: String(assignment?.playerId ?? ""),
      vehicleId: String(assignment?.vehicleId ?? ""),
      seat: String(assignment?.seat ?? "driver"),
      slotIndex: Math.max(0, Math.trunc(Number(assignment?.slotIndex) || 0)),
      spawn: assignment?.spawn ?? null,
      seatPosition: assignment?.seatPosition ?? null,
      headingRadians: Number(assignment?.headingRadians) || 0
    }
  });
}

function resolvePlayerSeatAssignment(room, playerId, { includeWaiting = false } = {}) {
  if (!room || !playerId) {
    return { sessionDraft: null, assignment: null };
  }
  const sessionDraft = buildRoomRaceSessionDraft(room, { includeWaiting });
  const assignments = Array.isArray(sessionDraft?.seatAssignments) ? sessionDraft.seatAssignments : [];
  const targetId = String(playerId ?? "").trim();
  const assignment =
    assignments.find((item) => String(item?.playerId ?? "").trim() === targetId) ?? null;
  return { sessionDraft, assignment };
}

function areAllAssignedPlayersBoarded(room, sessionDraft) {
  if (!room || !sessionDraft) {
    return false;
  }
  const assignments = Array.isArray(sessionDraft?.seatAssignments) ? sessionDraft.seatAssignments : [];
  if (assignments.length <= 0) {
    return false;
  }
  for (const assignment of assignments) {
    const playerId = String(assignment?.playerId ?? "");
    if (!playerId) {
      continue;
    }
    const player = room.players.get(playerId);
    if (!player || player.admitted !== true || player.alive === false || isPlayerHostModerator(room, player)) {
      continue;
    }
    const vehicleId = String(assignment?.vehicleId ?? "");
    if (player.seatBoarded !== true || String(player.assignedVehicleId ?? "") !== vehicleId) {
      return false;
    }
  }
  return true;
}

function maybeAutoSeatPlayerOnReach(room, player, sourceSocket = null) {
  if (!room || !player || player.admitted !== true || player.alive === false || isPlayerHostModerator(room, player)) {
    return false;
  }
  const { sessionDraft, assignment } = resolvePlayerSeatAssignment(room, player.id, {
    includeWaiting: false
  });
  if (!sessionDraft || !assignment) {
    return false;
  }
  const seatAssignment = sessionDraft?.seatAssignment ?? {};
  const seatMode = String(seatAssignment?.mode ?? "auto").trim().toLowerCase() === "manual" ? "manual" : "auto";
  if (seatMode === "manual" || seatAssignment?.autoSeatOnReachVehicle === false) {
    return false;
  }
  const assignedVehicleId = String(assignment?.vehicleId ?? "");
  if (player.seatBoarded === true && String(player.assignedVehicleId ?? "") === assignedVehicleId) {
    return false;
  }
  const seatState = buildSeatStateFromAssignment(assignment);
  const currentState = sanitizePlayerState(player.state ?? {});
  const distance = Math.hypot(
    Number(seatState.x) - Number(currentState.x),
    Number(seatState.y) - Number(currentState.y),
    Number(seatState.z) - Number(currentState.z)
  );
  const reachRadius = Math.max(
    1.6,
    Number(seatAssignment?.autoSeatReachRadius) || RACE_SEAT_DEFAULTS.autoSeatReachRadius
  );
  if (distance > reachRadius) {
    return false;
  }

  setPlayerAuthoritativeState(player, seatState);
  player.seatBoarded = true;
  player.assignedVehicleId = assignedVehicleId;
  const targetSocket = sourceSocket ?? io?.sockets?.sockets?.get(player.id);
  if (targetSocket) {
    targetSocket.emit("player:correct", {
      state: player.state,
      reason: "race-auto-seat-reach"
    });
    emitSeatAssignmentToPlayer(targetSocket, room, assignment, sessionDraft, {
      reason: "auto-seat-reach",
      autoApplied: true,
      autoSeatAt: 0
    });
  }

  const race = getRoomrace(room);
  if (race?.seatTimer && areAllAssignedPlayersBoarded(room, sessionDraft)) {
    clearRaceSeatTimer(race);
  }
  emitRoomUpdate(room);
  return true;
}

function applyAutoSeatNow(room, reason = "auto-seat") {
  if (!room) {
    return 0;
  }
  const race = getRoomrace(room);
  clearRaceSeatTimer(race);
  const sessionDraft = buildRoomRaceSessionDraft(room, { includeWaiting: false });
  const assignments = Array.isArray(sessionDraft?.seatAssignments) ? sessionDraft.seatAssignments : [];
  if (assignments.length <= 0) {
    return 0;
  }
  let appliedCount = 0;
  for (const assignment of assignments) {
    const playerId = String(assignment?.playerId ?? "");
    if (!playerId) {
      continue;
    }
    const player = room.players.get(playerId);
    if (!player || player.admitted !== true || player.alive === false || isPlayerHostModerator(room, player)) {
      continue;
    }
    const assignedVehicleId = String(assignment?.vehicleId ?? "");
    if (player.seatBoarded === true && String(player.assignedVehicleId ?? "") === assignedVehicleId) {
      continue;
    }
    const seatState = buildSeatStateFromAssignment(assignment);
    setPlayerAuthoritativeState(player, seatState);
    player.assignedVehicleId = assignedVehicleId;
    player.seatBoarded = true;
    appliedCount += 1;
    const targetSocket = io?.sockets?.sockets?.get(playerId);
    if (targetSocket) {
      targetSocket.emit("player:correct", {
        state: player.state,
        reason: "race-auto-seat"
      });
      emitSeatAssignmentToPlayer(targetSocket, room, assignment, sessionDraft, {
        reason,
        autoApplied: true,
        autoSeatAt: 0
      });
    }
  }
  if (appliedCount > 0) {
    emitRoomUpdate(room);
  }
  return appliedCount;
}

function dispatchRoomSeatAssignments(room, reason = "seat-update") {
  if (!room) {
    return;
  }
  const race = getRoomrace(room);
  clearRaceSeatTimer(race);
  const sessionDraft = buildRoomRaceSessionDraft(room, { includeWaiting: false });
  const assignments = Array.isArray(sessionDraft?.seatAssignments) ? sessionDraft.seatAssignments : [];
  if (assignments.length <= 0) {
    return;
  }

  const seatAssignment = sessionDraft?.seatAssignment ?? {};
  const mode = String(seatAssignment?.mode ?? "auto").trim().toLowerCase() === "manual" ? "manual" : "auto";
  const autoSeatOnSpawn = mode !== "manual" && seatAssignment?.autoSeatOnSpawn !== false;
  const delayMs = autoSeatOnSpawn
    ? Math.max(0, Math.trunc((Number(seatAssignment?.autoSeatDelaySeconds) || 0) * 1000))
    : 0;
  const autoSeatAt = autoSeatOnSpawn ? Date.now() + delayMs : 0;

  for (const assignment of assignments) {
    const playerId = String(assignment?.playerId ?? "");
    if (!playerId) {
      continue;
    }
    const player = room.players.get(playerId);
    if (!player || player.admitted !== true || player.alive === false || isPlayerHostModerator(room, player)) {
      continue;
    }
    const assignedVehicleId = String(assignment?.vehicleId ?? "");
    if (String(player.assignedVehicleId ?? "") !== assignedVehicleId) {
      player.seatBoarded = false;
    }
    player.assignedVehicleId = assignedVehicleId;
    const socket = io?.sockets?.sockets?.get(playerId);
    if (!socket) {
      continue;
    }
    emitSeatAssignmentToPlayer(socket, room, assignment, sessionDraft, {
      reason,
      autoApplied: false,
      autoSeatAt
    });
  }

  if (!autoSeatOnSpawn) {
    return;
  }
  if (delayMs <= 0) {
    applyAutoSeatNow(room, reason);
    return;
  }

  race.seatScheduledAt = autoSeatAt;
  race.seatTimer = setTimeout(() => {
    race.seatTimer = null;
    race.seatScheduledAt = 0;
    const currentRoom = rooms.get(room.code);
    if (!currentRoom) {
      return;
    }
    applyAutoSeatNow(currentRoom, reason);
  }, delayMs);
  race.seatTimer.unref?.();
}

function openEntryGate(room) {
  if (!room) {
    return { ok: false, error: "room missing" };
  }
  const race = getRoomrace(room);
  if (race.active) {
    return { ok: false, error: "race already active" };
  }
  const gate = ensureRoomEntryGate(room);
  if (gate.admissionStartsAt > Date.now()) {
    return { ok: false, error: "admission already in progress" };
  }
  if (gate.portalOpen) {
    return { ok: false, error: "lobby already open" };
  }
  gate.portalOpen = true;
  gate.openedAt = Date.now();
  gate.admissionStartsAt = 0;
  gate.pendingAdmissionIds = [];

  for (const player of room.players.values()) {
    if (!player) {
      continue;
    }
    player.seatBoarded = false;
    player.assignedVehicleId = null;
    if (isPlayerHostController(room, player)) {
      player.admitted = true;
      player.awaitingAdmission = false;
      removeNextPriorityPlayer(room, player.id);
      continue;
    }
    player.admitted = false;
    player.awaitingAdmission = true;
    player.alive = false;
    player.lastChoice = null;
    player.lastChoiceReason = "spectator";
    relocatePlayerToSpectatorZone(room, player, "entry-waiting");
  }

  return {
    ok: true,
    waitingPlayers: countWaitingPlayers(room),
    spectatorPlayers: countSpectatorPlayers(room),
    participantLimit: ENTRY_PARTICIPANT_LIMIT,
    openedAt: gate.openedAt
  };
}

function startEntryAdmission(room) {
  if (!room) {
    return { ok: false, error: "room missing" };
  }
  const race = getRoomrace(room);
  if (race.active) {
    return { ok: false, error: "race already active" };
  }
  const gate = ensureRoomEntryGate(room);
  if (!gate.portalOpen) {
    return { ok: false, error: "lobby not open" };
  }
  if (gate.admissionStartsAt > Date.now()) {
    return { ok: false, error: "admission already in progress" };
  }

  const waitingPlayers = collectWaitingPlayers(room);
  if (waitingPlayers.length <= 0) {
    gate.portalOpen = false;
    gate.lastAdmissionAt = Date.now();
    return {
      ok: false,
      error: "no waiting players",
      waitingPlayers: 0,
      spectatorPlayers: countSpectatorPlayers(room),
      admittedPlayers: countPlayablePlayers(room)
    };
  }

  const waitingById = new Map(
    waitingPlayers.map((player) => [String(player?.id ?? ""), player]).filter(([id]) => Boolean(id))
  );
  const priorityIds = normalizeEntryGateQueueIds(room, gate.nextPriorityIds);
  const orderedWaiting = [];
  for (const id of priorityIds) {
    const player = waitingById.get(id);
    if (!player) {
      continue;
    }
    orderedWaiting.push(player);
    waitingById.delete(id);
  }
  const remainingWaiting = Array.from(waitingById.values()).sort((left, right) => {
    const leftJoinedAt = Math.max(0, Math.trunc(Number(left?.joinedAt) || 0));
    const rightJoinedAt = Math.max(0, Math.trunc(Number(right?.joinedAt) || 0));
    if (leftJoinedAt !== rightJoinedAt) {
      return leftJoinedAt - rightJoinedAt;
    }
    return String(left?.name ?? "").localeCompare(String(right?.name ?? ""), "ko");
  });
  orderedWaiting.push(...remainingWaiting);

  const admissionTargets = orderedWaiting.slice(0, ENTRY_PARTICIPANT_LIMIT);
  const overflowTargets = orderedWaiting.slice(ENTRY_PARTICIPANT_LIMIT);
  for (const player of overflowTargets) {
    player.admitted = false;
    player.awaitingAdmission = false;
    player.alive = false;
    player.lastChoice = null;
    player.lastChoiceReason = "spectator";
    relocatePlayerToSpectatorZone(room, player, "entry-overflow-spectator");
  }

  const countdownMs = 3000;
  gate.portalOpen = false;
  gate.admissionStartsAt = Date.now() + countdownMs;
  gate.pendingAdmissionIds = admissionTargets.map((player) => String(player?.id ?? "")).filter(Boolean);
  gate.nextPriorityIds = overflowTargets.map((player) => String(player?.id ?? "")).filter(Boolean);
  if (gate.admissionTimer) {
    clearTimeout(gate.admissionTimer);
    gate.admissionTimer = null;
  }
  gate.admissionTimer = setTimeout(() => {
    const currentRoom = rooms.get(room.code);
    if (!currentRoom) {
      return;
    }
    const currentGate = ensureRoomEntryGate(currentRoom);
    currentGate.admissionTimer = null;
    const ids = Array.isArray(currentGate.pendingAdmissionIds) ? currentGate.pendingAdmissionIds : [];
    const targets = ids
      .map((id) => currentRoom.players.get(String(id)))
      .filter(Boolean)
      .filter((player) => !isPlayerHostController(currentRoom, player));

    for (let index = 0; index < targets.length; index += 1) {
      const player = targets[index];
      const spawn = buildAdmissionSpawnPoint(index, targets.length);
      player.admitted = true;
      player.awaitingAdmission = false;
      player.alive = true;
      player.lastChoice = null;
      player.lastChoiceReason = "admitted";
      player.seatBoarded = false;
      player.assignedVehicleId = null;
      setPlayerAuthoritativeState(player, {
        x: spawn.x,
        y: spawn.y,
        z: spawn.z,
        yaw: 0,
        pitch: 0
      });
      const targetSocket = io.sockets.sockets.get(player.id);
      if (targetSocket) {
        targetSocket.emit("player:correct", {
          state: player.state,
          reason: "entry-admitted"
        });
      }
    }

    currentGate.lastAdmissionAt = Date.now();
    currentGate.admissionStartsAt = 0;
    currentGate.pendingAdmissionIds = [];
    currentGate.nextPriorityIds = normalizeEntryGateQueueIds(currentRoom, currentGate.nextPriorityIds);
    io.to(currentRoom.code).emit("portal:lobby-admitted", {
      admittedCount: targets.length,
      spectatorCount: countSpectatorPlayers(currentRoom),
      priorityPlayers: currentGate.nextPriorityIds.length,
      participantLimit: ENTRY_PARTICIPANT_LIMIT,
      at: currentGate.lastAdmissionAt
    });
    dispatchRoomSeatAssignments(currentRoom, "entry-admitted");
    emitRoomUpdate(currentRoom);
    emitraceScore(currentRoom, "lobby-admit");
  }, countdownMs);
  gate.admissionTimer.unref?.();

  gate.portalOpen = false;
  gate.lastAdmissionAt = 0;
  return {
    ok: true,
    waitingPlayers: countWaitingPlayers(room),
    admittedCount: admissionTargets.length,
    spectatorCount: overflowTargets.length,
    priorityPlayers: gate.nextPriorityIds.length,
    participantLimit: ENTRY_PARTICIPANT_LIMIT,
    admittedPlayers: countPlayablePlayers(room),
    startsAt: gate.admissionStartsAt,
    countdownMs
  };
}

function clearraceAutoStartTimer(race) {
  if (!race || typeof race !== "object") {
    return;
  }
  if (race.autoStartTimer) {
    clearTimeout(race.autoStartTimer);
    race.autoStartTimer = null;
  }
  race.autoStartsAt = 0;
}

function clearraceLockTimer(race) {
  if (!race || typeof race !== "object") {
    return;
  }
  clearraceAutoStartTimer(race);
  clearRaceSeatTimer(race);
  if (race.lockTimer) {
    clearTimeout(race.lockTimer);
    race.lockTimer = null;
  }
  if (race.nextTimer) {
    clearTimeout(race.nextTimer);
    race.nextTimer = null;
  }
  race.lockResolveAt = 0;
}

function resetraceState(room) {
  const race = getRoomrace(room);
  clearraceLockTimer(race);
  clearEntryAdmissionTimer(room);
  race.active = false;
  race.phase = "idle";
  race.autoMode = false;
  race.autoFinish = true;
  race.autoStartsAt = 0;
  race.hostId = room?.hostId ?? null;
  race.startedAt = 0;
  race.prepareEndsAt = 0;
  race.endedAt = 0;
  race.lockSeconds = race_DEFAULT_LOCK_SECONDS;
  race.lockAt = 0;
  race.lockResolveAt = 0;
}

function serializeRoom(room) {
  pruneRoomPlayers(room);
  const gate = ensureRoomEntryGate(room);
  const billboardMedia = ensureRoomBillboardMedia(room);
  const priorityQueue = normalizeEntryGateQueueIds(room, gate.nextPriorityIds);
  return {
    code: room.code,
    hostId: room.hostId,
    portalTargetUrl: sanitizePortalTargetUrl(room?.portalTargetUrl ?? ""),
    billboardMedia: {
      board1: sanitizeBillboardMediaEntryForBoard("board1", billboardMedia.board1),
      board2: sanitizeBillboardMediaEntryForBoard("board2", billboardMedia.board2)
    },
    entryGate: {
      portalOpen: gate.portalOpen === true,
      waitingPlayers: countWaitingPlayers(room),
      admittedPlayers: countPlayablePlayers(room),
      spectatorPlayers: countSpectatorPlayers(room),
      priorityPlayers: priorityQueue.length,
      participantLimit: ENTRY_PARTICIPANT_LIMIT,
      roomCapacity: MAX_ROOM_PLAYERS,
      openedAt: Number(gate.openedAt || 0),
      lastAdmissionAt: Number(gate.lastAdmissionAt || 0),
      admissionStartsAt: Number(gate.admissionStartsAt || 0),
      admissionInProgress: Number(gate.admissionStartsAt || 0) > Date.now()
    },
    players: Array.from(room.players.values()).map((player) => {
      const trackProgress = ensurePlayerTrackProgressState(player);
      return {
        id: player.id,
        name: player.name,
        state: player.state ?? null,
        score: Number.isFinite(Number(player.score)) ? Math.max(0, Math.trunc(Number(player.score))) : 0,
        lap: Math.max(0, Math.trunc(Number(trackProgress?.lap) || 0)),
        progress: Number((normalizeTrackProgress(trackProgress?.progress)).toFixed(6)),
        nextCheckpointIndex: Math.max(0, Math.trunc(Number(trackProgress?.nextCheckpointIndex) || 0)),
        offTrack: trackProgress?.offTrack === true,
        alive: Boolean(player.alive),
        admitted: player.admitted !== false,
        queuedForAdmission: player.awaitingAdmission === true,
        spectator: isPlayerHostModerator(room, player),
        hostParticipating: player.hostParticipating === true,
        chatMuted: player.chatMuted === true,
        lastChoice: player.lastChoice ?? null,
        lastChoiceReason: player.lastChoiceReason ?? null
      };
    }),
    raceSession: buildRoomRaceSessionDraft(room, { includeWaiting: true }),
    track: {
      id: String(ACTIVE_TRACK_BLUEPRINT?.id ?? "car-race-alpha-track"),
      progressReady: TRACK_PROGRESS_READY,
      checkpointCount: TRACK_CHECKPOINT_PROGRESS_VALUES.length,
      centerlinePointCount: TRACK_CENTERLINE_POINTS.length,
      colliderSegmentCount: Number(TRACK_COLLIDER_LAYOUT?.segmentCount || 0),
      boundaryEnabled: TRACK_BOUNDARY.enabled === true,
      antiCheatEnabled: TRACK_ANTICHEAT_ENABLED
    }
  };
}

function summarizeRooms() {
  const summary = [];
  for (const room of rooms.values()) {
    pruneRoomPlayers(room);
    summary.push({
      code: room.code,
      count: room.players.size,
      capacity: MAX_ROOM_PLAYERS,
      hostName: room.players.get(room.hostId)?.name ?? "AUTO",
      ownerPresent: roomHasOwnerPresence(room),
      raceActive: Boolean(room.race?.active),
      createdAt: Number(room.createdAt || 0)
    });
  }

  summary.sort((left, right) => {
    const ownerDelta = Number(right.ownerPresent === true) - Number(left.ownerPresent === true);
    if (ownerDelta !== 0) {
      return ownerDelta;
    }
    const playersDelta = right.count - left.count;
    if (playersDelta !== 0) {
      return playersDelta;
    }
    return left.createdAt - right.createdAt;
  });

  return summary;
}

function emitRoomList(target = io) {
  target.emit("room:list", summarizeRooms());
}

function emitRoomUpdate(room) {
  io.to(room.code).emit("room:update", serializeRoom(room));
}

function getRoomChatHistory(room) {
  if (!room || typeof room !== "object") {
    return [];
  }
  if (!Array.isArray(room.chatHistory)) {
    room.chatHistory = [];
  }
  if (room.chatHistory.length > CHAT_HISTORY_MAX_ENTRIES) {
    room.chatHistory = room.chatHistory.slice(room.chatHistory.length - CHAT_HISTORY_MAX_ENTRIES);
  }
  return room.chatHistory;
}

function pushRoomChatHistory(room, entry = {}) {
  if (!room) {
    return;
  }
  const history = getRoomChatHistory(room);
  const text = String(entry?.text ?? "").trim().slice(0, 200);
  if (!text) {
    return;
  }
  const type = String(entry?.type ?? "remote").trim().toLowerCase() === "system" ? "system" : "remote";
  history.push({
    id: String(entry?.id ?? ""),
    name: sanitizeName(entry?.name ?? "PLAYER"),
    text,
    type,
    at: Date.now()
  });
  if (history.length > CHAT_HISTORY_MAX_ENTRIES) {
    history.splice(0, history.length - CHAT_HISTORY_MAX_ENTRIES);
  }
}

function emitChatHistorySnapshot(socket, room) {
  if (!socket || !room) {
    return;
  }
  const history = getRoomChatHistory(room);
  socket.emit("chat:history", {
    replace: true,
    entries: history.map((entry) => ({
      id: String(entry?.id ?? ""),
      name: sanitizeName(entry?.name ?? "PLAYER"),
      text: String(entry?.text ?? "").trim().slice(0, 200),
      type: String(entry?.type ?? "remote").trim().toLowerCase() === "system" ? "system" : "remote",
      at: Number(entry?.at ?? 0)
    }))
  });
}

function isRoomHost(room, socketId) {
  if (!room || !socketId) {
    return false;
  }
  return String(room.hostId ?? "") === String(socketId);
}

function pickNextHostId(room) {
  if (!room?.players || room.players.size <= 0) {
    return null;
  }
  for (const [socketId, player] of room.players.entries()) {
    if (player?.isOwner === true) {
      return socketId;
    }
  }
  // When owner key is configured, host must be claimed via owner link/key.
  if (ROOM_OWNER_KEY) {
    return null;
  }
  return room.players.keys().next().value ?? null;
}

function updateHost(room) {
  if (room.hostId && room.players.has(room.hostId)) {
    normalizeHostParticipationState(room);
    return false;
  }
  const previousHostId = room.hostId;
  room.hostId = pickNextHostId(room);
  normalizeHostParticipationState(room);
  return previousHostId !== room.hostId;
}

function buildraceLeaderboard(room) {
  const players = Array.from(room?.players?.values?.() ?? []);
  const board = players.map((player) => {
    const score = Number.isFinite(Number(player?.score)) ? Math.max(0, Math.trunc(Number(player.score))) : 0;
    const spectator = isPlayerHostModerator(room, player) || player?.admitted !== true;
    const trackProgress = ensurePlayerTrackProgressState(player);
    const lap = Math.max(0, Math.trunc(Number(trackProgress?.lap) || 0));
    const progress = normalizeTrackProgress(trackProgress?.progress);
    return {
      id: player?.id,
      name: player?.name,
      score,
      lap,
      progress: Number(progress.toFixed(6)),
      alive: Boolean(player?.alive),
      spectator,
      offTrack: trackProgress?.offTrack === true,
      lastChoice: player?.lastChoice ?? null,
      lastChoiceReason: player?.lastChoiceReason ?? null
    };
  });

  board.sort((left, right) => {
    if (left.spectator !== right.spectator) {
      return Number(left.spectator) - Number(right.spectator);
    }
    if (right.lap !== left.lap) {
      return right.lap - left.lap;
    }
    if (right.progress !== left.progress) {
      return right.progress - left.progress;
    }
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    if (left.alive !== right.alive) {
      return Number(right.alive) - Number(left.alive);
    }
    return String(left.name ?? "").localeCompare(String(right.name ?? ""));
  });

  return board;
}

function buildraceRanking(room) {
  const leaderboard = buildraceLeaderboard(room).filter((entry) => entry?.spectator !== true);
  const ranking = [];
  let previousKey = null;
  let currentRank = 0;

  for (let index = 0; index < leaderboard.length; index += 1) {
    const entry = leaderboard[index];
    const rankKey = [
      String(Math.max(0, Number(entry?.lap) || 0)),
      String(Number(entry?.progress || 0).toFixed(6)),
      String(Number(entry?.score) || 0)
    ].join(":");
    if (previousKey === null || rankKey !== previousKey) {
      currentRank = index + 1;
      previousKey = rankKey;
    }
    ranking.push({
      ...entry,
      rank: currentRank
    });
  }

  return ranking;
}

function countraceSurvivors(room) {
  let survivors = 0;
  for (const player of room?.players?.values?.() ?? []) {
    if (isPlayerHostModerator(room, player)) {
      continue;
    }
    if (player?.admitted !== true) {
      continue;
    }
    if (Boolean(player?.alive)) {
      survivors += 1;
    }
  }
  return survivors;
}

function emitraceScore(room, reason = "update", targetSocket = null) {
  if (!room) {
    return;
  }

  const race = getRoomrace(room);
  const payload = {
    reason,
    active: Boolean(race.active),
    phase: String(race.phase ?? "idle"),
    autoMode: race.autoMode !== false,
    autoFinish: race.autoFinish !== false,
    autoStartsAt: Number(race.autoStartsAt ?? 0),
    prepareEndsAt: Number(race.prepareEndsAt ?? 0),
    hostId: race.hostId ?? room.hostId ?? null,
    survivors: countraceSurvivors(room),
    leaderboard: buildraceLeaderboard(room),
    trackId: String(ACTIVE_TRACK_BLUEPRINT?.id ?? "car-race-alpha-track"),
    progressReady: TRACK_PROGRESS_READY,
    updatedAt: Date.now()
  };

  if (targetSocket) {
    targetSocket.emit("race:score", payload);
    return;
  }

  io.to(room.code).emit("race:score", payload);
}

function buildraceStartPayload(race) {
  return {
    startedAt: Number(race.startedAt ?? Date.now()),
    prepareEndsAt: Number(race.prepareEndsAt ?? 0),
    hostId: race.hostId ?? null,
    autoMode: race.autoMode !== false,
    autoFinish: race.autoFinish !== false
  };
}

function buildraceEndPayload(room, reason = "finished") {
  const race = getRoomrace(room);
  const ranking = buildraceRanking(room);
  const winners = ranking.filter((entry) => Number(entry.rank) === 1);

  return {
    reason,
    hostId: race.hostId ?? room.hostId ?? null,
    endedAt: Number(race.endedAt || Date.now()),
    winners,
    leaderboard: ranking,
    ranking
  };
}

function buildraceConfigPayload(room) {
  const config = ensureRoomraceConfig(room);
  return {
    seatMode: String(config?.seatMode ?? TRACK_SEAT_DEFAULT_MODE).toLowerCase() === "manual" ? "manual" : "auto",
    endPolicy: {
      autoFinish: config?.endPolicy?.autoFinish !== false,
      showOppositeBillboard: config?.endPolicy?.showOppositeBillboard !== false
    },
    sessionDraft: buildRoomRaceSessionDraft(room, { includeWaiting: true }),
    track: {
      id: String(ACTIVE_TRACK_BLUEPRINT?.id ?? "car-race-alpha-track"),
      progressReady: TRACK_PROGRESS_READY,
      progressMaxDistance: Number(TRACK_PROGRESS_MAX_DISTANCE.toFixed(2)),
      checkpointProgressValues: TRACK_CHECKPOINT_PROGRESS_VALUES,
      centerlinePoints: TRACK_CENTERLINE_POINTS,
      colliderSegmentCount: Number(TRACK_COLLIDER_LAYOUT?.segmentCount || 0),
      colliderSegments: Array.isArray(TRACK_COLLIDER_LAYOUT?.segments) ? TRACK_COLLIDER_LAYOUT.segments : [],
      networkInterest: {
        nearRadius: AOI_NEAR_RADIUS,
        midRadius: AOI_MID_RADIUS,
        farRadius: AOI_FAR_RADIUS,
        nearCadence: AOI_NEAR_CADENCE,
        midCadence: AOI_MID_CADENCE,
        farCadence: AOI_FAR_CADENCE,
        edgeCadence: AOI_EDGE_CADENCE
      },
      boundary: {
        enabled: TRACK_BOUNDARY.enabled === true,
        useInvisibleWalls: TRACK_BOUNDARY.useInvisibleWalls === true,
        minX: Number(TRACK_BOUNDARY.minX),
        maxX: Number(TRACK_BOUNDARY.maxX),
        minZ: Number(TRACK_BOUNDARY.minZ),
        maxZ: Number(TRACK_BOUNDARY.maxZ),
        wallMargin: Number(TRACK_BOUNDARY.wallMargin)
      },
      antiCheat: {
        enabled: TRACK_ANTICHEAT_ENABLED,
        maxDistanceFromCenterline: Number(TRACK_ANTICHEAT_MAX_DISTANCE.toFixed(2)),
        wrongWayDelta: Number(TRACK_ANTICHEAT_RESET_WRONG_WAY_DELTA.toFixed(4)),
        wrongWayStrikes: TRACK_ANTICHEAT_RESET_WRONG_WAY_STRIKES,
        cuttingStrikes: TRACK_ANTICHEAT_RESET_CUTTING_STRIKES,
        resetCooldownMs: TRACK_ANTICHEAT_RESET_COOLDOWN_MS
      }
    }
  };
}

function emitraceSnapshot(socket, room) {
  if (!socket || !room) {
    return;
  }

  const race = getRoomrace(room);
  const hasAutoCountdown = Number(race.autoStartsAt) > Date.now();
  if (!race.active && race.phase !== "ended" && !hasAutoCountdown) {
    return;
  }

  if (hasAutoCountdown) {
    socket.emit("race:auto-countdown", {
      autoMode: race.autoMode !== false,
      startsAt: Number(race.autoStartsAt),
      delayMs: Math.max(0, Number(race.autoStartsAt) - Date.now()),
      players: countPlayablePlayers(room),
      minPlayers: race_AUTO_START_MIN_PLAYERS
    });
  }

  if (race.startedAt > 0) {
    socket.emit("race:start", buildraceStartPayload(race));
  }

  emitraceScore(room, "snapshot", socket);

  if (race.phase === "ended") {
    socket.emit("race:end", buildraceEndPayload(room, "snapshot"));
  }
}

function scheduleAutoraceStart(
  room,
  {
    delayMs = race_AUTO_START_DELAY_MS,
    reason = "auto",
    minPlayers = race_AUTO_START_MIN_PLAYERS
  } = {}
) {
  if (!room) {
    return;
  }

  const race = getRoomrace(room);
  if (race.autoMode === false) {
    return;
  }
  if (race.active) {
    return;
  }
  const playablePlayers = countPlayablePlayers(room);
  if (playablePlayers < minPlayers) {
    clearraceAutoStartTimer(race);
    return;
  }
  if (race.autoStartTimer) {
    return;
  }

  const safeDelay = Math.max(2000, Math.trunc(Number(delayMs) || race_AUTO_START_DELAY_MS));
  race.autoStartsAt = Date.now() + safeDelay;

  io.to(room.code).emit("race:auto-countdown", {
    autoMode: race.autoMode !== false,
    startsAt: race.autoStartsAt,
    delayMs: safeDelay,
    reason,
    players: playablePlayers,
    minPlayers
  });
  emitraceScore(room, "auto-countdown");

  race.autoStartTimer = setTimeout(() => {
    race.autoStartTimer = null;
    const currentRoom = rooms.get(room.code);
    if (!currentRoom) {
      return;
    }
    const currentrace = getRoomrace(currentRoom);
    currentrace.autoStartsAt = 0;
    if (currentrace.autoMode === false || currentrace.active) {
      return;
    }
    if (countPlayablePlayers(currentRoom) < minPlayers) {
      return;
    }

    const hostId =
      currentRoom.hostId && currentRoom.players.has(currentRoom.hostId)
        ? currentRoom.hostId
        : pickNextHostId(currentRoom);
    if (!currentrace.hostId || !currentRoom.players.has(currentrace.hostId)) {
      currentrace.hostId = hostId;
    }

    const started = startrace(currentRoom, currentrace.hostId ?? hostId, {
      autoMode: true,
      autoFinish: ensureRoomraceConfig(currentRoom)?.endPolicy?.autoFinish !== false
    });
    if (!started?.ok) {
      scheduleAutoraceStart(currentRoom, { delayMs: race_AUTO_START_DELAY_MS, reason: "auto-retry" });
    }
  }, safeDelay);
}

function finishrace(room, reason = "finished") {
  if (!room) {
    return;
  }

  const race = getRoomrace(room);
  if (race.phase === "ended") {
    return;
  }

  clearraceLockTimer(race);
  race.active = false;
  race.phase = "ended";
  race.lockAt = 0;
  race.lockResolveAt = 0;
  race.prepareEndsAt = 0;
  race.endedAt = Date.now();

  const payload = buildraceEndPayload(room, reason);
  io.to(room.code).emit("race:end", payload);
  emitraceScore(room, "end");

  // Keep post-round flow explicit: everyone returns to lobby waiting state after race end.
  if (race_AUTO_OPEN_LOBBY_ON_END) {
    const opened = openEntryGate(room);
    if (opened?.ok) {
      emitRoomUpdate(room);
      emitraceScore(room, "lobby-open-auto");
    }
  }

  if (race.autoMode !== false) {
    scheduleAutoraceStart(room, {
      delayMs: race_AUTO_RESTART_DELAY_MS,
      reason: "auto-restart"
    });
  }
}

function scheduleraceGoLive(room, delayMs = race_PREPARE_DELAY_MS) {
  if (!room) {
    return 0;
  }
  const race = getRoomrace(room);
  if (!race.active || race.phase !== "start") {
    return 0;
  }
  if (race.nextTimer) {
    clearTimeout(race.nextTimer);
    race.nextTimer = null;
  }

  const safeDelay = Math.max(1600, Math.trunc(Number(delayMs) || race_PREPARE_DELAY_MS));
  race.prepareEndsAt = Date.now() + safeDelay;
  race.nextTimer = setTimeout(() => {
    race.nextTimer = null;
    const currentRoom = rooms.get(room.code);
    if (!currentRoom) {
      return;
    }
    const currentrace = getRoomrace(currentRoom);
    if (!currentrace.active || currentrace.phase !== "start") {
      return;
    }
    currentrace.prepareEndsAt = 0;
    currentrace.phase = "running";
    const runningPayload = {
      startedAt: Number(currentrace.startedAt || Date.now()),
      runningAt: Date.now()
    };
    io.to(currentRoom.code).emit("race:running", runningPayload);
    emitraceScore(currentRoom, "running");
  }, safeDelay);

  return safeDelay;
}

function startrace(room, hostSocketId, payload = {}) {
  if (!room) {
    return { ok: false, error: "room missing" };
  }

  const race = getRoomrace(room);
  if (race.active) {
    return { ok: false, error: "race already active" };
  }
  clearraceLockTimer(race);
  ensureRoomEntryGate(room);
  const raceConfig = ensureRoomraceConfig(room);
  const waitingPlayers = countWaitingPlayers(room);
  if (waitingPlayers > 0) {
    return { ok: false, error: "players waiting admission" };
  }
  if (countPlayablePlayers(room) <= 0) {
    return { ok: false, error: "no playable players" };
  }

  const autoMode = payload.autoMode !== false;
  const autoFinish = Object.prototype.hasOwnProperty.call(payload ?? {}, "autoFinish")
    ? payload.autoFinish !== false
    : raceConfig?.endPolicy?.autoFinish !== false;
  const resolvedHostId =
    hostSocketId && room.players.has(hostSocketId)
      ? hostSocketId
      : room.hostId && room.players.has(room.hostId)
        ? room.hostId
        : pickNextHostId(room);

  race.active = true;
  race.phase = "start";
  race.autoMode = autoMode;
  race.autoFinish = autoFinish;
  race.autoStartsAt = 0;
  race.hostId = resolvedHostId;
  race.startedAt = Date.now();
  race.prepareEndsAt = 0;
  race.endedAt = 0;
  race.lockSeconds = race_DEFAULT_LOCK_SECONDS;
  race.lockAt = 0;
  race.lockResolveAt = 0;

  for (const player of room.players.values()) {
    initializePlayerForrace(player, true);
    if (isPlayerHostModerator(room, player)) {
      player.admitted = true;
      player.awaitingAdmission = false;
      player.lastChoiceReason = "spectator";
      relocatePlayerToSpectatorZone(room, player, "race-host-spectator");
    } else {
      player.awaitingAdmission = false;
      if (player.admitted === true) {
        player.admitted = true;
      } else {
        player.admitted = false;
        player.alive = false;
        player.lastChoiceReason = "spectator";
        relocatePlayerToSpectatorZone(room, player, "race-spectator");
      }
    }
  }

  dispatchRoomSeatAssignments(room, "race-start");
  const startPayload = buildraceStartPayload(race);
  const prepareDelay = scheduleraceGoLive(room, payload.prepareDelayMs);
  const startWithPrepare = {
    ...startPayload,
    prepareEndsAt: Number(race.prepareEndsAt || Date.now() + prepareDelay),
    prepareDelayMs: prepareDelay
  };
  io.to(room.code).emit("race:start", startWithPrepare);
  emitraceScore(room, "start");

  return {
    ok: true,
    start: startWithPrepare
  };
}

function reconcileraceAfterRosterChange(room, reason = "roster-change") {
  if (!room) {
    return;
  }

  const race = getRoomrace(room);
  if (room.players.size === 0) {
    resetraceState(room);
    return;
  }

  if (!race.hostId || !room.players.has(race.hostId)) {
    race.hostId = room.hostId ?? pickNextHostId(room);
  }

  if (!race.active) {
    emitraceScore(room, reason);
    if (race.autoMode !== false) {
      scheduleAutoraceStart(room, {
        delayMs: race_AUTO_START_DELAY_MS,
        reason: `${reason}-auto`
      });
    }
    return;
  }

  const survivors = countraceSurvivors(room);
  if (survivors <= 0) {
    finishrace(room, "player-left");
    return;
  }

  emitraceScore(room, reason);
}

function pruneRoomPlayers(room) {
  if (!room || !io?.sockets?.sockets) {
    return false;
  }

  let changed = false;
  for (const socketId of room.players.keys()) {
    if (!io.sockets.sockets.has(socketId)) {
      room.players.delete(socketId);
      const gate = ensureRoomEntryGate(room);
      gate.pendingAdmissionIds = gate.pendingAdmissionIds.filter((id) => id !== socketId);
      removeNextPriorityPlayer(room, socketId);
      changed = true;
    }
  }

  if (changed) {
    updateHost(room);
    reconcileraceAfterRosterChange(room, "prune");
    if (!room.persistent && room.players.size === 0) {
      rememberRoomraceConfig(room);
      clearEntryAdmissionTimer(room);
      resetraceState(room);
      rooms.delete(room.code);
    }
  }
  return changed;
}

function ack(ackFn, payload) {
  if (typeof ackFn === "function") {
    ackFn(payload);
  }
}

function leaveCurrentRoom(socket) {
  const roomCode = socket.data.roomCode;
  if (!roomCode) {
    return;
  }

  const room = rooms.get(roomCode);
  socket.leave(roomCode);
  socket.data.roomCode = null;
  clearSocketDeltaCache(socket, roomCode);

  if (!room) {
    emitRoomList();
    return;
  }

  room.players.delete(socket.id);
  const gate = ensureRoomEntryGate(room);
  gate.pendingAdmissionIds = gate.pendingAdmissionIds.filter((id) => id !== socket.id);
  removeNextPriorityPlayer(room, socket.id);
  pruneRoomPlayers(room);
  updateHost(room);
  reconcileraceAfterRosterChange(room, "leave");

  if (!room.persistent && room.players.size === 0) {
    rememberRoomraceConfig(room);
    clearEntryAdmissionTimer(room);
    resetraceState(room);
    rooms.delete(room.code);
  }

  if (room.players.size > 0) {
    emitRoomUpdate(room);
  }
  emitRoomList();
}

function pickOrCreateRoomForQuickJoin(preferredCode = null) {
  if (WORKER_SINGLE_ROOM_MODE) {
    const workerRoom =
      getRoom(WORKER_FIXED_ROOM_CODE) ?? createMatchRoom(WORKER_FIXED_ROOM_CODE, true);
    if (!isRoomJoinable(workerRoom)) {
      return null;
    }
    return workerRoom;
  }

  const preferred = sanitizeRoomCode(preferredCode);
  if (preferred) {
    const preferredRoom = getRoom(preferred);
    if (preferredRoom && isRoomJoinable(preferredRoom)) {
      return preferredRoom;
    }
    if (!preferredRoom && rooms.size < MAX_ACTIVE_ROOMS) {
      return createMatchRoom(preferred);
    }
  }

  const candidate = findJoinableRoom(preferredCode);
  if (candidate) {
    return candidate;
  }
  if (rooms.size >= MAX_ACTIVE_ROOMS) {
    return null;
  }
  return createMatchRoom();
}

function joinRoom(socket, room, nameOverride = null) {
  if (!room) {
    return {
      ok: false,
      error: "no available room"
    };
  }

  pruneRoomPlayers(room);

  const name = sanitizeName(nameOverride ?? socket.data.playerName);
  socket.data.playerName = name;

  if (socket.data.roomCode === room.code && room.players.has(socket.id)) {
    const existing = room.players.get(socket.id);
    existing.name = name;
    existing.isOwner = existing.isOwner === true || socket.data.ownerClaim === true;
    existing.chatMuted = existing.chatMuted === true;
    existing.hostParticipating = existing.hostParticipating === true;
    existing.joinedAt = Math.max(0, Math.trunc(Number(existing.joinedAt) || Date.now()));
    ensurePlayerNetState(existing);
    ensurePlayerTrackProgressState(existing);
    existing.seatBoarded = existing.seatBoarded === true;
    existing.assignedVehicleId = String(existing.assignedVehicleId ?? "");
    if (socket.data.ownerClaim === true && room.hostId !== socket.id) {
      room.hostId = socket.id;
      const raceState = getRoomrace(room);
      raceState.hostId = socket.id;
      normalizeHostParticipationState(room);
      emitRoomUpdate(room);
      emitraceScore(room, "owner-claim");
    }
    const race = getRoomrace(room);
    const gate = ensureRoomEntryGate(room);
    if (isPlayerHostController(room, existing)) {
      existing.admitted = true;
      existing.awaitingAdmission = false;
      existing.alive = true;
      removeNextPriorityPlayer(room, existing.id);
    } else if (race.active) {
      existing.admitted = false;
      existing.awaitingAdmission = false;
      existing.alive = false;
      addNextPriorityPlayer(room, existing.id);
    } else if (gate.admissionStartsAt > Date.now()) {
      existing.admitted = false;
      existing.awaitingAdmission = false;
      existing.alive = false;
      addNextPriorityPlayer(room, existing.id);
    } else if (gate.portalOpen) {
      existing.admitted = false;
      existing.awaitingAdmission = true;
      existing.alive = false;
    } else if (existing.admitted === false) {
      existing.awaitingAdmission = false;
      existing.alive = false;
      addNextPriorityPlayer(room, existing.id);
    } else {
      existing.admitted = true;
      existing.awaitingAdmission = false;
      removeNextPriorityPlayer(room, existing.id);
    }
    if (existing.admitted !== true || existing.alive === false) {
      existing.seatBoarded = false;
      existing.assignedVehicleId = null;
    }
    if (isRestrictedFromraceArena(room, existing)) {
      relocatePlayerToSpectatorZone(room, existing, "join-spectator");
    }
    resetPlayerTrackProgressState(existing, existing.state, true);
    if (!race.active && race.autoMode !== false) {
      scheduleAutoraceStart(room, {
        delayMs: race_AUTO_START_DELAY_MS,
        reason: "rejoin-auto"
      });
    }
    emitRoomUpdate(room);
    emitraceSnapshot(socket, room);
    emitChatHistorySnapshot(socket, room);
    socket.emit("player:correct", {
      state: existing?.state ?? sanitizePlayerState(),
      reason: "join-refresh"
    });
    socket.emit("race:config:update", buildraceConfigPayload(room));
    maybeEmitPlayerRaceProgress(room, existing, socket);
    return { ok: true, room: serializeRoom(room) };
  }

  leaveCurrentRoom(socket);

  if (room.players.size >= MAX_ROOM_PLAYERS) {
    return {
      ok: false,
      error: `${room.code} room is full (${MAX_ROOM_PLAYERS})`
    };
  }

  const race = getRoomrace(room);
  const gate = ensureRoomEntryGate(room);
  const joinAsAlive = !race.active;
  const initialState = buildPortalArrivalSpawnPoint();

  room.players.set(socket.id, {
    id: socket.id,
    name,
    state: initialState,
    score: 0,
    alive: joinAsAlive,
    admitted: true,
    awaitingAdmission: false,
    hostParticipating: false,
    isOwner: socket.data.ownerClaim === true,
    chatMuted: false,
    seatBoarded: false,
    assignedVehicleId: null,
    joinedAt: Date.now(),
    lastChoice: null,
    lastChoiceReason: null,
    net: createPlayerNetState(initialState),
    trackProgress: createPlayerTrackProgressState({
      lap: 0,
      lastProgress: 0,
      progress: 0,
      unwrappedProgress: 0,
      nextCheckpointIndex: 0
    })
  });

  if (socket.data.ownerClaim === true) {
    room.hostId = socket.id;
  } else {
    updateHost(room);
  }
  if (!race.hostId || socket.data.ownerClaim === true) {
    race.hostId = room.hostId ?? socket.id;
  }
  normalizeHostParticipationState(room);

  const joined = room.players.get(socket.id);
  if (joined) {
    if (isPlayerHostController(room, joined)) {
      joined.admitted = true;
      joined.awaitingAdmission = false;
      joined.alive = true;
      removeNextPriorityPlayer(room, joined.id);
    } else if (race.active) {
      joined.admitted = false;
      joined.awaitingAdmission = false;
      joined.alive = false;
      addNextPriorityPlayer(room, joined.id);
    } else if (gate.admissionStartsAt > Date.now()) {
      joined.admitted = false;
      joined.awaitingAdmission = false;
      joined.alive = false;
      addNextPriorityPlayer(room, joined.id);
    } else if (gate.portalOpen) {
      joined.admitted = false;
      joined.awaitingAdmission = true;
      joined.alive = false;
    } else {
      joined.admitted = true;
      joined.awaitingAdmission = false;
      removeNextPriorityPlayer(room, joined.id);
    }
    if (isRestrictedFromraceArena(room, joined)) {
      relocatePlayerToSpectatorZone(room, joined, "join-spectator");
    }
    if (joined.admitted !== true || joined.alive === false) {
      joined.seatBoarded = false;
      joined.assignedVehicleId = null;
    }
    resetPlayerTrackProgressState(joined, joined.state, false);
  }

  socket.join(room.code);
  socket.data.roomCode = room.code;

  if (joined?.state) {
    socket.emit("player:correct", {
      state: joined.state,
      reason: "join-spawn"
    });
  }

  emitRoomUpdate(room);
  emitRoomList();
  emitraceSnapshot(socket, room);
  emitChatHistorySnapshot(socket, room);
  socket.emit("race:config:update", buildraceConfigPayload(room));
  if (joined) {
    maybeEmitPlayerRaceProgress(room, joined, socket);
  }
  if (race.active || race.phase === "ended") {
    emitraceScore(room, "join");
  } else if (race.autoMode !== false) {
    scheduleAutoraceStart(room, {
      delayMs: race_AUTO_START_DELAY_MS,
      reason: "join-auto"
    });
  }

  return { ok: true, room: serializeRoom(room) };
}

const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    const roomsSummary = summarizeRooms();
    const totalPlayers = roomsSummary.reduce((sum, room) => sum + Number(room.count || 0), 0);
    const activeraceRooms = roomsSummary.filter((room) => room.raceActive).length;
    const topRoom = roomsSummary[0] ?? null;
    const topRoomrace = topRoom ? getRoomrace(getRoom(topRoom.code)) : null;
    writeJson(res, 200, {
      ok: true,
      service: "reclaim-fps-chat",
      rooms: roomsSummary.length,
      online: playerCount,
      totalPlayers,
      activeraceRooms,
      capacityPerRoom: MAX_ROOM_PLAYERS,
      participantLimit: ENTRY_PARTICIPANT_LIMIT,
      maxActiveRooms: MAX_ACTIVE_ROOMS,
      tickRate: SERVER_TICK_RATE,
      workerSingleRoomMode: WORKER_SINGLE_ROOM_MODE,
      workerRoomCode: WORKER_SINGLE_ROOM_MODE ? WORKER_FIXED_ROOM_CODE : null,
      topRoom: topRoom
        ? {
            code: topRoom.code,
            players: topRoom.count,
            capacity: topRoom.capacity,
            ownerPresent: topRoom.ownerPresent === true,
            hostName: topRoom.hostName,
            race: topRoomrace
                ? {
                    active: Boolean(topRoomrace.active),
                    phase: topRoomrace.phase,
                    autoMode: topRoomrace.autoMode !== false,
                    autoStartsAt: Number(topRoomrace.autoStartsAt ?? 0)
                  }
                : null
          }
        : null,
      track: {
        id: String(ACTIVE_TRACK_BLUEPRINT?.id ?? "car-race-alpha-track"),
        progressReady: TRACK_PROGRESS_READY,
        checkpointCount: TRACK_CHECKPOINT_PROGRESS_VALUES.length,
        centerlinePointCount: TRACK_CENTERLINE_POINTS.length,
        colliderSegmentCount: Number(TRACK_COLLIDER_LAYOUT?.segmentCount || 0)
      },
      now: Date.now()
    });
    return;
  }

  if (req.url === "/" || req.url === "/status") {
    writeJson(res, 200, {
      ok: true,
      message: "Emptines realtime sync server is running",
      roomPrefix: ROOM_CODE_PREFIX,
      capacityPerRoom: MAX_ROOM_PLAYERS,
      participantLimit: ENTRY_PARTICIPANT_LIMIT,
      maxActiveRooms: MAX_ACTIVE_ROOMS,
      tickRate: SERVER_TICK_RATE,
      workerSingleRoomMode: WORKER_SINGLE_ROOM_MODE,
      workerRoomCode: WORKER_SINGLE_ROOM_MODE ? WORKER_FIXED_ROOM_CODE : null,
      trackId: String(ACTIVE_TRACK_BLUEPRINT?.id ?? "car-race-alpha-track"),
      health: "/health"
    });
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

const corsOrigin = parseCorsOrigins(process.env.CORS_ORIGIN);

const io = new Server(httpServer, {
  cors: {
    origin: corsOrigin,
    methods: ["GET", "POST"]
  },
  transports: ["websocket", "polling"],
  pingInterval: 5000,
  pingTimeout: 5000
});

const roomTickInterval = setInterval(() => {
  tickRooms();
}, SERVER_TICK_INTERVAL_MS);
roomTickInterval.unref?.();

io.on("connection", (socket) => {
  socket.data.playerName = `PLAYER_${Math.floor(Math.random() * 9000 + 1000)}`;
  socket.data.roomCode = null;
  socket.data.deltaCache = new Map();
  socket.data.ownerClaim = false;

  if (WORKER_SINGLE_ROOM_MODE && REQUIRE_JOIN_TOKEN) {
    const token = String(
      socket.handshake?.auth?.token ??
        socket.handshake?.query?.token ??
        socket.handshake?.headers?.["x-room-token"] ??
        ""
    ).trim();
    const verified = validateJoinTokenForWorker(token);
    if (!verified?.ok) {
      socket.emit("auth:error", {
        code: "invalid-room-token",
        reason: verified?.error ?? "invalid token"
      });
      socket.disconnect(true);
      return;
    }
    socket.data.playerName = sanitizeName(verified.payload?.name ?? socket.data.playerName);
    socket.data.ownerClaim = Boolean(verified.payload?.ownerClaim ?? verified.payload?.owner);
  }

  playerCount += 1;

  console.log(`[+] player connected (${playerCount}) ${socket.id}`);

  socket.emit("server:role", {
    role: "worker",
    singleRoomMode: WORKER_SINGLE_ROOM_MODE,
    roomCode: WORKER_SINGLE_ROOM_MODE ? WORKER_FIXED_ROOM_CODE : null
  });

  const initialRoom = pickOrCreateRoomForQuickJoin();
  if (initialRoom) {
    joinRoom(socket, initialRoom);
  }
  emitRoomList(socket);

  socket.on("chat:send", ({ name, text } = {}, ackFn) => {
    const safeName = sanitizeName(name ?? socket.data.playerName);
    const safeText = String(text ?? "").trim().slice(0, 200);
    if (!safeText) {
      ack(ackFn, { ok: false, error: "empty message" });
      return;
    }

    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room) {
      ack(ackFn, { ok: false, error: "not in room" });
      return;
    }

    const player = room.players.get(socket.id);
    if (!player) {
      ack(ackFn, { ok: false, error: "player not found" });
      return;
    }

    if (player.chatMuted === true) {
      ack(ackFn, { ok: false, error: "chat muted" });
      return;
    }

    socket.data.playerName = safeName;
    player.name = safeName;
    pushRoomChatHistory(room, {
      id: socket.id,
      name: safeName,
      text: safeText,
      type: "remote"
    });
    io.to(room.code).emit("chat:message", {
      id: socket.id,
      name: safeName,
      text: safeText
    });
    ack(ackFn, { ok: true });
    emitRoomUpdate(room);
  });

  socket.on("player:sync", (payload = {}) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room) {
      return;
    }

    const player = room.players.get(socket.id);
    if (!player) {
      return;
    }

    const net = ensurePlayerNetState(player);
    const seq = Number(payload?.s);
    if (Number.isFinite(seq)) {
      const safeSeq = Math.trunc(seq);
      const previousSeq = Number(net.lastSeq);
      if (Number.isFinite(previousSeq) && previousSeq >= 0) {
        // Drop stale/out-of-order sync packets to reduce correction jitter.
        if (safeSeq <= previousSeq && previousSeq - safeSeq < 1_000_000) {
          return;
        }
      }
      net.lastSeq = safeSeq;
    }

    const sanitized = sanitizePlayerState(payload);
    const movementResult = applyAuthoritativeMovement(player, sanitized);
    if (isRestrictedFromraceArena(room, player)) {
      const forcedOutside = projectStateOutsideraceArena(player.state);
      if (forcedOutside.corrected) {
        const correctedState = forcedOutside.state;
        const correctionDistance = Math.hypot(
          Number(correctedState.x) - Number(player.state?.x || 0),
          Number(correctedState.y) - Number(player.state?.y || 0),
          Number(correctedState.z) - Number(player.state?.z || 0)
        );
        setPlayerAuthoritativeState(player, correctedState);
        const now = Date.now();
        const cooldownElapsed = now - Number(net.lastCorrectionAt || 0);
        if (
          correctionDistance >= SERVER_CORRECTION_MIN_DISTANCE &&
          cooldownElapsed >= SERVER_CORRECTION_COOLDOWN_MS
        ) {
          net.lastCorrectionAt = now;
          socket.emit("player:correct", {
            state: player.state,
            reason: "race-spectator-zone"
          });
        }
        return;
      }
    }
    let boundaryCorrected = false;
    if (shouldEnforceTrackBoundary(room, player)) {
      const bounded = projectStateInsideTrackBoundary(player.state);
      if (bounded.corrected) {
        boundaryCorrected = true;
        const correctedState = bounded.state;
        const correctionDistance = Math.hypot(
          Number(correctedState.x) - Number(player.state?.x || 0),
          Number(correctedState.y) - Number(player.state?.y || 0),
          Number(correctedState.z) - Number(player.state?.z || 0)
        );
        setPlayerAuthoritativeState(player, correctedState);
        const now = Date.now();
        const cooldownElapsed = now - Number(net.lastCorrectionAt || 0);
        if (
          correctionDistance >= SERVER_CORRECTION_MIN_DISTANCE &&
          cooldownElapsed >= SERVER_CORRECTION_COOLDOWN_MS
        ) {
          net.lastCorrectionAt = now;
          socket.emit("player:correct", {
            state: player.state,
            reason: "track-boundary-wall"
          });
        }
      }
    }
    if (
      !boundaryCorrected &&
      movementResult.clamped &&
      movementResult.correctionDistance >= SERVER_CORRECTION_MIN_DISTANCE
    ) {
      const now = Date.now();
      const cooldownElapsed = now - Number(net.lastCorrectionAt || 0);
      if (cooldownElapsed >= SERVER_CORRECTION_COOLDOWN_MS) {
        net.lastCorrectionAt = now;
        socket.emit("player:correct", {
          state: movementResult.nextState,
          reason: "server-authoritative"
        });
      }
    }

    maybeAutoSeatPlayerOnReach(room, player, socket);

    maybeEmitPlayerRaceProgress(room, player, socket);
  });

  socket.on("race:start", (payload = {}, ackFn) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room) {
      ack(ackFn, { ok: false, error: "not in room" });
      return;
    }

    if (!isRoomHost(room, socket.id)) {
      ack(ackFn, { ok: false, error: "host only" });
      return;
    }
    if (ROOM_OWNER_KEY && socket.data.ownerClaim !== true) {
      ack(ackFn, { ok: false, error: "unauthorized" });
      return;
    }

    const started = startrace(room, socket.id, {
      ...payload,
      autoMode: false,
      prepareDelayMs: payload?.prepareDelayMs
    });
    ack(ackFn, started);
  });

  socket.on("race:stop", (payload = {}, ackFn) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room) {
      ack(ackFn, { ok: false, error: "not in room" });
      return;
    }

    if (!isRoomHost(room, socket.id)) {
      ack(ackFn, { ok: false, error: "host only" });
      return;
    }
    if (ROOM_OWNER_KEY && socket.data.ownerClaim !== true) {
      ack(ackFn, { ok: false, error: "unauthorized" });
      return;
    }

    const race = getRoomrace(room);
    if (!race.active) {
      ack(ackFn, { ok: false, error: "race is not active" });
      return;
    }

    race.autoMode = false;
    finishrace(room, "stopped-by-host");
    ack(ackFn, { ok: true });
  });

  socket.on("room:claim-host", (ackFn) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room) {
      ack(ackFn, { ok: false, error: "not in room" });
      return;
    }
    if (socket.data.ownerClaim !== true) {
      ack(ackFn, { ok: false, error: "unauthorized" });
      return;
    }

    const previousHostId = room.hostId ?? null;
    room.hostId = socket.id;
    const race = getRoomrace(room);
    race.hostId = socket.id;
    normalizeHostParticipationState(room);

    emitRoomUpdate(room);
    emitraceScore(room, "host-claim");
    ack(ackFn, {
      ok: true,
      hostId: socket.id,
      changed: String(previousHostId ?? "") !== String(socket.id)
    });
  });

  socket.on("host:set-participating", (payload = {}, ackFn) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room) {
      ack(ackFn, { ok: false, error: "not in room" });
      return;
    }

    const player = room.players.get(socket.id);
    if (!isPlayerHostController(room, player)) {
      ack(ackFn, { ok: false, error: "host only" });
      return;
    }

    const participating = payload?.participating === true;
    player.hostParticipating = participating;
    player.admitted = true;
    player.awaitingAdmission = false;
    player.lastChoice = null;
    if (participating) {
      player.alive = true;
      player.lastChoiceReason = null;
      player.seatBoarded = false;
      player.assignedVehicleId = null;
    } else {
      player.alive = true;
      player.lastChoiceReason = "spectator";
      player.seatBoarded = false;
      player.assignedVehicleId = null;
      if (isRestrictedFromraceArena(room, player)) {
        relocatePlayerToSpectatorZone(room, player, "host-spectator-toggle");
      }
    }
    normalizeHostParticipationState(room);

    emitRoomUpdate(room);
    emitraceScore(room, participating ? "host-participating-on" : "host-participating-off");
    ack(ackFn, {
      ok: true,
      participating,
      spectator: isPlayerHostModerator(room, player),
      alive: Boolean(player.alive),
      admitted: player.admitted !== false,
      state: player.state ?? null
    });
  });

  socket.on("race:state", (ackFn) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room) {
      ack(ackFn, { ok: false, error: "not in room" });
      return;
    }

    const race = getRoomrace(room);
    ack(ackFn, {
      ok: true,
      race: {
        active: Boolean(race.active),
        phase: race.phase,
        autoMode: race.autoMode !== false,
        autoFinish: race.autoFinish !== false,
        autoStartsAt: Number(race.autoStartsAt ?? 0),
        prepareEndsAt: Number(race.prepareEndsAt ?? 0),
        hostId: race.hostId ?? room.hostId ?? null,
        endedAt: Number(race.endedAt ?? 0)
      },
      scoreboard: {
        survivors: countraceSurvivors(room),
        leaderboard: buildraceLeaderboard(room)
      }
    });
  });

  socket.on("race:config:get", (ackFn) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room) {
      ack(ackFn, { ok: false, error: "not in room" });
      return;
    }
    ack(ackFn, {
      ok: true,
      config: buildraceConfigPayload(room)
    });
  });

  socket.on("race:config:set", (payload = {}, ackFn) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room) {
      ack(ackFn, { ok: false, error: "not in room" });
      return;
    }
    if (!isRoomHost(room, socket.id)) {
      ack(ackFn, { ok: false, error: "host only" });
      return;
    }
    if (ROOM_OWNER_KEY && socket.data.ownerClaim !== true) {
      ack(ackFn, { ok: false, error: "unauthorized" });
      return;
    }

    const race = getRoomrace(room);
    if (race.active) {
      ack(ackFn, { ok: false, error: "race already active" });
      return;
    }

    const config = ensureRoomraceConfig(room);
    const requestedSeatMode = Object.prototype.hasOwnProperty.call(payload ?? {}, "seatMode")
      ? payload?.seatMode
      : payload?.seatAssignment?.mode;
    if (requestedSeatMode !== undefined) {
      const requestedMode =
        String(requestedSeatMode ?? "").trim().toLowerCase() === "manual" ? "manual" : "auto";
      if (requestedMode === "manual" && !TRACK_SEAT_ALLOW_MANUAL_OPTION) {
        ack(ackFn, { ok: false, error: "manual seat mode disabled" });
        return;
      }
      config.seatMode = requestedMode;
    }
    if (payload?.endPolicy && typeof payload.endPolicy === "object") {
      config.endPolicy.autoFinish = payload.endPolicy.autoFinish !== false;
      if (Object.prototype.hasOwnProperty.call(payload.endPolicy, "showOppositeBillboard")) {
        config.endPolicy.showOppositeBillboard =
          payload.endPolicy.showOppositeBillboard !== false;
      }
    } else if (Object.prototype.hasOwnProperty.call(payload ?? {}, "autoFinish")) {
      config.endPolicy.autoFinish = payload.autoFinish !== false;
    }
    config.endPolicy.autoFinish = config.endPolicy.autoFinish !== false;
    if (Object.prototype.hasOwnProperty.call(payload ?? {}, "showOppositeBillboard")) {
      config.endPolicy.showOppositeBillboard = payload.showOppositeBillboard !== false;
    }
    config.endPolicy.showOppositeBillboard = config.endPolicy.showOppositeBillboard !== false;
    rememberRoomraceConfig(room);
    race.autoFinish = config.endPolicy.autoFinish;

    const response = {
      ok: true,
      config: buildraceConfigPayload(room)
    };
    io.to(room.code).emit("race:config:update", response.config);
    dispatchRoomSeatAssignments(room, "config-update");
    emitraceScore(room, "config-update");
    ack(ackFn, response);
  });

  socket.on("race:seat:board", (payload = {}, ackFn) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room) {
      ack(ackFn, { ok: false, error: "not in room" });
      return;
    }
    const player = room.players.get(socket.id);
    if (!player) {
      ack(ackFn, { ok: false, error: "player missing" });
      return;
    }
    if (player.admitted !== true || player.alive === false || isPlayerHostModerator(room, player)) {
      ack(ackFn, { ok: false, error: "seat boarding unavailable" });
      return;
    }

    const { sessionDraft, assignment } = resolvePlayerSeatAssignment(room, socket.id, {
      includeWaiting: false
    });
    if (!sessionDraft || !assignment) {
      ack(ackFn, { ok: false, error: "seat assignment missing" });
      return;
    }
    const seatMode =
      String(sessionDraft?.seatAssignment?.mode ?? "auto").trim().toLowerCase() === "manual"
        ? "manual"
        : "auto";
    if (seatMode !== "manual") {
      ack(ackFn, { ok: false, error: "seat mode is auto" });
      return;
    }

    const requestedVehicleId = String(payload?.vehicleId ?? "").trim();
    const assignedVehicleId = String(assignment?.vehicleId ?? "");
    if (requestedVehicleId && requestedVehicleId !== assignedVehicleId) {
      ack(ackFn, { ok: false, error: "vehicle mismatch" });
      return;
    }

    const seatState = buildSeatStateFromAssignment(assignment);
    const currentState = sanitizePlayerState(player.state ?? {});
    const distance = Math.hypot(
      Number(seatState.x) - Number(currentState.x),
      Number(seatState.y) - Number(currentState.y),
      Number(seatState.z) - Number(currentState.z)
    );
    const reachRadius = Math.max(
      1.6,
      Number(sessionDraft?.seatAssignment?.autoSeatReachRadius) || RACE_SEAT_DEFAULTS.autoSeatReachRadius
    );
    if (distance > reachRadius) {
      ack(ackFn, {
        ok: false,
        error: "too far from seat",
        distance: Number(distance.toFixed(3)),
        required: Number(reachRadius.toFixed(3))
      });
      return;
    }

    setPlayerAuthoritativeState(player, seatState);
    player.assignedVehicleId = assignedVehicleId;
    player.seatBoarded = true;
    socket.emit("player:correct", {
      state: player.state,
      reason: "race-manual-seat"
    });
    socket.emit("race:seat:boarded", {
      room: String(room.code ?? ""),
      vehicleId: assignedVehicleId,
      seat: "driver",
      at: Date.now()
    });
    ack(ackFn, {
      ok: true,
      vehicleId: assignedVehicleId,
      seat: "driver",
      state: player.state
    });
  });

  socket.on("room:list", () => {
    emitRoomList(socket);
  });

  socket.on("room:quick-join", (payload = {}, ackFn) => {
    applySocketOwnerAccess(socket, payload?.ownerKey);
    if (WORKER_SINGLE_ROOM_MODE) {
      const workerRoom =
        getRoom(WORKER_FIXED_ROOM_CODE) ?? createMatchRoom(WORKER_FIXED_ROOM_CODE, true);
      if (!workerRoom || workerRoom.players.size >= MAX_ROOM_PLAYERS) {
        ack(ackFn, { ok: false, error: "room full" });
        return;
      }
      ack(ackFn, joinRoom(socket, workerRoom, payload.name));
      return;
    }

    const preferredCode = sanitizeRoomCode(payload.roomCode ?? payload.code);
    const room = pickOrCreateRoomForQuickJoin(preferredCode);
    if (!room) {
      ack(ackFn, { ok: false, error: "no room capacity available" });
      return;
    }
    ack(ackFn, joinRoom(socket, room, payload.name));
  });

  socket.on("room:create", (payload = {}, ackFn) => {
    applySocketOwnerAccess(socket, payload?.ownerKey);
    if (WORKER_SINGLE_ROOM_MODE) {
      ack(ackFn, { ok: false, error: "create disabled in worker mode" });
      return;
    }

    if (rooms.size >= MAX_ACTIVE_ROOMS) {
      ack(ackFn, { ok: false, error: "room limit reached" });
      return;
    }
    const requestedCode = sanitizeRoomCode(payload.code ?? payload.roomCode);
    if (requestedCode && rooms.has(requestedCode)) {
      ack(ackFn, { ok: false, error: "room already exists" });
      return;
    }
    const room = createMatchRoom(requestedCode);
    ack(ackFn, joinRoom(socket, room, payload.name));
  });

  socket.on("room:join", (payload = {}, ackFn) => {
    applySocketOwnerAccess(socket, payload?.ownerKey);
    if (WORKER_SINGLE_ROOM_MODE) {
      const requested = sanitizeRoomCode(payload.code ?? payload.roomCode);
      if (requested && requested !== WORKER_FIXED_ROOM_CODE) {
        ack(ackFn, { ok: false, error: "room mismatch" });
        return;
      }
      const workerRoom =
        getRoom(WORKER_FIXED_ROOM_CODE) ?? createMatchRoom(WORKER_FIXED_ROOM_CODE, true);
      if (!workerRoom || workerRoom.players.size >= MAX_ROOM_PLAYERS) {
        ack(ackFn, { ok: false, error: "room full" });
        return;
      }
      ack(ackFn, joinRoom(socket, workerRoom, payload.name));
      return;
    }

    const code = sanitizeRoomCode(payload.code ?? payload.roomCode);
    if (!code) {
      ack(ackFn, { ok: false, error: "room code required" });
      return;
    }
    const room = getRoom(code);
    if (!room) {
      ack(ackFn, { ok: false, error: "room not found" });
      return;
    }
    ack(ackFn, joinRoom(socket, room, payload.name));
  });

  socket.on("portal:lobby-open", (ackFn) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room) {
      ack(ackFn, { ok: false, error: "not in room" });
      return;
    }
    if (!isRoomHost(room, socket.id)) {
      ack(ackFn, { ok: false, error: "host only" });
      return;
    }
    if (ROOM_OWNER_KEY && socket.data.ownerClaim !== true) {
      ack(ackFn, { ok: false, error: "unauthorized" });
      return;
    }

    const opened = openEntryGate(room);
    if (!opened?.ok) {
      ack(ackFn, opened);
      return;
    }

    emitRoomUpdate(room);
    emitraceScore(room, "lobby-open");
    ack(ackFn, opened);
  });

  socket.on("portal:lobby-start", (ackFn) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room) {
      ack(ackFn, { ok: false, error: "not in room" });
      return;
    }
    if (!isRoomHost(room, socket.id)) {
      ack(ackFn, { ok: false, error: "host only" });
      return;
    }
    if (ROOM_OWNER_KEY && socket.data.ownerClaim !== true) {
      ack(ackFn, { ok: false, error: "unauthorized" });
      return;
    }

    const admitted = startEntryAdmission(room);
    if (!admitted?.ok) {
      emitRoomUpdate(room);
      ack(ackFn, admitted);
      return;
    }

    emitRoomUpdate(room);
    emitraceScore(room, "lobby-admit-countdown");
    ack(ackFn, admitted);
  });

  socket.on("portal:set-target", (payload = {}, ackFn) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room) {
      ack(ackFn, { ok: false, error: "not in room" });
      return;
    }
    if (!isRoomHost(room, socket.id)) {
      ack(ackFn, { ok: false, error: "unauthorized" });
      return;
    }
    if (ROOM_OWNER_KEY && socket.data.ownerClaim !== true) {
      ack(ackFn, { ok: false, error: "unauthorized" });
      return;
    }

    const rawTargetUrl = String(payload?.targetUrl ?? "").trim();
    const nextTargetUrl = sanitizePortalTargetUrl(rawTargetUrl);
    if (rawTargetUrl && !nextTargetUrl) {
      ack(ackFn, { ok: false, error: "invalid portal target" });
      return;
    }
    room.portalTargetUrl = nextTargetUrl;
    const updatePayload = {
      targetUrl: nextTargetUrl,
      updatedBy: socket.id,
      updatedAt: Date.now()
    };

    io.to(room.code).emit("portal:target:update", updatePayload);
    emitRoomUpdate(room);
    ack(ackFn, { ok: true, ...updatePayload });
  });

  socket.on("billboard:media:set", (payload = {}, ackFn) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room) {
      ack(ackFn, { ok: false, error: "not in room" });
      return;
    }
    if (!isRoomHost(room, socket.id)) {
      ack(ackFn, { ok: false, error: "host only" });
      return;
    }
    if (ROOM_OWNER_KEY && socket.data.ownerClaim !== true) {
      ack(ackFn, { ok: false, error: "unauthorized" });
      return;
    }

    const current = ensureRoomBillboardMedia(room);
    const next = sanitizeRoomBillboardMediaPayload(payload, current);
    if (!next?.ok) {
      ack(ackFn, { ok: false, error: next?.error || "invalid billboard media" });
      return;
    }
    room.billboardMedia = next.media;
    emitRoomUpdate(room);
    ack(ackFn, { ok: true, media: next.media, updatedAt: Date.now() });
  });

  socket.on("host:kick-player", (payload = {}, ackFn) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room) {
      ack(ackFn, { ok: false, error: "not in room" });
      return;
    }
    if (!isRoomHost(room, socket.id)) {
      ack(ackFn, { ok: false, error: "host only" });
      return;
    }
    if (ROOM_OWNER_KEY && socket.data.ownerClaim !== true) {
      ack(ackFn, { ok: false, error: "unauthorized" });
      return;
    }

    const targetId = String(payload?.targetId ?? payload?.playerId ?? "").trim();
    if (!targetId) {
      ack(ackFn, { ok: false, error: "target required" });
      return;
    }
    if (targetId === socket.id) {
      ack(ackFn, { ok: false, error: "cannot target self" });
      return;
    }

    const targetPlayer = room.players.get(targetId);
    if (!targetPlayer) {
      ack(ackFn, { ok: false, error: "player not found" });
      return;
    }

    const targetSocket = io.sockets.sockets.get(targetId) ?? null;
    if (targetSocket) {
      targetSocket.emit("host:kicked", {
        roomCode: room.code,
        by: socket.id,
        at: Date.now()
      });
      targetSocket.disconnect(true);
    } else {
      room.players.delete(targetId);
      emitRoomUpdate(room);
      emitRoomList();
    }

    ack(ackFn, {
      ok: true,
      targetId,
      targetName: targetPlayer.name
    });
  });

  socket.on("host:set-chat-muted", (payload = {}, ackFn) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room) {
      ack(ackFn, { ok: false, error: "not in room" });
      return;
    }
    if (!isRoomHost(room, socket.id)) {
      ack(ackFn, { ok: false, error: "host only" });
      return;
    }
    if (ROOM_OWNER_KEY && socket.data.ownerClaim !== true) {
      ack(ackFn, { ok: false, error: "unauthorized" });
      return;
    }

    const targetId = String(payload?.targetId ?? payload?.playerId ?? "").trim();
    if (!targetId) {
      ack(ackFn, { ok: false, error: "target required" });
      return;
    }
    if (targetId === socket.id) {
      ack(ackFn, { ok: false, error: "cannot target self" });
      return;
    }

    const targetPlayer = room.players.get(targetId);
    if (!targetPlayer) {
      ack(ackFn, { ok: false, error: "player not found" });
      return;
    }

    const nextMuted = payload?.muted !== false;
    targetPlayer.chatMuted = nextMuted;
    emitRoomUpdate(room);

    const targetSocket = io.sockets.sockets.get(targetId) ?? null;
    if (targetSocket) {
      targetSocket.emit("host:chat-muted", {
        muted: nextMuted,
        by: socket.id,
        at: Date.now()
      });
    }

    ack(ackFn, {
      ok: true,
      targetId,
      targetName: targetPlayer.name,
      muted: nextMuted
    });
  });

  socket.on("room:leave", (ackFn) => {
    leaveCurrentRoom(socket);
    ack(ackFn, { ok: true, room: null });
  });

  socket.on("disconnecting", () => {
    leaveCurrentRoom(socket);
    clearSocketDeltaCache(socket);
  });

  socket.on("disconnect", () => {
    playerCount = Math.max(0, playerCount - 1);
    console.log(`[-] player disconnected (${playerCount}) ${socket.id}`);
  });
});

const PORT = Number(process.env.PORT ?? 3001);
httpServer.on("error", (error) => {
  if (error && error.code === "EADDRINUSE") {
    void (async () => {
      const existingServer = await probeExistingServer(PORT);
      if (existingServer) {
        console.log(`Port ${PORT} is already in use. Existing sync server is running.`);
        process.exit(0);
      }

      console.error(`Port ${PORT} is in use by another process. Free the port or set a different PORT.`);
      process.exit(1);
    })();
    return;
  }

  console.error("Sync server failed to start:", error);
  process.exit(1);
});

httpServer.listen(PORT, () => {
  console.log(`Chat server running on http://localhost:${PORT}`);
  console.log(
    `[track] ${String(ACTIVE_TRACK_BLUEPRINT?.id ?? "car-race-alpha-track")} progress=${TRACK_PROGRESS_READY ? "ready" : "invalid"} checkpoints=${TRACK_CHECKPOINT_PROGRESS_VALUES.length} centerline=${TRACK_CENTERLINE_POINTS.length} colliders=${Number(TRACK_COLLIDER_LAYOUT?.segmentCount || 0)}`
  );
  if (WORKER_SINGLE_ROOM_MODE) {
    console.log(
      `Room worker mode (${WORKER_FIXED_ROOM_CODE}, capacity ${MAX_ROOM_PLAYERS}, participant limit ${ENTRY_PARTICIPANT_LIMIT}, token ${
        REQUIRE_JOIN_TOKEN ? "required" : "optional"
      })`
    );
    return;
  }
  console.log(
    `Match rooms enabled (${ROOM_CODE_PREFIX}-xxxxx, capacity ${MAX_ROOM_PLAYERS}, participant limit ${ENTRY_PARTICIPANT_LIMIT}, max rooms ${MAX_ACTIVE_ROOMS})`
  );
});




