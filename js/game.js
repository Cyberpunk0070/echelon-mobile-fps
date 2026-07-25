// ECHELON — game runtime: dockyard arena, player controller, combat, HUD.
import * as THREE from "three";
import { Bot } from "./bots.js";
import { SQUAD_ALLY, SQUAD_ENEMY, MATCH } from "./data.js";

const DARK = { bg: 0x151312, surface: 0x211f1e, text: 0xf3f2f2, red: 0xff563c };
const ARENA = 47;              // half-extent of playable area
const GRAVITY = 16;
const EYE = 1.55;
const EYE_CROUCH = 1.02;
const SPRINT_MULT = 1.5;
const CROUCH_MULT = 0.52;
const SPRINT_OUT = 0.18;   // seconds from dropping sprint to first shot

const _a = new THREE.Vector3(), _b = new THREE.Vector3();

/* ---------------- broadphase ----------------
   Uniform spatial hash over the static world AABBs. Queries that used to scan
   every box now touch only the cells they overlap, and rays walk the grid with
   a 2D DDA (the standard voxel-traversal approach) instead of testing all of
   them. Cell size is tuned to the container footprint. */
const GRID_CELL = 6;

class SpatialHash {
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
function slabHit(b, ox, oy, oz, dx, dy, dz, maxDist) {
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

/* Segmented hitboxes in the bot's local frame (facing -z, origin at feet),
   the standard FPS model: a head worth a one-shot multiplier, a torso, and
   lower-value legs. Replaces the old single cylinder + height threshold. */
const HITBOXES = [
  { name: "HEAD", cx: 0, cy: 1.68, cz: 0, hx: 0.17, hy: 0.17, hz: 0.17, mult: 2.0 },
  { name: "CHEST", cx: 0, cy: 1.22, cz: 0, hx: 0.33, hy: 0.30, hz: 0.22, mult: 1.0 },
  { name: "ABDOMEN", cx: 0, cy: 0.80, cz: 0, hx: 0.30, hy: 0.22, hz: 0.20, mult: 0.9 },
  { name: "LEGS", cx: 0, cy: 0.36, cz: 0, hx: 0.28, hy: 0.36, hz: 0.19, mult: 0.75 },
];

// Ray vs a local-space box (half extents), slab method.
function localSlabHit(h, ox, oy, oz, dx, dy, dz, maxDist) {
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

/* ---------------- audio ---------------- */
class Sfx {
  constructor() { this.ctx = null; }
  ensure() {
    if (!this.ctx) {
      try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.32;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  }
  noise(dur, vol, freq, decay = 0.9) {
    const ctx = this.ensure(); if (!ctx) return;
    const n = ctx.createBufferSource();
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(decay, i / len * 20);
    n.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = "lowpass"; f.frequency.value = freq;
    const g = ctx.createGain(); g.gain.value = vol;
    n.connect(f); f.connect(g); g.connect(this.master);
    n.start();
  }
  tone(freq, dur, vol, type = "square", slide = 0) {
    const ctx = this.ensure(); if (!ctx) return;
    const o = ctx.createOscillator();
    o.type = type; o.frequency.value = freq;
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), ctx.currentTime + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.connect(g); g.connect(this.master);
    o.start(); o.stop(ctx.currentTime + dur);
  }
  fire() { this.noise(0.09, 0.5, 2600); this.tone(160, 0.07, 0.25, "square", -110); }
  enemyFire(dist) { const v = Math.max(0.03, 0.3 - dist * 0.005); this.noise(0.08, v, 900); }
  hit() { this.tone(1900, 0.05, 0.22, "square"); }
  kill() { this.tone(780, 0.07, 0.25, "square"); setTimeout(() => this.tone(1170, 0.09, 0.25, "square"), 70); }
  magOut() { this.tone(340, 0.05, 0.22, "square", -90); this.noise(0.04, 0.12, 1500); }
  magIn() { this.tone(230, 0.07, 0.26, "square", 50); this.noise(0.05, 0.16, 1100); }
  rack() { this.tone(500, 0.04, 0.2, "square"); setTimeout(() => this.tone(380, 0.05, 0.2, "square"), 70); }
  hurt() { this.tone(110, 0.16, 0.4, "sawtooth", -40); }
  vault() { this.noise(0.12, 0.2, 500); }
}

/* ---------------- game ---------------- */
export class Game {
  constructor({ canvas, loadout, onEnd }) {
    this.canvas = canvas;
    this.loadout = loadout;
    this.onEnd = onEnd;
    this.sfx = new Sfx();
    this.paused = false;
    this.over = false;
    this.disposed = false;
    this.raf = 0;
    this.boxes = [];       // {minX,maxX,y0,top,minZ,maxZ}
    this.boxSpecs = [];    // draw specs, batched into InstancedMeshes at map end
    this.tracers = [];
    this.feedTimers = [];
    this._bound = [];
    this.$ = id => document.getElementById(id);
  }

  /* ---------- setup ---------- */
  start() {
    this.setupScene();
    this.buildMap();
    this.setupPlayer();
    this.setupBots();
    this.setupViewmodel();
    this.setupInput();
    this.setupHud();
    this.time = MATCH.timeLimit;
    this.score = [0, 0];
    this.last = performance.now();
    this.fpsFrames = 0; this.fpsT = 0;
    this.pushTimer = 20;
    window.__game = this; // debug/QA handle
    const loop = (now) => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      const rawDt = (now - this.last) / 1000;
      this.last = now;
      const dt = Math.min(rawDt, 0.05);
      // fps readout (status strip) — counts real rAF cadence, updates 2x/s
      this.fpsFrames++; this.fpsT += rawDt;
      if (this.fpsT >= 0.5) {
        this.$("fps").textContent = Math.round(this.fpsFrames / this.fpsT) + " FPS";
        this.fpsFrames = 0; this.fpsT = 0;
      }
      if (!this.paused && !this.over) {
        this.update(dt);
        // adaptive resolution: if the phone can't hold frame time, step the
        // pixel ratio down (and back up when there's headroom)
        this.perfAccum += rawDt; this.perfFrames++;
        // 0.004 guard: ignore implausible sub-4ms deltas (rAF never
        // legitimately paces above 250 Hz)
        if (rawDt >= 0.004) {
          if (rawDt < this.perfMin1) { this.perfMin2 = this.perfMin1; this.perfMin1 = rawDt; }
          else if (rawDt < this.perfMin2) { this.perfMin2 = rawDt; }
        }
        if (this.perfFrames >= 120) {
          const avg = this.perfAccum / this.perfFrames;
          const floor = this.perfMin2 === Infinity ? 0.0167 : this.perfMin2;
          this.perfAccum = 0; this.perfFrames = 0;
          this.perfMin1 = Infinity; this.perfMin2 = Infinity;
          const scales = [1, 0.8, 0.65];
          // missing >~40% of vsyncs -> downscale; comfortably hitting them -> restore
          if (avg > floor * 1.7 && this.perfLevel < 2) this.perfLevel++;
          else if (avg < floor * 1.25 && this.perfLevel > 0) this.perfLevel--;
          const target = this.basePixelRatio * scales[this.perfLevel];
          if (Math.abs(this.renderer.getPixelRatio() - target) > 0.01) {
            this.renderer.setPixelRatio(target);
            this.resize();
          }
        }
      }
      this.renderer.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(loop);
  }

  setupScene() {
    // high-dpi phones (S23 Ultra: dpr ~3) render at a capped ratio; MSAA is
    // skipped there since the resolution already covers it
    this.basePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: this.basePixelRatio < 2,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(this.basePixelRatio);
    this.perfLevel = 0; this.perfAccum = 0; this.perfFrames = 0;
    // Per-window estimate of the display's vsync period, so the perf
    // thresholds scale to 120 Hz or 60 Hz instead of a hardcoded budget.
    // Two minima are tracked and the *second* smallest is used: rAF
    // occasionally fires early, and a single outlier must not skew the floor.
    this.perfMin1 = Infinity; this.perfMin2 = Infinity;
    this.geoCache = new THREE.BoxGeometry(1, 1, 1);
    this.matCache = new Map();
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(DARK.bg);
    this.scene.fog = new THREE.Fog(DARK.bg, 30, 110);
    this.camera = new THREE.PerspectiveCamera(74, 1, 0.08, 240);
    this.resize();
    this._onResize = () => this.resize();
    window.addEventListener("resize", this._onResize);

    // Three-point rig: a warm key defines form, a cool fill keeps shadowed
    // faces readable (enemies used to vanish into them), and a low bounce
    // separates geometry from the ground plane.
    const hemi = new THREE.HemisphereLight(0xaebac6, 0x38302c, 1.25);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xfff0e4, 1.55);
    key.position.set(30, 60, -20);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x93b0cc, 0.62);
    fill.position.set(-42, 26, 38);
    this.scene.add(fill);
    const bounce = new THREE.DirectionalLight(0xffd9c2, 0.24);
    bounce.position.set(6, -20, 12);
    this.scene.add(bounce);
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  mat(color) {
    let m = this.matCache.get(color);
    if (!m) { m = new THREE.MeshLambertMaterial({ color }); this.matCache.set(color, m); }
    return m;
  }

  // Records a world box: an AABB for collision plus a draw spec. Nothing is
  // added to the scene here — buildStaticMeshes() batches the specs into one
  // InstancedMesh per color, which is what keeps the draw-call count flat.
  addBox(cx, cz, w, d, h, color, y0 = 0, stripe = null) {
    this.boxSpecs.push({ x: cx, y: y0 + h / 2, z: cz, w, h, d, color });
    if (stripe) {
      this.boxSpecs.push({
        x: cx, y: y0 + h * 0.62, z: cz,
        w: w + 0.04, h: h * 0.18, d: d + 0.04, color: stripe,
      });
    }
    this.boxes.push({ minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2, y0, top: y0 + h });
  }

  buildStaticMeshes() {
    const byColor = new Map();
    for (const s of this.boxSpecs) {
      let list = byColor.get(s.color);
      if (!list) { list = []; byColor.set(s.color, list); }
      list.push(s);
    }
    const m4 = new THREE.Matrix4();
    for (const [color, list] of byColor) {
      const im = new THREE.InstancedMesh(this.geoCache, this.mat(color), list.length);
      list.forEach((s, i) => {
        m4.makeScale(s.w, s.h, s.d);
        m4.setPosition(s.x, s.y, s.z);
        im.setMatrixAt(i, m4);
      });
      im.instanceMatrix.needsUpdate = true;
      im.frustumCulled = false; // instance bounds span the arena; culling can't help
      this.scene.add(im);
    }
    this.boxSpecs = null;
  }

  buildMap() {
    // ground: dark slab with a modernist grid texture
    const gc = document.createElement("canvas");
    gc.width = gc.height = 512;
    const g2 = gc.getContext("2d");
    g2.fillStyle = "#232020"; g2.fillRect(0, 0, 512, 512);
    g2.strokeStyle = "rgba(243,242,242,0.13)"; g2.lineWidth = 2;
    for (let i = 0; i <= 8; i++) {
      g2.beginPath(); g2.moveTo(i * 64, 0); g2.lineTo(i * 64, 512); g2.stroke();
      g2.beginPath(); g2.moveTo(0, i * 64); g2.lineTo(512, i * 64); g2.stroke();
    }
    g2.fillStyle = "rgba(255,86,60,0.55)";
    g2.fillRect(250, 250, 12, 12);
    const gt = new THREE.CanvasTexture(gc);
    gt.wrapS = gt.wrapT = THREE.RepeatWrapping;
    gt.repeat.set(12, 12);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(ARENA * 2 + 10, ARENA * 2 + 10),
      new THREE.MeshLambertMaterial({ map: gt })
    );
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);

    // perimeter walls
    const W = ARENA + 1;
    this.addBox(0, -W - 1.5, W * 2 + 8, 3, 7, 0x322e2c);
    this.addBox(0, W + 1.5, W * 2 + 8, 3, 7, 0x322e2c);
    this.addBox(-W - 1.5, 0, 3, W * 2 + 8, 7, 0x322e2c);
    this.addBox(W + 1.5, 0, 3, W * 2 + 8, 7, 0x322e2c);

    // shipping containers — deterministic dockyard rows
    const grays = [0x3a3634, 0x474241, 0x555050, 0x625d5b];
    let seed = 1337;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const rows = [-30, -18, -6, 6, 18, 30];
    for (const rz of rows) {
      let x = -38;
      while (x < 38) {
        if (rnd() < 0.68) {
          const len = 7 + Math.floor(rnd() * 3) * 2;
          const col = grays[Math.floor(rnd() * grays.length)];
          const stripe = rnd() < 0.18 ? DARK.red : null;
          const zj = (rnd() - 0.5) * 3;
          this.addBox(x + len / 2, rz + zj, len, 2.6, 2.6, col, 0, stripe);
          if (rnd() < 0.3) {
            const l2 = Math.max(5, len - 2);
            this.addBox(x + len / 2 + (rnd() - 0.5) * 2, rz + zj, l2, 2.6, 2.6, grays[Math.floor(rnd() * grays.length)], 2.6);
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
      for (const b of this.boxes) {
        if (x > b.minX - 2 && x < b.maxX + 2 && z > b.minZ - 2 && z < b.maxZ + 2 && b.y0 === 0) { clash = true; break; }
      }
      if (clash) continue;
      this.addBox(x, z, 1.9, 1.9, 1.25, grays[Math.floor(rnd() * grays.length)]);
    }
    // central landmark: red monolith block (the "one red field")
    this.addBox(0, 0, 3.5, 3.5, 6.5, DARK.red);

    this.buildStaticMeshes();
    this.grid = new SpatialHash(this.boxes);
    this._q = [];   // scratch list reused by every broadphase query
  }

  /* ---------- collision & rays ---------- */
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

  // Nearest enemy hitbox along the ray. Transforms the ray into each bot's
  // local frame and slab-tests the segmented boxes, so a headshot is an actual
  // head intersection rather than a height comparison.
  raycastBots(ox, oy, oz, dx, dy, dz, maxT) {
    let bestT = maxT, bestBot = null, bestPart = null;
    for (const b of this.bots) {
      if (!b.alive || b.team === 0) continue;
      // cheap reject: skip bots whose bounding sphere the ray misses
      const rx = b.pos.x - ox, ry = (b.pos.y + 0.9) - oy, rz = b.pos.z - oz;
      const along = rx * dx + ry * dy + rz * dz;
      if (along < -1.2 || along > bestT + 1.2) continue;
      const perp2 = (rx * rx + ry * ry + rz * rz) - along * along;
      if (perp2 > 1.44) continue;                        // 1.2 m radius
      const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
      const px = ox - b.pos.x, pz = oz - b.pos.z;
      const lx = px * c - pz * s, lz = px * s + pz * c;
      const ly = oy - b.pos.y;
      const ldx = dx * c - dz * s, ldz = dx * s + dz * c;
      for (const h of HITBOXES) {
        const t = localSlabHit(h, lx, ly, lz, ldx, dy, ldz, bestT);
        if (t < bestT) { bestT = t; bestBot = b; bestPart = h; }
      }
    }
    return bestBot ? { bot: bestBot, t: bestT, part: bestPart } : null;
  }

  losBlocked(x1, y1, z1, x2, y2, z2) {
    const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-6) return false;
    const t = this.rayWorldDist(x1, y1, z1, dx / len, dy / len, dz / len, len);
    return t < len - 0.1;
  }

  spawnFor(team) {
    const bx = team === 0 ? -40 : 40;
    for (let i = 0; i < 24; i++) {
      const x = bx + (Math.random() - 0.5) * 8;
      const z = (Math.random() - 0.5) * 44;
      if (!this.collides(x, z, 0.5, 0, 1.8)) return new THREE.Vector3(x, 0, z);
    }
    return new THREE.Vector3(bx, 0, 0);
  }

  randomNavPoint() {
    for (let i = 0; i < 12; i++) {
      const x = (Math.random() * 2 - 1) * (ARENA - 4);
      const z = (Math.random() * 2 - 1) * (ARENA - 4);
      if (!this.collides(x, z, 0.5, 0, 1.8)) return new THREE.Vector3(x, 0, z);
    }
    return new THREE.Vector3(0, 0, 20);
  }

  /* ---------- player ---------- */
  setupPlayer() {
    const L = this.loadout;
    this.player = {
      isPlayer: true, name: "VIPER-04", team: 0,
      pos: this.spawnFor(0), yaw: 0, pitch: 0,
      vy: 0, grounded: true,
      alive: true, hp: 100, radius: 0.4, height: 1.8,
      speedVal: 0, kills: 0, deaths: 0,
      ammo: L.mag, reserve: L.reserve,
      reloading: 0, shotT: 0, lastHurt: -10,
      respawnT: 0, vaultT: 0, vaultFrom: null, vaultTo: null,
      eyeH: EYE, sprintOutT: 0,
    };
    this.sprinting = false;
    this.crouching = false;
    // face the arena center (forward is (-sin yaw, -cos yaw))
    this.player.yaw = Math.atan2(this.player.pos.x, this.player.pos.z);
  }

  setupBots() {
    this.bots = [];
    for (let i = 1; i < SQUAD_ALLY.length; i++) this.bots.push(new Bot(SQUAD_ALLY[i], 0));
    for (const n of SQUAD_ENEMY) this.bots.push(new Bot(n, 1));
    for (const b of this.bots) b.mesh = this.makeBotMesh(b.team);
    this.combatants = [this.player, ...this.bots];
    this.botCtx = {
      combatants: this.combatants,
      escalation: 0,   // 0 -> 1 across the match; drives bot speed/accuracy
      world: {
        losBlocked: (...a) => this.losBlocked(...a),
        moveEntity: (e, dx, dz) => this.moveEntity(e, dx, dz),
        spawnFor: t => this.spawnFor(t),
        randomNavPoint: () => this.randomNavPoint(),
      },
      events: {
        onBotShot: (bot, target, hit, dmg) => this.handleBotShot(bot, target, hit, dmg),
        onDeath: (bot, killer) => this.handleDeath(bot, killer),
        onRespawn: (bot) => { bot.mesh.visible = true; },
      },
    };
  }

  makeBotMesh(team) {
    const grp = new THREE.Group();
    const bodyCol = team === 1 ? 0x3b322f : 0x565150;
    const accCol = team === 1 ? DARK.red : 0xd8d5d2;
    const part = (w, h, d, x, y, z, c) => {
      const m = new THREE.Mesh(this.geoCache, this.mat(c));
      m.scale.set(w, h, d);
      m.position.set(x, y, z);
      grp.add(m);
      return m;
    };
    part(0.62, 1.12, 0.4, 0, 0.94, 0, bodyCol);           // body
    part(0.3, 0.3, 0.3, 0, 1.68, 0, bodyCol);             // head
    part(0.32, 0.07, 0.31, 0, 1.7, -0.01, accCol);        // visor
    part(0.66, 0.12, 0.44, 0, 1.32, 0, accCol);           // stripe
    part(0.5, 0.42, 0.34, 0, 0.21, 0, 0x1e1b1a);          // legs
    part(0.1, 0.12, 0.7, 0.22, 1.18, -0.36, 0x151312);    // gun
    grp.visible = false;
    this.scene.add(grp);
    return grp;
  }

  setupViewmodel() {
    // honest schematic blocks — the design's assembling parts, held in-hand
    const vm = new THREE.Group();
    const mk = (w, h, d, x, y, z, c) => {
      const m = new THREE.Mesh(this.geoCache, this.mat(c));
      m.scale.set(w, h, d);
      m.position.set(x, y, z);
      vm.add(m);
      return m;
    };
    mk(0.09, 0.1, 0.5, 0.26, -0.24, -0.55, 0x2e2b29);        // receiver
    mk(0.05, 0.05, 0.42, 0.26, -0.21, -0.95, 0x413c3a);      // barrel
    mk(0.012, 0.05, 0.05, 0.26, -0.155, -0.62, DARK.red);    // optic accent
    this.vmMag = mk(0.07, 0.16, 0.1, 0.26, -0.36, -0.48, 0x242120); // magazine
    this.vmMagBase = this.vmMag.position.clone();
    this.vmFlash = new THREE.Mesh(this.geoCache, new THREE.MeshBasicMaterial({ color: DARK.red }));
    this.vmFlash.scale.set(0.09, 0.09, 0.09);
    this.vmFlash.position.set(0.26, -0.2, -1.2);
    this.vmFlash.visible = false;
    vm.add(this.vmFlash);
    this.viewmodel = vm;
    this.camera.add(vm);
    this.scene.add(this.camera);
    this.vmKick = 0;
    this._rlPhase = -1;
    this.sprintBlend = 0;
    this.runT = 0;

    this.setupTracers();
  }

  // All tracers live in one LineSegments over a fixed buffer: one draw call
  // and zero per-shot allocation, so heavy crossfire can't trigger GC hitches.
  setupTracers() {
    this.tracerMax = 64;
    this.tracerPos = new Float32Array(this.tracerMax * 6);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.tracerPos, 3));
    geo.setDrawRange(0, 0);
    this.tracerMat = new THREE.LineBasicMaterial({ color: 0xffb3a6, transparent: true, opacity: 0.7 });
    this.tracerMesh = new THREE.LineSegments(geo, this.tracerMat);
    this.tracerMesh.frustumCulled = false;
    this.scene.add(this.tracerMesh);
    this.tracers = [];
  }

  // Staged reload: tilt in → mag drops out → grab pause → new mag seats →
  // charging-handle rack, all scaled to the loadout's real reload time.
  animateReload(t) {
    const ph = t < 0.15 ? 0 : t < 0.45 ? 1 : t < 0.55 ? 2 : t < 0.8 ? 3 : 4;
    if (ph !== this._rlPhase) {
      this._rlPhase = ph;
      if (ph === 1) this.sfx.magOut();
      if (ph === 3) this.sfx.magIn();
      if (ph === 4) this.sfx.rack();
    }
    const ease = x => x * x * (3 - 2 * x);
    const vm = this.viewmodel, mag = this.vmMag;
    // whole-gun tilt toward the player while hands work the mag well
    const tilt = t < 0.15 ? ease(t / 0.15) : t > 0.8 ? 1 - ease((t - 0.8) / 0.2) : 1;
    vm.rotation.z = 0.22 * tilt;
    vm.rotation.x = 0.13 * tilt;
    vm.position.y = -0.05 * tilt;
    // magazine out / in
    let magY = 0, magRX = 0, magVisible = true;
    if (t >= 0.15 && t < 0.45) {
      const k = ease((t - 0.15) / 0.3);
      magY = -0.42 * k; magRX = -0.75 * k;
    } else if (t >= 0.45 && t < 0.55) {
      magVisible = false;                      // old mag away, grabbing fresh one
    } else if (t >= 0.55 && t < 0.8) {
      const k = ease((t - 0.55) / 0.25);
      magY = -0.42 * (1 - k); magRX = -0.75 * (1 - k);
    } else if (t >= 0.8) {
      // rack: quick back-and-forward jolt of the whole gun
      vm.position.z = 0.07 * Math.sin(((t - 0.8) / 0.2) * Math.PI);
    }
    mag.position.y = this.vmMagBase.y + magY;
    mag.rotation.x = magRX;
    mag.visible = magVisible;
    const pctText = (t * 100).toFixed(0) + "%";
    this.$("reload-fill").style.width = pctText;
    this.$("reload-cuff").style.width = pctText;   // progress on the button itself
  }

  spawnTracer(from, to) {
    if (this.tracers.length >= this.tracerMax) this.tracers.shift();
    this.tracers.push({
      ax: from.x, ay: from.y, az: from.z,
      bx: to.x, by: to.y, bz: to.z, t: 0.06,
    });
  }

  updateTracers(dt) {
    const arr = this.tracers, pos = this.tracerPos;
    let n = 0;
    for (let i = 0; i < arr.length; i++) {
      const tr = arr[i];
      tr.t -= dt;
      if (tr.t <= 0) continue;
      arr[n] = tr;                       // compact survivors toward the front
      const o = n * 6;
      pos[o] = tr.ax; pos[o + 1] = tr.ay; pos[o + 2] = tr.az;
      pos[o + 3] = tr.bx; pos[o + 4] = tr.by; pos[o + 5] = tr.bz;
      n++;
    }
    arr.length = n;
    this.tracerMesh.geometry.setDrawRange(0, n * 2);
    this.tracerMesh.geometry.attributes.position.needsUpdate = true;
  }

  /* ---------- input ---------- */
  setupInput() {
    this.keys = {};
    this.stick = { active: false, id: -1, ox: 0, oy: 0, x: 0, y: 0 };
    this.look = { id: -1, lx: 0, ly: 0 };
    this.firing = false;
    this.pointerLocked = false;
    this.ads = 0;          // 0 = hip, 1 = fully aimed
    this.adsOn = false;
    this.lookScale = 1;    // sensitivity follows fov while aiming

    const kd = e => {
      if (e.repeat) return;
      this.keys[e.code] = true;
      if (e.code === "KeyR") this.startReload();
      if (e.code === "Space") { e.preventDefault(); this.doVault(); }
      if (e.code === "KeyC") this.toggleCrouch();
      if (e.code === "ShiftLeft" || e.code === "ShiftRight") this.setSprint(true);
    };
    const ku = e => {
      this.keys[e.code] = false;
      if (e.code === "ShiftLeft" || e.code === "ShiftRight") this.setSprint(false);
    };
    this.bind(window, "keydown", kd);
    this.bind(window, "keyup", ku);
    // any focus loss drops every held input — a key/touch released off-window
    // would otherwise stay latched and leave the player running or firing
    this.bind(window, "blur", () => this.resetInput());

    // desktop: pointer lock look + click fire
    this.bind(this.canvas, "mousedown", e => {
      if (this.paused || this.over || !this.player.alive) return;
      if (!this.pointerLocked) { this.canvas.requestPointerLock?.(); return; }
      if (e.button === 0) this.firing = true;
      if (e.button === 2) this.adsOn = true;   // desktop: hold right mouse to ADS
    });
    this.bind(window, "mouseup", e => {
      if (e.button === 2) this.adsOn = false;
      this.firing = this.fireBtnHeld || false;
    });
    this.bind(this.canvas, "contextmenu", e => e.preventDefault());
    this.bind(document, "pointerlockchange", () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
    });
    this.bind(window, "mousemove", e => {
      if (!this.pointerLocked || this.paused) return;
      this.player.yaw -= e.movementX * 0.0023 * this.lookScale;
      this.player.pitch -= e.movementY * 0.0023 * this.lookScale;
      this.clampPitch();
    });

    // touch: left = move stick, right = look. The HUD layer is
    // pointer-events:none, so free touches land on the stage; touches that
    // start on HUD buttons are skipped here and handled by the buttons.
    const surface = this.$("stage");
    this.bind(surface, "touchstart", e => {
      this.reconcileTouches(e);
      if (this.paused || this.over) return;
      for (const t of e.changedTouches) {
        if (t.target?.closest?.("button")) continue;
        const x = t.clientX, y = t.clientY;
        if (x < window.innerWidth * 0.42 && this.stick.id === -1) {
          this.stick.id = t.identifier;
          this.stick.ox = x; this.stick.oy = y;
          this.stick.x = 0; this.stick.y = 0;
        } else if (x >= window.innerWidth * 0.42 && this.look.id === -1) {
          this.look.id = t.identifier;
          this.look.lx = x; this.look.ly = y;
        }
        e.preventDefault();
      }
    }, { passive: false });
    this.bind(surface, "touchmove", e => {
      for (const t of e.changedTouches) {
        if (t.identifier === this.stick.id) {
          const dx = t.clientX - this.stick.ox, dy = t.clientY - this.stick.oy;
          const m = Math.hypot(dx, dy), cap = 52;
          const k = m > cap ? cap / m : 1;
          this.stick.x = (dx * k) / cap;
          this.stick.y = (dy * k) / cap;
        } else if (t.identifier === this.look.id) {
          this.player.yaw -= (t.clientX - this.look.lx) * 0.0052 * this.lookScale;
          this.player.pitch -= (t.clientY - this.look.ly) * 0.0052 * this.lookScale;
          this.clampPitch();
          this.look.lx = t.clientX; this.look.ly = t.clientY;
        }
      }
      e.preventDefault();
    }, { passive: false });
    const touchEnd = e => {
      for (const t of e.changedTouches) {
        if (t.identifier === this.stick.id) { this.stick.id = -1; this.stick.x = 0; this.stick.y = 0; }
        if (t.identifier === this.look.id) this.look.id = -1;
        if (t.identifier === this.fireTouchId) { this.fireTouchId = -1; this.fireBtnHeld = false; this.firing = false; }
      }
      this.reconcileTouches(e);
    };
    this.bind(surface, "touchend", touchEnd);
    this.bind(surface, "touchcancel", touchEnd);

    // buttons — a touch that starts on FIRE also drives the look camera
    // (CoD-style: track targets while holding fire)
    const fireBtn = this.$("btn-fire");
    const fstart = e => {
      e.preventDefault();
      this.sfx.ensure();
      this.fireBtnHeld = true;
      this.firing = true;
      this.setSprint(false);           // shooting always wins over sprinting
      if (e.changedTouches?.length && this.look.id === -1) {
        const t = e.changedTouches[0];
        this.fireTouchId = t.identifier;
        this.look.id = t.identifier;   // same finger aims while it fires
        this.look.lx = t.clientX;
        this.look.ly = t.clientY;
      }
    };
    const fend = e => {
      e.preventDefault();
      this.fireBtnHeld = false;
      if (!this.pointerLocked) this.firing = false;
      // release the look claim so the finger can't leave the camera latched
      if (this.fireTouchId !== -1) {
        if (this.look.id === this.fireTouchId) this.look.id = -1;
        this.fireTouchId = -1;
      }
    };
    this.bind(fireBtn, "touchstart", fstart, { passive: false });
    this.bind(fireBtn, "touchend", fend, { passive: false });
    // Android turns a held touch into a system gesture via touchcancel —
    // without this the weapon sticks in full-auto
    this.bind(fireBtn, "touchcancel", fend, { passive: false });
    this.bind(fireBtn, "mousedown", fstart);
    this.bind(fireBtn, "mouseup", fend);
    this.bind(this.$("btn-reload"), "click", () => this.startReload());
    this.bind(this.$("btn-vault"), "click", () => this.doVault());
    this.bind(this.$("btn-ads"), "click", () => this.toggleAds());
    this.bind(this.$("btn-sprint"), "click", () => this.setSprint(!this.sprinting));
    this.bind(this.$("btn-crouch"), "click", () => this.toggleCrouch());

    // mobile: tabbing away / locking the screen pauses the match
    this.bind(document, "visibilitychange", () => {
      if (document.hidden && !this.paused && !this.over) {
        this.setPaused(true);
        this.$("overlay-pause").classList.add("active");
      }
    });
  }

  bind(el, ev, fn, opts) {
    el.addEventListener(ev, fn, opts);
    this._bound.push([el, ev, fn, opts]);
  }

  clampPitch() {
    const p = this.player;
    p.pitch = Math.max(-1.35, Math.min(1.35, p.pitch));
  }

  /* ---------- HUD ---------- */
  setupHud() {
    this.$("ammo-gun").textContent = this.loadout.name;
    this.$("scope-overlay").querySelector(".tag").textContent =
      `${this.loadout.name.split(" ")[0]} · ${this.loadout.adsZoom.toFixed(1)}×`;
    this.$("scope-overlay").style.display = "none";
    this.$("btn-ads").classList.remove("on");
    this.$("fps").textContent = "";
    this.mm = this.$("minimap").getContext("2d");
    // compass strip: repeated cardinal sequence
    const seq = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    const strip = this.$("compass-strip");
    strip.innerHTML = "";
    for (let r = 0; r < 5; r++) {
      for (const s of seq) {
        const sp = document.createElement("span");
        sp.textContent = s;
        if (s.length === 1) sp.className = "card";
        strip.appendChild(sp);
      }
    }
    this.$("killfeed").innerHTML = "";
    // the HUD DOM is shared across Game instances — clear anything a
    // mid-reload match end could have left stranded
    this.$("reload-ring").style.display = "none";
    this.$("reload-fill").style.width = "0%";
    this.setPrompt("");
    this.moveLabel = "SPRINT";
    this.hudCache = {};      // avoid touching the DOM when values are unchanged
    this.mmTimer = 0;        // minimap redraws at ~12 Hz, not every frame
  }

  hudSet(key, value, apply) {
    if (this.hudCache[key] === value) return;
    this.hudCache[key] = value;
    apply(value);
  }

  setPrompt(t) { this.$("hud-prompt").textContent = t; }

  addFeed(a, b, allyKill) {
    const feed = this.$("killfeed");
    const row = document.createElement("div");
    row.className = "feedrow";
    row.style.borderLeftColor = allyKill ? "var(--red)" : "var(--text)";
    row.innerHTML = `<span>${a}</span><span class="x">✕</span><span class="b">${b}</span>`;
    feed.prepend(row);
    while (feed.children.length > 4) feed.lastChild.remove();
    setTimeout(() => { if (row.parentNode) row.remove(); }, 4200);
  }

  /* ---------- combat events ---------- */
  handleBotShot(bot, target, hit, dmg) {
    // audio + tracer if near the player
    const distToPlayer = bot.pos.distanceTo(this.player.pos);
    if (distToPlayer < 60) this.sfx.enemyFire(distToPlayer);
    bot.eyePos(_a);
    if (target.isPlayer) { _b.copy(this.player.pos); _b.y += 1.2; } else { target.chestPos(_b); }
    if (!hit) {
      _b.x += (Math.random() - 0.5) * 2.4;
      _b.y += (Math.random() - 0.2) * 1.4;
      _b.z += (Math.random() - 0.5) * 2.4;
    }
    this.spawnTracer(_a, _b);

    if (!hit) return;
    if (target.isPlayer) {
      this.damagePlayer(dmg, bot);
    } else {
      target.damage(dmg, bot, this.botCtx);
    }
  }

  damagePlayer(dmg, attacker) {
    const p = this.player;
    if (!p.alive) return;
    p.hp -= dmg;
    p.lastHurt = this.time;
    this.sfx.hurt();
    if (p.hp <= 0) this.playerDie(attacker);
  }

  playerDie(killer) {
    const p = this.player;
    p.alive = false;
    p.deaths++;
    p.respawnT = 3.2;
    p.reloading = 0;
    p.vaultT = 0; p.vaultFrom = null; p.vaultTo = null; // no ghost-vault after respawn
    this.adsOn = false; // hudSet syncs the button; ads lerps out via adsTarget
    this.$("reload-ring").style.display = "none";
    this.firing = false;
    this.score[1]++;
    if (killer) killer.kills = (killer.kills || 0) + 1;
    this.addFeed(killer ? killer.name : "RAVENGLASS", p.name, false);
    this.setPrompt("REDEPLOYING · STAND BY");
    this.checkEnd();
  }

  handleDeath(bot, killer) {
    bot.mesh.visible = false;
    this.score[bot.team === 1 ? 0 : 1]++;
    if (killer) {
      killer.kills = (killer.kills || 0) + 1;
      this.addFeed(killer.name, bot.name, killer.team === 0);
      if (killer.isPlayer) {
        this.sfx.kill();
        this.setPrompt(`ELIMINATED ${bot.name} · +100`);
      }
    } else {
      this.addFeed("RAVENGLASS", bot.name, bot.team === 1);
    }
    this.checkEnd();
  }

  checkEnd() {
    if (this.over) return;
    if (this.score[0] >= MATCH.killTarget || this.score[1] >= MATCH.killTarget || this.time <= 0) {
      this.over = true;
      const rows = this.combatants
        .map(c => ({ name: c.name, team: c.team, kills: c.kills || 0, deaths: c.deaths || 0, me: !!c.isPlayer }))
        .sort((a, b) => b.kills - a.kills);
      setTimeout(() => this.onEnd({
        won: this.score[0] > this.score[1],
        ally: this.score[0], enemy: this.score[1], rows,
      }), 900);
    }
  }

  /* ---------- player actions ---------- */
  startReload() {
    const p = this.player, L = this.loadout;
    if (this.paused || this.over) return; // update() no longer runs — a reload would strand
    if (!p.alive || p.reloading > 0 || p.ammo >= L.mag || p.reserve <= 0) return;
    p.reloading = L.reloadTime;
    this._rlPhase = -1;
    this.setSprint(false);            // both hands on the weapon
    this.moveLabel = "RELOADING";
    this.setPrompt(`MAG SWAP · ${L.reloadTime.toFixed(1)}s`);
    this.$("reload-fill").style.width = "0%";
    this.$("reload-cuff").style.width = "0%";
    this.$("reload-ring").style.display = "flex";
  }

  toggleAds() {
    if (!this.player.alive || this.paused || this.over) return;
    this.adsOn = !this.adsOn;
    if (this.adsOn) this.setSprint(false); // can't aim down sights at a run
  }

  setSprint(on) {
    if (on && (!this.player.alive || this.paused || this.over || this.crouching)) return;
    if (on === this.sprinting) return;
    this.sprinting = on;
    if (on) {
      this.adsOn = false;
    } else {
      // leaving sprint costs a short raise time before the gun can fire
      this.player.sprintOutT = SPRINT_OUT;
    }
  }

  toggleCrouch() {
    if (!this.player.alive || this.paused || this.over) return;
    if (!this.crouching) {
      this.crouching = true;
      this.setSprint(false);
      return;
    }
    // only stand back up if there is headroom (never clip into a container)
    const p = this.player;
    if (this.collides(p.pos.x, p.pos.z, p.radius, p.pos.y, p.pos.y + 1.8)) {
      this.setPrompt("NO HEADROOM · STAY LOW");
      return;
    }
    this.crouching = false;
  }

  // Every tracked touch id is re-checked against the live touch list on every
  // touch event. Android can drop a touchend (system gesture, palm rejection,
  // identifier reuse), which used to leave the stick latched — the player then
  // ran into a wall forever and could not act.
  reconcileTouches(e) {
    const live = new Set();
    for (const t of e.touches) live.add(t.identifier);
    if (this.stick.id !== -1 && !live.has(this.stick.id)) {
      this.stick.id = -1; this.stick.x = 0; this.stick.y = 0;
    }
    if (this.look.id !== -1 && !live.has(this.look.id)) this.look.id = -1;
    if (this.fireTouchId !== -1 && !live.has(this.fireTouchId)) {
      this.fireTouchId = -1; this.fireBtnHeld = false; this.firing = false;
    }
    if (live.size === 0) {
      // nothing is touching the screen: no input may remain held
      this.stick.id = -1; this.stick.x = 0; this.stick.y = 0;
      this.look.id = -1;
      this.fireTouchId = -1;
      this.fireBtnHeld = false;
      if (!this.pointerLocked) this.firing = false;
    }
  }

  resetInput() {
    this.keys = {};
    this.stick.id = -1; this.stick.x = 0; this.stick.y = 0;
    this.look.id = -1;
    this.fireTouchId = -1;
    this.fireBtnHeld = false;
    this.firing = false;
    this.sprinting = false;
  }

  // Push the player out of any box they are overlapping. Without this, ending
  // up inside geometry fails BOTH axis tests in moveEntity forever — the
  // "stuck and can't move" report. Costs one pass over the AABB list.
  unstick(e) {
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
    if (e.pos.y < -2) { e.pos.copy(this.spawnFor(e.team)); e.vy = 0; } // fell out of the world
  }

  doVault() {
    const p = this.player;
    if (!p.alive || p.vaultT > 0) return;
    // probe ahead for a mantle-able ledge
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
    const px = p.pos.x + fx * 1.15, pz = p.pos.z + fz * 1.15;
    let ledge = null;
    for (const b of this.boxes) {
      if (px > b.minX - 0.3 && px < b.maxX + 0.3 && pz > b.minZ - 0.3 && pz < b.maxZ + 0.3) {
        const rel = b.top - p.pos.y;
        if (rel > 0.5 && rel < 1.9 && (!ledge || b.top < ledge.top)) ledge = b;
      }
    }
    this.sfx.vault();
    if (ledge) {
      const to = new THREE.Vector3(
        Math.max(ledge.minX + 0.5, Math.min(ledge.maxX - 0.5, px)),
        ledge.top,
        Math.max(ledge.minZ + 0.5, Math.min(ledge.maxZ - 0.5, pz))
      );
      // landing spot must have standing room — a stacked container or the
      // perimeter wall above the ledge would entomb the player
      if (this.collides(to.x, to.z, p.radius, to.y, to.y + p.height)) {
        if (p.grounded) { p.vy = 5.6; p.grounded = false; this.moveLabel = "AIRBORNE"; }
        return;
      }
      p.vaultT = 0.36;
      p.vaultFrom = p.pos.clone();
      p.vaultTo = to;
      this.moveLabel = "VAULT · MANTLE";
      this.setPrompt("PARKOUR CHAIN ×2 · +4 TEMPO");
    } else if (p.grounded) {
      p.vy = 5.6;
      p.grounded = false;
      this.moveLabel = "AIRBORNE";
    }
  }

  tryFire() {
    const p = this.player, L = this.loadout;
    if (!p.alive || p.reloading > 0) return;
    if (this.sprinting || p.sprintOutT > 0) return; // gun is down / coming up
    if (p.shotT > 0) return;
    if (p.ammo <= 0) { this.startReload(); return; }
    if (!L.auto && this._semiHeld) return;
    this._semiHeld = true;

    p.shotT = 60 / L.rpm;
    p.ammo--;
    this.sfx.fire();
    this.vmKick = 1;
    this.moveLabel = "FIRING";

    // spread: hip vs ADS interpolated by aim progress, movement penalty fades while aimed
    const aim = this.ads;
    const spreadMult = (L.hipSpreadMult + (L.adsSpreadMult - L.hipSpreadMult) * aim)
      * (this.crouching ? 0.62 : 1);          // crouching steadies the weapon
    const moveP = p.speedVal > 0.5 ? L.moveSpreadDeg * (1 - 0.7 * aim) : 0;
    const spread = (L.spreadDeg * spreadMult + moveP) * Math.PI / 180;
    const yawOff = (Math.random() - 0.5) * spread;
    const pitchOff = (Math.random() - 0.5) * spread;
    const yaw = p.yaw + yawOff, pitch = p.pitch + pitchOff;
    const dx = -Math.sin(yaw) * Math.cos(pitch);
    const dy = Math.sin(pitch);
    const dz = -Math.cos(yaw) * Math.cos(pitch);
    const ox = p.pos.x, oy = p.pos.y + p.eyeH, oz = p.pos.z;

    const wallT = this.rayWorldDist(ox, oy, oz, dx, dy, dz, 200);
    // bots are only hittable in front of whatever the round would strike first
    const shot = this.raycastBots(ox, oy, oz, dx, dy, dz, Math.min(wallT, 200));
    const hitBot = shot?.bot ?? null;
    const hitT = shot?.t ?? Infinity;
    const part = shot?.part ?? null;
    const headshot = part?.name === "HEAD";

    // muzzle flash DOM + 3D
    const mz = this.$("muzzle");
    mz.classList.remove("show"); void mz.offsetWidth; mz.classList.add("show");
    this.vmFlash.visible = true;
    clearTimeout(this._mf);
    this._mf = setTimeout(() => { this.vmFlash.visible = false; }, 45);

    // recoil
    p.pitch += L.recoilKick * (0.7 + Math.random() * 0.5) * Math.PI / 180;
    p.yaw += (Math.random() - 0.5) * L.recoilKick * 0.35 * Math.PI / 180;
    this.clampPitch();
    const hudEl = this.$("hud");
    hudEl.classList.remove("kick"); void hudEl.offsetWidth; hudEl.classList.add("kick");

    if (hitBot) {
      let dmg = L.damage * part.mult;          // per-limb multiplier
      const dist = hitT;
      if (dist > L.falloffStart) {
        const f = Math.max(0.45, 1 - (dist - L.falloffStart) / Math.max(1, L.falloffEnd - L.falloffStart) * 0.55);
        dmg *= f;
      }
      this.sfx.hit();
      const hm = this.$("hitmarker");
      hm.classList.remove("show", "head"); void hm.offsetWidth;
      hm.classList.add("show"); if (headshot) hm.classList.add("head");
      const killed = hitBot.damage(dmg, this.player, this.botCtx);
      if (!killed) this.setPrompt(`TARGET · ${Math.round(dist)}m · ${part.name}`);
    }

    if (p.ammo === 0) this.startReload();
  }

  /* ---------- per-frame ---------- */
  update(dt) {
    const p = this.player, L = this.loadout;
    this.time -= dt;
    if (this.time <= 0) { this.time = 0; this.checkEnd(); }

    // ---- player respawn ----
    if (!p.alive) {
      p.respawnT -= dt;
      if (p.respawnT <= 0) {
        p.pos.copy(this.spawnFor(0));
        p.hp = 100; p.alive = true; p.pitch = 0;
        p.yaw = Math.atan2(p.pos.x, p.pos.z);
        p.ammo = L.mag; p.reserve = L.reserve; p.reloading = 0;
        this.$("reload-ring").style.display = "none";
        this.setPrompt("");
        this.moveLabel = "SPRINT";
      }
    }

    // ---- ADS lerp: aiming drops while reloading or vaulting ----
    const adsTarget = (this.adsOn && p.alive && p.reloading <= 0 && p.vaultT <= 0) ? 1 : 0;
    const adsStep = dt / Math.max(0.05, L.adsTime);
    this.ads += Math.sign(adsTarget - this.ads) * Math.min(Math.abs(adsTarget - this.ads), adsStep);

    // ---- player movement ----
    if (p.alive) {
      if (p.vaultT > 0) {
        p.vaultT -= dt;
        const k = 1 - Math.max(0, p.vaultT) / 0.36;
        p.pos.lerpVectors(p.vaultFrom, p.vaultTo, k);
        p.pos.y = p.vaultFrom.y + (p.vaultTo.y - p.vaultFrom.y) * k + Math.sin(k * Math.PI) * 0.35;
        if (p.vaultT <= 0) { p.pos.copy(p.vaultTo); p.grounded = true; p.vy = 0; }
        p.speedVal = 3;
      } else {
        let mx = 0, mz = 0;
        if (this.keys["KeyW"]) mz -= 1;
        if (this.keys["KeyS"]) mz += 1;
        if (this.keys["KeyA"]) mx -= 1;
        if (this.keys["KeyD"]) mx += 1;
        mx += this.stick.x; mz += this.stick.y;
        const mlen = Math.hypot(mx, mz);
        if (mlen > 1) { mx /= mlen; mz /= mlen; }
        // sprint only holds while genuinely moving forward
        if (this.sprinting && (mlen < 0.35 || mz > 0.4)) this.setSprint(false);
        if (this.keys["ShiftLeft"] && mlen > 0.35 && !this.crouching) this.setSprint(true);

        const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
        const wx = (-sin * -mz) + (cos * mx);
        const wz = (-cos * -mz) + (-sin * mx);
        let speed = L.moveSpeed * (1 + (L.adsMoveMult - 1) * this.ads);
        if (this.sprinting) speed *= SPRINT_MULT;
        if (this.crouching) speed *= CROUCH_MULT;
        this.moveEntity(p, wx * speed * dt, wz * speed * dt);
        p.speedVal = mlen * speed;
        if (p.reloading <= 0 && p.vaultT <= 0 && !this.firing && p.grounded) {
          this.moveLabel = this.sprinting ? "SPRINT"
            : this.crouching ? "CROUCH"
            : this.ads > 0.6 ? (L.scope ? "SCOPED" : "ADS")
            : mlen > 0.05 ? "MOVE" : "HOLD";
        }

        // gravity / ground
        const ground = this.groundHeight(p.pos.x, p.pos.z, p.radius, p.pos.y);
        p.vy -= GRAVITY * dt;
        p.pos.y += p.vy * dt;
        if (p.pos.y <= ground) { p.pos.y = ground; p.vy = 0; p.grounded = true; }
        else if (p.pos.y > ground + 0.05) p.grounded = false;
        this.unstick(p);
      }

      // stance: collision height and eye height follow the crouch state
      p.height = this.crouching ? 1.2 : 1.8;
      const wantEye = this.crouching ? EYE_CROUCH : EYE;
      p.eyeH += (wantEye - p.eyeH) * Math.min(1, dt * 12);
      if (p.sprintOutT > 0) p.sprintOutT -= dt;

      // reload
      if (p.reloading > 0) {
        p.reloading -= dt;
        if (p.reloading <= 0) {
          const need = L.mag - p.ammo;
          const take = Math.min(need, p.reserve);
          p.ammo += take; p.reserve -= take;
          this.$("reload-ring").style.display = "none";
          this.$("reload-cuff").style.width = "0%";
          this.moveLabel = "HOLD";
          this.setPrompt("");
        }
      }

      // fire
      p.shotT -= dt;
      if (this.firing) this.tryFire();
      else this._semiHeld = false;

      // hp regen after 4s
      if (p.hp < 100 && this.timeSinceHurt() > 4) p.hp = Math.min(100, p.hp + 14 * dt);
    }

    // ---- bots ----
    // Escalation ramps with whichever is further along: elapsed time or the
    // leading score. Late rounds are faster, sharper and more aggressive.
    const byTime = 1 - this.time / MATCH.timeLimit;
    const byScore = Math.max(this.score[0], this.score[1]) / MATCH.killTarget;
    this.botCtx.escalation = Math.min(1, Math.max(byTime, byScore));

    // periodic coordinated push: a fireteam commits on the player's position
    this.pushTimer -= dt;
    if (this.pushTimer <= 0) {
      this.pushTimer = 22 - 10 * this.botCtx.escalation;
      if (this.player.alive) {
        const squad = this.bots
          .filter(b => b.team === 1 && b.alive)
          .sort((x, y) => x.pos.distanceTo(this.player.pos) - y.pos.distanceTo(this.player.pos))
          .slice(0, 2 + Math.round(this.botCtx.escalation * 2));
        for (const b of squad) {
          b.pushT = 6;
          b.goal = this.player.pos.clone();
          b.repathT = 6;
        }
      }
    }

    for (const b of this.bots) {
      b.update(dt, this.botCtx);
      if (b.mesh) {
        b.mesh.position.copy(b.pos);
        b.mesh.rotation.y = b.yaw;
      }
    }

    this.updateTracers(dt);

    // ---- camera ----
    this.camera.position.set(p.pos.x, p.pos.y + p.eyeH, p.pos.z);
    this.camera.rotation.order = "YXZ";
    this.camera.rotation.y = p.yaw;
    this.camera.rotation.x = p.pitch;
    // ADS fov zoom; look sensitivity tracks the zoom so aiming feels stable
    const fov = 74 / (1 + (L.adsZoom - 1) * this.ads);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    this.lookScale = fov / 74;
    // viewmodel: reset to rest pose, then layer reload animation + recoil kick
    const vm = this.viewmodel;
    vm.rotation.set(0, 0, 0);
    vm.position.set(0, 0, 0);
    this.vmMag.position.copy(this.vmMagBase);
    this.vmMag.rotation.set(0, 0, 0);
    this.vmMag.visible = true;
    if (p.alive && p.reloading > 0) {
      this.animateReload(1 - p.reloading / this.loadout.reloadTime);
    } else {
      this._rlPhase = -1;
    }

    // sprint pose: weapon canted down and across, with a two-step run bob.
    // sprintBlend also covers the raise back to centre via sprintOutT.
    const wantSprint = (this.sprinting && p.alive) ? 1
      : p.sprintOutT > 0 ? p.sprintOutT / SPRINT_OUT : 0;
    this.sprintBlend += (wantSprint - this.sprintBlend) * Math.min(1, dt * 11);
    if (this.sprintBlend > 0.002) {
      const s = this.sprintBlend;
      this.runT += dt * 11;
      vm.rotation.z += 0.55 * s;
      vm.rotation.x += 0.42 * s;
      vm.rotation.y += 0.30 * s;
      vm.position.y += (-0.13 + Math.sin(this.runT) * 0.022) * s;
      vm.position.x += (0.06 + Math.cos(this.runT * 0.5) * 0.012) * s;
      vm.position.z += 0.05 * s;
    }
    this.vmKick = Math.max(0, this.vmKick - dt * 9);
    vm.position.z += this.vmKick * 0.06;
    vm.rotation.x += this.vmKick * 0.05;
    // ADS: bring the gun to center; fully-scoped sniper hides the viewmodel
    vm.position.x = -0.26 * this.ads;
    vm.position.y += 0.055 * this.ads;
    vm.position.z += 0.1 * this.ads;
    vm.visible = !(L.scope && this.ads > 0.9);

    this.updateHud(dt);
  }

  timeSinceHurt() { return (this.player.lastHurt === -10) ? 999 : Math.max(0, this.player.lastHurt - this.time); }

  updateHud(dt) {
    const p = this.player;
    this.hudSet("ammo", `${p.ammo}<span> / ${p.reserve}</span>`,
      v => { this.$("ammo-count").innerHTML = v; });
    this.hudSet("armor", Math.max(0, Math.round(p.hp)),
      v => { this.$("armor-fill").style.width = v + "%"; });
    this.hudSet("move", p.alive ? this.moveLabel : "DOWN",
      v => { this.$("move-state").textContent = v; });
    this.hudSet("scoreA", this.score[0], v => { this.$("score-ally").textContent = v; });
    this.hudSet("scoreB", this.score[1], v => { this.$("score-enemy").textContent = v; });
    const t = Math.max(0, Math.ceil(this.time));
    this.hudSet("clock", `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`,
      v => { this.$("hud-clock").textContent = v; });
    this.hudSet("joy", `${Math.round(this.stick.x * 30)},${Math.round(this.stick.y * 30)}`, () => {
      this.$("joy-knob").style.transform =
        `translate(calc(-50% + ${Math.round(this.stick.x * 30)}px), calc(-50% + ${Math.round(this.stick.y * 30)}px))`;
    });

    // ADS visuals: crosshair tightens (hides behind a scope), overlay at full zoom
    const L = this.loadout;
    this.hudSet("ch", Math.round(this.ads * 24), () => {
      const ch = this.$("crosshair");
      ch.style.opacity = (L.scope && this.ads > 0.6) ? 0 : 1;
      ch.style.transform = `translate(-50%,-50%) scale(${(1 - 0.4 * this.ads).toFixed(3)})`;
    });
    this.hudSet("scope", L.scope && this.ads > 0.92,
      v => { this.$("scope-overlay").style.display = v ? "block" : "none"; });
    this.hudSet("adsBtn", this.adsOn,
      v => this.$("btn-ads").classList.toggle("on", v));
    // vignette is derived from state every frame, never from a timer that a
    // respawn or a forced heal could outlive
    const hurtAge = this.timeSinceHurt();
    const vig = !p.alive ? 0.85
      : hurtAge < 0.25 ? Math.min(1, 0.35 + (100 - p.hp) / 120)
      : p.hp < 35 ? 0.4
      : 0;
    this.hudSet("vig", vig.toFixed(2), v => { this.$("dmg-vignette").style.opacity = v; });
    this.hudSet("sprintBtn", this.sprinting,
      v => this.$("btn-sprint").classList.toggle("on", v));
    this.hudSet("crouchBtn", this.crouching,
      v => this.$("btn-crouch").classList.toggle("on", v));

    // compass: strip spans are 55px per 45°
    const yawDeg = ((-this.player.yaw * 180 / Math.PI) % 360 + 360) % 360;
    const px = Math.round((-(yawDeg / 45) * 55 - 55 * 8 + 110 - 27.5) * 2) / 2;
    this.hudSet("compass", px, v => { this.$("compass-strip").style.transform = `translateX(${v}px)`; });

    // minimap (throttled)
    this.mmTimer -= dt;
    if (this.mmTimer > 0) return;
    this.mmTimer = 1 / 12;
    const mm = this.mm, S = 104, scale = S / (ARENA * 2 + 4);
    mm.clearRect(0, 0, S, S);
    mm.strokeStyle = "rgba(243,242,242,0.16)";
    mm.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      mm.beginPath(); mm.moveTo(i * S / 4, 0); mm.lineTo(i * S / 4, S); mm.stroke();
      mm.beginPath(); mm.moveTo(0, i * S / 4); mm.lineTo(S, i * S / 4); mm.stroke();
    }
    const toMap = (x, z) => [S / 2 + x * scale, S / 2 + z * scale];
    for (const b of this.bots) {
      if (!b.alive) continue;
      const [x, y] = toMap(b.pos.x, b.pos.z);
      mm.fillStyle = b.team === 1 ? "#ff563c" : "rgba(243,242,242,0.55)";
      mm.fillRect(x - 2.5, y - 2.5, 5, 5);
    }
    if (p.alive) {
      const [x, y] = toMap(p.pos.x, p.pos.z);
      mm.fillStyle = "#f3f2f2";
      mm.fillRect(x - 3, y - 3, 6, 6);
      mm.strokeStyle = "#f3f2f2";
      mm.beginPath();
      mm.moveTo(x, y);
      mm.lineTo(x - Math.sin(p.yaw) * 8, y - Math.cos(p.yaw) * 8);
      mm.stroke();
    }
  }

  /* ---------- lifecycle ---------- */
  setPaused(v) {
    this.paused = v;
    if (v) {
      this.firing = false;
      this.fireBtnHeld = false; // stale flag would re-assert firing on mouseup
      document.exitPointerLock?.();
    } else {
      this.last = performance.now();
    }
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    for (const [el, ev, fn, opts] of this._bound) el.removeEventListener(ev, fn, opts);
    this._bound = [];
    window.removeEventListener("resize", this._onResize);
    document.exitPointerLock?.();
    this.scene.traverse(o => {
      if (o.isInstancedMesh) o.dispose(); // frees the per-instance matrix buffer
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => {
        if (m.map) m.map.dispose();
        m.dispose();
      });
    });
    this.tracerMat.dispose();
    this.renderer.dispose();
    this.sfx.ctx?.close?.();
    if (window.__game === this) window.__game = null;
  }
}
