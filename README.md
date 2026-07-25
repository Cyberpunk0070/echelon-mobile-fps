# ECHELON — Operation Ravenglass

A playable mobile-landscape FPS prototype with AI opponents, implemented from the
Claude Design project *Mobile Shooter* (ECHELON / ShooterShell — Modernist ground,
dark theme). Five screens from the design are live: cold boot, lobby, loadout,
gunsmith, and the in-game HUD.

## Play it

**Live (phone-ready): https://warm-sun-523.higgsfield.gg/** — open in Chrome or
Samsung Internet on Android, landscape. PLAY goes fullscreen and locks
landscape orientation.

Deployment record (for updating the same URL — pass this `game_id` back to
`deploy_game`, never omit it on an update):

- game_id: `db86761f-63d2-4125-9d4e-477c80f64227`
- slug: `warm-sun-523`
- bundle: `index.html` + `logic.js` (inert rules stub; game is client-side) + `js/**`

## Run locally

```bash
python -m http.server 8123
```

Then open http://localhost:8123 (ES modules + Three.js CDN require a server —
`file://` won't work). On a phone, open it in landscape.

## What's implemented

- **Boot sequences** from the design: cold boot (viewmodel parts assembling, red
  scan sweep, hard-stepped counter, telemetry log, glitch on phase change) and
  deploy boot (terrain mesh filling cell by cell) before every match.
- **Lobby / Loadout / Gunsmith** — the design's screens, working. Gunsmith
  attachment chips cycle and move the real stat bars; the three weapons and six
  attachment slots (with the design's exact stat deltas) feed actual ballistics:
  damage, RPM, falloff, spread, recoil, move speed, mag size, reload time.
- **Team deathmatch vs AI** — 6v6 on Ravenglass Dockyard (player + 5 ally bots
  vs 6 enemy bots). Bots have line-of-sight checks, hunt/strafe/burst-fire
  behavior, target switching when shot, respawns, and fight each other so the
  score keeps moving. First team to 40 kills or best score at 8:00 wins.
- **HUD** per the design: score bar, minimap with live dots, killfeed, compass,
  crosshair + hitmarker (white on headshot), ammo, armor with regen, contextual
  prompt line, FIRE / RELOAD / VAULT.
- **Vault/parkour**: VAULT mantles onto ledges up to ~1.9 m in front of you,
  otherwise jumps.
- **Match end** scoreboard with per-operator K/D, REDEPLOY / LOBBY.
- **Staged reload animation**: tilt → mag drops → grab pause → fresh mag seats →
  charging-handle rack, scaled to the loadout's real reload time, with
  phase-timed sounds and a HUD progress bar.
- Procedural WebAudio sound (gunfire, hits, kills, reload phases, damage).

## Android optimizations

- Three.js vendored locally (no CDN fetch), capped pixel ratio, MSAA skipped at
  high DPR, `high-performance` WebGL context.
- Adaptive resolution: pixel ratio steps down under sustained load and recovers
  using the display's measured vsync floor (works on 60/120 Hz).
- Shared unit-box geometry + material cache; HUD DOM writes only on change;
  minimap throttled to 12 Hz.
- Fullscreen + landscape orientation lock from the PLAY gesture; RESUME
  re-enters it; auto-pause on fullscreen loss, portrait rotation, tab
  switch/screen lock.
- Android back gesture pauses the match (history sentinel) instead of
  unloading the page; FIRE handles `touchcancel` so system gestures can't
  stick the weapon in full-auto.

## Controls

| Action | Touch | Desktop |
|---|---|---|
| Move | left-side virtual stick | WASD |
| Look | drag right side | mouse (click canvas for pointer lock) |
| Fire | hold FIRE | left mouse |
| Reload | RELOAD | R |
| Vault / jump | VAULT | Space |
| Pause | MENU | Esc |

## Files

- `index.html` — all screens + Modernist CSS (Archivo, #151312 / #ff563c tokens)
- `js/app.js` — screen state machine, boot sequences, lobby/loadout/gunsmith
- `js/data.js` — weapon/attachment/log/phase tables from the design file
- `js/game.js` — Three.js world, player controller, combat, HUD, audio
- `js/bots.js` — AI opponents
