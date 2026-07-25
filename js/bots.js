// ECHELON — bot AI. Simple but complete combat FSM: acquire → hunt → engage.
// Bots fight whichever opponents they can see (the player included), so a
// 6v6 team-deathmatch score keeps moving even when the player is repositioning.
import * as THREE from "three";

const TURN_RATE = 5.2;          // rad/s
const ACQUIRE_INTERVAL = 0.4;
const VIEW_RANGE = 55;
const FIRE_RANGE = 46;
const AIM_CONE = 0.13;          // rad — must face target this closely to shoot

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
    this.speedVal = 3.4 + Math.random() * 0.7;
    this.radius = 0.45;
    this.height = 1.8;

    this.target = null;
    this.acquireT = Math.random() * ACQUIRE_INTERVAL;
    this.goal = null;
    this.repathT = 0;
    this.detourT = 0;
    this.detourSign = 1;
    this.strafeT = 0;
    this.strafeDir = 1;

    // weapon feel per bot: rpm + burst cadence
    this.rpm = weapon?.rpm ?? (520 + Math.random() * 240);
    this.dmg = weapon?.dmg ?? (9 + Math.random() * 4);
    this.shotT = 0;
    this.burstLeft = 0;
    this.burstPauseT = 0.4 + Math.random();

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

    // --- decide desired movement ---
    let desired = null; // normalized dir on XZ
    if (visible) {
      const dist = this.pos.distanceTo(t.pos);
      _dir.subVectors(t.pos, this.pos); _dir.y = 0;
      const fwd = _dir.clone().normalize();
      this.strafeT -= dt;
      if (this.strafeT <= 0) {
        this.strafeT = 0.7 + Math.random() * 1.1;
        this.strafeDir = Math.random() < 0.5 ? -1 : 1;
      }
      const side = new THREE.Vector3(-fwd.z, 0, fwd.x).multiplyScalar(this.strafeDir);
      if (dist > 20) desired = fwd.clone().multiplyScalar(0.85).add(side.multiplyScalar(0.4)).normalize();
      else if (dist < 8) desired = fwd.clone().multiplyScalar(-0.5).add(side.multiplyScalar(0.9)).normalize();
      else desired = side.normalize();
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
      const turn = Math.sign(diff) * Math.min(Math.abs(diff), TURN_RATE * dt);
      this.yaw += turn;
      facingTarget = Math.abs(diff) < AIM_CONE;
    } else if (desired) {
      const wantYaw = Math.atan2(-desired.x, -desired.z);
      let diff = wantYaw - this.yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      this.yaw += Math.sign(diff) * Math.min(Math.abs(diff), TURN_RATE * 0.6 * dt);
    }

    // --- fire control ---
    this.shotT -= dt;
    if (visible && facingTarget) {
      const dist = this.pos.distanceTo(t.pos);
      if (dist < FIRE_RANGE) {
        if (this.burstLeft <= 0) {
          this.burstPauseT -= dt;
          if (this.burstPauseT <= 0) {
            this.burstLeft = 3 + Math.floor(Math.random() * 4);
            this.burstPauseT = 0.55 + Math.random() * 0.9;
          }
        } else if (this.shotT <= 0) {
          this.shotT = 60 / this.rpm;
          this.burstLeft--;
          this.fireAt(t, dist, ctx);
        }
      }
    } else {
      this.burstLeft = 0;
    }
  }

  acquire(ctx) {
    let best = null, bestD = Infinity;
    let nearest = null, nearestD = Infinity;
    for (const e of ctx.combatants) {
      if (e === this || e.team === this.team || !e.alive) continue;
      const d = this.pos.distanceTo(e.pos);
      if (d < nearestD) { nearestD = d; nearest = e; }
      if (d < VIEW_RANGE && d < bestD && this.canSee(e, ctx)) { bestD = d; best = e; }
    }
    // keep hunting the nearest opponent even without sight
    this.target = best || this.target || nearest;
    if (this.target && !this.target.alive) this.target = nearest;
  }

  canSee(e, ctx) {
    return !ctx.world.losBlocked(
      this.pos.x, this.pos.y + 1.55, this.pos.z,
      e.pos.x, e.pos.y + 1.15, e.pos.z
    );
  }

  fireAt(t, dist, ctx) {
    // accuracy: distance + target speed + own movement
    const targetSpeed = t.isPlayer ? (t.speedVal || 0) : t.moving;
    let p = 0.82 - dist * 0.011 - targetSpeed * 0.045 - this.moving * 0.03;
    p = Math.max(0.05, Math.min(0.8, p));
    const hit = Math.random() < p;
    const dmg = this.dmg * (0.85 + Math.random() * 0.3);
    ctx.events.onBotShot(this, t, hit, hit ? dmg : 0);
  }
}

