# OX Removal RG Checklist (Runtime-focused)

## Goal

Find and remove any remaining OX/quiz runtime path with deterministic `rg` checks.

## 1) Search Priority

1. `P0` hard-block keywords (must be zero in runtime code).
2. `P1` mode-entry route checks (`car-race-alpha` default/fallback).
3. `P2` UI/network/world residual checks.
4. `P3` docs/scripts references (allowed for history/audit only).

## 2) P0 Hard-block Keywords

Run:

```powershell
rg -n '(?i)quiz|oxArena|OX 퀴즈|특이점 OX|ROOM_CODE_PREFIX\s*=\s*"OX"|race:next|race:prev|race:force-lock' src server.js index.html src/styles/main.css
```

Pass criteria:

1. No hits in runtime code (`src`, `server.js`, `index.html`, `src/styles/main.css`).
2. Hits are allowed only in `docs/` and `scripts/audit-ox.mjs`.

## 3) P1 Mode-entry Route (race-only)

### A. Boot path

```powershell
rg -n 'contentPackId:\s*"car-race-alpha"' src/main.js
```

Pass criteria:

1. Boot content pack is `car-race-alpha`.

### B. Registry fallback path

```powershell
rg -n 'DEFAULT_CONTENT_PACK_ID|getContentPack\(|listContentPacks\(' src/game/content/registry.js
```

Pass criteria:

1. Default is `car-race-alpha`.
2. Fallback request (`base-void` or empty) resolves to race pack.
3. Exposed list does not promote OX/quiz mode pack.

## 4) P2 Residual Checks (UI / Network / World)

### A. Portal -> OX route remnants

```powershell
rg -n '(?i)portal.*ox|ox.*portal|targetUrl.*ox|portal-target.*ox' src server.js index.html
```

### B. UI id/class text remnants

```powershell
rg -n '(?i)quiz|ox|truefalse|btn-ox|ox-' index.html src/styles/main.css src/game/ui src/game/runtime
```

### C. Legacy question/lock control

```powershell
rg -n '(?i)question|lock.*answer|answer.*lock|quiz.*state' server.js src/game/runtime src/game/network
```

### D. Checkpoint caution query (manual review)

```powershell
rg -n '(?i)checkpoint' src/game/runtime src/game/world src/server
```

Note:

1. `checkpoint` is valid in race progress logic.
2. Remove only if tied to OX/quiz semantics.

## 5) Deletion Target File Groups (if hits found)

1. Mode entry:
- `src/main.js`
- `src/game/content/registry.js`

2. Client UI/HUD:
- `index.html`
- `src/styles/main.css`
- `src/game/ui/*`
- `src/game/runtime/*`

3. Network/server event path:
- `server.js`
- `src/game/network/*`

4. World/packs:
- `src/game/content/packs/*`
- `src/game/world/*`

## 6) Mandatory Completion Commands

```powershell
npm run audit:ox:strict --silent
npm run verify:map-assets --silent
npm run verify:race-allocation --silent
npm run check:smoke --silent
npm run build --silent
npm run check:load50 --silent
# Or run all gates in one pass:
npm run check:race-ready --silent
```

Pass criteria:

1. OX strict audit: `totalHits = 0`
2. map-assets strict: `completedBundles = 3`, `errors = []`
3. race-allocation: N participants => N cars => N seat assignments
4. smoke/build/load50 pass
