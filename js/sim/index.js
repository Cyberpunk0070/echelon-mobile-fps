// ECHELON sim — orchestrator.
//
// One steppable simulation with no rendering, no DOM and no wall-clock reads.
// The browser drives it for prediction; the Pi drives it as the authority. Both
// run this file, which is the whole point of the extraction: there is no second
// copy of the movement or combat rules to drift out of sync.
import { Rng } from "./rng.js";
import { World } from "./world.js";
import { Bot } from "./bots.js";
import { Match } from "./match.js";
import { makePlayer, stepPlayer, damagePlayer, makeInput } from "./player.js";
import { SQUAD_ALLY, SQUAD_ENEMY } from "../data.js";

export const FIXED_DT = 1 / 60;

export class Sim {
  constructor({ seed = 1337, matchSeed = seed } = {}) {
    this.rng = new Rng(matchSeed);
    this.world = new World(seed);
    this.players = [];
    this.bots = [];
    this.combatants = [];
    this.events = [];
    this.match = new Match(this.combatants);
    this.tick = 0;

    /* One mutable context reused every tick. Rebuilding it per player and per
       shot allocated thousands of short-lived objects a second, which on a
       phone is exactly the GC pressure the renderer was carefully avoiding. */
    this.ctx = {
      world: this.world,
      rng: this.rng,
      combatants: this.combatants,
      loadout: null,
      events: this.events,
      matchTime: this.match.time,
      applyDamage: (t, d, a) => this.applyDamage(t, d, a),
      onDeath: (victim, killer) => this.onDeath(victim, killer),
    };

    // The bot AI calls back in for world queries and to report shots and deaths.
    this.botCtx = {
      combatants: this.combatants,
      escalation: 0,
      world: this.world,
      rng: this.rng,
      events: {
        onBotShot: (bot, target, hit, dmg) => this.onBotShot(bot, target, hit, dmg),
        onDeath: (victim, killer) => this.onDeath(victim, killer),
        onRespawn: bot => this.events.push({ type: "respawn", ent: bot }),
      },
    };
  }

  /* ---------- population ---------- */

  addPlayer({ name, team = 0, loadout }) {
    const p = makePlayer({ name, team, loadout, world: this.world, rng: this.rng });
    p.loadout = loadout;
    // Seeded with the spawn angles: a player whose input hasn't arrived yet must
    // keep facing where they are, not snap to yaw 0.
    p.lastInput = makeInput();
    p.lastInput.yaw = p.yaw;
    p.lastInput.pitch = p.pitch;
    this.players.push(p);
    this.combatants.push(p);
    return p;
  }

  countTeam(team) {
    let n = 0;
    for (const c of this.combatants) if (c.team === team) n++;
    return n;
  }

  /* Fills the remaining slots on both teams with bots, skipping roster names a
     human has already taken. With one human on team 0 this reproduces the
     original 5 ally bots + 6 enemy bots. */
  fillBots(perTeam = 6) {
    const taken = new Set(this.players.map(p => p.name));
    const fill = (roster, team) => {
      for (const n of roster) {
        if (this.countTeam(team) >= perTeam) break;
        if (taken.has(n)) continue;
        const b = new Bot(n, team, this.rng);
        this.bots.push(b);
        this.combatants.push(b);
      }
    };
    fill(SQUAD_ALLY, 0);
    fill(SQUAD_ENEMY, 1);
    return this.bots;
  }

  /* ---------- damage routing ---------- */

  // Single entry point so a hit resolves identically whoever took it.
  applyDamage(target, dmg, attacker) {
    if (target.isPlayer) return damagePlayer(target, dmg, attacker, this.ctx);
    return target.damage(dmg, attacker, this.botCtx);
  }

  onBotShot(bot, target, hit, dmg) {
    this.events.push({ type: "bot-shot", bot, target, hit, dmg });
    if (hit) this.applyDamage(target, dmg, bot);
  }

  onDeath(victim, killer) {
    this.match.recordDeath(victim);
    if (killer) killer.kills = (killer.kills || 0) + 1;
    this.events.push({ type: "death", victim, killer });
  }

  /* ---------- the tick ----------
     Order is load-bearing and matches the original single-player update():
     clock, players, escalation, push, bots. Bots read escalation and the player
     positions produced earlier in the same tick. */
  step(dt, inputs) {
    this.events.length = 0;
    this.tick++;

    this.match.tickClock(dt);
    this.ctx.matchTime = this.match.time;

    for (const p of this.players) {
      const input = (inputs && inputs.get(p.name)) || p.lastInput;
      p.lastInput = input;
      this.ctx.loadout = p.loadout;
      stepPlayer(p, input, dt, this.ctx);
    }

    this.match.tickEscalation();
    this.botCtx.escalation = this.match.escalation;
    this.match.stepPush(dt, { rng: this.rng });

    for (const b of this.bots) b.update(dt, this.botCtx);

    if (this.match.checkEnd()) this.events.push({ type: "match-end" });
    return this.events;
  }
}

export { makeInput };
