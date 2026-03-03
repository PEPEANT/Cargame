# OX Removal Checklist (Step-by-step)

## Goal

Remove OX quiz legacy safely while keeping service stable.

## Stage 0 (Done in this iteration)

- Default content pack switched to `car-race-alpha`.
- Room code prefix switched from `OX` to `CR`.
- OX audit script added: `npm run audit:ox`.

## Stage 1 (Done)

- Remove OX/quiz UI blocks from `index.html` and `main.css`.
- Replace host controls with race controls (start grid / countdown / restart).
- Remove OX-specific HUD texts.

## Stage 2 (Done)

- Remove OX server events (`quiz:*`) and replace with race session events.
- Remove OX question config storage and related handlers.
- Keep portal admission contract.

### Stage 2 progress notes (2026-03-03)

1. Removed legacy question-control handlers: `race:next`, `race:prev`, `race:force-lock`.
2. Removed legacy `questions` payload handling in `race:config:set`.
3. `startrace` now runs `start -> running` flow (no question/lock pipeline).
4. Snapshot and score payload no longer emit question/lock/result events.

## Stage 3 (In progress)

- Remove remaining OX visual assets/config from base content pack.
- Finalize race-only world config cleanup across all packs.

## Stage 4

- Run strict audit: `npm run audit:ox:strict`.
- Fix all remaining OX hits in code paths that ship.

## Verification

1. `npm run audit:ox` shows declining hit count each stage.
2. `npm run audit:ox:strict` passes when removal is complete.
3. Use `docs/OX_REMOVAL_RG_CHECKLIST.md` for runtime-first search keywords, deletion target file groups, and mode-entry route checks.
