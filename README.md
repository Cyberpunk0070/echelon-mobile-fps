# ECHELON — Operation Ravenglass

A playable mobile-landscape FPS prototype with AI opponents, implemented from the
Claude Design project *Mobile Shooter* (ECHELON / ShooterShell — Modernist ground,
dark theme). Five screens from the design are live: cold boot, lobby, loadout,
gunsmith, and the in-game HUD.

## Run

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
- Procedural WebAudio sound (gunfire, hits, kills, reload, damage).

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
