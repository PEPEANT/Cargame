import * as THREE from "three";
import { io } from "socket.io-client";
import { HUD } from "../ui/HUD.js";
import { GAME_CONSTANTS } from "../config/gameConstants.js";
import { getContentPack } from "../content/registry.js";
import { RACE_SEAT_DEFAULTS, RACE_SESSION_DEFAULTS } from "../modes/race/RaceSessionDefaults.js";
import { isLikelyTouchDevice } from "../utils/device.js";
import { buildRoadMeshesFromCenterline } from "../world/track/clientRoadMesh.js";
import { buildTrackPropInstancesFromPack } from "../world/track/clientTrackProps.js";

const DELTA_POS_SCALE = 100;
const DELTA_ROT_SCALE = 1000;
const EXTRAPOLATION_MAX_SECONDS = 0.18;
const HUD_FPS_SAMPLE_SECONDS = 0.5;
const HUD_REFRESH_INTERVAL_SECONDS = 0.15;

function parseVec3(raw, fallback) {
  const source = Array.isArray(raw) ? raw : fallback;
  return new THREE.Vector3(
    Number(source?.[0] ?? fallback[0]) || 0,
    Number(source?.[1] ?? fallback[1]) || 0,
    Number(source?.[2] ?? fallback[2]) || 0
  );
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function resolveSocketEndpoint() {
  if (typeof window === "undefined") {
    return "http://localhost:3001";
  }
  const params = new URLSearchParams(window.location.search);
  const explicit = String(params.get("server") ?? "").trim();
  if (explicit) {
    return explicit;
  }
  const protocol = window.location.protocol === "https:" ? "https:" : "http:";
  return `${protocol}//${window.location.hostname}:3001`;
}

function resolveOwnerAccess() {
  if (typeof window === "undefined") {
    return false;
  }
  const params = new URLSearchParams(window.location.search);
  const owner = String(
    params.get("owner") ??
      params.get("owner_key") ??
      params.get("hostKey") ??
      params.get("host_key") ??
      ""
  ).trim();
  return owner.length > 0;
}

function createRemoteMesh(material) {
  const group = new THREE.Group();

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 0.82, 6, 10), material);
  // Remote avatar origin is aligned to feet on ground.
  body.position.y = 0.76;
  body.castShadow = true;
  body.receiveShadow = true;

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.25, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0xd4b59b, roughness: 0.7, metalness: 0 })
  );
  head.position.y = 1.6;
  head.castShadow = true;
  head.receiveShadow = true;

  group.add(body, head);
  return group;
}

export class GameRuntime {
  constructor(mount, options = {}) {
    this.mount = mount;
    this.clock = new THREE.Clock();
    this.mobileEnabled = isLikelyTouchDevice();
    this.hud = new HUD();
    this.graphicsPanelOpen = false;
    this.graphicsQualityStorageKey = "graphicsQuality_v1";
    this.graphicsQuality = this.loadGraphicsQualityPreference();
    this.autoResolutionEnabled = true;

    this.contentPack = options.contentPack ?? getContentPack(options.contentPackId);
    this.worldContent = this.contentPack.world;
    this.networkContent = this.contentPack.network;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(Number(this.worldContent?.skyColor) || 0xa6d3f7);
    const fogDensity = Number(this.worldContent?.fogDensity) || 0;
    this.scene.fog =
      fogDensity > 0
        ? new THREE.FogExp2(this.scene.background.getHex(), fogDensity)
        : new THREE.Fog(this.scene.background.getHex(), 90, 620);

    this.camera = new THREE.PerspectiveCamera(
      GAME_CONSTANTS.DEFAULT_FOV,
      window.innerWidth / window.innerHeight,
      0.1,
      1400
    );

    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.mobileEnabled,
      powerPreference: "high-performance"
    });
    const devicePixelRatio = Math.max(1, Number(window.devicePixelRatio) || 1);
    this.maxPixelRatio = Math.min(devicePixelRatio, this.mobileEnabled ? 1.4 : 1.6);
    this.minPixelRatio = Math.min(this.maxPixelRatio, this.mobileEnabled ? 0.75 : 0.9);
    this.currentPixelRatio = this.maxPixelRatio;
    this.lastQualityAdjustAt = 0;
    this.renderer.setPixelRatio(this.currentPixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    const rendererExposure = Number(this.worldContent?.postProcessing?.exposure);
    this.renderer.toneMappingExposure = Number.isFinite(rendererExposure) ? rendererExposure : 1.02;
    this.renderer.shadowMap.enabled = !this.mobileEnabled;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.applyGraphicsQualityOverrides();

    this.playerPosition = new THREE.Vector3(0, GAME_CONSTANTS.PLAYER_HEIGHT, 0);
    this.playerVelocityY = 0;
    this.onGround = true;
    this.yaw = 0;
    this.pitch = 0;
    this.keys = new Set();
    this.pointerLocked = false;
    this.pointerLockSupported =
      "pointerLockElement" in document &&
      typeof this.renderer.domElement.requestPointerLock === "function";

    this.moveForward = new THREE.Vector3();
    this.moveRight = new THREE.Vector3();
    this.moveDelta = new THREE.Vector3();
    this.remotePredictedPosition = new THREE.Vector3();
    this.netSyncClock = 0;
    this.netSyncInterval = Math.max(1 / 16, Number(this.networkContent?.syncInterval) || 1 / 12);
    this.remoteLerpSpeed = Math.max(4, Number(this.networkContent?.remoteLerpSpeed) || 12);

    this.socket = null;
    this.socketEndpoint = resolveSocketEndpoint();
    this.networkConnected = false;
    this.localPlayerId = null;
    this.currentRoomCode = "";
    this.ownerAccessEnabled = resolveOwnerAccess();
    this.remotePlayers = new Map();
    this.remoteMeshPool = [];
    this.remoteMaterial = new THREE.MeshStandardMaterial({
      color: 0x77c8ff,
      roughness: 0.55,
      metalness: 0.04
    });
    this.raceProgress = {
      lap: 0,
      progress: 0,
      offTrack: false,
      updatedAt: 0
    };
    this.raceSessionConfig = {
      seatMode: RACE_SESSION_DEFAULTS.seatModeDefault,
      allowManualOption: true,
      autoSeatDelaySeconds: RACE_SEAT_DEFAULTS.autoSeatDelaySeconds,
      autoSeatOnReachVehicle: RACE_SEAT_DEFAULTS.autoSeatOnReachVehicle,
      autoSeatReachRadius: RACE_SEAT_DEFAULTS.autoSeatReachRadius
    };
    this.assignedSeat = null;
    this.lastManualBoardAttemptAt = 0;
    this.manualBoardInFlight = false;

    this.ambientLight = null;
    this.sunLight = null;
    this.ground = null;
    this.startGridPlatformMesh = null;
    this.portalGroup = null;
    this.roadGroup = null;
    this.trackPropGroup = null;
    this.trackPropVisibility = {
      enabled: false,
      updateInterval: 0.2,
      hysteresis: 16,
      clock: 0
    };
    this.trackPropVisibilityEntries = [];
    this.hudFpsSampleClock = 0;
    this.hudFpsFrameCounter = 0;
    this.hudFpsSmoothed = 0;
    this.hudRefreshClock = 0;

    this.portalOpenBtnEl = document.getElementById("portal-open-btn");
    this.portalAdmitBtnEl = document.getElementById("portal-admit-btn");
    this.portalTargetInputEl = document.getElementById("portal-target-input");
    this.portalTargetSaveBtnEl = document.getElementById("portal-target-save-btn");
    this.fullscreenToggleBtnEl = document.getElementById("fullscreen-toggle");
    this.graphicsToggleBtnEl = document.getElementById("graphics-toggle");
    this.graphicsControlsEl = document.getElementById("graphics-controls");
    this.graphicsQualitySelectEl = document.getElementById("graphics-quality-select");
    this.raceControlsEl = document.getElementById("race-controls");
    this.raceControlsNoteEl = document.getElementById("race-controls-note");
    this.chatUiEl = document.getElementById("chat-ui");
    this.chatLogEl = document.getElementById("chat-log");
    this.chatControlsEl = document.getElementById("chat-controls");
    this.chatInputEl = document.getElementById("chat-input");
    this.chatSendBtnEl = document.getElementById("chat-send-btn");
    this.chatHideBtnEl = document.getElementById("chat-hide-btn");
    this.chatCloseBtnEl = document.getElementById("chat-close-btn");
    this.mobileChatPreviewEl = document.getElementById("mobile-chat-preview");
    this.mobileChatToggleBtnEl = document.getElementById("mobile-chat-toggle-btn");
    this.chatMuted = false;
    this.chatUnreadCount = 0;
    this.chatMaxEntries = 80;
    this.chatOpen = !this.mobileEnabled;
    this.chatPreviewDismissTimer = null;

    this.boundLoop = this.loop.bind(this);
    this.boundResize = this.onResize.bind(this);
    this.boundMouseMove = this.onMouseMove.bind(this);
    this.boundPointerLock = this.onPointerLockChange.bind(this);
    this.boundKeyDown = this.onKeyDown.bind(this);
    this.boundKeyUp = this.onKeyUp.bind(this);
    this.boundPointerDown = this.onPointerDown.bind(this);
    this.boundDocumentPointerDown = this.onDocumentPointerDown.bind(this);
    this.boundFullscreenChange = this.onFullscreenChange.bind(this);
  }

  init() {
    this.mount.innerHTML = "";
    this.mount.appendChild(this.renderer.domElement);
    this.setupWorld();
    this.setupRoadFromCenterline();
    this.setupPortalMarker();
    this.bindDomEvents();
    this.bindRaceControls();
    this.bindChatUi();
    this.connectSocket();
    this.updateFullscreenToggleState();
    this.syncGraphicsControlsUi();
    this.updateRaceControlsVisibility();
    this.hud.setStatus("Booting race runtime");
    requestAnimationFrame(this.boundLoop);
  }

  setupWorld() {
    this.ambientLight = new THREE.HemisphereLight(0xe8f6ff, 0x8a94a3, 0.86);
    this.scene.add(this.ambientLight);

    this.sunLight = new THREE.DirectionalLight(0xffffff, 0.96);
    this.sunLight.position.set(72, 122, 54);
    this.sunLight.castShadow = !this.mobileEnabled;
    this.sunLight.shadow.mapSize.set(this.mobileEnabled ? 1024 : 1536, this.mobileEnabled ? 1024 : 1536);
    this.sunLight.shadow.camera.near = 1;
    this.sunLight.shadow.camera.far = 600;
    this.sunLight.shadow.camera.left = -260;
    this.sunLight.shadow.camera.right = 260;
    this.sunLight.shadow.camera.top = 260;
    this.sunLight.shadow.camera.bottom = -260;
    this.sunLight.shadow.bias = -0.00016;
    this.scene.add(this.sunLight);

    const groundSize = Math.max(460, Number(this.worldContent?.ground?.size) || 460);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x4f5964,
      roughness: 0.95,
      metalness: 0.02
    });
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(groundSize, groundSize), groundMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.ground.position.y = 0;
    this.scene.add(this.ground);

    const raceConfig = this.worldContent?.race ?? {};
    const startGrid = raceConfig?.startGrid ?? {};
    const startGridPlatform = raceConfig?.spawnHub?.startGridPlatform ?? {};
    if (startGridPlatform?.enabled !== false) {
      const platformSize = Array.isArray(startGridPlatform?.size) ? startGridPlatform.size : [54, 1.04, 34];
      const sx = Math.max(14, Number(platformSize?.[0]) || 54);
      const sy = Math.max(0.2, Number(platformSize?.[1]) || 1.04);
      const sz = Math.max(12, Number(platformSize?.[2]) || 34);
      const platformCenter = Array.isArray(startGridPlatform?.center)
        ? startGridPlatform.center
        : [Number(startGrid?.anchor?.[0]) || 0, sy * 0.5, Number(startGrid?.anchor?.[2]) || -24];
      const platformGeometry = new THREE.BoxGeometry(sx, sy, sz);
      const platformMaterial = new THREE.MeshStandardMaterial({
        color: 0x59626e,
        roughness: 0.95,
        metalness: 0.02
      });
      this.startGridPlatformMesh = new THREE.Mesh(platformGeometry, platformMaterial);
      this.startGridPlatformMesh.position.set(
        Number(platformCenter?.[0]) || 0,
        Number(platformCenter?.[1]) || sy * 0.5,
        Number(platformCenter?.[2]) || -24
      );
      this.startGridPlatformMesh.receiveShadow = true;
      this.startGridPlatformMesh.castShadow = false;
      this.startGridPlatformMesh.name = "start-grid-platform";
      this.scene.add(this.startGridPlatformMesh);
    }

    this.playerPosition.copy(parseVec3(this.worldContent?.race?.spawnHub?.spawn, [0, GAME_CONSTANTS.PLAYER_HEIGHT, -86]));
    this.camera.position.copy(this.playerPosition);
  }

  setupRoadFromCenterline() {
    const built = buildRoadMeshesFromCenterline();
    if (!built?.group) {
      return;
    }
    this.roadGroup = built.group;
    this.scene.add(this.roadGroup);
    this.setupTrackPropsFromPack(built.curve);
  }

  async setupTrackPropsFromPack(curve) {
    if (!curve) {
      return;
    }
    const trackPropGroup = await buildTrackPropInstancesFromPack(undefined, curve);
    if (!trackPropGroup) {
      return;
    }
    this.trackPropGroup = trackPropGroup;
    this.scene.add(trackPropGroup);
    this.configureTrackPropVisibilityState();
    this.updateTrackPropVisibility(0, true);
  }

  configureTrackPropVisibilityState() {
    this.trackPropVisibilityEntries = [];
    const group = this.trackPropGroup;
    if (!group) {
      return;
    }
    const visibilityConfig = group?.userData?.visibility ?? {};
    this.trackPropVisibility.enabled = visibilityConfig?.enabled !== false;
    this.trackPropVisibility.updateInterval = 1 / Math.max(1, Number(visibilityConfig?.updateHz) || 5);
    this.trackPropVisibility.hysteresis = Math.max(0, Number(visibilityConfig?.hysteresis) || 16);
    this.trackPropVisibility.clock = 0;
    group.updateMatrixWorld(true);

    group.traverse((node) => {
      if (!node?.isMesh) {
        return;
      }
      const range = node?.userData?.visibilityRange;
      if (!range || typeof range !== "object") {
        return;
      }
      const centerRaw = Array.isArray(range?.center) ? range.center : [0, 0, 0];
      const radius = Math.max(1, Number(range?.radius) || 1);
      const maxDistance = Number(range?.maxDistance);
      if (!Number.isFinite(maxDistance) || maxDistance <= 0) {
        return;
      }
      const centerLocal = new THREE.Vector3(
        Number(centerRaw?.[0]) || 0,
        Number(centerRaw?.[1]) || 0,
        Number(centerRaw?.[2]) || 0
      );
      const centerWorld = centerLocal.clone().applyMatrix4(node.matrixWorld);
      this.trackPropVisibilityEntries.push({
        mesh: node,
        centerWorldX: Number(centerWorld.x) || 0,
        centerWorldY: Number(centerWorld.y) || 0,
        centerWorldZ: Number(centerWorld.z) || 0,
        radius,
        baseLimit: Math.max(1, maxDistance + radius)
      });
    });
  }

  updateTrackPropVisibility(delta, force = false) {
    if (!this.trackPropVisibility.enabled || this.trackPropVisibilityEntries.length <= 0) {
      return;
    }
    if (!force) {
      this.trackPropVisibility.clock += Math.max(0, Number(delta) || 0);
      if (this.trackPropVisibility.clock < this.trackPropVisibility.updateInterval) {
        return;
      }
      this.trackPropVisibility.clock %= this.trackPropVisibility.updateInterval;
    }

    const hysteresis = this.trackPropVisibility.hysteresis;
    const playerX = Number(this.playerPosition.x) || 0;
    const playerY = Number(this.playerPosition.y) || 0;
    const playerZ = Number(this.playerPosition.z) || 0;
    for (const entry of this.trackPropVisibilityEntries) {
      const mesh = entry?.mesh;
      if (!mesh) {
        continue;
      }
      const dx = playerX - Number(entry.centerWorldX || 0);
      const dy = playerY - Number(entry.centerWorldY || 0);
      const dz = playerZ - Number(entry.centerWorldZ || 0);
      const distanceSq = dx * dx + dy * dy + dz * dz;
      const extra = mesh.visible ? hysteresis : 0;
      const limit = Number(entry.baseLimit || 1) + extra;
      mesh.visible = distanceSq <= limit * limit;
    }
  }

  setupPortalMarker() {
    const portalPosition = parseVec3(this.worldContent?.hubFlow?.portal?.position, [44, 0.08, 14]);
    const portalRadius = Math.max(2.2, Number(this.worldContent?.hubFlow?.portal?.radius) || 4.4);
    const group = new THREE.Group();
    group.position.set(portalPosition.x, 0, portalPosition.z);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(portalRadius, 0.24, 16, this.mobileEnabled ? 42 : 74),
      new THREE.MeshStandardMaterial({
        color: 0x74d2ff,
        emissive: 0x2e8fc4,
        emissiveIntensity: 0.7,
        roughness: 0.24,
        metalness: 0.18
      })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 1.8;
    group.add(ring);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(portalRadius * 0.86, this.mobileEnabled ? 20 : 48),
      new THREE.MeshBasicMaterial({
        color: 0x4bbef8,
        transparent: true,
        opacity: 0.3,
        side: THREE.DoubleSide
      })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.03;
    group.add(floor);

    this.portalGroup = group;
    this.scene.add(group);
  }

  bindDomEvents() {
    window.addEventListener("resize", this.boundResize);
    document.addEventListener("mousemove", this.boundMouseMove, { passive: true });
    document.addEventListener("pointerlockchange", this.boundPointerLock, { passive: true });
    document.addEventListener("fullscreenchange", this.boundFullscreenChange);
    document.addEventListener("webkitfullscreenchange", this.boundFullscreenChange);
    document.addEventListener("keydown", this.boundKeyDown);
    document.addEventListener("keyup", this.boundKeyUp);
    document.addEventListener("pointerdown", this.boundDocumentPointerDown);
    this.renderer.domElement.addEventListener("pointerdown", this.boundPointerDown);
    this.fullscreenToggleBtnEl?.addEventListener("click", () => {
      this.toggleFullscreenFromInteraction();
    });
    this.graphicsToggleBtnEl?.addEventListener("click", (event) => {
      event.preventDefault();
      this.graphicsPanelOpen = !this.graphicsPanelOpen;
      this.syncGraphicsControlsUi();
    });
    this.graphicsQualitySelectEl?.addEventListener("change", () => {
      this.setGraphicsQuality(this.graphicsQualitySelectEl.value, { persist: true });
    });
  }

  onDocumentPointerDown(event) {
    const target = event?.target;
    if (!this.graphicsPanelOpen || !target) {
      return;
    }
    const clickedGraphicsToggle =
      this.graphicsToggleBtnEl &&
      typeof this.graphicsToggleBtnEl.contains === "function" &&
      this.graphicsToggleBtnEl.contains(target);
    const clickedGraphicsPanel =
      this.graphicsControlsEl &&
      typeof this.graphicsControlsEl.contains === "function" &&
      this.graphicsControlsEl.contains(target);
    if (!clickedGraphicsToggle && !clickedGraphicsPanel) {
      this.graphicsPanelOpen = false;
      this.syncGraphicsControlsUi();
    }
  }

  onFullscreenChange() {
    this.updateFullscreenToggleState();
  }

  isFullscreenActive() {
    return Boolean(document.fullscreenElement ?? document.webkitFullscreenElement);
  }

  updateFullscreenToggleState() {
    if (!this.fullscreenToggleBtnEl) {
      return;
    }
    const fullscreen = this.isFullscreenActive();
    this.fullscreenToggleBtnEl.textContent = fullscreen ? "전체화면 해제" : "전체화면";
    this.fullscreenToggleBtnEl.setAttribute("aria-pressed", fullscreen ? "true" : "false");
  }

  async toggleFullscreenFromInteraction() {
    const root = document.documentElement;
    if (!root) {
      return;
    }
    const requestFn = root.requestFullscreen ?? root.webkitRequestFullscreen;
    const exitFn = document.exitFullscreen ?? document.webkitExitFullscreen;
    try {
      if (this.isFullscreenActive()) {
        if (typeof exitFn === "function") {
          await exitFn.call(document);
        }
      } else if (typeof requestFn === "function") {
        await requestFn.call(root);
      }
    } catch {
      // ignore and preserve current viewport state
    } finally {
      this.updateFullscreenToggleState();
    }
  }

  normalizeGraphicsQuality(rawQuality) {
    const quality = String(rawQuality ?? "").trim().toLowerCase();
    if (quality === "low" || quality === "high") {
      return quality;
    }
    return "medium";
  }

  loadGraphicsQualityPreference() {
    try {
      const saved = localStorage.getItem(this.graphicsQualityStorageKey);
      return this.normalizeGraphicsQuality(saved);
    } catch {
      return "medium";
    }
  }

  saveGraphicsQualityPreference() {
    try {
      localStorage.setItem(this.graphicsQualityStorageKey, this.graphicsQuality);
    } catch {
      // ignore persistence errors
    }
  }

  applyGraphicsQualityOverrides() {
    const quality = this.normalizeGraphicsQuality(this.graphicsQuality);
    this.graphicsQuality = quality;
    const devicePixelRatio = Math.max(1, Number(window.devicePixelRatio) || 1);
    let maxRatioCap = this.mobileEnabled ? 1.25 : 1.6;
    let minRatio = this.mobileEnabled ? 0.72 : 0.88;
    let dynamicEnabled = true;

    if (quality === "low") {
      maxRatioCap = this.mobileEnabled ? 0.95 : 1.0;
      minRatio = this.mobileEnabled ? 0.55 : 0.68;
      dynamicEnabled = true;
    } else if (quality === "high") {
      maxRatioCap = this.mobileEnabled ? 1.35 : 1.9;
      minRatio = this.mobileEnabled ? 0.86 : 1.0;
      dynamicEnabled = false;
    }

    this.autoResolutionEnabled = dynamicEnabled;
    this.maxPixelRatio = Math.min(devicePixelRatio, Math.max(0.7, maxRatioCap));
    this.minPixelRatio = Math.min(this.maxPixelRatio, Math.max(0.5, minRatio));
    this.currentPixelRatio = Number(
      clamp(this.currentPixelRatio, this.minPixelRatio, this.maxPixelRatio).toFixed(3)
    );
    if (quality === "low") {
      this.currentPixelRatio = this.minPixelRatio;
    } else if (quality === "high") {
      this.currentPixelRatio = this.maxPixelRatio;
    }

    this.renderer.shadowMap.enabled = !this.mobileEnabled && quality !== "low";
    this.renderer.setPixelRatio(this.currentPixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
  }

  setGraphicsQuality(rawQuality, { persist = true } = {}) {
    const nextQuality = this.normalizeGraphicsQuality(rawQuality);
    this.graphicsQuality = nextQuality;
    if (persist) {
      this.saveGraphicsQualityPreference();
    }
    this.applyGraphicsQualityOverrides();
    this.syncGraphicsControlsUi();
  }

  syncGraphicsControlsUi() {
    const quality = this.normalizeGraphicsQuality(this.graphicsQuality);
    this.graphicsQuality = quality;
    const blocked = this.mobileEnabled;
    if (blocked && this.graphicsPanelOpen) {
      this.graphicsPanelOpen = false;
    }
    const labelMap = {
      high: "높음",
      medium: "기본",
      low: "낮음"
    };
    if (this.graphicsToggleBtnEl) {
      this.graphicsToggleBtnEl.textContent = `그래픽: ${labelMap[quality] ?? "기본"}`;
      this.graphicsToggleBtnEl.classList.toggle("hidden", blocked);
      this.graphicsToggleBtnEl.setAttribute("aria-pressed", this.graphicsPanelOpen ? "true" : "false");
    }
    if (this.graphicsQualitySelectEl && this.graphicsQualitySelectEl.value !== quality) {
      this.graphicsQualitySelectEl.value = quality;
    }
    if (this.graphicsControlsEl) {
      this.graphicsControlsEl.classList.toggle("hidden", blocked || !this.graphicsPanelOpen);
    }
  }

  bindRaceControls() {
    this.portalOpenBtnEl?.addEventListener("click", () => {
      if (!this.socket || !this.networkConnected) {
        this.setSystemStatus("Server not connected");
        return;
      }
      this.socket.emit("portal:lobby-open", (response = {}) => {
        this.setSystemStatus(
          response?.ok ? "Portal opened" : `Portal open failed: ${String(response?.error ?? "unknown")}`
        );
      });
    });

    this.portalAdmitBtnEl?.addEventListener("click", () => {
      if (!this.socket || !this.networkConnected) {
        this.setSystemStatus("Server not connected");
        return;
      }
      this.socket.emit("portal:lobby-start", (response = {}) => {
        if (response?.ok) {
          this.setSystemStatus("Admission countdown started");
          return;
        }
        if (response?.error === "no players waiting admission") {
          this.setSystemStatus("No waiting players");
          return;
        }
        this.setSystemStatus(`Admission failed: ${String(response?.error ?? "unknown")}`);
      });
    });

    this.portalTargetSaveBtnEl?.addEventListener("click", () => {
      if (!this.socket || !this.networkConnected) {
        this.setSystemStatus("Server not connected");
        return;
      }
      const targetUrl = String(this.portalTargetInputEl?.value ?? "").trim();
      this.socket.emit("portal:set-target", { targetUrl }, (response = {}) => {
        this.setSystemStatus(
          response?.ok ? "Portal target saved" : `Target save failed: ${String(response?.error ?? "unknown")}`
        );
      });
    });
  }

  updateRaceControlsVisibility() {
    if (!this.raceControlsEl) {
      return;
    }
    const visible = this.ownerAccessEnabled || !this.mobileEnabled;
    this.raceControlsEl.classList.toggle("hidden", !visible);
    if (this.raceControlsNoteEl) {
      this.raceControlsNoteEl.textContent = visible
        ? "Race portal and moderation controls are enabled."
        : "Owner access key is required for race controls.";
    }
  }

  bindChatUi() {
    if (!this.chatUiEl || !this.chatLogEl) {
      return;
    }
    this.chatControlsEl?.classList.remove("hidden");
    this.chatUiEl.classList.toggle("mobile-chat-hidden", this.mobileEnabled && !this.chatOpen);
    this.updateMobileChatToggleState();

    this.chatSendBtnEl?.addEventListener("click", () => {
      this.sendChatMessage();
    });
    this.chatInputEl?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this.sendChatMessage();
      }
      event.stopPropagation();
    });
    this.chatInputEl?.addEventListener("focus", () => {
      if (this.mobileEnabled) {
        document.body.classList.add("mobile-chat-focus");
      }
    });
    this.chatInputEl?.addEventListener("blur", () => {
      if (this.mobileEnabled) {
        document.body.classList.remove("mobile-chat-focus");
      }
    });
    this.chatHideBtnEl?.addEventListener("click", () => {
      if (this.mobileEnabled) {
        this.chatOpen = false;
        this.chatUiEl?.classList.add("mobile-chat-hidden");
        document.body.classList.remove("mobile-chat-focus");
        this.updateMobileChatToggleState();
      }
    });
    this.chatCloseBtnEl?.addEventListener("click", () => {
      if (!this.mobileEnabled) {
        this.chatInputEl?.focus();
        return;
      }
      this.chatOpen = !this.chatOpen;
      this.chatUiEl?.classList.toggle("mobile-chat-hidden", !this.chatOpen);
      if (!this.chatOpen) {
        document.body.classList.remove("mobile-chat-focus");
      }
      if (this.chatOpen) {
        this.chatUnreadCount = 0;
        this.clearMobileChatPreview();
      }
      this.updateMobileChatToggleState();
    });
    this.mobileChatToggleBtnEl?.addEventListener("click", () => {
      this.chatOpen = !this.chatOpen;
      this.chatUiEl?.classList.toggle("mobile-chat-hidden", !this.chatOpen);
      if (this.chatOpen) {
        this.chatUnreadCount = 0;
        this.clearMobileChatPreview();
        this.chatInputEl?.focus();
      } else {
        document.body.classList.remove("mobile-chat-focus");
      }
      this.updateMobileChatToggleState();
    });
  }

  updateMobileChatToggleState() {
    if (!this.mobileEnabled || this.chatOpen) {
      this.clearMobileChatPreview();
    }
    if (!this.mobileChatToggleBtnEl) {
      return;
    }
    this.mobileChatToggleBtnEl.classList.toggle("hidden", !this.mobileEnabled);
    this.mobileChatToggleBtnEl.classList.toggle("active", this.chatOpen);
    if (this.chatUnreadCount > 0) {
      this.mobileChatToggleBtnEl.dataset.unread = String(Math.min(99, this.chatUnreadCount));
    } else {
      delete this.mobileChatToggleBtnEl.dataset.unread;
    }
  }

  clearMobileChatPreview() {
    if (this.chatPreviewDismissTimer) {
      clearTimeout(this.chatPreviewDismissTimer);
      this.chatPreviewDismissTimer = null;
    }
    if (!this.mobileChatPreviewEl) {
      return;
    }
    this.mobileChatPreviewEl.textContent = "";
    this.mobileChatPreviewEl.classList.add("hidden");
  }

  appendMobileChatPreview(payload = {}) {
    if (!this.mobileEnabled || this.chatOpen || !this.mobileChatPreviewEl) {
      return;
    }
    const text = String(payload?.text ?? "").trim();
    if (!text) {
      return;
    }
    const name = String(payload?.name ?? "PLAYER").trim();
    const line = document.createElement("p");
    line.className = "mobile-chat-preview-line";
    line.textContent = `${name}: ${text}`;
    this.mobileChatPreviewEl.appendChild(line);
    while (this.mobileChatPreviewEl.childElementCount > 4) {
      this.mobileChatPreviewEl.removeChild(this.mobileChatPreviewEl.firstElementChild);
    }
    this.mobileChatPreviewEl.classList.remove("hidden");
    if (this.chatPreviewDismissTimer) {
      clearTimeout(this.chatPreviewDismissTimer);
    }
    this.chatPreviewDismissTimer = setTimeout(() => {
      this.clearMobileChatPreview();
    }, 4500);
  }

  appendChatLine(payload = {}, { system = false, trackUnread = true } = {}) {
    if (!this.chatLogEl) {
      return;
    }
    const text = String(payload?.text ?? "").trim();
    if (!text) {
      return;
    }
    const line = document.createElement("p");
    line.className = `chat-line${system ? " system" : ""}${
      String(payload?.id ?? "") === String(this.localPlayerId ?? "") ? " self" : ""
    }`;
    if (!system) {
      const name = document.createElement("span");
      name.className = "chat-name";
      name.textContent = `${String(payload?.name ?? "PLAYER")}:`;
      line.appendChild(name);
    }
    line.appendChild(document.createTextNode(text));
    this.chatLogEl.appendChild(line);
    while (this.chatLogEl.childElementCount > this.chatMaxEntries) {
      this.chatLogEl.removeChild(this.chatLogEl.firstElementChild);
    }
    this.chatLogEl.scrollTop = this.chatLogEl.scrollHeight;

    if (trackUnread && this.mobileEnabled && !this.chatOpen && !system) {
      this.chatUnreadCount += 1;
      this.appendMobileChatPreview(payload);
      this.updateMobileChatToggleState();
    }
  }

  renderChatHistory(payload = {}) {
    if (!this.chatLogEl) {
      return;
    }
    this.chatLogEl.textContent = "";
    const history = Array.isArray(payload?.entries) ? payload.entries : [];
    for (const entry of history) {
      this.appendChatLine(entry, { system: String(entry?.type ?? "") === "system", trackUnread: false });
    }
  }

  sendChatMessage() {
    if (!this.socket || !this.networkConnected || this.chatMuted) {
      return;
    }
    const text = String(this.chatInputEl?.value ?? "").trim();
    if (!text) {
      return;
    }
    this.socket.emit("chat:send", { text }, (response = {}) => {
      if (!response?.ok) {
        const reason = String(response?.error ?? "send failed");
        this.appendChatLine({ text: `채팅 전송 실패: ${reason}` }, { system: true });
        return;
      }
      if (this.chatInputEl) {
        this.chatInputEl.value = "";
      }
    });
  }

  connectSocket() {
    this.socket = io(this.socketEndpoint, {
      transports: ["websocket"],
      timeout: 7000,
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 220
    });

    this.socket.on("connect", () => {
      this.networkConnected = true;
      this.localPlayerId = this.socket?.id ?? null;
      this.currentRoomCode = "";
      this.raceProgress = { lap: 0, progress: 0, offTrack: false, updatedAt: Date.now() };
      this.assignedSeat = null;
      this.manualBoardInFlight = false;
      this.chatMuted = false;
      this.chatUnreadCount = 0;
      this.updateMobileChatToggleState();
      this.setSystemStatus(`Connected to ${this.socketEndpoint}`);
      this.socket.emit("room:list");
    });

    this.socket.on("connect_error", (error) => {
      const reason = String(error?.message ?? "network error").trim();
      this.setSystemStatus(`Connect failed: ${reason}`);
    });

    this.socket.on("disconnect", () => {
      this.networkConnected = false;
      this.raceProgress = { lap: 0, progress: 0, offTrack: false, updatedAt: Date.now() };
      this.assignedSeat = null;
      this.manualBoardInFlight = false;
      this.chatMuted = false;
      this.chatUnreadCount = 0;
      this.updateMobileChatToggleState();
      this.currentRoomCode = "";
      this.clearRemotePlayers();
      this.setSystemStatus("Disconnected");
    });

    this.socket.on("race:config:update", (payload = {}) => {
      this.applyRaceConfigPayload(payload);
    });

    this.socket.on("race:seat:assigned", (payload = {}) => {
      this.applyRaceSeatAssignmentPayload(payload);
    });
    this.socket.on("race:seat:boarded", (payload = {}) => {
      const vehicleId = String(payload?.vehicleId ?? "").trim();
      this.setSystemStatus(`Manual boarded: ${vehicleId || "assigned car"}`);
    });

    this.socket.on("race:progress:self", (payload = {}) => {
      this.applyRaceProgressPayload(payload, true);
    });

    this.socket.on("race:progress", (payload = {}) => {
      const id = String(payload?.id ?? "").trim();
      if (id && id === this.localPlayerId) {
        this.applyRaceProgressPayload(payload, false);
      }
    });

    this.socket.on("race:lap", (payload = {}) => {
      const id = String(payload?.id ?? "").trim();
      if (id && this.localPlayerId && id !== this.localPlayerId) {
        return;
      }
      const lap = Math.max(0, Math.trunc(Number(payload?.lap) || 0));
      this.raceProgress.lap = lap;
      this.setSystemStatus(`Lap ${lap} complete`);
    });

    this.socket.on("player:sync", (payload = {}) => {
      this.updateRemotePlayerFromSync(payload);
    });

    this.socket.on("player:delta", (payload = {}) => {
      const updates = Array.isArray(payload?.updates) ? payload.updates : [];
      for (const update of updates) {
        this.updateRemotePlayerFromDelta(update);
      }
      const removals = Array.isArray(payload?.removes) ? payload.removes : [];
      for (const removeId of removals) {
        this.removeRemotePlayer(removeId);
      }
    });

    this.socket.on("player:correct", (payload = {}) => {
      this.applyPlayerCorrectionPayload(payload);
    });

    this.socket.on("room:list", (rooms = []) => {
      const list = Array.isArray(rooms) ? rooms : [];
      const preferredCode = String(this.currentRoomCode || "").trim();
      const current = preferredCode ? list.find((entry) => String(entry?.code ?? "") === preferredCode) : list[0];
      const count = Math.max(0, Number(current?.count) || 0);
      this.hud.setPlayers(count);
    });

    this.socket.on("room:update", (payload = {}) => {
      const code = String(payload?.code ?? "").trim();
      if (code) {
        this.currentRoomCode = code;
      }
      const players = Array.isArray(payload?.players) ? payload.players : [];
      this.hud.setPlayers(players.length);
    });

    this.socket.on("portal:target:update", (payload = {}) => {
      const next = String(payload?.targetUrl ?? "").trim();
      if (this.portalTargetInputEl && this.portalTargetInputEl.value !== next) {
        this.portalTargetInputEl.value = next;
      }
    });

    this.socket.on("chat:history", (payload = {}) => {
      this.renderChatHistory(payload);
    });
    this.socket.on("chat:message", (payload = {}) => {
      this.appendChatLine(payload);
    });
    this.socket.on("host:chat-muted", (payload = {}) => {
      this.chatMuted = payload?.muted === true;
      if (this.chatInputEl) {
        this.chatInputEl.disabled = this.chatMuted;
      }
      if (this.chatSendBtnEl) {
        this.chatSendBtnEl.disabled = this.chatMuted;
      }
      this.appendChatLine(
        { text: this.chatMuted ? "채팅이 제한되었습니다." : "채팅 제한이 해제되었습니다." },
        { system: true }
      );
    });
  }

  applyRaceConfigPayload(payload = {}) {
    const sessionDraft = payload?.sessionDraft ?? null;
    const seatAssignment = sessionDraft?.seatAssignment ?? {};
    const nextSeatMode = String(
      seatAssignment?.mode ??
        seatAssignment?.defaultMode ??
        this.raceSessionConfig.seatMode ??
        RACE_SESSION_DEFAULTS.seatModeDefault
    )
      .trim()
      .toLowerCase() === "manual"
      ? "manual"
      : "auto";
    const previousSeatMode = this.raceSessionConfig.seatMode;
    this.raceSessionConfig = {
      seatMode: nextSeatMode,
      allowManualOption: seatAssignment?.allowManualOption !== false,
      autoSeatDelaySeconds: Math.max(
        0,
        Number(seatAssignment?.autoSeatDelaySeconds) || RACE_SEAT_DEFAULTS.autoSeatDelaySeconds
      ),
      autoSeatOnReachVehicle: seatAssignment?.autoSeatOnReachVehicle !== false,
      autoSeatReachRadius: Math.max(
        1.6,
        Number(seatAssignment?.autoSeatReachRadius) || RACE_SEAT_DEFAULTS.autoSeatReachRadius
      )
    };
    this.syncLocalSeatAssignmentFromSessionDraft(sessionDraft);
    if (previousSeatMode !== nextSeatMode) {
      this.setSystemStatus(nextSeatMode === "manual" ? "Seat mode: Manual boarding" : "Seat mode: Auto boarding");
    }
  }

  syncLocalSeatAssignmentFromSessionDraft(sessionDraft = null) {
    const localId = String(this.localPlayerId ?? "").trim();
    if (!localId) {
      return;
    }
    const seatAssignments = Array.isArray(sessionDraft?.seatAssignments) ? sessionDraft.seatAssignments : [];
    const mine = seatAssignments.find((item) => String(item?.playerId ?? "").trim() === localId);
    if (!mine) {
      return;
    }
    const seatPosition =
      mine?.seatPosition && typeof mine.seatPosition === "object" ? mine.seatPosition : mine?.spawn ?? null;
    if (!seatPosition) {
      return;
    }
    this.assignedSeat = {
      vehicleId: String(mine?.vehicleId ?? ""),
      mode: this.raceSessionConfig.seatMode,
      seatPosition: {
        x: Number(seatPosition?.x) || 0,
        y: Number(seatPosition?.y) || GAME_CONSTANTS.PLAYER_HEIGHT,
        z: Number(seatPosition?.z) || 0
      },
      headingRadians: Number(mine?.headingRadians) || 0,
      autoSeatAt: 0
    };
  }

  applyRaceSeatAssignmentPayload(payload = {}) {
    const assignment = payload?.assignment ?? null;
    if (!assignment) {
      return;
    }
    const playerId = String(assignment?.playerId ?? "").trim();
    const localId = String(this.localPlayerId ?? "").trim();
    if (!playerId || !localId || playerId !== localId) {
      return;
    }
    const seatPosition =
      assignment?.seatPosition && typeof assignment.seatPosition === "object"
        ? assignment.seatPosition
        : assignment?.spawn ?? null;
    if (!seatPosition) {
      return;
    }
    const mode = String(payload?.mode ?? this.raceSessionConfig.seatMode ?? RACE_SESSION_DEFAULTS.seatModeDefault)
      .trim()
      .toLowerCase() === "manual"
      ? "manual"
      : "auto";
    this.assignedSeat = {
      vehicleId: String(assignment?.vehicleId ?? ""),
      mode,
      seatPosition: {
        x: Number(seatPosition?.x) || 0,
        y: Number(seatPosition?.y) || GAME_CONSTANTS.PLAYER_HEIGHT,
        z: Number(seatPosition?.z) || 0
      },
      headingRadians: Number(assignment?.headingRadians) || 0,
      autoSeatAt: Math.max(0, Math.trunc(Number(payload?.autoSeatAt) || 0))
    };
    this.raceSessionConfig.autoSeatReachRadius = Math.max(
      1.6,
      Number(payload?.autoSeatReachRadius) ||
        Number(this.raceSessionConfig?.autoSeatReachRadius) ||
        RACE_SEAT_DEFAULTS.autoSeatReachRadius
    );

    if (payload?.autoApplied === true) {
      this.setSystemStatus(`Auto boarded: ${this.assignedSeat.vehicleId || "assigned car"}`);
      return;
    }
    if (mode === "manual") {
      this.setSystemStatus("Assigned car ready. Manual boarding: press F near your seat.");
      return;
    }
    const seconds = Math.max(0, Number(payload?.autoSeatDelaySeconds) || 0).toFixed(1);
    this.setSystemStatus(`Assigned car ready. Auto boarding in ${seconds}s`);
  }

  applyPlayerCorrectionPayload(payload = {}) {
    const state = payload?.state ?? null;
    if (!state || typeof state !== "object") {
      return;
    }
    const x = Number(state?.x);
    const y = Number(state?.y);
    const z = Number(state?.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return;
    }
    this.playerPosition.set(x, y, z);
    if (Number.isFinite(Number(state?.yaw))) {
      this.yaw = Number(state.yaw);
    }
    if (Number.isFinite(Number(state?.pitch))) {
      this.pitch = Number(state.pitch);
    }
    this.camera.position.copy(this.playerPosition);
    this.camera.rotation.set(this.pitch, this.yaw, 0, "YXZ");

    const reason = String(payload?.reason ?? "").trim().toLowerCase();
    if (reason.includes("race-auto-seat")) {
      this.setSystemStatus("Auto boarded into assigned car");
      return;
    }
    if (reason.includes("race-manual-seat")) {
      this.setSystemStatus("Manual seat confirmed");
    }
  }

  tryManualBoardAssignedSeat() {
    const seat = this.assignedSeat;
    if (!seat || seat.mode !== "manual") {
      return false;
    }
    const now = performance.now();
    if (now - Number(this.lastManualBoardAttemptAt || 0) < 180) {
      return false;
    }
    this.lastManualBoardAttemptAt = now;
    const seatPos = seat.seatPosition ?? null;
    if (!seatPos) {
      return false;
    }
    const dx = Number(seatPos.x) - this.playerPosition.x;
    const dy = Number(seatPos.y) - this.playerPosition.y;
    const dz = Number(seatPos.z) - this.playerPosition.z;
    const distance = Math.hypot(dx, dy, dz);
    if (
      distance >
      Math.max(
        1.6,
        Number(this.raceSessionConfig?.autoSeatReachRadius) || RACE_SEAT_DEFAULTS.autoSeatReachRadius
      )
    ) {
      this.setSystemStatus("Move closer to your assigned car seat");
      return false;
    }
    if (!this.socket || !this.networkConnected) {
      this.playerPosition.set(
        Number(seatPos.x) || 0,
        Number(seatPos.y) || GAME_CONSTANTS.PLAYER_HEIGHT,
        Number(seatPos.z) || 0
      );
      this.yaw = Number(seat.headingRadians) || this.yaw;
      this.camera.position.copy(this.playerPosition);
      this.camera.rotation.set(this.pitch, this.yaw, 0, "YXZ");
      this.setSystemStatus(`Manual boarded: ${seat.vehicleId || "assigned car"}`);
      return true;
    }
    if (this.manualBoardInFlight) {
      return false;
    }

    this.manualBoardInFlight = true;
    this.socket.emit("race:seat:board", { vehicleId: seat.vehicleId }, (response = {}) => {
      this.manualBoardInFlight = false;
      if (!response?.ok) {
        if (response?.error === "too far from seat") {
          this.setSystemStatus("Move closer to your assigned car seat");
          return;
        }
        this.setSystemStatus(`Manual board failed: ${String(response?.error ?? "unknown")}`);
        return;
      }
      this.applyPlayerCorrectionPayload({
        state: response?.state ?? null,
        reason: "race-manual-seat"
      });
      this.setSystemStatus(`Manual boarded: ${seat.vehicleId || "assigned car"}`);
    });
    return true;
  }

  updateRemotePlayerFromSync(payload) {
    const id = String(payload?.id ?? "").trim();
    if (!id || id === this.localPlayerId) {
      return;
    }
    const state = payload?.state ?? payload;
    const x = Number(state?.x);
    const y = Number(state?.y);
    const z = Number(state?.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return;
    }
    const yaw = Number(state?.yaw) || 0;
    const remote = this.ensureRemotePlayer(id);
    this.setRemoteTarget(remote, x, y - GAME_CONSTANTS.PLAYER_HEIGHT, z, yaw);
  }

  updateRemotePlayerFromDelta(update) {
    const id = String(update?.id ?? "").trim();
    if (!id || id === this.localPlayerId) {
      return;
    }
    const p = Array.isArray(update?.p) ? update.p : null;
    if (!p || p.length < 3) {
      return;
    }
    const r = Array.isArray(update?.r) ? update.r : null;
    const remote = this.ensureRemotePlayer(id);
    const x = (Number(p[0]) || 0) / DELTA_POS_SCALE;
    const y =
      (Number(p[1]) || GAME_CONSTANTS.PLAYER_HEIGHT * DELTA_POS_SCALE) / DELTA_POS_SCALE - GAME_CONSTANTS.PLAYER_HEIGHT;
    const z = (Number(p[2]) || 0) / DELTA_POS_SCALE;
    const yaw =
      r && r.length >= 1 ? (Number(r[0]) || 0) / DELTA_ROT_SCALE : Number(update?.y) || remote.targetYaw || 0;
    this.setRemoteTarget(remote, x, y, z, yaw);
  }

  setRemoteTarget(remote, x, y, z, yaw) {
    const now = performance.now();
    const dtSeconds = Math.max(1 / 240, (now - Number(remote.lastUpdateAt || now)) / 1000);
    const dx = Number(x) - Number(remote.targetPosition?.x || 0);
    const dy = Number(y) - Number(remote.targetPosition?.y || 0);
    const dz = Number(z) - Number(remote.targetPosition?.z || 0);
    remote.velocity.set(dx / dtSeconds, dy / dtSeconds, dz / dtSeconds);
    remote.targetPosition.set(x, y, z);
    remote.targetYaw = Number(yaw) || 0;
    remote.lastUpdateAt = now;
  }

  applyRaceProgressPayload(payload, selfEvent) {
    const lap = Math.max(0, Math.trunc(Number(payload?.lap) || 0));
    const progress = clamp(Number(payload?.progress) || 0, 0, 1);
    const offTrack = payload?.offTrack === true;
    const previousOffTrack = this.raceProgress.offTrack === true;
    this.raceProgress.lap = lap;
    this.raceProgress.progress = progress;
    this.raceProgress.offTrack = offTrack;
    this.raceProgress.updatedAt = Date.now();

    const events = Array.isArray(payload?.events) ? payload.events : [];
    const antiCheatResetEvent = events.find(
      (event) => String(event?.type ?? "").trim().toLowerCase() === "anti-cheat-reset"
    );
    if (antiCheatResetEvent) {
      const reason = String(antiCheatResetEvent?.reason ?? "reset").trim() || "reset";
      this.setSystemStatus(`Anti-cheat reset: ${reason}`);
      return;
    }
    if (events.some((event) => String(event?.type ?? "") === "wrong-way")) {
      this.setSystemStatus("Wrong way detected");
      return;
    }
    if (events.some((event) => String(event?.type ?? "") === "possible-cutting")) {
      this.setSystemStatus("Possible cutting detected");
      return;
    }
    if (offTrack && !previousOffTrack) {
      this.setSystemStatus("Off track");
      return;
    }
    if (!offTrack && previousOffTrack) {
      this.setSystemStatus("Back on track");
      return;
    }
    if (selfEvent && events.some((event) => String(event?.type ?? "") === "checkpoint")) {
      this.setSystemStatus(`Checkpoint ${Math.round(progress * 100)}%`);
    }
  }

  ensureRemotePlayer(id) {
    if (this.remotePlayers.has(id)) {
      return this.remotePlayers.get(id);
    }
    let mesh = this.remoteMeshPool.pop();
    if (!mesh) {
      mesh = createRemoteMesh(this.remoteMaterial);
      this.scene.add(mesh);
    } else {
      mesh.visible = true;
      mesh.position.set(0, 0, 0);
      mesh.rotation.set(0, 0, 0);
    }
    const remote = {
      id,
      mesh,
      targetPosition: new THREE.Vector3(0, 0, 0),
      velocity: new THREE.Vector3(0, 0, 0),
      targetYaw: 0,
      lastUpdateAt: performance.now()
    };
    this.remotePlayers.set(id, remote);
    return remote;
  }

  removeRemotePlayer(id) {
    const key = String(id ?? "").trim();
    if (!key) {
      return;
    }
    const remote = this.remotePlayers.get(key);
    if (!remote) {
      return;
    }
    if (remote.mesh) {
      remote.mesh.visible = false;
      this.remoteMeshPool.push(remote.mesh);
    }
    this.remotePlayers.delete(key);
  }

  clearRemotePlayers() {
    for (const [id] of this.remotePlayers) {
      this.removeRemotePlayer(id);
    }
  }

  onPointerDown() {
    if (!this.pointerLockSupported || this.mobileEnabled) {
      return;
    }
    if (document.pointerLockElement !== this.renderer.domElement) {
      this.renderer.domElement.requestPointerLock();
    }
  }

  onPointerLockChange() {
    this.pointerLocked = document.pointerLockElement === this.renderer.domElement;
  }

  onMouseMove(event) {
    if (!this.pointerLocked) {
      return;
    }
    const sensitivityX = 0.0025;
    const sensitivityY = 0.0021;
    this.yaw -= (event.movementX || 0) * sensitivityX;
    this.pitch -= (event.movementY || 0) * sensitivityY;
    this.pitch = clamp(this.pitch, -Math.PI * 0.49, Math.PI * 0.49);
  }

  onKeyDown(event) {
    const code = String(event?.code ?? "");
    const activeEl = document.activeElement;
    const typingInField =
      activeEl &&
      (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA" || activeEl.isContentEditable === true);
    if (typingInField) {
      if (code === "Escape" && this.chatInputEl === activeEl) {
        this.chatInputEl.blur();
      }
      return;
    }
    if (code === "Escape" && this.graphicsPanelOpen) {
      event.preventDefault();
      this.graphicsPanelOpen = false;
      this.syncGraphicsControlsUi();
      return;
    }
    if (code === "Enter" && this.chatInputEl) {
      event.preventDefault();
      if (this.mobileEnabled && !this.chatOpen) {
        this.chatOpen = true;
        this.chatUiEl?.classList.remove("mobile-chat-hidden");
        this.chatUnreadCount = 0;
        this.updateMobileChatToggleState();
      }
      this.chatInputEl.focus();
      return;
    }
    this.keys.add(code);
    if (code === "KeyF") {
      this.tryManualBoardAssignedSeat();
    }
    if (code === "Space" && this.onGround) {
      this.playerVelocityY = GAME_CONSTANTS.JUMP_FORCE;
      this.onGround = false;
    }
  }

  onKeyUp(event) {
    const code = String(event?.code ?? "");
    this.keys.delete(code);
  }

  onResize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.applyGraphicsQualityOverrides();
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.syncGraphicsControlsUi();
  }

  setSystemStatus(text) {
    this.hud.setStatus(String(text ?? ""));
    if (this.raceControlsNoteEl) {
      this.raceControlsNoteEl.textContent = String(text ?? "");
    }
  }

  updateLocalMovement(delta) {
    const moveSpeed = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight")
      ? GAME_CONSTANTS.PLAYER_SPRINT
      : GAME_CONSTANTS.PLAYER_SPEED;

    const forwardInput = Number(this.keys.has("KeyW") || this.keys.has("ArrowUp")) -
      Number(this.keys.has("KeyS") || this.keys.has("ArrowDown"));
    const rightInput = Number(this.keys.has("KeyD") || this.keys.has("ArrowRight")) -
      Number(this.keys.has("KeyA") || this.keys.has("ArrowLeft"));

    this.moveForward.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.moveRight.set(this.moveForward.z, 0, -this.moveForward.x);

    this.moveDelta.set(0, 0, 0);
    this.moveDelta.addScaledVector(this.moveForward, forwardInput);
    this.moveDelta.addScaledVector(this.moveRight, rightInput);
    if (this.moveDelta.lengthSq() > 1e-6) {
      this.moveDelta.normalize().multiplyScalar(moveSpeed * delta);
      this.playerPosition.add(this.moveDelta);
    }

    this.playerVelocityY += GAME_CONSTANTS.PLAYER_GRAVITY * delta;
    this.playerPosition.y += this.playerVelocityY * delta;
    if (this.playerPosition.y <= GAME_CONSTANTS.PLAYER_HEIGHT) {
      this.playerPosition.y = GAME_CONSTANTS.PLAYER_HEIGHT;
      this.playerVelocityY = 0;
      this.onGround = true;
    }

    this.playerPosition.x = clamp(this.playerPosition.x, -GAME_CONSTANTS.WORLD_LIMIT, GAME_CONSTANTS.WORLD_LIMIT);
    this.playerPosition.z = clamp(this.playerPosition.z, -GAME_CONSTANTS.WORLD_LIMIT, GAME_CONSTANTS.WORLD_LIMIT);

    this.camera.position.copy(this.playerPosition);
    this.camera.rotation.set(this.pitch, this.yaw, 0, "YXZ");
  }

  emitLocalSync(delta) {
    if (!this.socket || !this.networkConnected) {
      return;
    }
    this.netSyncClock += delta;
    if (this.netSyncClock < this.netSyncInterval) {
      return;
    }
    this.netSyncClock %= this.netSyncInterval;
    this.socket.emit("player:sync", {
      x: this.playerPosition.x,
      y: this.playerPosition.y,
      z: this.playerPosition.z,
      yaw: this.yaw,
      pitch: this.pitch
    });
  }

  updateRemotePlayers(delta) {
    const staleAfterMs = 18000;
    const now = performance.now();
    const predicted = this.remotePredictedPosition;
    for (const [id, remote] of this.remotePlayers) {
      if (!remote?.mesh) {
        continue;
      }
      if (now - Number(remote.lastUpdateAt || now) > staleAfterMs) {
        this.removeRemotePlayer(id);
        continue;
      }
      const stalenessSeconds = Math.max(0, (now - Number(remote.lastUpdateAt || now)) / 1000);
      const extrapolationSeconds = Math.min(EXTRAPOLATION_MAX_SECONDS, stalenessSeconds);
      predicted.copy(remote.targetPosition).addScaledVector(remote.velocity, extrapolationSeconds);
      remote.mesh.position.lerp(predicted, clamp(delta * this.remoteLerpSpeed, 0.02, 0.45));
      remote.mesh.rotation.y +=
        Math.atan2(Math.sin(remote.targetYaw - remote.mesh.rotation.y), Math.cos(remote.targetYaw - remote.mesh.rotation.y)) *
        clamp(delta * 11, 0.04, 0.65);
    }
  }

  maybeAdjustDynamicResolution() {
    if (!this.autoResolutionEnabled) {
      return;
    }
    const fps = Number(this.hudFpsSmoothed);
    if (!Number.isFinite(fps) || fps <= 0) {
      return;
    }
    const now = performance.now();
    if (now - Number(this.lastQualityAdjustAt || 0) < 1400) {
      return;
    }
    let next = this.currentPixelRatio;
    if (fps < 44 && this.currentPixelRatio > this.minPixelRatio + 0.01) {
      next = Math.max(this.minPixelRatio, this.currentPixelRatio - (this.mobileEnabled ? 0.08 : 0.1));
    } else if (fps > 58 && this.currentPixelRatio < this.maxPixelRatio - 0.01) {
      next = Math.min(this.maxPixelRatio, this.currentPixelRatio + 0.05);
    }
    if (Math.abs(next - this.currentPixelRatio) < 0.01) {
      return;
    }
    this.currentPixelRatio = Number(next.toFixed(3));
    this.renderer.setPixelRatio(this.currentPixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.lastQualityAdjustAt = now;
  }

  tick(delta) {
    this.updateLocalMovement(delta);
    this.updateTrackPropVisibility(delta);
    this.updateRemotePlayers(delta);
    this.emitLocalSync(delta);
    this.hudFpsSampleClock += delta;
    this.hudFpsFrameCounter += 1;
    if (this.hudFpsSampleClock >= HUD_FPS_SAMPLE_SECONDS) {
      this.hudFpsSmoothed = this.hudFpsFrameCounter / Math.max(this.hudFpsSampleClock, 0.0001);
      this.hudFpsSampleClock = 0;
      this.hudFpsFrameCounter = 0;
      this.maybeAdjustDynamicResolution();
    }

    this.hudRefreshClock += delta;
    if (this.hudRefreshClock >= HUD_REFRESH_INTERVAL_SECONDS) {
      this.hudRefreshClock %= HUD_REFRESH_INTERVAL_SECONDS;
      const localCount = this.networkConnected ? 1 : 0;
      this.hud.update({
        status: this.networkConnected ? "Online / Race staging" : "Offline",
        players: this.remotePlayers.size + localCount,
        lap: this.raceProgress.lap,
        progress: this.raceProgress.progress,
        offTrack: this.raceProgress.offTrack,
        x: this.playerPosition.x,
        z: this.playerPosition.z,
        fps: this.hudFpsSmoothed > 0 ? this.hudFpsSmoothed : delta > 0 ? 1 / delta : 0
      });
    }
  }

  loop() {
    const delta = Math.min(0.05, this.clock.getDelta());
    this.tick(delta);
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this.boundLoop);
  }
}
