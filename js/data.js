// ECHELON — shared data. Weapon/attachment tables come from the design file
// (ShooterShell.dc.html) so the gunsmith numbers match the shipped concept.

export const LOG = [
  ["0x1A", "MOUNT /pak/core.vpk", "18ms"],
  ["0x2F", "SHADER CACHE 4192/4192", "204ms"],
  ["0x3C", "BALLISTICS TABLE · 74 ENTRIES", "31ms"],
  ["0x44", "PARKOUR IK RIG · VAULT/SLIDE", "96ms"],
  ["0x51", "STREAM ASSETS 4.7 GB", "612ms"],
  ["0x63", "ANTI-CHEAT HANDSHAKE", "44ms"],
  ["0x70", "NETCODE SYNC · 12ms RTT", "12ms"],
  ["0x88", "VIEWMODEL BAKE COMPLETE", "77ms"],
];

export const DEPLOY_LOG = [
  ["0x1A", "TERRAIN MESH · RAVENGLASS", "88ms"],
  ["0x2B", "NAV VOLUME · 1,204 NODES", "41ms"],
  ["0x3D", "SPAWN TABLE · 2 FACTIONS", "9ms"],
  ["0x4E", "BOT BEHAVIOR TREES × 11", "63ms"],
  ["0x5F", "BALLISTICS SOLVER WARM", "22ms"],
  ["0x66", "SQUAD VOIP RELAY", "35ms"],
  ["0x71", "MATCH CLOCK ARMED", "4ms"],
  ["0x90", "DEPLOY AUTHORIZED", "11ms"],
];

export const PARTS = [
  ["RECEIVER", 210, 16],
  ["BARREL ASSEMBLY", 270, 34],
  ["OPTIC · MK4 HOLO", 120, 54],
  ["MAGAZINE · 30RD", 90, 72],
  ["STOCK · SKELETON", 150, 88],
];

export const PHASES = [
  [0, "COLD BOOT"],
  [22, "DECOMPRESSING PAKS"],
  [46, "BUILDING VIEWMODEL"],
  [70, "STREAMING TERRAIN"],
  [90, "HANDSHAKE"],
  [100, "READY"],
];

export const DEPLOY_PHASES = [
  [0, "ALLOCATING SERVER"],
  [22, "STREAMING TERRAIN"],
  [46, "PLACING SQUADS"],
  [70, "WAKING BOTS"],
  [90, "FINAL HANDSHAKE"],
  [100, "DEPLOYING"],
];

// base: [DAMAGE, RANGE, HANDLING, RECOIL CTRL, MOBILITY, FIRE RATE]
export const WEAPONS = [
  {
    name: "KM-7 MERIDIAN", cls: "ASSAULT RIFLE", lvl: 41, origin: "5.56×45 · 750 RPM",
    note: "Flat recoil impulse to 40m. The compensator trades handling for a vertical climb you can hold through a full mag.",
    base: [62, 70, 58, 66, 54, 61], rpm: 750, mag: 30, reserve: 120, reload: 1.8, auto: true,
  },
  {
    name: "VZ-9 CINDER", cls: "SUBMACHINE GUN", lvl: 27, origin: "9×19 · 980 RPM",
    note: "Fastest sprint-to-fire in the armory. Falls off hard past 25m — pair with the DMR secondary.",
    base: [48, 40, 84, 52, 88, 86], rpm: 980, mag: 40, reserve: 160, reload: 1.5, auto: true,
  },
  {
    name: "LR-13 OBELISK", cls: "MARKSMAN RIFLE", lvl: 12, origin: "7.62×51 · 220 RPM",
    note: "Two-shot chest kill at any range. Heavy ADS penalty; the skeleton stock is not optional.",
    base: [92, 96, 34, 44, 36, 24], rpm: 220, mag: 12, reserve: 48, reload: 2.2, auto: false,
    zoom: 2.4,
  },
  {
    name: "AM-50 BASILISK", cls: "SNIPER RIFLE", lvl: 55, origin: ".50 BMG · 45 RPM",
    note: "One shot, one kill to center mass — through the scope. Hip fire is a prayer; commit to the glass.",
    base: [100, 100, 18, 30, 22, 6], rpm: 45, mag: 5, reserve: 25, reload: 3.2, auto: false,
    zoom: 5.0, scope: true, dmgScale: 1.0,
  },
];

export const ATTS = [
  { kind: "OPTIC", opts: [["IRON SIGHT", [0, 0, 0, 0, 0, 0]], ["MK4 HOLO", [0, 6, -3, 4, -2, 0]], ["4× PRISM", [0, 14, -9, 6, -5, 0]]] },
  { kind: "MUZZLE", opts: [["NONE", [0, 0, 0, 0, 0, 0]], ["COMPENSATOR", [0, 4, -6, 14, -3, 0]], ["SUPPRESSOR", [-3, 8, -8, 6, -4, 0]]] },
  { kind: "BARREL", opts: [["STOCK", [0, 0, 0, 0, 0, 0]], ["LONG 18\"", [5, 12, -10, 5, -8, 0]], ["SHORT 11\"", [-4, -8, 12, -5, 9, 0]]] },
  { kind: "UNDERBRL", opts: [["NONE", [0, 0, 0, 0, 0, 0]], ["ANGLED GRIP", [0, 0, 7, 8, -2, 0]], ["BIPOD", [0, 3, -4, 12, -6, 0]]] },
  { kind: "MAGAZINE", opts: [["30 RD", [0, 0, 0, 0, 0, 0]], ["45 RD", [0, 0, -6, 0, -7, 0]], ["FAST MAG", [0, 0, 5, 0, 2, 0]]] },
  { kind: "STOCK", opts: [["STANDARD", [0, 0, 0, 0, 0, 0]], ["SKELETON", [0, -3, 11, -6, 8, 0]], ["HEAVY", [0, 5, -7, 10, -6, 0]]] },
];

export const STAT_NAMES = ["DAMAGE", "RANGE", "HANDLING", "RECOIL CTRL", "MOBILITY", "FIRE RATE"];

// Effective 0-100 stats for weapon index + attachment indices.
export function statsFor(weaponIdx, atts) {
  const w = WEAPONS[weaponIdx];
  return w.base.map((v, i) => {
    let d = 0;
    ATTS.forEach((a, ai) => { d += a.opts[atts[ai]][1][i]; });
    return { v: Math.max(4, Math.min(100, v + d)), d };
  });
}

// Translate design-sheet stats into gameplay ballistics.
export function buildLoadout(weaponIdx, atts) {
  const w = WEAPONS[weaponIdx];
  const st = statsFor(weaponIdx, atts).map(s => s.v);
  const [dmg, rng, hnd, rec, mob, fr] = st;
  let mag = w.mag, reload = w.reload;
  if (atts[4] === 1) mag = Math.round(w.mag * 1.5);       // 45 RD
  if (atts[4] === 2) reload = Math.max(0.9, w.reload - 0.6); // FAST MAG
  const scope = !!w.scope;
  return {
    weaponIdx, atts: atts.slice(),
    name: w.name, cls: w.cls, auto: w.auto,
    damage: 10 + dmg * (w.dmgScale ?? 0.45),    // sniper one-shots, DMR 2-shots, AR 3-shots
    headshotMult: 1.5,
    rpm: w.rpm * (1 + (fr - w.base[5]) / 220),
    falloffStart: 10 + rng * 0.32,              // meters, then linear decay
    falloffEnd: 30 + rng * 0.62,
    spreadDeg: Math.max(0.25, 2.4 - hnd * 0.02),
    moveSpreadDeg: 1.6,
    recoilKick: Math.max(0.25, 1.7 - rec * 0.014), // degrees pitch per shot
    moveSpeed: 4.0 + mob * 0.022,
    mag, reserve: w.reserve, reloadTime: reload,
    stats: st,
    // --- ADS (aim down sights) model ---
    adsZoom: w.zoom ?? 1.35,                    // fov divisor at full ADS
    scope,                                      // full scope overlay at max zoom
    adsTime: scope ? 0.34 : 0.16 + (100 - hnd) * 0.0016, // seconds to full ADS
    adsSpreadMult: scope ? 0.02 : 0.22,         // spread while aimed
    hipSpreadMult: scope ? 4.5 : 1,             // sniper hip fire is a prayer
    adsMoveMult: scope ? 0.38 : 0.55,           // move slower while aimed
  };
}

export const SQUAD_ALLY = ["VIPER-04", "HALVARD", "SIX-TEN", "MARROW", "TALLINN", "OKHOTNIK"];
export const SQUAD_ENEMY = ["KOR-11", "AZOV-3", "DELTA-9", "BRACKEN", "MOTH-2", "SABLE-6"];

export const MATCH = { killTarget: 40, timeLimit: 8 * 60 };
