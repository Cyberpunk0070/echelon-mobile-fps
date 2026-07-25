# ECHELON — Operation Ravenglass

A playable mobile-landscape FPS prototype with AI opponents, implemented from the
Claude Design project *Mobile Shooter* (ECHELON / ShooterShell — Modernist ground,
dark theme). Five screens from the design are live: cold boot, lobby, loadout,
gunsmith, and the in-game HUD.

## Play it

**Android app:** `android/app/build/outputs/apk/debug/app-debug.apk` — sideload
it (see *Building the APK*). The native shell forces the panel's highest refresh
mode (120 Hz on an S23 Ultra), immersive fullscreen, landscape, keep-screen-on,
and ships all assets offline.

**Live web build: https://warm-sun-523.higgsfield.gg/** — Chrome or Samsung
Internet on Android, landscape. PLAY goes fullscreen and locks orientation.

Deployment record (for updating the same URL — pass this `game_id` back to
`deploy_game`, never omit it on an update):

- game_id: `db86761f-63d2-4125-9d4e-477c80f64227`
- slug: `warm-sun-523`
- bundle: `index.html` + `logic.js` (inert rules stub; game is client-side) + `js/**` + `fonts/**`

## Run locally

```bash
python -m http.server 8123
```

Then open http://localhost:8123 (ES modules require a server — `file://` won't
work). On a phone, open it in landscape.

## Building the APK

Requires **JDK 21** (Capacitor 7 rejects 17) and the Android SDK. This repo is
wired for a portable JDK at `Z:\jdk21\jdk-21.0.12+8` via
`org.gradle.java.home` in `android/gradle.properties`, and the SDK path lives in
the untracked `android/local.properties` (`sdk.dir=Z:\\AndroidSDK`).

```bash
npm install
```

```bash
pwsh ./build-www.ps1 && npx cap sync android && cd android && ./gradlew.bat assembleDebug
```

The APK lands at `android/app/build/outputs/apk/debug/app-debug.apk`
(package `gg.echelon.ravenglass`, minSdk 24, targetSdk 36). Install it over USB
with `adb install -r <path>`, or copy it to the phone and open it (Android will
ask you to allow installing from unknown sources — it's a debug-signed build,
so Play Protect will warn; that's expected for sideloading).

`build-www.ps1` assembles the Capacitor `webDir` from the game sources, so
always run it (or `npx cap sync`) after editing `index.html` / `js/**`.

## What's implemented

- **Boot sequences** from the design: cold boot (viewmodel parts assembling, red
  scan sweep, hard-stepped counter, telemetry log, glitch on phase change) and
  deploy boot (terrain mesh filling cell by cell) before every match.
- **Lobby / Loadout / Gunsmith** — the design's screens, working. Gunsmith
  attachment chips cycle and move the real stat bars; the three weapons and six
  attachment slots (with the design's exact stat deltas) feed actual ballistics:
  damage, RPM, falloff, spread, recoil, move speed, mag size, reload time.
- **Team deathmatch vs AI** — 6v6 on Ravenglass Dockyard (player + 5 ally bots
  vs 6 enemy bots). Bots come in four archetypes — RUSHER, MARKSMAN, FLANKER,
  ANCHOR — each with its own speed, preferred engagement band, burst cadence,
  accuracy and reaction delay, so they can't all be read the same way. They do
  line-of-sight checks, hold their band, retarget when shot, and fight each
  other. Difficulty escalates with match progress (whichever is further along,
  the clock or the leading score), and a fireteam periodically commits a
  coordinated push onto the player. First to 40 kills or best score at 8:00.
- **Movement**: sprint (1.5×, weapon lowered with a run bob, 0.18 s to raise
  before you can fire), crouch (0.52× speed, lower profile, 0.62× spread, and
  it refuses to stand up without headroom), jump and ledge mantling.
- **Anti-lockout**: the player is depenetrated from any geometry they end up
  inside, recovers from falls out of the world, and every touch id is
  reconciled against the live touch list each event — a dropped `touchend`
  from an Android system gesture can no longer latch the stick or the trigger.
- **CoD-style shooting**: the FIRE button doubles as an aim pad — hold it and
  drag to track a target while the gun is firing. ADS vs hip-fire is a real
  model: aiming interpolates fov, spread, movement speed and look sensitivity
  together, so hip-firing is loose and aimed fire is tight.
- **Four weapons** including the **AM-50 BASILISK** bolt-action sniper: 5×
  scope overlay with mil-dot reticle, one-shot center-mass kill, and hip fire
  so wide it's unusable — you commit to the glass. The LR-13 marksman rifle
  aims at 2.4×, the AR/SMG at 1.35×.
- **HUD** per the design: score bar, minimap with live dots, killfeed, compass,
  crosshair + hitmarker (white on headshot), ammo, armor with regen, contextual
  prompt line, FPS readout, FIRE / RELOAD / VAULT / ADS.
- **Vault/parkour**: VAULT mantles onto ledges up to ~1.9 m in front of you,
  otherwise jumps.
- **Match end** scoreboard with per-operator K/D, REDEPLOY / LOBBY.
- **Staged reload animation**: tilt → mag drops → grab pause → fresh mag seats →
  charging-handle rack, scaled to the loadout's real reload time, with
  phase-timed sounds and a HUD progress bar.
- Procedural WebAudio sound (gunfire, hits, kills, reload phases, damage).

## Performance (120 fps target)

The frame loop is uncapped and vsync-paced, so it renders at whatever the panel
runs at; the native shell requests the highest mode (120 Hz on an S23 Ultra).
Measured 144 fps in-browser on a 144 Hz desktop panel with 78 draw calls.

- **Instanced world**: every static box is drawn from one shared unit-box
  geometry through one `InstancedMesh` per color — the whole dockyard is 6 draw
  calls instead of ~110.
- **Broadphase**: a uniform spatial hash indexes the world AABBs; collision and
  ground queries test only the overlapping cells, and rays walk the grid with a
  2D DDA that stops as soon as the nearest hit precedes the next cell boundary.
- **Segmented hitboxes**: HEAD (2.0×) / CHEST (1.0×) / ABDOMEN (0.9×) /
  LEGS (0.75×) slab-tested in each bot's local frame, replacing the old
  cylinder-plus-height-threshold headshot approximation.
- **Pooled tracers**: all bullet tracers live in a single `LineSegments` over a
  fixed buffer, so sustained crossfire allocates nothing and can't cause GC
  hitches. Total scene geometry count stays at 3.
- **Adaptive resolution** relative to the measured vsync period, not a fixed
  budget: it downscales when the average frame exceeds ~1.7 vsyncs and restores
  when it comfortably fits — correct at both 60 and 120 Hz. The refresh estimate
  uses the *second* smallest frame delta per window so one early rAF callback
  can't skew it.
- Three.js vendored locally (no CDN fetch), capped pixel ratio, MSAA skipped at
  high DPR, `high-performance` WebGL context, self-hosted font.
- HUD DOM writes only on value change; minimap throttled to 12 Hz.

## Android integration
- Fullscreen + landscape orientation lock from the PLAY gesture; RESUME
  re-enters it; auto-pause on fullscreen loss, portrait rotation, tab
  switch/screen lock.
- Android back gesture pauses the match (history sentinel) instead of
  unloading the page; FIRE handles `touchcancel` so system gestures can't
  stick the weapon in full-auto.

## Controls

Controls sit in two thumb clusters with a guaranteed-empty centre channel,
positioned off shared layout tokens (`--edge-*`, `--col2-*`) that also absorb
the punch-hole and gesture-bar safe areas, so no two controls can collide.

| Action | Touch | Desktop |
|---|---|---|
| Move | left-side virtual stick | WASD |
| Look | drag right side | mouse (click canvas for pointer lock) |
| Fire | hold FIRE | left mouse |
| Aim while firing | drag from the FIRE button | mouse (always free) |
| ADS / scope | ADS button (toggle) | hold right mouse |
| Sprint | SPRINT | Shift |
| Crouch | CROUCH | C |
| Reload | RELOAD | R |
| Jump / vault | JUMP | Space |
| Pause | MENU | Esc / back gesture |

## Files

- `index.html` — all screens + Modernist CSS (Archivo, #151312 / #ff563c tokens)
- `js/app.js` — screen state machine, boot sequences, lobby/loadout/gunsmith
- `js/data.js` — weapon/attachment/log/phase tables from the design file
- `js/game.js` — Three.js world, player controller, combat, ADS, HUD, audio
- `js/bots.js` — AI opponents
- `android/` — Capacitor shell (`MainActivity.java` sets the 120 Hz display mode)
- `build-www.ps1` — assembles the Capacitor `webDir`
