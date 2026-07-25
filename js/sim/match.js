// ECHELON sim — match state: clock, score, difficulty ramp, end condition.
//
// Pure. In multiplayer this is server-owned and clients only mirror it.
import { MATCH } from "../data.js";

export class Match {
  constructor(combatants) {
    this.time = MATCH.timeLimit;
    this.score = [0, 0];          // [team 0 kills, team 1 kills]
    this.escalation = 0;          // 0 -> 1 across the match
    this.pushTimer = 20;
    this.over = false;
    this.combatants = combatants;
  }

  // Called for every death, whoever it was. score[0] counts team-1 losses.
  recordDeath(victim) {
    this.score[victim.team === 1 ? 0 : 1]++;
  }

  /* Clock and escalation are stepped separately so the caller can preserve the
     original tick order: clock, then players, then escalation and bots. Bots
     read escalation, so folding these together would shift the difficulty ramp
     by one frame relative to the single-player build being matched. */
  tickClock(dt) {
    this.time -= dt;
    if (this.time < 0) this.time = 0;
  }

  /* Escalation ramps with whichever is further along: elapsed time or the
     leading score. Late rounds are faster, sharper and more aggressive. */
  tickEscalation() {
    const byTime = 1 - this.time / MATCH.timeLimit;
    const byScore = Math.max(this.score[0], this.score[1]) / MATCH.killTarget;
    this.escalation = Math.min(1, Math.max(byTime, byScore));
  }

  /* Periodic coordinated push: the nearest enemy fireteam commits on a live
     opponent's position. Targets whichever human is alive rather than assuming
     there is exactly one. */
  stepPush(dt, ctx) {
    this.pushTimer -= dt;
    if (this.pushTimer > 0) return;
    this.pushTimer = 22 - 10 * this.escalation;

    const humans = this.combatants.filter(c => c.isPlayer && c.alive);
    if (!humans.length) return;
    const focus = ctx.rng.pick(humans);

    const squad = this.combatants
      .filter(b => !b.isPlayer && b.team === 1 && b.alive)
      .sort((x, y) => x.pos.distanceTo(focus.pos) - y.pos.distanceTo(focus.pos))
      .slice(0, 2 + Math.round(this.escalation * 2));
    for (const b of squad) {
      b.pushT = 6;
      b.goal = focus.pos.clone();
      b.repathT = 6;
    }
  }

  checkEnd() {
    if (this.over) return false;
    if (this.score[0] >= MATCH.killTarget ||
        this.score[1] >= MATCH.killTarget ||
        this.time <= 0) {
      this.over = true;
      return true;
    }
    return false;
  }

  scoreboard() {
    return this.combatants
      .map(c => ({
        name: c.name, team: c.team,
        kills: c.kills || 0, deaths: c.deaths || 0,
        me: !!c.isPlayer,
      }))
      .sort((a, b) => b.kills - a.kills);
  }
}

export { MATCH };
