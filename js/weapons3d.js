// ECHELON — weapon geometry.
//
// One description per firearm, consumed twice: `buildWeaponModel` merges it
// into a low-draw-call THREE group for the viewmodel, and `sideViewSvg`
// projects the same parts onto the ZY plane for the gunsmith schematic. That
// is the whole point of building it this way — the diagram in the menu is a
// true orthographic side view of the gun you actually carry.
//
// Frame: bore runs along -Z (muzzle forward), +Y up, +X right. The origin sits
// at the magazine well so every model shares a grip reference.

/* ---------------- materials ---------------- */
export const MAT_COLORS = {
  stl: 0x55504d,   // machined steel
  blk: 0x1d1b1a,   // polymer / parkerized
  dgy: 0x33302e,   // receiver grey
  lgy: 0x6d6663,   // bright wear edge
  fde: 0x7d6a4c,   // flat dark earth furniture
  wod: 0x6b4526,   // laminate wood
  lens: 0x1b3a4a,  // optic glass
  acc: 0xff563c,   // reticle / accent
  brs: 0xb08b3f,   // brass
};

let matCache = null;
function materials(THREE) {
  if (matCache) return matCache;
  matCache = {};
  for (const [k, c] of Object.entries(MAT_COLORS)) {
    matCache[k] = new THREE.MeshPhongMaterial({
      color: c,
      shininess: k === "lens" ? 110 : k === "stl" ? 46 : k === "wod" || k === "fde" ? 12 : 22,
      specular: k === "lens" ? 0x88aacc : k === "blk" ? 0x1a1a1a : 0x3a3634,
    });
  }
  matCache.acc = new THREE.MeshBasicMaterial({ color: MAT_COLORS.acc });
  return matCache;
}

/* ---------------- part rig ----------------
   Every call records a primitive twice: as a 3D placement and as a side-view
   rectangle (u = -z runs right, v = y runs up). Rotations are about X only,
   which is the axis perpendicular to the side view, so the schematic stays
   faithful without a projection pass. */
class Rig {
  constructor(offset = { x: 0, y: 0, z: 0 }) {
    this.off = offset;
    this.byMat = new Map();
    this.parts = [];
  }

  _rec(mat, su, sv, z, y, a) {
    this.parts.push({ mat, su, sv, u: -(z + this.off.z), v: y + this.off.y, a: -a });
  }

  // Rectangular prism. `a` tilts about X (positive = top leans rearward).
  box(mat, w, h, d, x, y, z, a = 0, ry = 0) {
    this._push(mat, { kind: "box", d: [w, h, d], x, y, z, a, ry });
    this._rec(mat, d, h, z, y, a);
    return this;
  }

  // Cylinder along Y (a barrel nut, a grip column).
  cylY(mat, r, h, x, y, z, a = 0, seg = 10) {
    this._push(mat, { kind: "cyl", d: [r, r, h, seg], x, y, z, a, ry: 0, axis: "y" });
    this._rec(mat, r * 2, h, z, y, a);
    return this;
  }

  // Cylinder along -Z: barrels, tubes, suppressors, scope bodies.
  tube(mat, r, len, x, y, z, a = 0, seg = 12, r2 = null) {
    this._push(mat, { kind: "cyl", d: [r, r2 ?? r, len, seg], x, y, z, a, ry: 0, axis: "z" });
    this._rec(mat, len, Math.max(r, r2 ?? r) * 2, z, y, a);
    return this;
  }

  // Cylinder along X — reads as a disc from the side (pins, sight drums).
  cylX(mat, r, len, x, y, z) {
    this._push(mat, { kind: "cyl", d: [r, r, len, 10], x, y, z, a: 0, ry: 0, axis: "x" });
    this._rec(mat, r * 2, r * 2, z, y, 0);
    return this;
  }

  // A rail: base plus evenly spaced ridges, so picatinny reads as picatinny.
  rail(mat, w, d, x, y, z, n = 7) {
    this.box(mat, w, 0.006, d, x, y, z);
    const step = d / n;
    for (let i = 0; i < n; i++) {
      this.box(mat, w * 0.92, 0.006, step * 0.5, x, y + 0.006, z - d / 2 + step * (i + 0.5));
    }
    return this;
  }

  _push(mat, rec) {
    let list = this.byMat.get(mat);
    if (!list) { list = []; this.byMat.set(mat, list); }
    list.push(rec);
  }

  // Merge every primitive into one geometry per material: a full weapon is 5-7
  // draw calls instead of sixty. Geometry is only created here, so the menu can
  // describe a weapon (for the schematic) without touching THREE at all.
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

/* ---------------- shared sub-assemblies ---------------- */

function pistolGrip(R, mat, x, y, z, h = 0.092, rake = -0.32) {
  R.box(mat, 0.034, h, 0.044, x, y, z, rake);
  R.box(mat, 0.036, 0.014, 0.05, x, y + h / 2 - 0.004, z + 0.004);       // beavertail
  R.box(mat, 0.03, 0.012, 0.05, x, y - h / 2 + 0.006, z - 0.012, rake);  // grip toe
}

function triggerGuard(R, mat, z, y = -0.012) {
  R.box(mat, 0.028, 0.006, 0.062, 0, y - 0.026, z);
  R.box(mat, 0.028, 0.03, 0.006, 0, y - 0.012, z - 0.028);
  R.box(mat, 0.028, 0.03, 0.006, 0, y - 0.012, z + 0.028);
  R.box("stl", 0.008, 0.026, 0.008, 0, y - 0.014, z - 0.008);            // trigger
}

// A2-style birdcage / compensator / can, sized to the host rifle's bore.
function muzzleDevice(R, kind, r, z, y, big = false) {
  if (kind === "sup") {
    R.tube("blk", r * 2.3, big ? 0.20 : 0.155, 0, y, z - (big ? 0.10 : 0.078));
    R.tube("dgy", r * 2.35, 0.012, 0, y, z - 0.006);
    for (let i = 1; i <= 3; i++) R.tube("dgy", r * 2.38, 0.006, 0, y, z - i * 0.038);
    return { end: z - (big ? 0.20 : 0.155) };
  }
  if (kind === "comp") {
    R.tube("stl", r * 1.85, 0.062, 0, y, z - 0.031);
    for (let i = 0; i < 3; i++) {
      R.box("blk", r * 4.2, 0.006, 0.008, 0, y + r * 1.5, z - 0.014 - i * 0.017);
    }
    R.tube("blk", r * 1.9, 0.008, 0, y, z - 0.058);
    return { end: z - 0.062 };
  }
  R.tube("stl", r * 1.6, 0.052, 0, y, z - 0.026);                        // birdcage
  for (let i = 0; i < 4; i++) R.box("blk", r * 3.4, 0.005, 0.006, 0, y + r * 1.3, z - 0.012 - i * 0.01);
  R.tube("stl", r * 1.75, 0.008, 0, y, z - 0.05);
  return { end: z - 0.052 };
}

// Red dot / prism / iron on a riser. Returns the optic-center {y,z} used for ADS.
function opticUnit(R, kind, y, z) {
  if (kind === "reddot") {
    R.box("blk", 0.026, 0.026, 0.042, 0, y + 0.013, z);                  // mount
    R.tube("blk", 0.017, 0.062, 0, y + 0.042, z - 0.006);
    R.tube("dgy", 0.019, 0.008, 0, y + 0.042, z - 0.033);
    R.tube("lens", 0.0145, 0.004, 0, y + 0.042, z - 0.03);
    R.box("acc", 0.0035, 0.0035, 0.002, 0, y + 0.042, z - 0.032);        // dot
    R.box("blk", 0.006, 0.012, 0.012, 0.017, y + 0.046, z + 0.006);      // turret
    return { y: y + 0.042, z: z - 0.006 };
  }
  if (kind === "prism") {
    R.box("blk", 0.028, 0.024, 0.05, 0, y + 0.012, z + 0.005);
    R.tube("blk", 0.021, 0.098, 0, y + 0.046, z - 0.01);
    R.tube("dgy", 0.027, 0.026, 0, y + 0.046, z - 0.05);                 // objective bell
    R.tube("lens", 0.023, 0.004, 0, y + 0.046, z - 0.062);
    R.tube("dgy", 0.024, 0.02, 0, y + 0.046, z + 0.03);                  // ocular
    R.tube("lens", 0.02, 0.004, 0, y + 0.046, z + 0.039);
    R.cylY("blk", 0.009, 0.016, 0, y + 0.062, z - 0.006);                // elevation turret
    R.cylX("blk", 0.009, 0.016, 0.019, y + 0.046, z - 0.006);            // windage turret
    return { y: y + 0.046, z: z - 0.01 };
  }
  // folding rear aperture — sight line through the aperture hole
  R.box("blk", 0.02, 0.006, 0.016, 0, y + 0.004, z + 0.02);
  R.box("blk", 0.018, 0.026, 0.005, 0, y + 0.02, z + 0.024);
  R.box("dgy", 0.006, 0.006, 0.006, 0, y + 0.026, z + 0.024);
  return { y: y + 0.026, z: z + 0.024 };
}

// Precision / telescopic sight for the marksman and anti-materiel rifles.
function riflescope(R, y, z, len, r) {
  R.tube("blk", r, len, 0, y, z);
  R.tube("dgy", r * 1.5, len * 0.22, 0, y, z - len * 0.42);              // objective bell
  R.tube("lens", r * 1.42, 0.004, 0, y, z - len * 0.52);
  R.tube("dgy", r * 1.3, len * 0.18, 0, y, z + len * 0.42);              // ocular
  R.tube("lens", r * 1.2, 0.004, 0, y, z + len * 0.5);
  R.cylY("blk", r * 0.62, 0.02, 0, y + r + 0.008, z - len * 0.06);       // turrets
  R.cylX("blk", r * 0.62, 0.02, r + 0.008, y, z - len * 0.06);
  R.box("dgy", r * 2.1, 0.03, 0.016, 0, y - r - 0.008, z - len * 0.22);  // rings
  R.box("dgy", r * 2.1, 0.03, 0.016, 0, y - r - 0.008, z + len * 0.2);
  return { y, z };
}

// Clamp / sanitize sight meta so a bad builder can't park ADS off-axis.
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

function bipod(R, z, y, len = 0.13) {
  R.box("dgy", 0.03, 0.022, 0.03, 0, y + 0.012, z);
  for (const s of [-1, 1]) {
    R.box("blk", 0.008, len, 0.01, s * 0.026, y - len / 2 + 0.01, z + 0.006, 0.18);
    R.box("blk", 0.014, 0.008, 0.03, s * 0.038, y - len + 0.014, z + 0.018, 0.18);
  }
}

function vertGrip(R, z, y) {
  R.box("blk", 0.026, 0.02, 0.03, 0, y + 0.004, z);
  R.box("blk", 0.024, 0.062, 0.028, 0, y - 0.03, z, 0.12);
  R.box("blk", 0.026, 0.008, 0.03, 0, y - 0.062, z + 0.007, 0.12);
}

/* ---------------- the armory ---------------- */

// M4A1-pattern carbine.
function buildAR15(R, MAG, BOLT, o) {
  const boreY = 0.048;
  const hgFront = o.barrel === "long" ? -0.40 : o.barrel === "short" ? -0.245 : -0.335;
  const barEnd = o.barrel === "long" ? -0.49 : o.barrel === "short" ? -0.30 : -0.40;

  // stock group
  if (o.stock === "skel") {
    R.box("blk", 0.044, 0.052, 0.10, 0, 0.036, 0.245, 0.03);
    R.box("blk", 0.05, 0.016, 0.018, 0, 0.012, 0.30);
    R.box("blk", 0.05, 0.07, 0.014, 0, 0.03, 0.30);
  } else if (o.stock === "heavy") {
    R.box("blk", 0.05, 0.088, 0.17, 0, 0.03, 0.27, 0.02);
    R.box("blk", 0.052, 0.026, 0.10, 0, 0.078, 0.25);                    // cheek riser
    R.box("dgy", 0.054, 0.10, 0.016, 0, 0.028, 0.355);
  } else {
    R.box("blk", 0.046, 0.062, 0.125, 0, 0.03, 0.255, 0.02);
    R.box("blk", 0.05, 0.036, 0.05, 0, 0.058, 0.223);                    // cheek weld
    R.box("dgy", 0.05, 0.082, 0.016, 0, 0.028, 0.322);                   // butt pad
  }
  R.tube("dgy", 0.017, 0.17, 0, 0.038, 0.175);                           // buffer tube
  R.box("blk", 0.03, 0.028, 0.02, 0, 0.008, 0.176);                      // castle nut / QD

  // receivers
  R.box("dgy", 0.046, 0.062, 0.152, 0, 0.014, 0.058);                    // lower
  R.box("dgy", 0.048, 0.05, 0.20, 0, boreY + 0.012, -0.005);             // upper
  R.rail("dgy", 0.021, 0.20, 0, boreY + 0.038, -0.005, 7);
  R.box("blk", 0.005, 0.024, 0.05, 0.025, boreY + 0.012, 0.02);          // ejection port
  R.cylX("dgy", 0.009, 0.012, 0.027, boreY + 0.004, 0.058);              // forward assist
  R.box("dgy", 0.03, 0.018, 0.03, 0, 0.03, 0.098);                       // magwell flare rear
  R.box("stl", 0.006, 0.016, 0.03, -0.026, 0.03, 0.09);                  // bolt catch
  R.box("stl", 0.008, 0.012, 0.012, 0.026, 0.028, 0.095);                // selector
  triggerGuard(R, "dgy", 0.088, 0.0);
  pistolGrip(R, "blk", 0, -0.038, 0.128);

  // handguard + barrel
  const hgLen = Math.abs(hgFront + 0.10);
  R.box("dgy", 0.05, 0.05, hgLen, 0, boreY + 0.004, (hgFront - 0.10) / 2);
  R.rail("dgy", 0.019, hgLen * 0.94, 0, boreY + 0.03, (hgFront - 0.10) / 2, 8);
  for (let i = 0; i < 5; i++) {                                          // M-LOK slots
    R.box("blk", 0.052, 0.012, 0.026, 0, boreY - 0.014, hgFront + 0.045 + i * 0.05);
  }
  R.tube("stl", 0.0095, Math.abs(barEnd - hgFront) + 0.02, 0, boreY, (barEnd + hgFront) / 2);
  if (o.barrel !== "short") {
    R.box("dgy", 0.022, 0.042, 0.026, 0, boreY + 0.018, hgFront - 0.02); // gas block / FSB
    R.box("dgy", 0.012, 0.026, 0.012, 0, boreY + 0.042, hgFront - 0.02);
  }
  const mz = muzzleDevice(R, o.muzzle, 0.0095, barEnd, boreY);

  // magazine (animated) — STANAG curve as two segments
  const magCount = o.mag === "ext" ? 1.32 : 1;
  MAG.box("dgy", 0.03, 0.108 * magCount, 0.048, 0, -0.058 * magCount, 0.048, 0.11);
  MAG.box("dgy", 0.032, 0.014, 0.05, 0, -0.005, 0.046, 0.11);            // feed lips
  MAG.box("blk", 0.032, 0.012, 0.052, 0, -0.112 * magCount, 0.036, 0.11); // floor plate
  if (o.mag === "fast") MAG.box("acc", 0.034, 0.008, 0.03, 0, -0.118 * magCount, 0.036, 0.11);

  BOLT.box("dgy", 0.034, 0.012, 0.024, 0, boreY + 0.036, 0.108);         // charging handle
  BOLT.box("dgy", 0.012, 0.01, 0.03, 0, boreY + 0.036, 0.09);

  const sight = opticUnit(R, o.optic, boreY + 0.038, -0.02);
  if (o.under === "grip") vertGrip(R, hgFront + 0.075, boreY - 0.03);
  if (o.under === "bipod") bipod(R, hgFront + 0.03, boreY - 0.026);

  return {
    sight: { x: 0, y: sight.y, z: sight.z },
    adsZ: -0.24,
    muzzle: { x: 0, y: boreY, z: mz.end - 0.01 },
    eject: { x: 0.03, y: boreY + 0.012, z: 0.02 },
    anchors: {
      OPTIC: [sight.z, sight.y + 0.02], MUZZLE: [barEnd - 0.02, boreY],
      MAGAZINE: [0.045, -0.09], STOCK: [0.27, 0.04], HANDGUARD: [hgFront + 0.09, boreY - 0.026],
    },
    vmScale: 1, length: 0.36 - barEnd,
  };
}

// MP5-pattern roller-delayed SMG.
function buildMP5(R, MAG, BOLT, o) {
  const boreY = 0.046;
  const barEnd = o.barrel === "long" ? -0.36 : o.barrel === "short" ? -0.235 : -0.295;

  if (o.stock === "skel") {                                              // collapsed slider
    R.tube("dgy", 0.008, 0.13, 0.019, 0.03, 0.185);
    R.tube("dgy", 0.008, 0.13, -0.019, 0.03, 0.185);
    R.box("blk", 0.052, 0.062, 0.016, 0, 0.028, 0.25);
  } else if (o.stock === "heavy") {                                      // fixed A-frame
    R.box("blk", 0.046, 0.05, 0.185, 0, 0.03, 0.215, 0.05);
    R.box("blk", 0.046, 0.055, 0.06, 0, -0.005, 0.145, -0.5);
    R.box("dgy", 0.05, 0.086, 0.016, 0, 0.025, 0.303);
  } else {
    R.tube("dgy", 0.0085, 0.19, 0.019, 0.028, 0.205);
    R.tube("dgy", 0.0085, 0.19, -0.019, 0.028, 0.205);
    R.box("blk", 0.054, 0.07, 0.02, 0, 0.026, 0.298);
    R.box("blk", 0.03, 0.024, 0.05, 0, 0.026, 0.27);
  }

  R.tube("dgy", 0.026, 0.235, 0, boreY, 0.0);                            // receiver tube
  R.box("dgy", 0.05, 0.02, 0.23, 0, boreY + 0.02, 0.0);                  // receiver top flat
  R.rail("dgy", 0.02, 0.11, 0, boreY + 0.03, -0.01, 5);                  // claw-mount rail
  R.tube("dgy", 0.014, 0.30, 0, boreY + 0.03, -0.10);                    // cocking tube
  R.box("dgy", 0.042, 0.05, 0.135, 0, -0.004, 0.075);                    // trigger housing
  R.box("blk", 0.044, 0.016, 0.05, 0, 0.026, 0.075);
  triggerGuard(R, "dgy", 0.10, -0.006);
  pistolGrip(R, "blk", 0, -0.046, 0.132, 0.086);
  R.box("blk", 0.008, 0.012, 0.03, 0.023, 0.012, 0.108);                 // selector

  R.tube("blk", 0.027, 0.155, 0, boreY - 0.004, -0.165);                 // handguard
  R.box("blk", 0.05, 0.012, 0.12, 0, boreY - 0.03, -0.165);
  R.tube("stl", 0.0085, Math.abs(barEnd + 0.24) + 0.02, 0, boreY, (barEnd - 0.24) / 2);
  R.tube("dgy", 0.013, 0.03, 0, boreY, -0.245);                          // barrel nut
  R.cylX("dgy", 0.018, 0.03, 0, boreY + 0.026, 0.085);                   // rear drum sight
  R.tube("dgy", 0.017, 0.03, 0, boreY + 0.026, barEnd + 0.03);           // front sight hood
  R.box("dgy", 0.006, 0.02, 0.006, 0, boreY + 0.03, barEnd + 0.03);
  const mz = muzzleDevice(R, o.muzzle, 0.0085, barEnd, boreY);

  const magLen = o.mag === "ext" ? 0.165 : 0.125;
  MAG.box("dgy", 0.026, magLen, 0.04, 0, -magLen / 2 - 0.012, 0.045, 0.08);
  MAG.box("dgy", 0.028, 0.014, 0.044, 0, -0.008, 0.045, 0.08);
  MAG.box("blk", 0.028, 0.01, 0.042, 0, -magLen - 0.016, 0.038, 0.08);
  if (o.mag === "fast") MAG.box("acc", 0.03, 0.007, 0.026, 0, -magLen - 0.022, 0.038, 0.08);

  BOLT.box("dgy", 0.02, 0.016, 0.03, -0.026, boreY + 0.03, -0.185);      // cocking handle
  BOLT.box("dgy", 0.016, 0.014, 0.014, -0.034, boreY + 0.03, -0.20);

  const sight = o.optic === "iron"
    ? { y: boreY + 0.03, z: 0.085 }
    : opticUnit(R, o.optic, boreY + 0.03, -0.01);
  if (o.under === "grip") vertGrip(R, -0.19, boreY - 0.032);
  if (o.under === "bipod") bipod(R, -0.20, boreY - 0.03, 0.10);

  return {
    sight: { x: 0, y: sight.y, z: sight.z },
    adsZ: -0.22,
    muzzle: { x: 0, y: boreY, z: mz.end - 0.01 },
    eject: { x: 0.028, y: boreY + 0.012, z: -0.02 },
    anchors: {
      OPTIC: [sight.z, sight.y + 0.02], MUZZLE: [barEnd - 0.02, boreY],
      MAGAZINE: [0.045, -0.09], STOCK: [0.24, 0.03], HANDGUARD: [-0.165, boreY - 0.03],
    },
    vmScale: 1.04, length: 0.32 - barEnd,
  };
}

// AKM-pattern long-stroke piston rifle.
function buildAK(R, MAG, BOLT, o) {
  const boreY = 0.05;
  const barEnd = o.barrel === "long" ? -0.47 : o.barrel === "short" ? -0.30 : -0.405;
  const furn = o.stock === "skel" ? "blk" : "wod";

  if (o.stock === "skel") {                                              // underfolder frame
    R.box("blk", 0.012, 0.03, 0.19, 0.02, 0.03, 0.245, 0.04);
    R.box("blk", 0.012, 0.03, 0.19, -0.02, 0.03, 0.245, 0.04);
    R.box("blk", 0.05, 0.062, 0.016, 0, 0.036, 0.335);
  } else if (o.stock === "heavy") {
    R.box(furn, 0.05, 0.085, 0.215, 0, 0.026, 0.26, 0.05);
    R.box(furn, 0.052, 0.028, 0.11, 0, 0.076, 0.245);
    R.box("blk", 0.052, 0.10, 0.016, 0, 0.022, 0.365);
  } else {
    R.box(furn, 0.046, 0.068, 0.20, 0, 0.028, 0.255, 0.055);
    R.box(furn, 0.048, 0.022, 0.09, 0, 0.066, 0.235, 0.055);
    R.box("blk", 0.05, 0.085, 0.016, 0, 0.02, 0.352);
  }

  R.box("dgy", 0.048, 0.072, 0.215, 0, 0.038, 0.045);                    // stamped receiver
  R.box("dgy", 0.046, 0.014, 0.185, 0, 0.079, 0.03);                     // dust cover
  R.box("dgy", 0.03, 0.008, 0.16, 0, 0.087, 0.03);                       // cover rib
  R.box("dgy", 0.032, 0.022, 0.032, 0, 0.086, -0.072);                   // rear sight block
  R.box("stl", 0.007, 0.062, 0.014, 0.026, 0.052, 0.055, -0.05);         // selector lever
  triggerGuard(R, "dgy", 0.10, 0.006);
  pistolGrip(R, "blk", 0, -0.036, 0.142, 0.09, -0.26);

  R.tube("dgy", 0.013, 0.165, 0, boreY + 0.028, -0.155);                 // gas tube
  R.box(furn, 0.038, 0.03, 0.115, 0, boreY + 0.03, -0.15);               // upper handguard
  R.box(furn, 0.052, 0.05, 0.145, 0, boreY - 0.012, -0.15);              // lower handguard
  R.box(furn, 0.054, 0.012, 0.12, 0, boreY - 0.036, -0.15);
  R.tube("stl", 0.0105, Math.abs(barEnd + 0.225) + 0.02, 0, boreY, (barEnd - 0.225) / 2);
  R.box("dgy", 0.03, 0.05, 0.032, 0, boreY + 0.016, -0.245, -0.6);       // angled gas block
  R.box("dgy", 0.028, 0.05, 0.03, 0, boreY + 0.016, barEnd + 0.03);      // front sight block
  R.box("dgy", 0.01, 0.024, 0.01, 0, boreY + 0.046, barEnd + 0.03);
  R.tube("dgy", 0.016, 0.03, 0, boreY, barEnd + 0.075);                  // cleaning-rod boss

  let mz;
  if (o.muzzle === "std") {                                              // slant compensator
    R.tube("stl", 0.016, 0.05, 0, boreY, barEnd - 0.025);
    R.box("stl", 0.032, 0.03, 0.03, 0, boreY + 0.012, barEnd - 0.048, 0.6);
    mz = { end: barEnd - 0.05 };
  } else {
    mz = muzzleDevice(R, o.muzzle, 0.0105, barEnd, boreY, o.muzzle === "sup");
  }

  /* banana magazine — a chain of segments, each stepped along the previous
     one's local "down" and raked a little further forward, which is what gives
     the AK its curve. Stepping (rather than placing absolutely) keeps the
     segments joined at any curvature. */
  const seg = o.mag === "ext" ? 6 : 4;
  MAG.box("dgy", 0.032, 0.018, 0.056, 0, -0.008, 0.052, 0.08);            // feed lips
  let cy = -0.018, cz = 0.052, ang = 0.08;
  const segH = 0.042;
  for (let i = 0; i < seg; i++) {
    const dy = -Math.cos(ang), dz = -Math.sin(ang);
    cy += dy * segH / 2; cz += dz * segH / 2;
    MAG.box("dgy", 0.03, segH * 1.08, 0.05, 0, cy, cz, ang);
    cy += dy * segH / 2; cz += dz * segH / 2;
    ang += 0.12;
  }
  MAG.box("blk", 0.032, 0.011, 0.05, 0, cy - 0.004, cz - 0.001, ang);     // floor plate
  if (o.mag === "fast") MAG.box("acc", 0.034, 0.007, 0.028, 0, cy - 0.013, cz - 0.002, ang);

  BOLT.box("dgy", 0.014, 0.016, 0.05, 0.028, boreY + 0.024, -0.03);      // right-side handle
  BOLT.box("dgy", 0.02, 0.014, 0.016, 0.036, boreY + 0.024, -0.05);

  const sight = o.optic === "iron"
    ? { y: 0.096, z: -0.072 }
    : opticUnit(R, o.optic, 0.086, -0.03);
  if (o.under === "grip") vertGrip(R, -0.185, boreY - 0.042);
  if (o.under === "bipod") bipod(R, -0.20, boreY - 0.04);

  return {
    sight: { x: 0, y: sight.y, z: sight.z },
    adsZ: -0.25,
    muzzle: { x: 0, y: boreY, z: mz.end - 0.01 },
    eject: { x: 0.03, y: boreY + 0.026, z: 0.0 },
    anchors: {
      OPTIC: [sight.z, sight.y + 0.02], MUZZLE: [barEnd - 0.03, boreY],
      MAGAZINE: [0.03, -0.10], STOCK: [0.26, 0.035], HANDGUARD: [-0.15, boreY - 0.03],
    },
    vmScale: 0.98, length: 0.37 - barEnd,
  };
}

// AR-10 pattern semi-automatic marksman rifle.
function buildAR10(R, MAG, BOLT, o) {
  const boreY = 0.052;
  const hgFront = o.barrel === "short" ? -0.30 : o.barrel === "long" ? -0.44 : -0.385;
  const barEnd = o.barrel === "short" ? -0.42 : o.barrel === "long" ? -0.60 : -0.52;

  // precision stock
  R.box("blk", 0.05, 0.075, 0.19, 0, 0.03, 0.28, 0.02);
  R.box("blk", 0.052, 0.03, 0.115, 0, 0.078, 0.265);                     // adjustable comb
  R.box("dgy", 0.012, 0.03, 0.012, 0.02, 0.058, 0.315);
  R.box("dgy", 0.056, 0.105, 0.018, 0, 0.026, 0.378);                    // recoil pad
  R.box("blk", 0.03, 0.05, 0.06, 0, -0.012, 0.345, 0.25);                // rear hook
  R.tube("dgy", 0.018, 0.16, 0, 0.04, 0.19);

  R.box("dgy", 0.05, 0.068, 0.165, 0, 0.016, 0.06);                      // lower
  R.box("dgy", 0.052, 0.056, 0.225, 0, boreY + 0.014, -0.01);            // upper
  R.rail("dgy", 0.023, 0.225, 0, boreY + 0.043, -0.01, 8);
  R.box("blk", 0.005, 0.026, 0.056, 0.027, boreY + 0.014, 0.02);
  R.box("stl", 0.008, 0.014, 0.014, 0.028, 0.03, 0.098);
  triggerGuard(R, "dgy", 0.092, 0.002);
  pistolGrip(R, "blk", 0, -0.04, 0.135, 0.096);

  const hgLen = Math.abs(hgFront + 0.115);
  R.tube("dgy", 0.031, hgLen, 0, boreY + 0.002, (hgFront - 0.115) / 2, 0, 14); // free-float tube
  R.rail("dgy", 0.021, hgLen * 0.95, 0, boreY + 0.03, (hgFront - 0.115) / 2, 10);
  for (let i = 0; i < 6; i++) {
    R.box("blk", 0.058, 0.014, 0.03, 0, boreY - 0.018, hgFront + 0.05 + i * 0.052);
  }
  R.tube("stl", 0.0125, Math.abs(barEnd - hgFront) + 0.02, 0, boreY, (barEnd + hgFront) / 2, 0, 12);
  for (let i = 0; i < 4; i++) {                                          // barrel flutes
    R.tube("dgy", 0.0135, 0.02, 0, boreY, hgFront - 0.03 - i * 0.035);
  }
  const mz = muzzleDevice(R, o.muzzle, 0.0125, barEnd, boreY, true);

  const magLen = o.mag === "ext" ? 0.175 : 0.135;
  MAG.box("dgy", 0.032, magLen, 0.056, 0, -magLen / 2 - 0.014, 0.05, 0.10);
  MAG.box("dgy", 0.034, 0.014, 0.058, 0, -0.008, 0.05, 0.10);
  MAG.box("blk", 0.034, 0.012, 0.058, 0, -magLen - 0.018, 0.042, 0.10);
  if (o.mag === "fast") MAG.box("acc", 0.036, 0.008, 0.032, 0, -magLen - 0.026, 0.042, 0.10);

  BOLT.box("dgy", 0.036, 0.013, 0.026, 0, boreY + 0.04, 0.116);
  BOLT.box("dgy", 0.013, 0.011, 0.032, 0, boreY + 0.04, 0.096);

  const sight = o.optic === "iron"
    ? opticUnit(R, "iron", boreY + 0.043, -0.02)
    : riflescope(R, boreY + 0.086, -0.03, o.optic === "reddot" ? 0.19 : 0.26, 0.019);
  if (o.under === "grip") vertGrip(R, hgFront + 0.08, boreY - 0.034);
  if (o.under === "bipod" || o.under === "none") bipod(R, hgFront + 0.045, boreY - 0.03, 0.15);

  return {
    sight: { x: 0, y: sight.y, z: sight.z },
    adsZ: -0.28,
    muzzle: { x: 0, y: boreY, z: mz.end - 0.01 },
    eject: { x: 0.032, y: boreY + 0.014, z: 0.02 },
    anchors: {
      OPTIC: [sight.z, sight.y + 0.026], MUZZLE: [barEnd - 0.03, boreY],
      MAGAZINE: [0.05, -0.10], STOCK: [0.29, 0.04], BIPOD: [hgFront + 0.045, boreY - 0.12],
    },
    vmScale: 0.92, length: 0.40 - barEnd,
  };
}

// M82-pattern .50 anti-materiel rifle.
function buildM82(R, MAG, BOLT, o) {
  const boreY = 0.058;
  const barEnd = o.barrel === "short" ? -0.60 : o.barrel === "long" ? -0.80 : -0.71;

  R.box("dgy", 0.068, 0.10, 0.42, 0, boreY + 0.012, -0.06);              // upper receiver
  R.box("dgy", 0.062, 0.078, 0.24, 0, -0.004, 0.10);                     // lower receiver
  R.box("dgy", 0.07, 0.016, 0.40, 0, boreY + 0.066, -0.06);              // top deck
  R.rail("dgy", 0.024, 0.34, 0, boreY + 0.076, -0.05, 12);
  R.box("dgy", 0.014, 0.05, 0.10, 0.03, boreY + 0.10, 0.03);             // carry handle posts
  R.box("dgy", 0.014, 0.05, 0.10, -0.03, boreY + 0.10, 0.03);
  R.box("blk", 0.05, 0.012, 0.13, 0, boreY + 0.128, 0.02);
  R.box("blk", 0.006, 0.03, 0.07, 0.035, boreY + 0.012, 0.02);           // ejection port

  triggerGuard(R, "dgy", 0.115, -0.004);
  pistolGrip(R, "blk", 0, -0.05, 0.155, 0.10);

  // stock + monopod
  R.box("blk", 0.06, 0.095, 0.20, 0, 0.012, 0.30, 0.02);
  R.box("blk", 0.062, 0.03, 0.12, 0, 0.072, 0.285);
  R.box("dgy", 0.064, 0.115, 0.02, 0, 0.008, 0.402);
  R.box("dgy", 0.024, 0.06, 0.024, 0, -0.056, 0.365, 0.2);

  // barrel + shroud
  R.tube("stl", 0.017, Math.abs(barEnd + 0.24) + 0.02, 0, boreY, (barEnd - 0.24) / 2, 0, 14);
  R.box("dgy", 0.05, 0.05, 0.20, 0, boreY, -0.34);                       // barrel shroud
  for (let i = 0; i < 4; i++) R.box("blk", 0.052, 0.016, 0.026, 0, boreY + 0.014, -0.27 - i * 0.048);
  R.tube("dgy", 0.024, 0.05, 0, boreY, barEnd + 0.08);                   // muzzle collar

  // arrow-head brake — three vented chambers with swept side plates
  let mz;
  if (o.muzzle === "sup") {
    mz = muzzleDevice(R, "sup", 0.017, barEnd, boreY, true);
  } else {
    R.tube("stl", 0.028, 0.10, 0, boreY, barEnd - 0.05);
    for (const s of [-1, 1]) {
      R.box("stl", 0.012, 0.052, 0.075, s * 0.03, boreY, barEnd - 0.05, 0, s * 0.42);
    }
    R.tube("blk", 0.03, 0.01, 0, boreY, barEnd - 0.098);
    for (let i = 0; i < 3; i++) R.box("blk", 0.06, 0.008, 0.01, 0, boreY + 0.026, barEnd - 0.022 - i * 0.028);
    mz = { end: barEnd - 0.10 };
  }

  const magLen = o.mag === "ext" ? 0.20 : 0.165;
  MAG.box("dgy", 0.05, magLen, 0.098, 0, -magLen / 2 - 0.018, 0.062, 0.06);
  MAG.box("dgy", 0.052, 0.016, 0.10, 0, -0.012, 0.062, 0.06);
  MAG.box("blk", 0.054, 0.012, 0.10, 0, -magLen - 0.022, 0.05, 0.06);
  if (o.mag === "fast") MAG.box("acc", 0.056, 0.008, 0.05, 0, -magLen - 0.03, 0.05, 0.06);

  BOLT.box("dgy", 0.018, 0.02, 0.06, 0.038, boreY + 0.03, 0.0);
  BOLT.box("dgy", 0.024, 0.018, 0.02, 0.048, boreY + 0.03, -0.024);

  const sight = riflescope(R, boreY + 0.155, -0.05, o.optic === "reddot" ? 0.22 : 0.30, 0.023);
  bipod(R, -0.30, boreY - 0.05, 0.19);

  return {
    sight: { x: 0, y: sight.y, z: sight.z },
    adsZ: -0.34,
    muzzle: { x: 0, y: boreY, z: mz.end - 0.01 },
    eject: { x: 0.04, y: boreY + 0.02, z: 0.02 },
    anchors: {
      OPTIC: [sight.z, sight.y + 0.03], "MUZZLE BRAKE": [barEnd - 0.05, boreY],
      MAGAZINE: [0.062, -0.12], STOCK: [0.32, 0.03], BIPOD: [-0.30, boreY - 0.20],
    },
    vmScale: 0.78, length: 0.44 - barEnd,
  };
}

// Gatling-pattern rotary LMG. BOLT holds the spinning barrel cluster.
function buildMinigun(R, MAG, BOLT, o) {
  const boreY = 0.055;
  const barEnd = o.barrel === "long" ? -0.58 : o.barrel === "short" ? -0.40 : -0.50;
  const barLen = Math.abs(barEnd + 0.08);

  // receiver / motor housing
  R.box("dgy", 0.078, 0.095, 0.28, 0, boreY + 0.01, 0.06);
  R.box("blk", 0.082, 0.04, 0.18, 0, boreY + 0.055, 0.04);               // top deck
  R.rail("dgy", 0.022, 0.14, 0, boreY + 0.078, -0.02, 6);
  R.tube("dgy", 0.042, 0.10, 0, boreY, -0.12);                           // motor collar
  R.box("blk", 0.06, 0.05, 0.08, 0, boreY - 0.01, -0.08);                // gearbox

  // spade grips + dual triggers
  R.box("blk", 0.07, 0.055, 0.04, 0, boreY + 0.02, 0.22);
  for (const s of [-1, 1]) {
    R.box("blk", 0.018, 0.09, 0.04, s * 0.04, boreY - 0.02, 0.24, -0.15);
    R.box("dgy", 0.02, 0.03, 0.03, s * 0.04, boreY - 0.06, 0.255);
  }
  R.box("stl", 0.01, 0.03, 0.012, 0, boreY - 0.01, 0.20);                // trigger bar

  // aircraft stock / shoulder brace
  if (o.stock === "skel") {
    R.tube("dgy", 0.01, 0.16, 0.02, boreY + 0.01, 0.30);
    R.tube("dgy", 0.01, 0.16, -0.02, boreY + 0.01, 0.30);
    R.box("blk", 0.06, 0.07, 0.016, 0, boreY, 0.38);
  } else if (o.stock === "heavy") {
    R.box("blk", 0.06, 0.09, 0.18, 0, boreY - 0.01, 0.32, 0.04);
    R.box("dgy", 0.062, 0.10, 0.018, 0, boreY - 0.015, 0.41);
  } else {
    R.box("blk", 0.055, 0.07, 0.14, 0, boreY, 0.30, 0.03);
    R.box("dgy", 0.058, 0.085, 0.016, 0, boreY - 0.005, 0.375);
  }

  // barrel shroud / flash cone (static)
  R.tube("dgy", 0.055, 0.08, 0, boreY, barEnd + 0.04, 0, 14, 0.04);
  R.tube("blk", 0.048, 0.03, 0, boreY, barEnd + 0.08);
  const mz = o.muzzle === "sup"
    ? muzzleDevice(R, "sup", 0.014, barEnd, boreY, true)
    : o.muzzle === "comp"
      ? muzzleDevice(R, "comp", 0.014, barEnd, boreY)
      : { end: barEnd };

  // Barrel cluster in BOLT local space (origin = bore axis). buildWeaponModel
  // lifts boltGroup to boreY so rotation.z spins the cluster correctly.
  const barrelR = 0.022;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const bx = Math.cos(a) * barrelR;
    const by = Math.sin(a) * barrelR;
    BOLT.tube("stl", 0.0075, barLen, bx, by, (barEnd - 0.08) / 2, 0, 8);
  }
  BOLT.tube("dgy", 0.018, 0.04, 0, 0, -0.10);                             // hub
  BOLT.tube("blk", 0.038, 0.02, 0, 0, barEnd + 0.10);                      // muzzle plate
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    BOLT.tube("dgy", 0.009, 0.016, Math.cos(a) * barrelR, Math.sin(a) * barrelR, barEnd + 0.02);
  }

  // side box mag
  const magH = o.mag === "ext" ? 0.22 : 0.17;
  MAG.box("dgy", 0.08, magH, 0.12, 0.06, -magH / 2 - 0.01, 0.04);
  MAG.box("blk", 0.082, 0.014, 0.122, 0.06, -0.008, 0.04);
  MAG.box("blk", 0.082, 0.012, 0.122, 0.06, -magH - 0.014, 0.04);
  if (o.mag === "fast") MAG.box("acc", 0.084, 0.008, 0.06, 0.06, -magH - 0.02, 0.04);
  R.box("dgy", 0.04, 0.04, 0.05, 0.045, boreY - 0.02, 0.02);             // feed chute

  if (o.under === "grip") vertGrip(R, -0.05, boreY - 0.05);
  if (o.under === "bipod") bipod(R, -0.16, boreY - 0.04, 0.14);

  const sight = o.optic === "iron"
    ? (() => {
      R.box("blk", 0.02, 0.028, 0.008, 0, boreY + 0.09, 0.08);
      R.box("dgy", 0.006, 0.008, 0.006, 0, boreY + 0.104, 0.08);
      R.box("blk", 0.012, 0.02, 0.012, 0, boreY + 0.085, barEnd + 0.12);
      return { y: boreY + 0.104, z: 0.08 };
    })()
    : opticUnit(R, o.optic, boreY + 0.078, -0.02);

  return {
    sight: { x: 0, y: sight.y, z: sight.z },
    adsZ: -0.30,
    spinBarrels: true,
    boreY,
    muzzle: { x: 0, y: boreY, z: mz.end - 0.01 },
    eject: { x: 0.05, y: boreY + 0.02, z: 0.0 },
    anchors: {
      OPTIC: [sight.z, sight.y + 0.02], MUZZLE: [barEnd - 0.02, boreY],
      MAGAZINE: [0.06, -0.12], STOCK: [0.34, boreY], MOTOR: [-0.12, boreY],
    },
    vmScale: 0.82, length: 0.42 - barEnd,
  };
}

const BUILDERS = {
  ar15: buildAR15, mp5: buildMP5, ak: buildAK,
  ar10: buildAR10, m82: buildM82, minigun: buildMinigun,
};

// Attachment indices -> the option keys the builders branch on.
export function attKeys(ATTS, atts) {
  const k = i => ATTS[i].opts[atts?.[i] ?? 0][2];
  return { optic: k(0), muzzle: k(1), barrel: k(2), under: k(3), mag: k(4), stock: k(5) };
}

/* Build a full weapon. Returns the group plus the handles the viewmodel
   animator needs: the magazine (drops during a reload) and the charging
   handle (racks at the end of one). */
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

// Geometry-free description: the part list and anchors the gunsmith needs to
// draw a true side view, with no WebGL objects allocated.
export function describeWeapon(modelKey, opts) {
  const { R, MAG, BOLT, meta } = runBuilder(modelKey, opts);
  const norm = normalizeSight(meta);
  const boltParts = meta.spinBarrels
    ? BOLT.parts.map(p => ({ ...p, v: p.v + (meta.boreY || 0) }))
    : BOLT.parts;
  return { parts: [...R.parts, ...MAG.parts, ...boltParts], ...meta, sight: norm.sight, adsZ: norm.adsZ };
}

/* ---------------- schematic ----------------
   Orthographic side view of the same part list, in the gunsmith's 520×260
   viewBox. Muzzle to the right, matching how the weapon is carried. */
// The 3D palette is tuned for a lit scene; on a flat dark panel the same
// values read as one black mass, so the schematic lifts every fill toward the
// paper colour.
function schematicFill(mat) {
  const c = MAT_COLORS[mat] ?? MAT_COLORS.dgy;
  const k = mat === "acc" || mat === "lens" ? 0 : 0.26;
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
