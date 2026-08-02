// ECHELON — weapon geometry.
//
// Design language matches the original playable build: honest schematic
// blocks (receiver / barrel / red optic accent / magazine), not life-size
// firearm recreations. One description per gun is consumed twice — merged
// into the viewmodel, and projected onto the ZY plane for the gunsmith
// schematic — so the menu silhouette is the gun you carry.
//
// Frame: bore along -Z (muzzle forward), +Y up, +X right. Origin at the
// magazine well. Sizes are viewmodel-scale (same order as the original
// in-camera blocks), so VM_SCALE stays near 1.

/* ---------------- materials ----------------
   Flat Lambert fills from the Swiss/Modernist UI palette. */
export const MAT_COLORS = {
  rcv: 0x2e2b29,   // receiver — original block grey
  bar: 0x413c3a,   // barrel / furniture
  blk: 0x242120,   // magazine / dark polymer
  dgy: 0x33302e,   // secondary plate
  lgy: 0x6d6663,   // edge / highlight
  acc: 0xff563c,   // optic accent (brand red)
  lens: 0x1b3a4a,  // unused glass slot (kept for palette compat)
  stl: 0x55504d,
  fde: 0x7d6a4c,
  wod: 0x6b4526,
  brs: 0xb08b3f,
};

let matCache = null;
function materials(THREE) {
  if (matCache) return matCache;
  matCache = {};
  for (const [k, c] of Object.entries(MAT_COLORS)) {
    if (k === "acc") {
      matCache.acc = new THREE.MeshBasicMaterial({ color: c });
      continue;
    }
    matCache[k] = new THREE.MeshLambertMaterial({ color: c });
  }
  return matCache;
}

/* ---------------- part rig ---------------- */
class Rig {
  constructor(offset = { x: 0, y: 0, z: 0 }) {
    this.off = offset;
    this.byMat = new Map();
    this.parts = [];
  }

  _rec(mat, su, sv, z, y, a) {
    this.parts.push({ mat, su, sv, u: -(z + this.off.z), v: y + this.off.y, a: -a });
  }

  box(mat, w, h, d, x, y, z, a = 0, ry = 0) {
    this._push(mat, { kind: "box", d: [w, h, d], x, y, z, a, ry });
    this._rec(mat, d, h, z, y, a);
    return this;
  }

  cylY(mat, r, h, x, y, z, a = 0, seg = 8) {
    this._push(mat, { kind: "cyl", d: [r, r, h, seg], x, y, z, a, ry: 0, axis: "y" });
    this._rec(mat, r * 2, h, z, y, a);
    return this;
  }

  tube(mat, r, len, x, y, z, a = 0, seg = 8, r2 = null) {
    this._push(mat, { kind: "cyl", d: [r, r2 ?? r, len, seg], x, y, z, a, ry: 0, axis: "z" });
    this._rec(mat, len, Math.max(r, r2 ?? r) * 2, z, y, a);
    return this;
  }

  cylX(mat, r, len, x, y, z) {
    this._push(mat, { kind: "cyl", d: [r, r, len, 8], x, y, z, a: 0, ry: 0, axis: "x" });
    this._rec(mat, r * 2, r * 2, z, y, 0);
    return this;
  }

  rail(mat, w, d, x, y, z, n = 5) {
    this.box(mat, w, 0.008, d, x, y, z);
    const step = d / n;
    for (let i = 0; i < n; i++) {
      this.box(mat, w * 0.9, 0.006, step * 0.45, x, y + 0.007, z - d / 2 + step * (i + 0.5));
    }
    return this;
  }

  _push(mat, rec) {
    let list = this.byMat.get(mat);
    if (!list) { list = []; this.byMat.set(mat, list); }
    list.push(rec);
  }

  build(T) {
    const mats = materials(T);
    const grp = new T.Group();
    const m = new T.Matrix4();
    const e = new T.Euler(0, 0, 0, "XYZ");
    for (const [matKey, list] of this.byMat) {
      let total = 0;
      const geos = list.map(rec => {
        let geo;
        if (rec.kind === "box") {
          geo = new T.BoxGeometry(rec.d[0], rec.d[1], rec.d[2]);
          e.set(rec.a, rec.ry, 0);
        } else {
          geo = new T.CylinderGeometry(rec.d[0], rec.d[1], rec.d[2], rec.d[3]);
          if (rec.axis === "z") e.set(Math.PI / 2 + rec.a, 0, 0);
          else if (rec.axis === "x") e.set(0, 0, Math.PI / 2);
          else e.set(rec.a, 0, 0);
        }
        m.makeRotationFromEuler(e);
        m.setPosition(rec.x, rec.y, rec.z);
        const g = geo.index ? geo.toNonIndexed() : geo.clone();
        geo.dispose();
        g.applyMatrix4(m);
        total += g.attributes.position.count;
        return g;
      });
      const pos = new Float32Array(total * 3);
      const nor = new Float32Array(total * 3);
      let o = 0;
      for (const g of geos) {
        pos.set(g.attributes.position.array, o * 3);
        nor.set(g.attributes.normal.array, o * 3);
        o += g.attributes.position.count;
        g.dispose();
      }
      const out = new T.BufferGeometry();
      out.setAttribute("position", new T.BufferAttribute(pos, 3));
      out.setAttribute("normal", new T.BufferAttribute(nor, 3));
      out.computeBoundingSphere();
      const mesh = new T.Mesh(out, mats[matKey] || mats.blk);
      mesh.frustumCulled = false;
      grp.add(mesh);
    }
    grp.position.set(this.off.x, this.off.y, this.off.z);
    return grp;
  }
}

/* ---------------- schematic sub-assemblies ----------------
   Chunks only — same language as the original mk() viewmodel. */

function grip(R, z = 0.10) {
  R.box("blk", 0.04, 0.10, 0.05, 0, -0.08, z, -0.28);
}

function stockBlock(R, kind, z0 = 0.22) {
  if (kind === "skel") {
    R.box("bar", 0.03, 0.04, 0.14, 0, 0.02, z0 + 0.06);
    R.box("blk", 0.05, 0.07, 0.02, 0, 0.02, z0 + 0.14);
  } else if (kind === "heavy") {
    R.box("blk", 0.06, 0.10, 0.18, 0, 0.02, z0 + 0.08);
    R.box("dgy", 0.062, 0.11, 0.02, 0, 0.02, z0 + 0.18);
  } else {
    R.box("blk", 0.05, 0.08, 0.16, 0, 0.02, z0 + 0.07);
    R.box("dgy", 0.052, 0.09, 0.018, 0, 0.02, z0 + 0.16);
  }
}

// Red accent optic — the brand signal from the original block gun.
function opticBlock(R, kind, y = 0.08, z = -0.02) {
  if (kind === "reddot") {
    R.box("blk", 0.03, 0.02, 0.04, 0, y, z);
    R.box("acc", 0.02, 0.05, 0.05, 0, y + 0.035, z - 0.01);
    return { y: y + 0.05, z: z - 0.01 };
  }
  if (kind === "prism") {
    R.box("blk", 0.032, 0.022, 0.05, 0, y, z);
    R.box("acc", 0.024, 0.04, 0.12, 0, y + 0.03, z - 0.02);
    R.box("dgy", 0.028, 0.045, 0.03, 0, y + 0.03, z - 0.08);
    return { y: y + 0.04, z: z - 0.02 };
  }
  // iron — small red post, same spirit as the original optic accent
  R.box("acc", 0.014, 0.05, 0.04, 0, y + 0.02, z);
  return { y: y + 0.045, z };
}

function muzzleBlock(R, kind, barEnd, y = 0.02) {
  if (kind === "sup") {
    R.box("blk", 0.055, 0.055, 0.16, 0, y, barEnd - 0.08);
    return { end: barEnd - 0.16 };
  }
  if (kind === "comp") {
    R.box("bar", 0.06, 0.05, 0.07, 0, y, barEnd - 0.035);
    R.box("dgy", 0.065, 0.02, 0.03, 0, y + 0.02, barEnd - 0.05);
    return { end: barEnd - 0.07 };
  }
  R.box("bar", 0.045, 0.045, 0.05, 0, y, barEnd - 0.025);
  return { end: barEnd - 0.05 };
}

function underBlock(R, kind, z, y = -0.02) {
  if (kind === "grip") R.box("blk", 0.03, 0.07, 0.035, 0, y - 0.03, z);
  if (kind === "bipod") {
    R.box("dgy", 0.04, 0.02, 0.04, 0, y, z);
    R.box("blk", 0.01, 0.10, 0.01, 0.02, y - 0.05, z);
    R.box("blk", 0.01, 0.10, 0.01, -0.02, y - 0.05, z);
  }
}

export function normalizeSight(meta) {
  const s = meta?.sight || {};
  let x = Number.isFinite(s.x) ? s.x : 0;
  let y = Number.isFinite(s.y) ? s.y : 0.08;
  let z = Number.isFinite(s.z) ? s.z : -0.02;
  if (Math.abs(x) > 0.04) x = 0;
  if (y < 0.02 || y > 0.28) y = 0.08;
  if (z < -0.20 || z > 0.16) z = -0.02;
  const adsZ = Number.isFinite(meta?.adsZ) ? meta.adsZ : -0.24;
  return {
    sight: { x, y, z },
    adsZ: Math.max(-0.42, Math.min(-0.16, adsZ)),
  };
}

function finish(R, MAG, BOLT, o, {
  boreY, barEnd, mz, sight, vmScale = 1, length, spinBarrels = false, anchors,
}) {
  return {
    sight: { x: 0, y: sight.y, z: sight.z },
    adsZ: -0.24,
    spinBarrels,
    boreY: spinBarrels ? boreY : undefined,
    muzzle: { x: 0, y: boreY, z: mz.end },
    eject: { x: 0.04, y: boreY + 0.02, z: 0.02 },
    anchors: anchors || {
      OPTIC: [sight.z, sight.y + 0.02],
      MUZZLE: [barEnd - 0.02, boreY],
      MAGAZINE: [0.05, -0.10],
      STOCK: [0.28, 0.03],
    },
    vmScale,
    length: length ?? (0.36 - barEnd),
  };
}

/* ---------------- the armory — schematic block kits ---------------- */

// Assault rifle — the original four-block silhouette, with stock + grip.
function buildAR15(R, MAG, BOLT, o) {
  const boreY = 0.02;
  const barEnd = o.barrel === "long" ? -0.72 : o.barrel === "short" ? -0.48 : -0.60;

  stockBlock(R, o.stock, 0.20);
  R.box("rcv", 0.09, 0.10, 0.50, 0, boreY, -0.02);                      // receiver
  R.box("bar", 0.05, 0.05, Math.abs(barEnd) - 0.18, 0, boreY, (barEnd - 0.18) / 2); // barrel
  grip(R, 0.12);
  R.box("dgy", 0.06, 0.03, 0.08, 0, boreY + 0.06, -0.22);               // handguard plate

  const mz = muzzleBlock(R, o.muzzle, barEnd, boreY);
  const sight = opticBlock(R, o.optic, boreY + 0.06, -0.08);
  underBlock(R, o.under, -0.28, boreY - 0.02);

  const magH = o.mag === "ext" ? 0.22 : 0.16;
  MAG.box("blk", 0.07, magH, 0.10, 0, -magH / 2 - 0.02, 0.02);
  if (o.mag === "fast") MAG.box("acc", 0.072, 0.012, 0.05, 0, -magH - 0.02, 0.02);

  BOLT.box("dgy", 0.04, 0.02, 0.05, 0, boreY + 0.06, 0.14);              // charge handle

  return finish(R, MAG, BOLT, o, { boreY, barEnd, mz, sight, vmScale: 1, length: 0.40 - barEnd });
}

// Compact SMG — shorter receiver, stubbier barrel.
function buildMP5(R, MAG, BOLT, o) {
  const boreY = 0.02;
  const barEnd = o.barrel === "long" ? -0.55 : o.barrel === "short" ? -0.36 : -0.45;

  stockBlock(R, o.stock === "heavy" ? "heavy" : o.stock, 0.18);
  R.box("rcv", 0.085, 0.09, 0.38, 0, boreY, 0.02);
  R.box("bar", 0.045, 0.045, Math.abs(barEnd) - 0.12, 0, boreY, (barEnd - 0.10) / 2);
  grip(R, 0.11);
  R.box("blk", 0.07, 0.05, 0.14, 0, boreY - 0.02, -0.18);               // handguard

  const mz = muzzleBlock(R, o.muzzle, barEnd, boreY);
  const sight = opticBlock(R, o.optic, boreY + 0.055, -0.04);
  underBlock(R, o.under, -0.20, boreY - 0.02);

  const magH = o.mag === "ext" ? 0.20 : 0.14;
  MAG.box("blk", 0.055, magH, 0.08, 0, -magH / 2 - 0.02, 0.02);
  if (o.mag === "fast") MAG.box("acc", 0.058, 0.01, 0.04, 0, -magH - 0.02, 0.02);

  BOLT.box("dgy", 0.03, 0.025, 0.04, -0.03, boreY + 0.04, -0.12);

  return finish(R, MAG, BOLT, o, { boreY, barEnd, mz, sight, vmScale: 1.02, length: 0.34 - barEnd });
}

// Battle rifle — thicker receiver, wood-tone stock plate when not skeleton.
function buildAK(R, MAG, BOLT, o) {
  const boreY = 0.02;
  const barEnd = o.barrel === "long" ? -0.70 : o.barrel === "short" ? -0.46 : -0.58;
  const furn = o.stock === "skel" ? "blk" : "wod";

  if (o.stock === "skel") stockBlock(R, "skel", 0.20);
  else {
    R.box(furn, 0.055, 0.09, 0.18, 0, 0.02, 0.28);
    R.box("blk", 0.056, 0.10, 0.02, 0, 0.02, 0.38);
  }
  R.box("rcv", 0.095, 0.11, 0.48, 0, boreY + 0.01, 0.0);
  R.box("bar", 0.05, 0.05, Math.abs(barEnd) - 0.16, 0, boreY, (barEnd - 0.14) / 2);
  R.box(furn, 0.07, 0.055, 0.16, 0, boreY - 0.01, -0.20);
  grip(R, 0.13);

  const mz = o.muzzle === "std"
    ? (R.box("bar", 0.05, 0.04, 0.06, 0, boreY + 0.01, barEnd - 0.03), { end: barEnd - 0.06 })
    : muzzleBlock(R, o.muzzle, barEnd, boreY);
  const sight = opticBlock(R, o.optic, boreY + 0.07, -0.06);
  underBlock(R, o.under, -0.24, boreY - 0.02);

  const magH = o.mag === "ext" ? 0.24 : 0.18;
  MAG.box("blk", 0.06, magH, 0.09, 0, -magH / 2 - 0.02, 0.03, 0.12);
  if (o.mag === "fast") MAG.box("acc", 0.062, 0.01, 0.04, 0, -magH - 0.02, 0.02, 0.12);

  BOLT.box("dgy", 0.025, 0.02, 0.06, 0.035, boreY + 0.04, -0.02);

  return finish(R, MAG, BOLT, o, { boreY, barEnd, mz, sight, vmScale: 0.98, length: 0.38 - barEnd });
}

// Marksman — longer barrel block, heavy stock, long red prism glass.
function buildAR10(R, MAG, BOLT, o) {
  const boreY = 0.02;
  const barEnd = o.barrel === "short" ? -0.62 : o.barrel === "long" ? -0.85 : -0.74;

  stockBlock(R, "heavy", 0.22);
  R.box("rcv", 0.095, 0.11, 0.52, 0, boreY, -0.02);
  R.box("bar", 0.048, 0.048, Math.abs(barEnd) - 0.20, 0, boreY, (barEnd - 0.18) / 2);
  R.box("dgy", 0.07, 0.04, 0.22, 0, boreY + 0.04, -0.28);
  grip(R, 0.12);

  const mz = muzzleBlock(R, o.muzzle, barEnd, boreY);
  const sight = o.optic === "iron"
    ? opticBlock(R, "iron", boreY + 0.07, -0.06)
    : opticBlock(R, "prism", boreY + 0.07, -0.04);
  underBlock(R, o.under === "none" ? "bipod" : o.under, -0.36, boreY - 0.02);

  const magH = o.mag === "ext" ? 0.20 : 0.15;
  MAG.box("blk", 0.065, magH, 0.10, 0, -magH / 2 - 0.02, 0.02);
  if (o.mag === "fast") MAG.box("acc", 0.068, 0.01, 0.05, 0, -magH - 0.02, 0.02);

  BOLT.box("dgy", 0.045, 0.02, 0.05, 0, boreY + 0.07, 0.16);

  return finish(R, MAG, BOLT, o, { boreY, barEnd, mz, sight, vmScale: 0.95, length: 0.42 - barEnd });
}

// Anti-materiel — longest block, tall scope accent, bipod.
function buildM82(R, MAG, BOLT, o) {
  const boreY = 0.025;
  const barEnd = o.barrel === "short" ? -0.85 : o.barrel === "long" ? -1.10 : -0.98;

  stockBlock(R, "heavy", 0.24);
  R.box("rcv", 0.11, 0.13, 0.58, 0, boreY + 0.01, -0.04);
  R.box("bar", 0.055, 0.055, Math.abs(barEnd) - 0.28, 0, boreY, (barEnd - 0.22) / 2);
  R.box("dgy", 0.08, 0.06, 0.22, 0, boreY, -0.40);
  grip(R, 0.14);

  const mz = o.muzzle === "sup"
    ? muzzleBlock(R, "sup", barEnd, boreY)
    : (R.box("bar", 0.08, 0.06, 0.12, 0, boreY, barEnd - 0.06), { end: barEnd - 0.12 });
  const sight = opticBlock(R, "prism", boreY + 0.10, -0.06);
  underBlock(R, "bipod", -0.42, boreY - 0.02);

  const magH = o.mag === "ext" ? 0.22 : 0.17;
  MAG.box("blk", 0.08, magH, 0.12, 0, -magH / 2 - 0.02, 0.04);
  if (o.mag === "fast") MAG.box("acc", 0.082, 0.012, 0.06, 0, -magH - 0.02, 0.04);

  BOLT.box("dgy", 0.03, 0.03, 0.07, 0.04, boreY + 0.05, 0.02);

  return finish(R, MAG, BOLT, o, { boreY, barEnd, mz, sight, vmScale: 0.88, length: 0.48 - barEnd });
}

// Rotary LMG — block motor + six spinning barrel sticks on BOLT.
function buildMinigun(R, MAG, BOLT, o) {
  const boreY = 0.03;
  const barEnd = o.barrel === "long" ? -0.78 : o.barrel === "short" ? -0.52 : -0.65;

  stockBlock(R, o.stock, 0.22);
  R.box("rcv", 0.12, 0.12, 0.42, 0, boreY, 0.04);                        // motor house
  R.box("dgy", 0.10, 0.08, 0.12, 0, boreY, -0.16);                       // collar
  // spade grips
  R.box("blk", 0.08, 0.06, 0.05, 0, boreY, 0.22);
  R.box("blk", 0.025, 0.10, 0.04, 0.04, boreY - 0.04, 0.24, -0.15);
  R.box("blk", 0.025, 0.10, 0.04, -0.04, boreY - 0.04, 0.24, -0.15);

  const mz = muzzleBlock(R, o.muzzle === "std" ? "comp" : o.muzzle, barEnd, boreY);
  R.box("blk", 0.09, 0.09, 0.06, 0, boreY, barEnd + 0.08);                 // muzzle plate

  // spinning barrel cluster (boxes — same design language)
  const barLen = Math.abs(barEnd + 0.10);
  const ring = 0.028;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    BOLT.box("bar", 0.018, 0.018, barLen, Math.cos(a) * ring, Math.sin(a) * ring, (barEnd - 0.08) / 2);
  }
  BOLT.box("dgy", 0.04, 0.04, 0.05, 0, 0, -0.12);

  const magH = o.mag === "ext" ? 0.24 : 0.18;
  MAG.box("blk", 0.10, magH, 0.14, 0.07, -magH / 2 - 0.01, 0.02);
  if (o.mag === "fast") MAG.box("acc", 0.102, 0.012, 0.07, 0.07, -magH - 0.02, 0.02);

  const sight = opticBlock(R, o.optic, boreY + 0.08, -0.02);
  underBlock(R, o.under, -0.10, boreY - 0.04);

  return finish(R, MAG, BOLT, o, {
    boreY, barEnd, mz, sight, vmScale: 0.90, length: 0.44 - barEnd, spinBarrels: true,
    anchors: {
      OPTIC: [sight.z, sight.y + 0.02], MUZZLE: [barEnd - 0.02, boreY],
      MAGAZINE: [0.07, -0.12], STOCK: [0.32, 0.03], MOTOR: [-0.12, boreY],
    },
  });
}

const BUILDERS = {
  ar15: buildAR15, mp5: buildMP5, ak: buildAK,
  ar10: buildAR10, m82: buildM82, minigun: buildMinigun,
};

export function attKeys(ATTS, atts) {
  const k = i => ATTS[i].opts[atts?.[i] ?? 0][2];
  return { optic: k(0), muzzle: k(1), barrel: k(2), under: k(3), mag: k(4), stock: k(5) };
}

export function buildWeaponModel(THREE, modelKey, opts) {
  const { R, MAG, BOLT, meta } = runBuilder(modelKey, opts);
  const norm = normalizeSight(meta);

  const group = new THREE.Group();
  group.add(R.build(THREE));
  const magGroup = MAG.build(THREE);
  const boltGroup = BOLT.build(THREE);
  if (meta.spinBarrels) boltGroup.position.y = meta.boreY ?? 0;
  group.add(magGroup, boltGroup);

  return {
    group, magGroup, boltGroup,
    parts: [...R.parts, ...MAG.parts, ...BOLT.parts],
    ...meta,
    sight: norm.sight,
    adsZ: norm.adsZ,
  };
}

function runBuilder(modelKey, opts) {
  const R = new Rig(), MAG = new Rig(), BOLT = new Rig();
  const fn = BUILDERS[modelKey];
  if (!fn) {
    if (typeof console !== "undefined") console.warn(`[weapons3d] unknown model "${modelKey}", using ar15`);
  }
  const meta = (fn || buildAR15)(R, MAG, BOLT, opts);
  return { R, MAG, BOLT, meta };
}

export function describeWeapon(modelKey, opts) {
  const { R, MAG, BOLT, meta } = runBuilder(modelKey, opts);
  const norm = normalizeSight(meta);
  const boltParts = meta.spinBarrels
    ? BOLT.parts.map(p => ({ ...p, v: p.v + (meta.boreY || 0) }))
    : BOLT.parts;
  return { parts: [...R.parts, ...MAG.parts, ...boltParts], ...meta, sight: norm.sight, adsZ: norm.adsZ };
}

function schematicFill(mat) {
  const c = MAT_COLORS[mat] ?? MAT_COLORS.dgy;
  const k = mat === "acc" ? 0 : 0.22;
  const r = Math.round(((c >> 16) & 255) * (1 - k) + 243 * k);
  const g = Math.round(((c >> 8) & 255) * (1 - k) + 242 * k);
  const b = Math.round((c & 255) * (1 - k) + 242 * k);
  return `rgb(${r},${g},${b})`;
}

export function sideViewSvg(spec, box = {}) {
  const w = box.w ?? 520, h = box.h ?? 260;
  const padX = box.padX ?? 26, padY = box.padY ?? 26;
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const p of spec.parts) {
    const ex = Math.abs(p.su * Math.cos(p.a)) / 2 + Math.abs(p.sv * Math.sin(p.a)) / 2;
    const ey = Math.abs(p.su * Math.sin(p.a)) / 2 + Math.abs(p.sv * Math.cos(p.a)) / 2;
    minU = Math.min(minU, p.u - ex); maxU = Math.max(maxU, p.u + ex);
    minV = Math.min(minV, p.v - ey); maxV = Math.max(maxV, p.v + ey);
  }
  const s = Math.min((w - padX * 2) / (maxU - minU), (h - padY * 2) / (maxV - minV));
  const ox = padX + (w - padX * 2 - (maxU - minU) * s) / 2 - minU * s;
  const oy = padY + (h - padY * 2 - (maxV - minV) * s) / 2 + maxV * s;
  const X = u => ox + u * s;
  const Y = v => oy - v * s;

  const body = spec.parts.map(p => {
    const pw = p.su * s, ph = p.sv * s;
    const cx = X(p.u), cy = Y(p.v);
    const deg = (-p.a * 180 / Math.PI).toFixed(2);
    const rot = Math.abs(p.a) > 1e-4 ? ` transform="rotate(${deg} ${cx.toFixed(1)} ${cy.toFixed(1)})"` : "";
    return `<rect x="${(cx - pw / 2).toFixed(1)}" y="${(cy - ph / 2).toFixed(1)}" width="${Math.max(0.8, pw).toFixed(1)}" height="${Math.max(0.8, ph).toFixed(1)}" fill="${schematicFill(p.mat)}" stroke="rgba(0,0,0,.5)" stroke-width=".6"${rot}/>`;
  }).join("");

  return { body, project: (z, y) => [X(-z), Y(y)], X, Y, bounds: { minU, maxU, minV, maxV, s } };
}
