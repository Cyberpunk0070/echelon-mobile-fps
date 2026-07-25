// ECHELON sim — deterministic randomness.
//
// Nothing under js/sim/ may call Math.random(). Every draw goes through a seeded
// generator so the server can reproduce a tick exactly, and so a client can
// replay its own predicted steps and arrive at the same result.

/* The map generator's original Lehmer/Park-Miller generator, preserved bit for
   bit. buildMap() seeded this at 1337 and the dockyard layout is entirely
   derived from it, so changing the recurrence — even to something better —
   would silently move every container in the arena. It stays exactly as it was. */
export function lehmer(seed = 1337) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

/* Runtime generator, used for everything the match does after map build:
   spawn selection, bot decisions, weapon spread, damage rolls. mulberry32 —
   small, fast, and good enough that a shooter cannot feel the difference. */
export function mulberry32(seed = 0x9e3779b9) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Bundles the draws the sim actually asks for. Passing this around rather than
   a bare function keeps call sites readable and gives one place to swap the
   underlying generator. */
export class Rng {
  /* The seed is required, deliberately. Defaulting it to a clock reading would
     make a match silently unreproducible — the server could not replay a tick
     and a desync would be undebuggable. Choosing the seed is the caller's job,
     and the caller is allowed to be nondeterministic about it. */
  constructor(seed) {
    if (!Number.isFinite(seed)) {
      throw new Error("Rng requires an explicit numeric seed");
    }
    this.seed = seed;
    this.next = mulberry32(seed);
  }
  float() { return this.next(); }
  range(lo, hi) { return lo + this.next() * (hi - lo); }
  int(n) { return Math.floor(this.next() * n); }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  bool(p = 0.5) { return this.next() < p; }
  sign() { return this.next() < 0.5 ? -1 : 1; }
}
