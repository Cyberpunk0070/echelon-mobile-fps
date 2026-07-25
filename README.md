<div align="center">

<img src="docs/hero.png" alt="ECHELON — Operation Ravenglass" width="100%">

<br>

<a href="https://warm-sun-523.higgsfield.gg/"><img src="https://img.shields.io/badge/PLAY_IN_BROWSER-ff563c?style=for-the-badge&labelColor=ff563c&color=ff563c" alt="Play in browser" height="34"></a>
&nbsp;
<a href="https://github.com/Cyberpunk0070/echelon-mobile-fps/releases/latest"><img src="https://img.shields.io/badge/DOWNLOAD_APK-151312?style=for-the-badge&logo=android&logoColor=ff563c&labelColor=151312" alt="Download APK" height="34"></a>

<br><br>

<img src="https://img.shields.io/badge/Three.js_r160-151312?style=flat-square&logo=threedotjs&logoColor=ff563c&labelColor=151312" alt="Three.js">
<img src="https://img.shields.io/badge/JavaScript-151312?style=flat-square&logo=javascript&logoColor=ff563c&labelColor=151312" alt="JavaScript">
<img src="https://img.shields.io/badge/WebGL-151312?style=flat-square&logo=webgl&logoColor=ff563c&labelColor=151312" alt="WebGL">
<img src="https://img.shields.io/badge/HTML5-151312?style=flat-square&logo=html5&logoColor=ff563c&labelColor=151312" alt="HTML5">
<img src="https://img.shields.io/badge/Capacitor-151312?style=flat-square&logo=capacitor&logoColor=ff563c&labelColor=151312" alt="Capacitor">
<img src="https://img.shields.io/badge/Android-151312?style=flat-square&logo=android&logoColor=ff563c&labelColor=151312" alt="Android">
<img src="https://img.shields.io/badge/Gradle-151312?style=flat-square&logo=gradle&logoColor=ff563c&labelColor=151312" alt="Gradle">

<br>

<img src="https://img.shields.io/badge/no_build_step-211f1e?style=flat-square&labelColor=211f1e&color=211f1e" alt="No build step">
<img src="https://img.shields.io/badge/~250_KB-211f1e?style=flat-square&labelColor=211f1e&color=211f1e" alt="250 KB">
<img src="https://img.shields.io/badge/zero_runtime_deps-211f1e?style=flat-square&labelColor=211f1e&color=211f1e" alt="Zero runtime dependencies">
<img src="https://img.shields.io/badge/offline_capable-211f1e?style=flat-square&labelColor=211f1e&color=211f1e" alt="Offline capable">

</div>

<br>

<table>
<tr><td width="60%" valign="top">

### What this is

ECHELON began as a static design comp — a Swiss/Modernist UI concept for a mobile shooter. Five screens of flat colour and Archivo Black, one red accent, hairline grids, no rounded corners anywhere.

This repository is that comp turned into a game you can actually play. The boot sequence, lobby, loadout, gunsmith and HUD are all functional, and behind them sits a real FPS: hitscan ballistics, segmented per-limb hitboxes, a spatial-hash broadphase, and a squad of AI that fights back and gets harder as the match runs.

The visual language never changed.

</td><td width="40%" valign="top">

### Specification

| | |
|---|---|
| **Mode** | 6v6 team deathmatch |
| **Map** | Ravenglass Dockyard, 2.1 km² |
| **Weapons** | 4 · 6 attachment slots |
| **Enemies** | 4 AI archetypes |
| **Target** | 40 kills / 8:00 |
| **Frame rate** | 120 fps |
| **Draw calls** | 78 |

</td></tr>
</table>

---

<div align="center">

## Gameplay

<img src="docs/shots/03-combat.png" width="100%" alt="Combat — mid-reload with an enemy closing">

<sub><b>CONTACT</b> · Mid-reload with an enemy closing, kill feed live, armour nearly gone and the damage vignette bleeding in at the edges. Captured on-device at 120 fps.</sub>

<br><br>

<table>
<tr>
<td width="50%"><img src="docs/shots/01-lobby.png" alt="Lobby"></td>
<td width="50%"><img src="docs/shots/02-gunsmith.png" alt="Gunsmith"></td>
</tr>
<tr>
<td align="center"><sub><b>LOBBY</b> · The design comp's own layout, working — operator card, playlist hero, season progress, squad roster.</sub></td>
<td align="center"><sub><b>GUNSMITH</b> · Callouts wired by leader line to the parts they name. Attachment deltas drive real ballistics; the stat bars are not decoration.</sub></td>
</tr>
<tr>
<td width="50%"><img src="docs/shots/04-sniper.png" alt="AM-50 BASILISK equipped"></td>
<td width="50%"><img src="docs/shots/05-scoreboard.png" alt="Match end scoreboard"></td>
</tr>
<tr>
<td align="center"><sub><b>AM-50 BASILISK</b> · .50 BMG bolt-action. 45 RPM, five rounds, one shot one kill to centre mass. Hip fire is a prayer.</sub></td>
<td align="center"><sub><b>MATCH END</b> · Per-operator K/D across both teams, scrollable, with REDEPLOY and LOBBY pinned on screen.</sub></td>
</tr>
</table>

</div>

---

## Controls

Two thumb clusters with a guaranteed-empty centre channel. Every control is positioned from shared layout tokens (`--edge-*`, `--col2-*`) that also absorb the punch-hole and gesture-bar safe areas, so no two controls can collide.

| Action | Touch | Desktop |
|:--|:--|:--|
| Move | left virtual stick | <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> |
| Look | drag the right side | mouse — click to lock the pointer |
| Fire | hold **FIRE** | left mouse |
| Aim while firing | drag off **FIRE**, or use a second finger | mouse is always free |
| ADS / scope | tap **ADS** — toggle | hold right mouse |
| **Sprint** | **push the stick to the outer ring** | <kbd>Shift</kbd> |
| Crouch | **CROUCH** | <kbd>C</kbd> |
| Reload | **RELOAD** | <kbd>R</kbd> |
| Jump / mantle | **JUMP** | <kbd>Space</kbd> |
| Pause | **MENU** | <kbd>Esc</kbd> / back gesture |

<table><tr><td>

**Why the input is built this way.** Touch controls started out single-touch: while any finger was down, taps on other buttons did nothing. The cause was `click` — it is single-pointer, and the browser stops synthesising it for an entire gesture once `preventDefault()` runs on another active touch.

Input is now built on **Pointer Events, one independent stream per finger**. Every control reacts to `pointerdown` and owns its own `pointerId`, with pointer capture guaranteeing the matching release even if the thumb slides off — so a control can neither be blocked nor left latched. Nothing depends on `click`. Move, look, fire, ADS and reload are all usable simultaneously.

**Sprint has no button.** Shove the movement stick to the outer ring while heading forward and the ring lights red (0.95 in / 0.8 out hysteresis). Combat outranks sprint — firing, aiming, reloading or crouching suppress it — so a stick parked at the ring never cancels your aim or blocks the trigger.

</td></tr></table>

---

## The AI

Enemies are not one averaged behaviour. Each bot is drawn from four archetypes with genuinely different threat profiles:

| Archetype | Speed | Band | Cadence | Behaviour |
|:--|:--|:--|:--|:--|
| **RUSHER** | 5.2 m/s | 3–14 m | 820 RPM | Closes hard and brawls, shortest reaction |
| **MARKSMAN** | 3.5 m/s | 26–55 m | 260 RPM | Holds long angles, highest accuracy |
| **FLANKER** | 4.8 m/s | 6–22 m | 700 RPM | Wide routes, heavy strafing |
| **ANCHOR** | 4.0 m/s | 12–34 m | 600 RPM | Holds ground and suppresses |

Each has its own turn rate, burst pattern, accuracy and **reaction delay** — a bot that has just spotted you cannot fire instantly. They run line-of-sight checks, hold their preferred range band, retarget when shot, and fight each other as well as you.

Difficulty **escalates** with match progress, tracking whichever is further along: the clock or the leading score. Late rounds are faster, sharper and more aggressive. Periodically a fireteam commits a **coordinated push** onto your position.

---

## Under the hood

The frame loop is uncapped and vsync-paced; the native Android shell requests the panel's highest refresh mode. Measured **120 fps on a Galaxy S23 Ultra** and 144 fps on a 144 Hz desktop panel, at 78 draw calls.

| | |
|:--|:--|
| **Instanced world** | Every static box draws from one shared unit-box geometry through one `InstancedMesh` per colour. The whole dockyard is **6 draw calls instead of ~110**. |
| **Pooled tracers** | All tracers live in a single `LineSegments` over a fixed buffer. Sustained crossfire allocates nothing, so there are no GC hitches — total scene geometry count stays at **3**. |
| **Adaptive resolution** | Scales relative to the *measured* vsync period rather than a fixed frame budget, so it behaves correctly at both 60 and 120 Hz. The refresh estimate uses the second-smallest frame delta per window, so one early `rAF` callback cannot skew it. |
| **Spatial-hash broadphase** | A uniform grid indexes the world AABBs. Collision and ground queries test only overlapping cells; rays walk the grid with a **2D DDA** that stops as soon as the nearest hit precedes the next cell boundary. |
| **Segmented hitboxes** | `HEAD` ×2.0 · `CHEST` ×1.0 · `ABDOMEN` ×0.9 · `LEGS` ×0.75, slab-tested in each bot's local frame. A headshot is a real head intersection, not a height comparison. |
| **Never stuck** | The player is depenetrated from any geometry they end up inside — previously both movement axes failed forever — recovers from falls out of the world, and every pointer id is reconciled so a dropped release from an Android system gesture cannot latch the stick or the trigger. |

Three.js is vendored locally and the font is self-hosted: **no network fetches at runtime**.

---

## Run it locally

`http.server` serves whatever directory you are standing in, so run it from the project root:

```bash
cd echelon-mobile-fps && python -m http.server 8123
```

Then open <http://localhost:8123>. ES modules need a server — opening `index.html` over `file://` will fail on CORS. Any static server works; there is nothing Python-specific about it. No `npm install` required for the web build.

## Build the APK

Requires **JDK 21** — Capacitor 7 rejects 17 — and the Android SDK. Point Gradle at your JDK via `org.gradle.java.home` in `~/.gradle/gradle.properties`, and set `sdk.dir` in the untracked `android/local.properties`.

```bash
npm install
```

```bash
pwsh ./build-www.ps1 && npx cap sync android && cd android && ./gradlew.bat assembleDebug
```

The APK lands at `android/app/build/outputs/apk/debug/app-debug.apk` — package `gg.echelon.ravenglass`, minSdk 24, targetSdk 36. Install with `adb install -r <path>`.

The native shell forces the display's highest refresh mode, immersive sticky fullscreen, landscape orientation and keep-screen-on, and ships every asset offline.

> [!NOTE]
> The published build is **debug-signed**, so Android will warn about unknown sources and Play Protect may flag it. That is expected for sideloading — a release build needs your own signing keystore.

## Layout

```
index.html          all five screens + the Modernist CSS
js/app.js           screen state machine, boot sequences, lobby/loadout/gunsmith
js/data.js          weapon, attachment, telemetry and phase tables
js/game.js          Three.js world, player controller, combat, ADS, HUD, audio
js/bots.js          AI archetypes and combat behaviour
android/            Capacitor shell — MainActivity sets the 120 Hz display mode
docs/shots/         the screenshots above, captured on-device
```

---

<div align="center">
<sub>Built with <a href="https://claude.com/claude-code">Claude Code</a></sub>
</div>
