function setText(el, value) {
  if (!el) {
    return;
  }
  const nextValue = String(value);
  if (el.textContent !== nextValue) {
    el.textContent = nextValue;
  }
}

export class HUD {
  constructor() {
    this.statusEl = document.getElementById("hud-status");
    this.playersEl = document.getElementById("hud-players");
    this.lapEl = document.getElementById("hud-lap");
    this.progressEl = document.getElementById("hud-progress");
    this.positionEl = document.getElementById("hud-position");
    this.fpsEl = document.getElementById("hud-fps");
    this.enabled = Boolean(
      this.statusEl || this.playersEl || this.lapEl || this.progressEl || this.positionEl || this.fpsEl
    );

    this.cache = {
      status: "",
      players: "",
      lap: "",
      progress: "",
      position: "",
      fps: ""
    };
  }

  setStatus(status) {
    if (!this.enabled) {
      return;
    }
    const next = String(status ?? "\uC624\uD504\uB77C\uC778");
    if (this.cache.status !== next) {
      this.cache.status = next;
      setText(this.statusEl, next);
    }
  }

  setPlayers(count) {
    if (!this.enabled) {
      return;
    }
    const next = String(count ?? 0);
    if (this.cache.players !== next) {
      this.cache.players = next;
      setText(this.playersEl, next);
    }
  }

  setLap(lap) {
    if (!this.enabled) {
      return;
    }
    const next = String(Math.max(0, Math.trunc(Number(lap) || 0)));
    if (this.cache.lap !== next) {
      this.cache.lap = next;
      setText(this.lapEl, next);
    }
  }

  setProgress(progress, offTrack = false) {
    if (!this.enabled) {
      return;
    }
    const ratio = Math.max(0, Math.min(1, Number(progress) || 0));
    const percent = `${Math.round(ratio * 100)}%`;
    const next = offTrack ? `${percent} OFF` : percent;
    if (this.cache.progress !== next) {
      this.cache.progress = next;
      setText(this.progressEl, next);
    }
  }

  setPosition(x, z) {
    if (!this.enabled) {
      return;
    }
    const next = `${Math.round(x ?? 0)}, ${Math.round(z ?? 0)}`;
    if (this.cache.position !== next) {
      this.cache.position = next;
      setText(this.positionEl, next);
    }
  }

  setFps(fps) {
    if (!this.enabled) {
      return;
    }
    const next = String(Math.max(0, Math.round(fps ?? 0)));
    if (this.cache.fps !== next) {
      this.cache.fps = next;
      setText(this.fpsEl, next);
    }
  }

  update(state = {}) {
    if (!this.enabled) {
      return;
    }
    this.setStatus(state.status ?? "\uC624\uD504\uB77C\uC778");
    this.setPlayers(state.players ?? 0);
    this.setLap(state.lap ?? 0);
    this.setProgress(state.progress ?? 0, state.offTrack === true);
    this.setPosition(state.x ?? 0, state.z ?? 0);
    this.setFps(state.fps ?? 0);
  }
}
