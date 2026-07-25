# ECHELON — Multiplayer Server Scope

Target: authoritative 12-player server on a Raspberry Pi 4 (`100.111.106.13`), browser
clients in UK / Germany / India joining a lobby the host opens.

Status: **scope only. Nothing below is implemented.**

---

## 1. Where the codebase actually stands

There is no networking. `js/data.js:11` contains `"NETCODE SYNC · 12ms RTT"` — a cosmetic
boot-log string. The lobby is a menu screen. `Game` (`js/game.js`, 1,545 lines) is a single
class that owns rendering, input, simulation, HUD, and audio, and `update(dt)` interleaves
all of them.

Three things in the existing design make this much cheaper than it looks:

**The map is deterministic.** `buildMap()` (`js/game.js:346`) generates the dockyard from a
fixed Lehmer PRNG seeded at `1337`. Container rows, stacks, and the 26 scattered crates are
all derived from that seed, and the clash test reads back `this.boxes` in a fixed order. Two
processes running the same code produce byte-identical collision geometry. **No map data
needs to cross the network, and there is no asset pipeline to build.**

**Collision and ray queries are already pure.** `collides`, `moveEntity`, `groundHeight`,
`rayWorldDist`, `raycastBots`, `losBlocked`, `SpatialHash`, `slabHit`, `localSlabHit`, and
`HITBOXES` depend only on `this.boxes` and `this.grid`. They touch no Three.js object and no
DOM. They lift out of the renderer essentially unchanged.

**Input is already command-shaped.** The pointer-event rework left the player's intent in a
small, flat set of values: `stick.x/y`, `player.yaw/pitch`, `firing`, plus discrete
`reload`/`vault`/`crouch`/`ads` actions. That is already an input packet; it does not need
redesigning, only serializing.

### What blocks server authority

| Blocker | Location | Fix |
|---|---|---|
| Hit detection is client-authoritative | `tryFire()` raycasts and calls `hitBot.damage()` directly, `js/game.js:1196`–`1227` | Move the raycast server-side; client sends intent only |
| Bot damage applied locally | `handleBotShot()` → `damagePlayer()` / `target.damage()`, `js/game.js:963` | Server-side; becomes a broadcast event |
| `Math.random()` throughout the sim | `spawnFor`, `randomNavPoint`, spread + recoil in `tryFire`, `Bot.fireAt` accuracy and damage rolls, burst timing, archetype selection | Seeded PRNG owned by the server |
| `THREE.Vector3` inside sim state | `player.pos`, `Bot.pos`, module scratch `_a/_b/_v/_dir` | Plain `{x,y,z}` + a ~40-line vec helper; **the Pi has no `three` and should not need it** |
| Variable timestep | `dt` from rAF, clamped to 0.05 (`js/game.js:216`) | Fixed 60 Hz accumulator — prediction and replay require it |
| Map build entangled with rendering | `buildMap()` creates a canvas texture and `InstancedMesh` alongside the AABBs | Split into `buildCollision()` (pure) + `buildMeshes()` (client) |
| Match state is per-client | `this.score`, `this.time`, `MATCH` | Server owns clock and score |
| Ray filter assumes one human | `raycastBots` skips `team === 0` (`js/game.js:497`) | Filter by "not me, not my team" over all combatants |

---

## 2. Architecture

Authoritative server, client-side prediction for own movement, entity interpolation for
everyone else, server-side lag compensation for shots. The standard model — there is no
cleverer option at 120 ms.

```
js/sim/                 ← shared verbatim by browser and Pi (ESM, zero deps)
  rng.js                seeded PRNG; every sim random draw goes through it
  vec.js                minimal vec3 replacing THREE.Vector3 in sim state
  world.js              buildWorld() + SpatialHash + all ray/collision queries
  player.js             stepPlayer(p, input, dt, ctx) — pure
  bots.js               former js/bots.js, THREE stripped, RNG injected
  match.js              clock, score, escalation, push timer, end condition
  index.js              Sim: population, damage routing, the ordered tick
  protocol.js           encode/decode input commands and snapshots  (phase 1)

server/                 ← runs on the Pi under Node 20                (phase 1)
  index.js              ws listener, lobby/room lifecycle, join/leave
  room.js               fixed 60 Hz tick, per-client snapshots, bot fill
  history.js            1 s ring buffer of entity transforms for lag comp

js/game.js              render + input + HUD + audio (+ prediction in phase 2)
```

Note the sim lives at `js/sim/`, not a top-level `sim/`: `build-www.ps1` copies
only `index.html`, `js/` and `fonts/` into the Capacitor `webDir`, so keeping it
inside `js/` means the Android build needs no change.

`sim/` is the contract. It must stay free of Three.js, DOM, `performance`, and
`Math.random`, and it must be the *same files* on both sides — not a reimplementation.
Divergence between two copies of movement code is the classic failure mode here.

### Authority split

- **Server owns:** positions, health, hits, damage, deaths, score, clock, respawns, spread
  rolls, bot behaviour.
- **Client owns:** its own look angles (`yaw`/`pitch`, including recoil kick), and all
  presentation — tracers, muzzle flash, viewmodel, audio, HUD.

Keeping recoil client-side matters. `tryFire()` mutates `p.pitch`/`p.yaw` directly
(`js/game.js:1210`). If the server also applied recoil, predicted aim would diverge every
shot. Instead the client applies recoil locally and reports the resulting **absolute** angle
in its next command; the server accepts it, validating only rate-of-change.

### Firing path

Client sends `{seq, yaw, pitch, fire}`. Server rolls spread from its own RNG, raycasts
against rewound hitboxes, applies damage, broadcasts the result. The client draws a tracer
immediately but the hitmarker arrives one round trip later (~120 ms). That is normal for the
genre and shipped shooters feel like this.

Optional refinement worth taking: derive the spread roll from `hash(playerId, shotCounter)`
so both sides compute the identical offset. The client can then predict its own hitmarker,
which removes the most noticeable piece of perceived lag. Cheap, and a real feel win.

### Rates and budget

- Sim: **60 Hz** fixed step.
- Snapshots: **30 Hz**, delta-compressed against each client's last acknowledged snapshot,
  quantized (positions to ~1 cm, angles to 16 bits).
- **Per-client adaptive interpolation buffer**, sized from that client's own measured jitter
  with a floor of two snapshot intervals (~66 ms). The measurements make this the single
  highest-value piece of the netcode: the correct buffer is 95 ms for Germany, 50 ms for
  off-peak India, and ~270 ms for peak-hour India. One global constant would either punish
  the good connections or break the bad one. Sizing it per client from a rolling jitter
  estimate handles all three automatically and degrades gracefully when a link congests
  mid-match, rather than requiring anyone to reconnect.
- ~12 entities × ~20 B ≈ 250 B/snapshot → ~7.5 KB/s per client → **~90 KB/s (0.7 Mbit/s)
  upstream for a full 12-player lobby.** Comfortable on residential upload.
- Pi 4 headroom: 4 × Cortex-A72, 3.1 GB free. The current sim runs 11 bots at 120 fps on a
  phone; 12 entities at 60 Hz is not close to the limit. Lag-comp history is 60 × 12 × ~32 B
  ≈ 23 KB. CPU is a non-issue; **jitter is the real constraint.**

---

## 3. Transport

The client page is served over HTTPS, so `ws://` is blocked as mixed content — TLS is
mandatory, not optional.

**Use the cloudflared tunnel already running on the Pi** (`vyuha-cloudflared-1`). It
terminates TLS for free, needs no port forwarding, and does not expose the home IP.
Cloudflare proxies WebSockets fine. It also usually *helps* the India↔UK case: the player
enters the Cloudflare backbone at a nearby PoP instead of traversing the open internet the
whole way. Expect ~5–15 ms over a direct connection, with better consistency.

Bind the server to **port 7900** — 3000, 7788, 7799, 8000, 9443 are taken.

WebSocket means TCP, so a lost packet head-of-line blocks the ones behind it. **Measurement
settles this: WebSocket is the right choice and WebRTC is not needed.** Germany recorded a
0.4% stall rate with a worst run of 5; off-peak India recorded 0% against a 404 ms
threshold. There is essentially no retransmission on either path, so head-of-line blocking
is not a cost being paid. Critically, the one genuinely bad result — peak-hour India — was
*queuing*, and queuing is completely immune to transport choice. WebRTC DataChannel would
have added ICE/STUN/TURN, broken CF tunnel compatibility, and fixed none of it.

**Drop WebRTC from the plan** rather than deferring it. Revisit only if a future client
shows a materially different stall profile.

### Measured (2026-07-25, via `tools/latency-probe`)

| Path | p50 RTT | Notes |
|---|---|---|
| Mac → Pi, direct over Tailscale (both on home Wi-Fi) | 6.9 ms | p95 80 ms, max 96 ms — **two wireless hops, large jitter spikes** |
| Mac → Pi, WSS via Cloudflare quick tunnel | 40.8 ms | both ends register at `lhr13` |
| Pi → router, idle ICMP | 3.8 ms | mdev 1.6 ms |

Real clients, 30 Hz for 60 s, host in Edinburgh via the LHR edge:

| Client | local time | min | p50 | p95 | p99 | **queue** | jitter | stalls | staleness |
|---|---|---|---|---|---|---|---|---|---|
| Germany (iPhone) | 15:04 CET | 59 ms | 76 ms | 105 ms | 167 ms | **17 ms** | 11.7 ms | 0.4% | 133 ms |
| India (Windows) | 19:00 IST | 157 ms | 319 ms | 524 ms | 587 ms | **162 ms** | 48.0 ms | — | 430 ms |
| India, re-test | 02:40 IST | 193 ms | 211 ms | 243 ms | 260 ms | **19 ms** | 14.8 ms | 0% | 156 ms |

"Queue" is p50 − min: delay spent waiting in a buffer rather than travelling. "Staleness"
is one-way latency + interpolation buffer — what the netcode actually has to hide.

**Verdict: the project is viable.** Germany and off-peak India both land in normal shooter
territory. India's RTT is 2.8× Germany's, yet effective staleness is only ~23 ms worse,
because Germany's wider relative jitter spread forces a fatter buffer. RTT is the wrong
number to optimise; staleness is the right one.

**The congestion hypothesis was confirmed.** Queue delay collapsed 162 → 19 ms off-peak,
matching Germany's 17 ms, with jitter 48 → 14.8 ms. Peak-hour degradation was the ISP's
last mile, not the route and not the Pi.

**The one real operational constraint is scheduling.** Indian residential peak (roughly
19:00–23:00 IST) costs ~160 ms of queue delay and pushes staleness to ~430 ms, which is not
playable. That window is 13:30–17:30 UTC — inconveniently, the hours *most* socially
convenient for a UK/Germany/India group. A UK-evening session (20:00 UK) is 01:30 IST,
which is when their link is clean but the hour is unsociable. Only two Indian data points
exist; a mid-morning IST sample would show whether congestion is evening-only or spans all
waking hours.

Note the floor moved between the two Indian runs (157 → 193 ms), so treat ~190 ms as the
honest path latency and the earlier 157 ms as a favourable route or a lucky sample.

A metric bug was found and fixed here: the stall detector originally thresholded at 3×
median, which reported 0 stalls for India because the median was itself inflated by
queuing. It now thresholds at median + min — one full extra round trip above baseline —
which stays honest when the floor rises.

**The tunnel costs local players ~34 ms**, because Edinburgh traffic detours to London
and back twice (client→LHR, LHR→Pi). My earlier 5–15 ms estimate was too optimistic for
the local case.

Crucially this penalty is *asymmetric in the useful direction*: a player in India enters
at an Indian PoP and rides the CF backbone to LHR, so the detour is on their path rather
than backwards. The tunnel taxes nearby players and roughly pays for itself on distant
ones — which is the opposite of the usual intuition and argues for keeping it.

Two environment fixes worth more than any netcode tuning, per the latency analysis:

1. **Wire the Pi to ethernet.** Wi-Fi jitter alone can exceed the London↔Mumbai delta.
2. **Enable SQM/`cake` on the router.** The interpolation buffer must be sized for the
   *worst* case, so upstream bufferbloat under household load taxes every player. A steady
   180 ms beats 120 ms ± 60.

Server placement is unavoidably asymmetric — the Pi's location hands the India player the
full deficit. That is a property of the request (host on *your* Pi), not something netcode
fixes.

---

## 4. Phases

| # | Work | New/changed LOC | Risk |
|---|---|---|---|
| 0 | ~~Extract `js/sim/` from `Game`~~ **DONE** — see below | ~1,350 | resolved |
| 1 | Node server: ws transport, lobby/room, 60 Hz tick, join/leave, bots filling empty slots, snapshot encode. | ~500 | Medium |
| 2 | Client netcode: send commands, predict local movement, reconcile against server snapshots, interpolate remote entities. | ~400 | **High** — prediction bugs read as "rubber-banding" |
| 3 | Lag compensation: transform ring buffer, rewind to the shooter's view, server-side hit validation. | ~150 | Medium |
| 4 | Hardening: jitter buffer tuning, disconnect/reconnect, join-in-progress, input-rate validation, basic anti-cheat (speed and angular-velocity bounds). | ~300 | Ongoing |

**~1,500–2,000 LOC on top of a 2,500 LOC codebase — this roughly doubles the project.**
Phases 0 and 2 carry nearly all the risk; phase 1 is mostly mechanical.

### Phase 0 outcome

`js/sim/` is 1,348 lines across 7 modules; `js/game.js` is 999 lines of pure
presentation. A CI-able gate asserts the sim imports no THREE, touches no
DOM/BOM global, and contains no `Math.random`, `Date.now`, `performance.now` or
timers — the properties that let it run on the Pi.

Verified: the sim steps 3,600 ticks headlessly under plain Node in 63 ms
(**0.017 ms/tick**, ~0.1% of a 60 Hz budget), the map is byte-identical across
builds from the same seed, and the browser build plays a full match to the
40-kill target with the fixed timestep measured at **60.14 Hz**.

Three latent bugs surfaced and were fixed:

1. **Double kill credit.** `damagePlayer` incremented `attacker.kills` while the
   bot death path did the same, so a human death credited its killer twice — and
   player deaths never reached `recordDeath`, so they never scored. Now one
   handler owns both. The invariant *kills = deaths = score total* is asserted in
   the headless test and held in a real match (72/72/72).
2. **`raycastBots` hardcoded `team === 0`** as "skip allies", silently assuming
   exactly one human. Now `raycastEntities(entities, shooter, …)`, filtered by
   the shooter's own team.
3. **`Rng` defaulted its seed to `Date.now()`**, which would have made matches
   unreproducible and desyncs undebuggable. The seed is now required; choosing it
   is the caller's job.

Also fixed as a consequence of the extraction: one-shot input actions are cleared
on consumption, so a reused or replayed input can no longer re-trigger a reload
every tick — a prerequisite for both server-side input reuse and client
reconciliation.

Deployment: no Node on the Pi today. Add a `node:20-alpine` service to the existing Docker
setup rather than installing Node on the host, and add a tunnel hostname for port 7900.

### Cut from v1

- **Vault** (`doVault`, `js/game.js:1127`). A scripted 0.36 s position lerp is awkward to
  reconcile. Ship it as a server-driven state the client plays back, or drop it initially.
- **Adaptive resolution** already exists client-side and needs no changes.
- **Bot escalation** should key off match state, not the local player, once humans are mixed in.

### Worth deciding early

Per the latency analysis: **slow the TTK and open the sightlines.** At 120 ms the felt
unfairness concentrates in close-range strafe duels and corner peeks. `AM-50 BASILISK`
one-shots to center mass and `LR-13 OBELISK` two-shots at any range (`js/data.js`,
`buildLoadout`) — those are exactly the weapons that make high-ping duels feel unjust. Tuning
this is far cheaper than any netcode work and has a larger effect on how the game plays
across three continents.
