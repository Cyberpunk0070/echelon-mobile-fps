// ECHELON sim — static world: map generation, broadphase, collision, rays.
//
// Pure simulation. No THREE, no DOM, no Math.random. buildWorld() returns both
// the collision AABBs and the draw specs the client needs, so the dockyard has
// exactly one definition rather than a renderer's copy and a server's copy that
// can drift apart.
import { lehmer } from "./rng.js";
import { Vec3 } from "./vec.js";

export const ARENA = 47;          // half-extent of playable area
export const GRAVITY = 16;
export const EYE = 1.55;
export const EYE_CROUCH = 1.02;
export const SPRINT_MULT = 1.5;
export const CROUCH_MULT = 0.52;
export const SPRINT_OUT = 0.18;   // seconds from dropping sprint to first shot

const DARK_RED = 0xff563c;

/* ---------------- broadphase ----------------
   Uniform spatial hash over the static world AABBs. Queries that used to scan
   every box now touch only the cells they overlap, and rays walk the grid with
   a 2D DDA (the standard voxel-traversal approach) instead of testing all of
   them. Cell size is tuned to the container footprint. */
const GRID_CELL = 6;

export class SpatialHash {
  constructor(boxes, cell = GRID_CELL) {
    this.cell = cell;
    this.boxes = boxes;
    this.map = new Map();
    this.stamp = new Int32Array(boxes.length);
    this.tick = 0;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      const x0 = Math.floor(b.minX / cell), x1 = Math.floor(b.maxX / cell);
      const z0 = Math.floor(b.minZ / cell), z1 = Math.floor(b.maxZ / cell);
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          const k = x * 73856093 ^ z * 19349663;
          let arr = this.map.get(k);
          if (!arr) { arr = []; this.map.set(k, arr); }
          arr.push(i);
        }
      }
    }
  }

  cellAt(x, z) { return this.map.get(x * 73856093 ^ z * 19349663); }

  // indices of boxes whose cells overlap the XZ rect, deduped via a stamp
  query(minX, maxX, minZ, maxZ, out) {
    out.length = 0;
    const c = this.cell;
    const t = ++this.tick;
    const x0 = Math.floor(minX / c), x1 = Math.floor(maxX / c);
    const z0 = Math.floor(minZ / c), z1 = Math.floor(maxZ / c);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const arr = this.cellAt(x, z);
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) {
          const bi = arr[i];
          if (this.stamp[bi] === t) continue;
          this.stamp[bi] = t;
          out.push(bi);
        }
      }
    }
    return out;
  }
}

// Ray vs AABB, slab method. Returns entry distance or Infinity.
export function slabHit(b, ox, oy, oz, dx, dy, dz, maxDist) {
  let tmin = 0, tmax = maxDist;
  if (Math.abs(dx) < 1e-9) { if (ox < b.minX || ox > b.maxX) return Infinity; }
  else {
    let t1 = (b.minX - ox) / dx, t2 = (b.maxX - ox) / dx;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return Infinity;
  }
  if (Math.abs(dy) < 1e-9) { if (oy < b.y0 || oy > b.top) return Infinity; }
  else {
    let t1 = (b.y0 - oy) / dy, t2 = (b.top - oy) / dy;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return Infinity;
  }
  if (Math.abs(dz) < 1e-9) { if (oz < b.minZ || oz > b.maxZ) return Infinity; }
  else {
    let t1 = (b.minZ - oz) / dz, t2 = (b.maxZ - oz) / dz;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return Infinity;
  }
  return tmin;
}

/* Segmented hitboxes in the entity's local frame (facing -z, origin at feet),
   the standard FPS model: a head worth a one-shot multiplier, a torso, and
   lower-value legs. Replaces the old single cylinder + height threshold. */
export const HITBOXES = [
  { name: "HEAD", cx: 0, cy: 1.68, cz: 0, hx: 0.17, hy: 0.17, hz: 0.17, mult: 2.0 },
  { name: "CHEST", cx: 0, cy: 1.22, cz: 0, hx: 0.33, hy: 0.30, hz: 0.22, mult: 1.0 },
  { name: "ABDOMEN", cx: 0, cy: 0.80, cz: 0, hx: 0.30, hy: 0.22, hz: 0.20, mult: 0.9 },
  { name: "LEGS", cx: 0, cy: 0.36, cz: 0, hx: 0.28, hy: 0.36, hz: 0.19, mult: 0.75 },
];

// Ray vs a local-space box (half extents), slab method.
export function localSlabHit(h, ox, oy, oz, dx, dy, dz, maxDist) {
  let tmin = 0, tmax = maxDist;
  const lo = [h.cx - h.hx, h.cy - h.hy, h.cz - h.hz];
  const hi = [h.cx + h.hx, h.cy + h.hy, h.cz + h.hz];
  const o = [ox, oy, oz], d = [dx, dy, dz];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) { if (o[i] < lo[i] || o[i] > hi[i]) return Infinity; continue; }
    let t1 = (lo[i] - o[i]) / d[i], t2 = (hi[i] - o[i]) / d[i];
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return Infinity;
  }
  return tmin;
}

/* ---------------- map generation ----------------
   Deterministic: the dockyard is a pure function of the Lehmer seed, so client
   and server generate byte-identical geometry and no map data is ever sent over
   the network. `boxes` are collision AABBs; `specs` are draw instructions the
   client batches into InstancedMeshes. Both come out of the same addBox call so
   they can never disagree. */
export function buildWorld(seed = 1337) {
  const boxes = [];
  const specs = [];

  const addBox = (cx, cz, w, d, h, color, y0 = 0, stripe = null) => {
    specs.push({ x: cx, y: y0 + h / 2, z: cz, w, h, d, color });
    if (stripe) {
      specs.push({
        x: cx, y: y0 + h * 0.62, z: cz,
        w: w + 0.04, h: h * 0.18, d: d + 0.04, color: stripe,
      });
    }
    boxes.push({
      minX: cx - w / 2, maxX: cx + w / 2,
      minZ: cz - d / 2, maxZ: cz + d / 2,
      y0, top: y0 + h,
    });
  };

  // perimeter walls
  const W = ARENA + 1;
  addBox(0, -W - 1.5, W * 2 + 8, 3, 7, 0x322e2c);
  addBox(0, W + 1.5, W * 2 + 8, 3, 7, 0x322e2c);
  addBox(-W - 1.5, 0, 3, W * 2 + 8, 7, 0x322e2c);
  addBox(W + 1.5, 0, 3, W * 2 + 8, 7, 0x322e2c);

  // shipping containers — deterministic dockyard rows
  const grays = [0x3a3634, 0x474241, 0x555050, 0x625d5b];
  const rnd = lehmer(seed);
  const rows = [-30, -18, -6, 6, 18, 30];
  for (const rz of rows) {
    let x = -38;
    while (x < 38) {
      if (rnd() < 0.68) {
        const len = 7 + Math.floor(rnd() * 3) * 2;
        const col = grays[Math.floor(rnd() * grays.length)];
        const stripe = rnd() < 0.18 ? DARK_RED : null;
        const zj = (rnd() - 0.5) * 3;
        addBox(x + len / 2, rz + zj, len, 2.6, 2.6, col, 0, stripe);
        if (rnd() < 0.3) {
          const l2 = Math.max(5, len - 2);
          addBox(x + len / 2 + (rnd() - 0.5) * 2, rz + zj, l2, 2.6, 2.6,
            grays[Math.floor(rnd() * grays.length)], 2.6);
        }
        x += len + 2.5 + rnd() * 5;
      } else {
        x += 5 + rnd() * 6;
      }
    }
  }
  // scattered crates (vault targets)
  for (let i = 0; i < 26; i++) {
    const x = (rnd() * 2 - 1) * 40, z = (rnd() * 2 - 1) * 40;
    let clash = false;
    for (const b of boxes) {
      if (x > b.minX - 2 && x < b.maxX + 2 && z > b.minZ - 2 && z < b.maxZ + 2 && b.y0 === 0) {
        clash = true; break;
      }
    }
    if (clash) continue;
    addBox(x, z, 1.9, 1.9, 1.25, grays[Math.floor(rnd() * grays.length)]);
  }
  // central landmark: red monolith block (the "one red field")
  addBox(0, 0, 3.5, 3.5, 6.5, DARK_RED);

  return { boxes, specs };
}

/* ---------------- world queries ---------------- */

export class World {
  constructor(seed = 1337) {
    const { boxes, specs } = buildWorld(seed);
    this.boxes = boxes;
    this.specs = specs;          // consumed by the client, ignored by the server
    this.grid = new SpatialHash(boxes);
    this._q = [];                // scratch list reused by every broadphase query
  }

  collides(x, z, r, feet, head) {
    if (Math.abs(x) > ARENA || Math.abs(z) > ARENA) return true;
    const hits = this.grid.query(x - r, x + r, z - r, z + r, this._q);
    for (let i = 0; i < hits.length; i++) {
      const b = this.boxes[hits[i]];
      if (b.top <= feet + 0.55 || b.y0 >= head) continue; // can step on / walk under
      if (x + r > b.minX && x - r < b.maxX && z + r > b.minZ && z - r < b.maxZ) return true;
    }
    return false;
  }

  moveEntity(e, dx, dz) {
    const feet = e.pos.y, head = e.pos.y + (e.height || 1.8);
    const r = e.radius || 0.45;
    if (!this.collides(e.pos.x + dx, e.pos.z, r, feet, head)) e.pos.x += dx;
    if (!this.collides(e.pos.x, e.pos.z + dz, r, feet, head)) e.pos.z += dz;
  }

  groundHeight(x, z, r, feet) {
    let g = 0;
    const hits = this.grid.query(x - r, x + r, z - r, z + r, this._q);
    for (let i = 0; i < hits.length; i++) {
      const b = this.boxes[hits[i]];
      if (x + r > b.minX && x - r < b.maxX && z + r > b.minZ && z - r < b.maxZ) {
        if (b.top <= feet + 0.55 && b.top > g) g = b.top;
      }
    }
    return g;
  }

  // Nearest world hit along the ray, via 2D DDA over the spatial hash: only
  // the grid columns the ray actually crosses are tested, and traversal stops
  // as soon as the closest hit precedes the next cell boundary.
  rayWorldDist(ox, oy, oz, dx, dy, dz, maxDist) {
    let best = Infinity;
    if (dy < -1e-9) {                       // ground plane
      const tg = -oy / dy;
      if (tg > 0 && tg < best) best = tg;
    }
    const c = this.grid.cell;
    let cx = Math.floor(ox / c), cz = Math.floor(oz / c);
    const stepX = dx > 1e-9 ? 1 : dx < -1e-9 ? -1 : 0;
    const stepZ = dz > 1e-9 ? 1 : dz < -1e-9 ? -1 : 0;
    const tDeltaX = stepX ? Math.abs(c / dx) : Infinity;
    const tDeltaZ = stepZ ? Math.abs(c / dz) : Infinity;
    let tMaxX = stepX ? ((stepX > 0 ? (cx + 1) * c : cx * c) - ox) / dx : Infinity;
    let tMaxZ = stepZ ? ((stepZ > 0 ? (cz + 1) * c : cz * c) - oz) / dz : Infinity;

    const tick = ++this.grid.tick;
    const stamp = this.grid.stamp;
    let t = 0;
    for (let guard = 0; guard < 512; guard++) {
      const arr = this.grid.cellAt(cx, cz);
      if (arr) {
        for (let i = 0; i < arr.length; i++) {
          const bi = arr[i];
          if (stamp[bi] === tick) continue;
          stamp[bi] = tick;
          const h = slabHit(this.boxes[bi], ox, oy, oz, dx, dy, dz, maxDist);
          if (h < best) best = h;
        }
      }
      if (!stepX && !stepZ) break;
      const nextT = Math.min(tMaxX, tMaxZ);
      if (nextT > maxDist || best <= nextT) break;  // nothing closer can exist
      if (tMaxX < tMaxZ) { t = tMaxX; cx += stepX; tMaxX += tDeltaX; }
      else { t = tMaxZ; cz += stepZ; tMaxZ += tDeltaZ; }
      if (t > maxDist) break;
    }
    return best;
  }

  /* Nearest hittable entity along the ray. Transforms the ray into each
     candidate's local frame and slab-tests the segmented boxes, so a headshot
     is an actual head intersection rather than a height comparison.

     `shooter` is excluded along with anyone on its team. This replaced a
     hardcoded `team === 0` skip, which silently assumed exactly one human on
     the ally side — untrue the moment a second player connects. */
  raycastEntities(entities, shooter, ox, oy, oz, dx, dy, dz, maxT) {
    let bestT = maxT, bestEnt = null, bestPart = null;
    for (const e of entities) {
      if (e === shooter || !e.alive || e.team === shooter.team) continue;
      // cheap reject: skip entities whose bounding sphere the ray misses
      const rx = e.pos.x - ox, ry = (e.pos.y + 0.9) - oy, rz = e.pos.z - oz;
      const along = rx * dx + ry * dy + rz * dz;
      if (along < -1.2 || along > bestT + 1.2) continue;
      const perp2 = (rx * rx + ry * ry + rz * rz) - along * along;
      if (perp2 > 1.44) continue;                        // 1.2 m radius
      const c = Math.cos(e.yaw), s = Math.sin(e.yaw);
      const px = ox - e.pos.x, pz = oz - e.pos.z;
      const lx = px * c - pz * s, lz = px * s + pz * c;
      const ly = oy - e.pos.y;
      const ldx = dx * c - dz * s, ldz = dx * s + dz * c;
      for (const h of HITBOXES) {
        const t = localSlabHit(h, lx, ly, lz, ldx, dy, ldz, bestT);
        if (t < bestT) { bestT = t; bestEnt = e; bestPart = h; }
      }
    }
    return bestEnt ? { ent: bestEnt, t: bestT, part: bestPart } : null;
  }

  losBlocked(x1, y1, z1, x2, y2, z2) {
    const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-6) return false;
    const t = this.rayWorldDist(x1, y1, z1, dx / len, dy / len, dz / len, len);
    return t < len - 0.1;
  }

  // Push an entity out of any box it is overlapping. Without this, ending up
  // inside geometry fails BOTH axis tests in moveEntity forever — the "stuck
  // and can't move" report. Costs one pass over the AABB list.
  unstick(e, rng) {
    const r = e.radius, feet = e.pos.y, head = e.pos.y + (e.height || 1.8);
    for (const b of this.boxes) {
      if (b.top <= feet + 0.05 || b.y0 >= head) continue;   // standing on / under it
      if (e.pos.x + r <= b.minX || e.pos.x - r >= b.maxX) continue;
      if (e.pos.z + r <= b.minZ || e.pos.z - r >= b.maxZ) continue;
      const outMinX = (e.pos.x + r) - b.minX;   // distance to escape via -x
      const outMaxX = b.maxX - (e.pos.x - r);
      const outMinZ = (e.pos.z + r) - b.minZ;
      const outMaxZ = b.maxZ - (e.pos.z - r);
      const m = Math.min(outMinX, outMaxX, outMinZ, outMaxZ);
      if (m === outMinX) e.pos.x -= m + 0.02;
      else if (m === outMaxX) e.pos.x += m + 0.02;
      else if (m === outMinZ) e.pos.z -= m + 0.02;
      else e.pos.z += m + 0.02;
    }
    const lim = ARENA - 0.15;
    e.pos.x = Math.max(-lim, Math.min(lim, e.pos.x));
    e.pos.z = Math.max(-lim, Math.min(lim, e.pos.z));
    if (e.pos.y < -2) { e.pos.copy(this.spawnFor(e.team, rng)); e.vy = 0; } // fell out of the world
  }

  spawnFor(team, rng) {
    const bx = team === 0 ? -40 : 40;
    for (let i = 0; i < 24; i++) {
      const x = bx + (rng.float() - 0.5) * 8;
      const z = (rng.float() - 0.5) * 44;
      if (!this.collides(x, z, 0.5, 0, 1.8)) return new Vec3(x, 0, z);
    }
    return new Vec3(bx, 0, 0);
  }

  randomNavPoint(rng) {
    for (let i = 0; i < 12; i++) {
      const x = (rng.float() * 2 - 1) * (ARENA - 4);
      const z = (rng.float() * 2 - 1) * (ARENA - 4);
      if (!this.collides(x, z, 0.5, 0, 1.8)) return new Vec3(x, 0, z);
    }
    return new Vec3(0, 0, 20);
  }

  // Probe ahead of an entity for a mantle-able ledge. Returns the landing spot
  // or null; the caller owns the resulting animation and its timing.
  findLedge(e, yaw) {
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const px = e.pos.x + fx * 1.15, pz = e.pos.z + fz * 1.15;
    let ledge = null;
    for (const b of this.boxes) {
      if (px > b.minX - 0.3 && px < b.maxX + 0.3 && pz > b.minZ - 0.3 && pz < b.maxZ + 0.3) {
        const rel = b.top - e.pos.y;
        if (rel > 0.5 && rel < 1.9 && (!ledge || b.top < ledge.top)) ledge = b;
      }
    }
    if (!ledge) return null;
    const to = new Vec3(
      Math.max(ledge.minX + 0.5, Math.min(ledge.maxX - 0.5, px)),
      ledge.top,
      Math.max(ledge.minZ + 0.5, Math.min(ledge.maxZ - 0.5, pz))
    );
    // landing spot must have standing room — a stacked container or the
    // perimeter wall above the ledge would entomb the entity
    if (this.collides(to.x, to.z, e.radius, to.y, to.y + e.height)) return null;
    return to;
  }
}
