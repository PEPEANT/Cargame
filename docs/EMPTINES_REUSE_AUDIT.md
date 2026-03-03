# Emptines Reuse Audit (2026-03-03)

## Scope

- Reference path: `C:\Users\rneet\OneDrive\Desktop\Emptines`
- Target area: HUD / UI / rendering improvements for Cargame race rebuild

## Imported This Round

1. Rendering code pattern only (no asset file copy):
- ACES filmic tone mapping + exposure wiring
- Applied in `src/game/runtime/GameRuntime.js`
- Tuned through `world.postProcessing.exposure` in `car-race-alpha` pack
2. HUD update tuning pattern only (no asset file copy):
- FPS sample window + HUD refresh interval throttling
- Applied in `src/game/runtime/GameRuntime.js`
- Derived from Emptines runtime tuning approach (`HUD_FPS_SAMPLE_SECONDS`, `HUD_REFRESH_INTERVAL_SECONDS`)

## Deferred (License/Ownership Review Needed Before Import)

1. Additional visual assets (images/video/fonts) found in Emptines `public/` tree:
- Not imported in this round
- Require explicit source + license chain before copying into Cargame assets

2. Large UI/CSS block reuse:
- Candidate exists (`Emptines/src/styles/main.css`)
- Not directly imported to avoid mixing unknown external media/font dependencies

## License Notes

1. Emptines contains license/source references in its README and asset SOURCE files.
2. This round imported code logic only; no third-party binary/media asset was copied from Emptines.
