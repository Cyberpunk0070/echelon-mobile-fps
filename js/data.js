// ECHELON — shared data: armory, attachments, ballistics translation.
//
// The five weapons are rough depictions of real service firearms — an
// M4-pattern carbine, an MP5-pattern SMG, an AKM-pattern rifle, an AR-10
// marksman rifle and an M82-pattern anti-materiel rifle. `model` drives both
// the 3D viewmodel (weapons3d.js) and the gunsmith schematic, so the silhouette
// in the menu is the silhouette you carry.

export const LOG = [
  ["0x1A", "MOUNT /pak/core.vpk", "18ms"],
  ["0x2F", "SHADER CACHE", "204ms"],
  ["0x3C", "BALLISTICS TABLE · 74 ENTRIES", "31ms"],
  ["0x44", "STANCE IK · CROUCH/PRONE/SLIDE", "96ms"],
  ["0x51", "STREAM ASSETS", "612ms"],
  ["0x70", "RECOIL PATTERNS · 5 WEAPONS", "12ms"],
  ["0x88", "VIEWMODEL BAKE COMPLETE", "77ms"],
];

export const DEPLOY_LOG = [
  ["0x1A", "TERRAIN MESH · RAVENGLASS", "88ms"],
  ["0x2B", "NAV VOLUME · 1,204 NODES", "41ms"],
  ["0x3D", "SPAWN TABLE · 2 FACTIONS", "9ms"],
  ["0x4E", "BOT BEHAVIOR TREES × 11", "63ms"],
  ["0x5F", "BALLISTICS SOLVER WARM", "22ms"],
  ["0x71", "MATCH CLOCK ARMED", "4ms"],
  ["0x90", "DEPLOY AUTHORIZED", "11ms"],
];

export const PARTS = [
  ["RECEIVER", 210, 16],
  ["BARREL ASSEMBLY", 270, 34],
  ["OPTIC", 120, 54],
  ["MAGAZINE", 90, 72],
  ["STOCK", 150, 88],
];

export const PHASES = [
  [0, "COLD BOOT"],
  [26, "DECOMPRESSING PAKS"],
  [52, "BUILDING VIEWMODEL"],
  [78, "STREAMING TERRAIN"],
  [100, "READY"],
];

export const DEPLOY_PHASES = [
  [0, "ALLOCATING SERVER"],
  [26, "STREAMING TERRAIN"],
  [52, "PLACING SQUADS"],
  [78, "WAKING BOTS"],
  [100, "DEPLOYING"],
];

/* Recoil patterns: [horizontal, vertical] multipliers per shot since the
   trigger was last reset. Learnable — the same weapon always climbs the same
   way, so pulling down through a mag is a skill rather than a dice roll.
   Past the end of the array the pattern oscillates on the last entries. */
const PAT_AR = [
  [0.0, 1.00], [0.05, 0.95], [-0.10, 0.90], [0.18, 0.82], [0.30, 0.74], [0.42, 0.62],
  [0.36, 0.52], [0.10, 0.46], [-0.26, 0.44], [-0.48, 0.42], [-0.55, 0.40], [-0.38, 0.40],
  [-0.05, 0.38], [0.30, 0.38], [0.52, 0.36], [0.58, 0.36],
];
const PAT_SMG = [
  [0.0, 0.86], [0.12, 0.80], [-0.16, 0.74], [0.26, 0.66], [-0.34, 0.60], [0.44, 0.54],
  [-0.48, 0.50], [0.52, 0.46], [-0.40, 0.44], [0.30, 0.42], [-0.22, 0.40], [0.36, 0.40],
];
const PAT_AK = [
  [0.0, 1.18], [0.08, 1.10], [0.22, 1.00], [0.40, 0.90], [0.58, 0.80], [0.70, 0.70],
  [0.66, 0.62], [0.40, 0.58], [0.02, 0.56], [-0.40, 0.54], [-0.66, 0.52], [-0.70, 0.50],
  [-0.44, 0.48], [0.0, 0.48], [0.46, 0.46], [0.72, 0.46],
];
const PAT_DMR = [[0.0, 1.0], [0.14, 0.94], [-0.16, 0.92], [0.2, 0.9]];
const PAT_AMR = [[0.0, 1.0], [0.1, 1.0]];

// base: [DAMAGE, RANGE, HANDLING, RECOIL CTRL, MOBILITY, FIRE RATE]
export const WEAPONS = [
  {
    name: "KM-7 MERIDIAN", cls: "ASSAULT RIFLE", origin: "5.56×45 NATO · 800 RPM",
    real: "M4A1-pattern carbine · direct impingement",
    note: "Flat recoil impulse to 40 m. The compensator trades a little handling for a vertical climb you can hold through a full magazine.",
    base: [62, 70, 60, 68, 56, 64], rpm: 800, mag: 30, reserve: 150, reload: 1.9, auto: true,
    recoil: { v: 0.62, h: 0.30, recover: 9.5, pattern: PAT_AR, kickback: 0.045 },
    model: "ar15",
  },
  {
    name: "VZ-9 CINDER", cls: "SUBMACHINE GUN", origin: "9×19 PARA · 900 RPM",
    real: "MP5-pattern roller-delayed SMG",
    note: "Fastest sprint-to-fire in the armory and almost no muzzle rise. Falls off hard past 25 m — a rangefinder, not a rifle.",
    base: [46, 40, 86, 62, 88, 88], rpm: 900, mag: 30, reserve: 180, reload: 1.6, auto: true,
    recoil: { v: 0.40, h: 0.34, recover: 12, pattern: PAT_SMG, kickback: 0.03 },
    model: "mp5",
  },
  {
    name: "PK-74 VOSTOK", cls: "BATTLE RIFLE", origin: "7.62×39 · 600 RPM",
    real: "AKM-pattern long-stroke piston rifle",
    note: "Hits harder than anything else that shoots this fast. The climb is savage for six rounds, then it walks right — tap it.",
    base: [78, 66, 48, 40, 50, 48], rpm: 600, mag: 30, reserve: 150, reload: 2.3, auto: true,
    recoil: { v: 0.95, h: 0.52, recover: 8, pattern: PAT_AK, kickback: 0.07 },
    model: "ak",
  },
  {
    name: "LR-13 OBELISK", cls: "MARKSMAN RIFLE", origin: "7.62×51 NATO · 260 RPM",
    real: "AR-10 pattern semi-automatic DMR",
    note: "Two rounds to the chest at any range. Heavy glass and a heavy trigger — pick your window before you commit.",
    base: [92, 96, 36, 52, 38, 26], rpm: 260, mag: 20, reserve: 80, reload: 2.4, auto: false,
    zoom: 3.2,
    recoil: { v: 1.45, h: 0.42, recover: 7, pattern: PAT_DMR, kickback: 0.1 },
    model: "ar10",
  },
  {
    name: "AM-50 BASILISK", cls: "ANTI-MATERIEL RIFLE", origin: ".50 BMG · 55 RPM",
    real: "M82-pattern short-recoil rifle",
    note: "One shot, one kill to center mass — through the glass. Hip fire is a prayer; commit to the scope or carry something else.",
    base: [100, 100, 18, 30, 22, 8], rpm: 55, mag: 10, reserve: 40, reload: 3.4, auto: false,
    zoom: 6.0, scope: true, dmgScale: 1.0,
    recoil: { v: 3.4, h: 0.5, recover: 5, pattern: PAT_AMR, kickback: 0.19 },
    model: "m82",
  },
];

/* Attachment tables. Option index 0 is always the stock configuration, and
   every option carries a `part` key the model builder reads, so fitting a
   suppressor actually puts a suppressor on the barrel. */
export const ATTS = [
  {
    kind: "OPTIC", opts: [
      ["IRON SIGHTS", [0, 0, 0, 0, 0, 0], "iron"],
      ["RED DOT", [0, 6, -2, 4, -2, 0], "reddot"],
      ["3× PRISM", [0, 14, -9, 6, -5, 0], "prism"],
    ],
  },
  {
    kind: "MUZZLE", opts: [
      ["STANDARD", [0, 0, 0, 0, 0, 0], "std"],
      ["COMPENSATOR", [0, 4, -5, 15, -3, 0], "comp"],
      ["SUPPRESSOR", [-3, 8, -8, 7, -5, 0], "sup"],
    ],
  },
  {
    kind: "BARREL", opts: [
      ["STANDARD", [0, 0, 0, 0, 0, 0], "std"],
      ["HEAVY LONG", [5, 12, -10, 6, -8, 0], "long"],
      ["CQB SHORT", [-4, -8, 13, -6, 10, 0], "short"],
    ],
  },
  {
    kind: "UNDERBRL", opts: [
      ["NONE", [0, 0, 0, 0, 0, 0], "none"],
      ["VERT GRIP", [0, 0, 7, 9, -2, 0], "grip"],
      ["BIPOD", [0, 3, -4, 13, -6, 0], "bipod"],
    ],
  },
  {
    kind: "MAGAZINE", opts: [
      ["STANDARD", [0, 0, 0, 0, 0, 0], "std"],
      ["EXTENDED", [0, 0, -6, 0, -7, 0], "ext"],
      ["QUICK-DET", [0, 0, 5, 0, 2, 0], "fast"],
    ],
  },
  {
    kind: "STOCK", opts: [
      ["STANDARD", [0, 0, 0, 0, 0, 0], "std"],
      ["SKELETON", [0, -3, 11, -7, 8, 0], "skel"],
      ["HEAVY", [0, 5, -7, 11, -6, 0], "heavy"],
    ],
  },
];

export const STAT_NAMES = ["DAMAGE", "RANGE", "HANDLING", "RECOIL CTRL", "MOBILITY", "FIRE RATE"];

// Effective 0-100 stats for weapon index + attachment indices.
export function statsFor(weaponIdx, atts) {
  const w = WEAPONS[weaponIdx];
  return w.base.map((v, i) => {
    let d = 0;
    ATTS.forEach((a, ai) => { d += a.opts[atts[ai] ?? 0][1][i]; });
    return { v: Math.max(4, Math.min(100, v + d)), d };
  });
}

// Translate design-sheet stats into gameplay ballistics.
export function buildLoadout(weaponIdx, atts) {
  const w = WEAPONS[weaponIdx];
  const st = statsFor(weaponIdx, atts).map(s => s.v);
  const [dmg, rng, hnd, rec, mob, fr] = st;
  let mag = w.mag, reload = w.reload;
  if (atts[4] === 1) mag = Math.round(w.mag * 1.5);            // EXTENDED
  if (atts[4] === 2) reload = Math.max(0.9, w.reload - 0.6);   // QUICK-DETACH
  const scope = !!w.scope;
  const suppressed = atts[1] === 2;
  const recBase = w.recoil;
  // recoil control scales the printed kick: a fully-built rifle climbs about
  // 40% less than a bare one
  const recMult = 1.35 - rec * 0.007;
  return {
    weaponIdx, atts: atts.slice(),
    name: w.name, cls: w.cls, auto: w.auto, model: w.model, real: w.real,
    damage: 10 + dmg * (w.dmgScale ?? 0.45),
    rpm: w.rpm * (1 + (fr - w.base[5]) / 240),
    falloffStart: 10 + rng * 0.34,
    falloffEnd: 30 + rng * 0.66,
    spreadDeg: Math.max(0.2, 2.4 - hnd * 0.02),
    moveSpreadDeg: 1.6,
    recoil: {
      v: recBase.v * recMult,
      h: recBase.h * recMult,
      recover: recBase.recover,
      pattern: recBase.pattern,
      kickback: recBase.kickback,
    },
    moveSpeed: 4.0 + mob * 0.022,
    mag, reserve: w.reserve, reloadTime: reload,
    stats: st, suppressed,
    // --- ADS ---
    adsZoom: w.zoom ?? (atts[0] === 2 ? 2.2 : 1.45),
    scope,
    adsTime: scope ? 0.38 : 0.14 + (100 - hnd) * 0.0018,
    adsSpreadMult: scope ? 0.02 : 0.16,
    hipSpreadMult: scope ? 4.5 : 1,
    adsMoveMult: scope ? 0.38 : 0.58,
  };
}

export const SQUAD_ALLY = ["VIPER-04", "HALVARD", "SIX-TEN", "MARROW", "TALLINN", "OKHOTNIK"];
export const SQUAD_ENEMY = ["KOR-11", "AZOV-3", "DELTA-9", "BRACKEN", "MOTH-2", "SABLE-6"];

export const MATCH = { killTarget: 40, timeLimit: 8 * 60 };
