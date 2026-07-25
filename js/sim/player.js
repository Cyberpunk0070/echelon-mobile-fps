// ECHELON sim — player controller. Pure: no DOM, no audio, no viewmodel.
//
// stepPlayer() is the function a client predicts with and a server validates
// against, so it must be the *same code* on both sides. Anything presentational
// is reported as an event for the caller to render however it likes.
import { Vec3 } from "./vec.js";
import {
  ARENA, GRAVITY, EYE, EYE_CROUCH, SPRINT_MULT, CROUCH_MULT, SPRINT_OUT,
} from "./world.js";

export const VAULT_TIME = 0.36;
export const RESPAWN_TIME = 3.2;
export const REGEN_DELAY = 4;       // seconds after last damage
export const REGEN_RATE = 14;       // hp per second

/* A fresh input command. The client fills this each tick and ships it; the
   server consumes it. `actions` are one-shot edges (button presses) while the
   rest are continuous state, which is what makes the packet idempotent to
   resend and safe to replay during reconciliation. */
export function makeInput() {
  return {
    moveX: 0, moveZ: 0,
    stickMag: 0, stickY: 0, stickActive: false,
    sprintKey: false,
    firing: false,
    yaw: 0, pitch: 0,
    actions: { reload: false, vault: false, toggleAds: false, toggleCrouch: false },
  };
}

export function makePlayer({ name, team, loadout, world, rng, isPlayer = true }) {
  const pos = world.spawnFor(team, rng);
  return {
    isPlayer, name, team,
    pos, yaw: Math.atan2(pos.x, pos.z), pitch: 0,
    vy: 0, grounded: true,
    alive: true, hp: 100, radius: 0.4, height: 1.8,
    speedVal: 0, kills: 0, deaths: 0,
    ammo: loadout.mag, reserve: loadout.reserve,
    reloading: 0, shotT: 0, lastHurt: -10,
    respawnT: 0, vaultT: 0, vaultFrom: null, vaultTo: null,
    eyeH: EYE, sprintOutT: 0,
    /* Stance lived on the Game object, which quietly assumed a single local
       player. It belongs to the player it describes. */
    sprinting: false, crouching: false, adsOn: false, ads: 0,
    shotCount: 0,     // drives deterministic spread; see fire()
    moving: 0,        // bots read this on their targets for accuracy penalties
  };
}

export function timeSinceHurt(p, matchTime) {
  return p.lastHurt === -10 ? 999 : Math.max(0, p.lastHurt - matchTime);
}

/* ---------------- stance transitions ---------------- */

function setSprint(p, on) {
  if (on && (!p.alive || p.crouching)) return;
  if (on === p.sprinting) return;
  p.sprinting = on;
  if (on) {
    p.adsOn = false;                 // can't aim down sights at a run
  } else {
    p.sprintOutT = SPRINT_OUT;       // leaving sprint costs a raise time
  }
}

function toggleCrouch(p, world, events) {
  if (!p.alive) return;
  if (!p.crouching) {
    p.crouching = true;
    setSprint(p, false);
    return;
  }
  // only stand back up if there is headroom (never clip into a container)
  if (world.collides(p.pos.x, p.pos.z, p.radius, p.pos.y, p.pos.y + 1.8)) {
    events.push({ type: "crouch-blocked" });
    return;
  }
  p.crouching = false;
}

function startReload(p, loadout, events) {
  if (!p.alive || p.reloading > 0 || p.ammo >= loadout.mag || p.reserve <= 0) return;
  p.reloading = loadout.reloadTime;
  setSprint(p, false);               // both hands on the weapon
  events.push({ type: "reload-start", time: loadout.reloadTime });
}

function doVault(p, world, events) {
  if (!p.alive || p.vaultT > 0) return;
  const to = world.findLedge(p, p.yaw);
  events.push({ type: "vault-attempt" });
  if (to) {
    p.vaultT = VAULT_TIME;
    p.vaultFrom = p.pos.clone();
    p.vaultTo = to;
    events.push({ type: "vault-mantle" });
  } else if (p.grounded) {
    p.vy = 5.6;
    p.grounded = false;
    events.push({ type: "vault-hop" });
  }
}

/* ---------------- firing ---------------- */

/* Spread is drawn from the shot counter rather than the shared match RNG.
   That makes a shot reproducible from (player, shotCount) alone, so a client
   can predict the exact cone its own round took — and therefore its own
   hitmarker — instead of waiting a round trip to find out. */
function spreadRolls(p) {
  let h = (p.shotCount * 0x9e3779b1) ^ (p.name.length * 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  const a = ((h >>> 0) / 4294967296) - 0.5;
  h = Math.imul(h ^ (h >>> 13), 0x297a2d39);
  const b = ((h >>> 0) / 4294967296) - 0.5;
  return [a, b];
}

export function fire(p, ctx) {
  const { world, combatants, loadout, events } = ctx;
  if (!p.alive || p.reloading > 0) return;
  if (p.sprinting || p.sprintOutT > 0) return;   // gun is down / coming up
  if (p.shotT > 0) return;
  if (p.ammo <= 0) { startReload(p, loadout, events); return; }

  p.shotT = 60 / loadout.rpm;
  p.ammo--;
  p.shotCount++;

  // spread: hip vs ADS interpolated by aim progress, movement penalty fades while aimed
  const aim = p.ads;
  const spreadMult = (loadout.hipSpreadMult + (loadout.adsSpreadMult - loadout.hipSpreadMult) * aim)
    * (p.crouching ? 0.62 : 1);                  // crouching steadies the weapon
  const moveP = p.speedVal > 0.5 ? loadout.moveSpreadDeg * (1 - 0.7 * aim) : 0;
  const spread = (loadout.spreadDeg * spreadMult + moveP) * Math.PI / 180;
  const [ry, rp] = spreadRolls(p);
  const yaw = p.yaw + ry * spread, pitch = p.pitch + rp * spread;

  const dx = -Math.sin(yaw) * Math.cos(pitch);
  const dy = Math.sin(pitch);
  const dz = -Math.cos(yaw) * Math.cos(pitch);
  const ox = p.pos.x, oy = p.pos.y + p.eyeH, oz = p.pos.z;

  const wallT = world.rayWorldDist(ox, oy, oz, dx, dy, dz, 200);
  // targets are only hittable in front of whatever the round would strike first
  const shot = world.raycastEntities(combatants, p, ox, oy, oz, dx, dy, dz, Math.min(wallT, 200));

  const ev = {
    type: "fire",
    from: { x: ox, y: oy, z: oz },
    dir: { x: dx, y: dy, z: dz },
    dist: shot ? shot.t : Math.min(wallT, 200),
    hit: null,
  };

  if (shot) {
    let dmg = loadout.damage * shot.part.mult;    // per-limb multiplier
    const dist = shot.t;
    if (dist > loadout.falloffStart) {
      const f = Math.max(0.45, 1 - (dist - loadout.falloffStart) /
        Math.max(1, loadout.falloffEnd - loadout.falloffStart) * 0.55);
      dmg *= f;
    }
    ev.hit = { target: shot.ent, part: shot.part.name, dist, dmg, killed: false };
    // Damage is applied here, inside the sim, so the authority for "did that
    // round land" is the same code on client and server.
    ev.hit.killed = ctx.applyDamage(shot.ent, dmg, p, ctx);
  }
  events.push(ev);

  if (p.ammo === 0) startReload(p, loadout, events);
  return ev;
}

/* ---------------- per-tick step ---------------- */

export function stepPlayer(p, input, dt, ctx) {
  const { world, rng, loadout, events, matchTime } = ctx;

  // ---- respawn ----
  if (!p.alive) {
    p.respawnT -= dt;
    if (p.respawnT <= 0) {
      p.pos.copy(world.spawnFor(p.team, rng));
      p.hp = 100; p.alive = true; p.pitch = 0;
      p.yaw = Math.atan2(p.pos.x, p.pos.z);
      p.ammo = loadout.mag; p.reserve = loadout.reserve; p.reloading = 0;
      p.sprinting = false; p.crouching = false; p.adsOn = false;
      events.push({ type: "respawn", ent: p });
    }
    return;
  }

  /* ---- one-shot actions ----
     Consumed and cleared. The server reuses a client's last input when a fresh
     one hasn't arrived, so leaving these set would re-trigger a reload on every
     tick of a dropped packet. Clearing makes a replayed input idempotent, which
     reconciliation also depends on. */
  const a = input.actions;
  if (a.reload) { startReload(p, loadout, events); a.reload = false; }
  if (a.vault) { doVault(p, world, events); a.vault = false; }
  if (a.toggleCrouch) { toggleCrouch(p, world, events); a.toggleCrouch = false; }
  if (a.toggleAds) {
    p.adsOn = !p.adsOn;
    if (p.adsOn) setSprint(p, false);
    a.toggleAds = false;
  }

  // ---- look (client-authoritative; recoil is applied by the owning client) ----
  p.yaw = input.yaw;
  p.pitch = Math.max(-1.35, Math.min(1.35, input.pitch));

  // ---- ADS lerp: aiming drops while reloading or vaulting ----
  const adsTarget = (p.adsOn && p.reloading <= 0 && p.vaultT <= 0) ? 1 : 0;
  const adsStep = dt / Math.max(0.05, loadout.adsTime);
  p.ads += Math.sign(adsTarget - p.ads) * Math.min(Math.abs(adsTarget - p.ads), adsStep);

  // ---- movement ----
  if (p.vaultT > 0) {
    p.vaultT -= dt;
    const k = 1 - Math.max(0, p.vaultT) / VAULT_TIME;
    p.pos.lerpVectors(p.vaultFrom, p.vaultTo, k);
    p.pos.y = p.vaultFrom.y + (p.vaultTo.y - p.vaultFrom.y) * k + Math.sin(k * Math.PI) * 0.35;
    if (p.vaultT <= 0) { p.pos.copy(p.vaultTo); p.grounded = true; p.vy = 0; }
    p.speedVal = 3;
  } else {
    let mx = input.moveX, mz = input.moveZ;
    const mlen = Math.hypot(mx, mz);
    if (mlen > 1) { mx /= mlen; mz /= mlen; }

    /* Sprint is a stick gesture: shove the stick to the outer ring while
       heading forward. Hysteresis (0.95 in / 0.8 out) stops it flickering
       right at the boundary.
       Combat always outranks sprinting: while firing, aiming or reloading the
       stick may sit at the ring without dragging the player back into a sprint
       (which would cancel ADS and block the trigger every frame). */
    const busy = input.firing || p.adsOn || p.reloading > 0 || p.crouching;
    const pushedToRing = input.stickMag >= 0.95 && input.stickY < -0.35;
    const backOff = input.stickMag < 0.8 || input.stickY > -0.15;
    if (busy) setSprint(p, false);
    else if (input.stickActive) {
      if (pushedToRing) setSprint(p, true);
      else if (backOff) setSprint(p, false);
    }
    if (p.sprinting && mlen < 0.35) setSprint(p, false);
    if (input.sprintKey && mlen > 0.35 && !busy) setSprint(p, true);

    const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
    const wx = (-sin * -mz) + (cos * mx);
    const wz = (-cos * -mz) + (-sin * mx);
    let speed = loadout.moveSpeed * (1 + (loadout.adsMoveMult - 1) * p.ads);
    if (p.sprinting) speed *= SPRINT_MULT;
    if (p.crouching) speed *= CROUCH_MULT;
    world.moveEntity(p, wx * speed * dt, wz * speed * dt);
    p.speedVal = mlen * speed;
    p.moving = p.speedVal;

    // gravity / ground
    const ground = world.groundHeight(p.pos.x, p.pos.z, p.radius, p.pos.y);
    p.vy -= GRAVITY * dt;
    p.pos.y += p.vy * dt;
    if (p.pos.y <= ground) { p.pos.y = ground; p.vy = 0; p.grounded = true; }
    else if (p.pos.y > ground + 0.05) p.grounded = false;
    world.unstick(p, rng);
  }

  // stance: collision height and eye height follow the crouch state
  p.height = p.crouching ? 1.2 : 1.8;
  const wantEye = p.crouching ? EYE_CROUCH : EYE;
  p.eyeH += (wantEye - p.eyeH) * Math.min(1, dt * 12);
  if (p.sprintOutT > 0) p.sprintOutT -= dt;

  // ---- reload ----
  if (p.reloading > 0) {
    p.reloading -= dt;
    if (p.reloading <= 0) {
      const need = loadout.mag - p.ammo;
      const take = Math.min(need, p.reserve);
      p.ammo += take; p.reserve -= take;
      events.push({ type: "reload-complete" });
    }
  }

  // ---- fire ----
  p.shotT -= dt;
  if (input.firing && (loadout.auto || !p.semiHeld)) fire(p, ctx);
  p.semiHeld = input.firing;

  // ---- regen ----
  if (p.hp < 100 && timeSinceHurt(p, matchTime) > REGEN_DELAY) {
    p.hp = Math.min(100, p.hp + REGEN_RATE * dt);
  }
}

/* Applies damage and reports death. Server-authoritative in multiplayer; the
   client only ever renders the consequences. */
export function damagePlayer(p, dmg, attacker, ctx) {
  if (!p.alive) return false;
  p.hp -= dmg;
  p.lastHurt = ctx.matchTime;
  // Carries the victim: with more than one human connected, "someone was hit"
  // is not enough for a client to decide whether to flash its own screen.
  ctx.events.push({ type: "hurt", victim: p, dmg, attacker });
  if (p.hp <= 0) {
    p.alive = false;
    p.deaths++;
    p.respawnT = RESPAWN_TIME;
    p.reloading = 0;
    p.vaultT = 0; p.vaultFrom = null; p.vaultTo = null;  // no ghost-vault after respawn
    p.adsOn = false;
    p.sprinting = false;
    /* Scoring and the kill credit belong to the one death handler, not here.
       Bots already routed through it; players incrementing the killer directly
       meant a human death credited the kill twice and never reached the
       scoreboard. */
    ctx.onDeath(p, attacker);
    return true;
  }
  return false;
}

export { ARENA };
