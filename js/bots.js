// ECHELON — bot AI. Simple but complete combat FSM: acquire → hunt → engage.
// Bots fight whichever opponents they can see (the player included), so a
// 6v6 team-deathmatch score keeps moving even when the player is repositioning.
import * as THREE from "three";

const ACQUIRE_INTERVAL = 0.3;
const AIM_CONE = 0.13;          // rad — must face target this closely to shoot

/* Archetypes give each bot a distinct threat profile instead of one averaged
   behaviour: a rusher closes and brawls, a marksman holds angles at range, a
   flanker takes wide routes, an anchor holds ground and suppresses. */
const ARCHETYPES = [
  {
    name: "RUSHER", weapon: "VZ-9 CINDER", weight: 3,
    speed: 5.2, sprint: 1.34, turn: 6.6, view: 52, fireRange: 30, idealMin: 3, idealMax: 14,
    rpm: 820, dmg: 9, burst: [5, 9], pause: [0.24, 0.55], react: [0.16, 0.30], acc: 0.74, strafe: 1.5,
  },
  {
    name: "MARKSMAN", weapon: "LR-13 OBELISK", weight: 2,
    speed: 3.5, sprint: 1.15, turn: 4.4, view: 78, fireRange: 74, idealMin: 26, idealMax: 55,
    rpm: 260, dmg: 26, burst: [1, 2], pause: [0.75, 1.35], react: [0.30, 0.62], acc: 0.9, strafe: 0.5,
  },
  {
    name: "FLANKER", weapon: "VZ-9 CINDER", weight: 3,
    speed: 4.8, sprint: 1.3, turn: 5.8, view: 58, fireRange: 40, idealMin: 6, idealMax: 22,
    rpm: 700, dmg: 11, burst: [4, 7], pause: [0.35, 0.7], react: [0.20, 0.38], acc: 0.78, strafe: 1.35,
  },
  {
    name: "ANCHOR", weapon: "KM-7 MERIDIAN", weight: 2,
    speed: 4.0, sprint: 1.2, turn: 5.0, view: 62, fireRange: 52, idealMin: 12, idealMax: 34,
    rpm: 600, dmg: 14, burst: [3, 6], pause: [0.45, 0.9], react: [0.24, 0.46], acc: 0.82, strafe: 0.9,
  },
];

const ARCH_BAG = ARCHETYPES.flatMap(a => Array(a.weight).fill(a));
const rand = (lo, hi) => lo + Math.random() * (hi - lo);

const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();

let botSeq = 0;

export class Bot {
  constructor(name, team, weapon) {
    this.id = ++botSeq;
    this.name = name;
    this.team = team;              // 0 = ally, 1 = enemy
    this.isPlayer = false;
    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.hp = 100;
    this.alive = false;
    this.respawnT = 0.5 + Math.random() * 1.2;
    this.radius = 0.45;
    this.height = 1.8;

    const a = ARCH_BAG[Math.floor(Math.random() * ARCH_BAG.length)];
    this.arch = a;
    this.baseSpeed = a.speed * rand(0.94, 1.08);
    this.speedVal = this.baseSpeed;
    this.reactT = 0;               // counts down once a target is seen
    this.sprintUntil = 0;
    this.pushT = 0;

    this.target = null;
    this.acquireT = Math.random() * ACQUIRE_INTERVAL;
    this.goal = null;
    this.repathT = 0;
    this.detourT = 0;
    this.detourSign = 1;
    this.strafeT = 0;
    this.strafeDir = 1;

    // weapon feel follows the archetype
    this.rpm = weapon?.rpm ?? a.rpm * rand(0.92, 1.08);
    this.dmg = weapon?.dmg ?? a.dmg * rand(0.9, 1.1);
    this.shotT = 0;
    this.burstLeft = 0;
    this.burstPauseT = rand(a.pause[0], a.pause[1]);

    this.kills = 0;
    this.deaths = 0;
    this.lastAttacker = null;
    this.moving = 0;               // smoothed speed for accuracy penalties
    this.mesh = null;              // assigned by game
  }

  eyePos(out) { return out.set(this.pos.x, this.pos.y + 1.55, this.pos.z); }
  chestPos(out) { return out.set(this.pos.x, this.pos.y + 1.15, this.pos.z); }

  damage(amount, attacker, ctx) {
    if (!this.alive) return false;
    this.hp -= amount;
    this.lastAttacker = attacker;
    // getting shot makes bots react: face the attacker's direction roughly
    if (attacker && Math.random() < 0.8) {
      this.target = attacker;
      this.goal = null;
    }
    if (this.hp <= 0) {
      this.die(attacker, ctx);
      return true;
    }
    return false;
  }

  die(killer, ctx) {
    this.alive = false;
    this.hp = 0;
    this.deaths++;
    this.respawnT = 3.0 + Math.random() * 1.5;
    this.target = null;
    ctx.events.onDeath(this, killer);
  }

  update(dt, ctx) {
    if (!this.alive) {
      this.respawnT -= dt;
      if (this.respawnT <= 0) {
        const sp = ctx.world.spawnFor(this.team);
        this.pos.copy(sp);
        // face the arena center (forward is (-sin yaw, -cos yaw))
        this.yaw = Math.atan2(this.pos.x, this.pos.z) + (Math.random() - 0.5);
        this.hp = 100;
        this.alive = true;
        ctx.events.onRespawn(this);
      }
      return;
    }

    // --- target acquisition ---
    this.acquireT -= dt;
    if (this.acquireT <= 0 || (this.target && !this.target.alive)) {
      this.acquireT = ACQUIRE_INTERVAL;
      this.acquire(ctx);
    }

    const t = this.target;
    const visible = t && t.alive && this.canSee(t, ctx);
    const a = this.arch;
    // difficulty ramps across the match: later rounds are faster and sharper
    const esc = ctx.escalation ?? 0;

    // reaction time: a bot that just spotted someone cannot fire instantly
    if (visible) {
      if (this.reactT > 0) this.reactT -= dt;
    } else {
      this.reactT = rand(a.react[0], a.react[1]) * (1 - 0.45 * esc) / (ctx.skill ?? 1);
    }

    // --- decide desired movement ---
    let desired = null; // normalized dir on XZ
    if (visible) {
      const dist = this.pos.distanceTo(t.pos);
      _dir.subVectors(t.pos, this.pos); _dir.y = 0;
      const fwd = _dir.clone().normalize();
      this.strafeT -= dt;
      if (this.strafeT <= 0) {
        this.strafeT = rand(0.45, 1.15) / a.strafe;
        this.strafeDir = Math.random() < 0.5 ? -1 : 1;
      }
      const side = new THREE.Vector3(-fwd.z, 0, fwd.x).multiplyScalar(this.strafeDir);
      // hold the archetype's preferred engagement band
      if (dist > a.idealMax) {
        desired = fwd.clone().multiplyScalar(0.9).add(side.multiplyScalar(0.35 * a.strafe)).normalize();
      } else if (dist < a.idealMin) {
        desired = fwd.clone().multiplyScalar(-0.6).add(side.multiplyScalar(0.85)).normalize();
      } else {
        desired = side.normalize().multiplyScalar(a.strafe > 1 ? 1 : 0.65);
        if (desired.lengthSq() < 0.01) desired = null;
      }
    } else {
      // hunt: head toward last known opponent area or wander
      this.repathT -= dt;
      if (!this.goal || this.repathT <= 0 || this.pos.distanceTo(this.goal) < 2.2) {
        this.repathT = 2.5 + Math.random() * 2.0;
        if (t && t.alive && Math.random() < 0.75) {
          this.goal = t.pos.clone();
        } else {
          this.goal = ctx.world.randomNavPoint();
        }
      }
      _dir.subVectors(this.goal, this.pos); _dir.y = 0;
      if (_dir.lengthSq() > 0.01) desired = _dir.normalize().clone();
    }

    // --- detour steering when stuck ---
    if (this.detourT > 0) {
      this.detourT -= dt;
      if (desired) {
        const a = this.detourSign * 1.1;
        const cos = Math.cos(a), sin = Math.sin(a);
        desired.set(desired.x * cos - desired.z * sin, 0, desired.x * sin + desired.z * cos);
      }
    }

    // --- move with collision ---
    // sprint to close ground when out of contact or ordered to push
    const wantSprint = !visible || this.pushT > 0 ||
      (t && t.alive && this.pos.distanceTo(t.pos) > a.idealMax * 1.4);
    this.speedVal = this.baseSpeed * (1 + 0.22 * esc) * (wantSprint ? a.sprint : 1);
    if (this.pushT > 0) this.pushT -= dt;

    let movedFrac = 1;
    if (desired) {
      const step = this.speedVal * dt;
      const before = _v.copy(this.pos);
      ctx.world.moveEntity(this, desired.x * step, desired.z * step);
      const actual = before.distanceTo(this.pos);
      movedFrac = step > 1e-5 ? actual / step : 1;
      if (movedFrac < 0.35 && this.detourT <= 0) {
        this.detourT = 0.5 + Math.random() * 0.4;
        this.detourSign = Math.random() < 0.5 ? -1 : 1;
      }
    }
    this.moving += (((desired ? movedFrac : 0) * this.speedVal) - this.moving) * Math.min(1, dt * 6);

    // --- aim ---
    let facingTarget = false;
    if (t && t.alive) {
      _dir.subVectors(t.pos, this.pos);
      const wantYaw = Math.atan2(-_dir.x, -_dir.z);
      let diff = wantYaw - this.yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const turnRate = a.turn * (1 + 0.3 * esc);
      const turn = Math.sign(diff) * Math.min(Math.abs(diff), turnRate * dt);
      this.yaw += turn;
      facingTarget = Math.abs(diff) < AIM_CONE;
    } else if (desired) {
      const wantYaw = Math.atan2(-desired.x, -desired.z);
      let diff = wantYaw - this.yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      this.yaw += Math.sign(diff) * Math.min(Math.abs(diff), a.turn * 0.6 * dt);
    }

    // --- fire control ---
    this.shotT -= dt;
    if (visible && facingTarget && this.reactT <= 0) {
      const dist = this.pos.distanceTo(t.pos);
      if (dist < a.fireRange) {
        if (this.burstLeft <= 0) {
          this.burstPauseT -= dt;
          if (this.burstPauseT <= 0) {
            this.burstLeft = Math.round(rand(a.burst[0], a.burst[1]));
            this.burstPauseT = rand(a.pause[0], a.pause[1]) * (1 - 0.35 * esc);
          }
        } else if (this.shotT <= 0) {
          this.shotT = 60 / this.rpm;
          this.burstLeft--;
          this.fireAt(t, dist, ctx, esc);
        }
      }
    } else {
      this.burstLeft = 0;
    }
  }

  acquire(ctx) {
    let best = null, bestScore = Infinity;
    let nearest = null, nearestD = Infinity;
    for (const e of ctx.combatants) {
      if (e === this || e.team === this.team || !e.alive) continue;
      const d = this.pos.distanceTo(e.pos);
      if (d < nearestD) { nearestD = d; nearest = e; }
      if (d > this.arch.view || !this.canSee(e, ctx)) continue;
      // prefer targets inside the preferred band, and favour the human so
      // the player is meaningfully contested rather than ignored
      const band = Math.abs(d - (this.arch.idealMin + this.arch.idealMax) / 2);
      const score = band * (e.isPlayer ? 0.55 : 1);
      if (score < bestScore) { bestScore = score; best = e; }
    }
    // keep hunting the nearest opponent even without sight
    this.target = best || this.target || nearest;
    if (this.target && !this.target.alive) this.target = nearest;
  }

  canSee(e, ctx) {
    // aim at the target's actual chest height — a prone player presents a
    // silhouette barely off the deck, and the sight line has to agree
    return !ctx.world.losBlocked(
      this.pos.x, this.pos.y + 1.55, this.pos.z,
      e.pos.x, e.pos.y + (e.chestY ?? 1.15), e.pos.z
    );
  }

  fireAt(t, dist, ctx, esc = 0) {
    // accuracy: archetype skill, range falloff, target and self motion,
    // all sharpened as the match escalates and scaled by the chosen difficulty
    const a = this.arch;
    const skill = ctx.skill ?? 1;
    const targetSpeed = t.isPlayer ? (t.speedVal || 0) : t.moving;
    const rangeFactor = Math.max(0, dist - a.idealMax) * 0.012;
    let p = a.acc * (0.82 + 0.3 * esc) * skill
      - rangeFactor
      - targetSpeed * 0.038
      - this.moving * 0.028;
    // a lower silhouette is harder to hit; prone most of all
    if (t.isPlayer) p -= [0, 0.06, 0.15][t.stance ?? 0];
    p = Math.max(0.05, Math.min(0.92, p));
    const hit = Math.random() < p;
    const dmg = this.dmg * (0.85 + Math.random() * 0.3) * (1 + 0.25 * esc) * skill;
    ctx.events.onBotShot(this, t, hit, hit ? dmg : 0);
  }
}

