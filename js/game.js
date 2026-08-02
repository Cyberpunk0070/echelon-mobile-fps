// ECHELON — game runtime: dockyard arena, player controller, combat, HUD.
import * as THREE from "three";
import { Bot } from "./bots.js";
import { SQUAD_ALLY, SQUAD_ENEMY, MATCH, ATTS } from "./data.js";
import { settings } from "./settings.js";
import { buildWeaponModel, attKeys } from "./weapons3d.js";

const DARK = { bg: 0x151312, surface: 0x211f1e, text: 0xf3f2f2, red: 0xff563c };
const ARENA = 47;              // half-extent of playable area
const GRAVITY = 16;
const DEG = Math.PI / 180;

/* ---- stances ----
   Index order is stand / crouch / prone. Every stance-dependent number lives
   here so a new stance is a row, not a scatter of conditionals. */
const STAND = 0, CROUCH = 1, PRONE = 2;
const STANCE_NAME = ["STAND", "CROUCH", "PRONE"];
const STANCE_EYE = [1.55, 1.00, 0.34];
const STANCE_HEIGHT = [1.80, 1.25, 0.62];
const STANCE_SPEED = [1, 0.50, 0.18];
const STANCE_SPREAD = [1, 0.70, 0.42];
const STANCE_RECOIL = [1, 0.76, 0.48];
// seconds the weapon is unusable while changing stance (prone costs the most)
const STANCE_LOCK = [[0, 0.22, 0.55], [0.22, 0, 0.42], [0.60, 0.45, 0]];

const SPRINT_MULT = 1.5;
const SPRINT_OUT = 0.16;   // seconds from dropping sprint to first shot
// Slide: smooth glide, then friction brakes you to a stop over a fixed distance.
const SLIDE_GLIDE_DIST = 2.7;     // metres at near-full speed
const SLIDE_BRAKE_DIST = 2.5;     // metres of hard friction after the glide
const SLIDE_FRIC_GLIDE = 1.6;     // m/s² during the smooth phase
const SLIDE_FRIC_BRAKE = 22;      // m/s² once friction bites
const SLIDE_END_SPEED = 0.35;     // drop below this → crouch settle
const SLIDE_MAX_TIME = 1.6;       // safety cap
const VM_SCALE = 1.0;      // schematic blocks are already viewmodel-sized (original mk() units)

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _eul = new THREE.Euler();

/* ---------------- broadphase ---------------- */
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

/* Segmented hitboxes in the bot's local frame (facing -z, origin at feet). */
const HITBOXES = [
  { name: "HEAD", cx: 0, cy: 1.68, cz: 0, hx: 0.17, hy: 0.17, hz: 0.17, mult: 2.0 },
  { name: "CHEST", cx: 0, cy: 1.22, cz: 0, hx: 0.33, hy: 0.30, hz: 0.22, mult: 1.0 },
  { name: "ABDOMEN", cx: 0, cy: 0.80, cz: 0, hx: 0.30, hy: 0.22, hz: 0.20, mult: 0.9 },
  { name: "LEGS", cx: 0, cy: 0.36, cz: 0, hx: 0.28, hy: 0.36, hz: 0.19, mult: 0.75 },
];

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

/* ---------------- audio ----------------
   Everything is synthesised — no sample files ship with the build. The downed
   sting is an original composition (a slow minor cluster with a filter sweep),
   not a licensed track. */
class Sfx {
  constructor() { this.ctx = null; this.sting = null; }

  ensure() {
    if (!this.ctx) {
      try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
      this.master = this.ctx.createGain();
      this.master.gain.value = settings.volume * 0.6;
      this.comp = this.ctx.createDynamicsCompressor();
      this.comp.threshold.value = -14;
      this.comp.ratio.value = 8;
      this.master.connect(this.comp);
      this.comp.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  }

  setVolume(v) { if (this.master) this.master.gain.value = v * 0.6; }

  noise(dur, vol, freq, decay = 0.9, type = "lowpass", q = 1) {
    const ctx = this.ensure(); if (!ctx) return;
    const n = ctx.createBufferSource();
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(decay, i / len * 20);
    n.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain(); g.gain.value = vol;
    n.connect(f); f.connect(g); g.connect(this.master);
    n.start();
  }

  tone(freq, dur, vol, type = "square", slide = 0, delay = 0) {
    const ctx = this.ensure(); if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(this.master);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }

  /* Layered gunshot: crack (band-passed transient), body (pitch-dropping
     square) and tail (long low noise). `weight` shifts the whole stack down
     for the heavier calibres. */
  fire(weight = 0.5, suppressed = false) {
    if (suppressed) {
      this.noise(0.05, 0.22, 900, 0.6, "lowpass");
      this.tone(120 - weight * 40, 0.07, 0.18, "sine", -50);
      this.noise(0.14, 0.06, 420, 0.94);
      return;
    }
    const crack = 3400 - weight * 1500;
    this.noise(0.035, 0.55, crack, 0.35, "bandpass", 0.8);
    this.tone(190 - weight * 105, 0.075 + weight * 0.05, 0.34, "square", -(120 - weight * 60));
    this.noise(0.20 + weight * 0.22, 0.16 + weight * 0.12, 700 - weight * 300, 0.95);
  }

  enemyFire(dist, weight = 0.4) {
    const v = Math.max(0.02, 0.26 - dist * 0.0042);
    this.noise(0.06, v, 1400 - weight * 600, 0.5, "bandpass", 0.9);
    this.noise(0.22, v * 0.55, 480, 0.95);
  }

  impact(hard = true) {
    if (hard) { this.noise(0.05, 0.16, 2600, 0.4, "bandpass", 1.4); this.tone(320, 0.04, 0.08, "square", -160); }
    else this.noise(0.06, 0.12, 700, 0.5);
  }

  hit() { this.tone(1750, 0.045, 0.2, "square"); }
  headshot() { this.tone(2300, 0.05, 0.24, "square"); this.tone(3100, 0.06, 0.18, "square", 0, 0.045); }
  kill() { this.tone(760, 0.07, 0.22, "square"); this.tone(1140, 0.09, 0.22, "square", 0, 0.07); }
  magOut() { this.tone(320, 0.05, 0.18, "square", -90); this.noise(0.05, 0.1, 1500, 0.6); }
  magIn() { this.tone(210, 0.07, 0.22, "square", 50); this.noise(0.06, 0.14, 1100, 0.7); }
  rack() { this.tone(520, 0.04, 0.17, "square"); this.tone(360, 0.05, 0.17, "square", 0, 0.07); }
  hurt() { this.tone(105, 0.16, 0.34, "sawtooth", -40); }
  vault() { this.noise(0.12, 0.16, 500); }
  slide() { this.noise(0.5, 0.2, 1500, 0.985, "bandpass", 0.7); }
  prone() { this.noise(0.18, 0.2, 380, 0.9); this.tone(90, 0.12, 0.16, "sine", -30); }
  brass() { this.tone(2400 + Math.random() * 900, 0.045, 0.055, "triangle", -900, 0.14); }

  /* Downed sting — original: a low minor cluster under a slow low-pass sweep,
     sustained until the player redeploys. */
  startSting() {
    if (!settings.wastedSting) return;
    const ctx = this.ensure(); if (!ctx) return;
    this.stopSting(0.05);
    const t0 = ctx.currentTime;
    const bus = ctx.createGain();
    bus.gain.setValueAtTime(0.0001, t0);
    bus.gain.exponentialRampToValueAtTime(0.5, t0 + 0.5);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(2400, t0);
    lp.frequency.exponentialRampToValueAtTime(320, t0 + 2.4);
    lp.Q.value = 2;
    bus.connect(lp); lp.connect(this.master);

    const oscs = [];
    // D minor cluster, detuned in pairs for a slow beat
    for (const [f, v, det] of [[73.42, 0.5, 0], [87.31, 0.32, 0.4], [110.0, 0.28, -0.5],
                               [146.83, 0.2, 0.7], [174.61, 0.14, -0.8]]) {
      for (const d of [-1, 1]) {
        const o = ctx.createOscillator();
        o.type = "sawtooth";
        o.frequency.value = f;
        o.detune.value = d * (4 + det * 6);
        const g = ctx.createGain();
        g.gain.value = v * 0.16;
        o.connect(g); g.connect(bus);
        o.start(t0);
        oscs.push(o);
      }
    }
    // one struck accent on the downbeat
    const hit = ctx.createGain();
    hit.gain.setValueAtTime(0.5, t0);
    hit.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.6);
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(110, t0);
    sub.frequency.exponentialRampToValueAtTime(36, t0 + 1.2);
    sub.connect(hit); hit.connect(this.master);
    sub.start(t0); sub.stop(t0 + 1.8);

    this.sting = { bus, oscs, sub };
  }

  stopSting(fade = 0.55) {
    const s = this.sting;
    if (!s || !this.ctx) return;
    this.sting = null;
    const t = this.ctx.currentTime;
    try {
      s.bus.gain.cancelScheduledValues(t);
      s.bus.gain.setValueAtTime(Math.max(0.0001, s.bus.gain.value), t);
      s.bus.gain.exponentialRampToValueAtTime(0.0001, t + fade);
    } catch { /* already torn down */ }
    for (const o of s.oscs) { try { o.stop(t + fade + 0.05); } catch { /* */ } }
  }
}

/* ---------------- game ---------------- */
export class Game {
  constructor({ canvas, loadout, onEnd, playerName, skill }) {
    this.canvas = canvas;
    this.loadout = loadout;
    this.onEnd = onEnd;
    this.playerName = playerName || "VIPER-04";
    this.skill = skill ?? 1;
    this.sfx = new Sfx();
    this.paused = false;
    this.over = false;
    this.disposed = false;
    this.raf = 0;
    this.boxes = [];
    this.boxSpecs = [];
    this.tracers = [];
    this.sparks = [];
    this._bound = [];
    this._timeouts = [];
    this.killcam = null;
    this.$ = id => document.getElementById(id);
  }

  // setTimeout that a dispose() can cancel wholesale. Fired timers drop
  // themselves so a long match cannot accumulate thousands of dead ids.
  after(fn, ms) {
    const t = setTimeout(() => {
      const i = this._timeouts.indexOf(t);
      if (i >= 0) this._timeouts.splice(i, 1);
      if (!this.disposed) fn();
    }, ms);
    this._timeouts.push(t);
    return t;
  }

  /* ---------- setup ---------- */
  start() {
    this.setupScene();
    this.buildMap();
    this.setupPlayer();
    this.setupBots();
    this.setupViewmodel();
    this.setupFx();
    this.setupKillcamRecorder();
    this.setupInput();
    this.setupHud();
    this.time = MATCH.timeLimit;
    this.elapsed = 0;
    this.score = [0, 0];
    this.last = performance.now();
    this.fpsFrames = 0; this.fpsT = 0;
    this.pushTimer = 20;
    if (typeof location !== "undefined" && /[?&]debug=1\b/.test(location.search)) {
      window.__game = this;
    }
    const loop = (now) => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      const rawDt = (now - this.last) / 1000;
      this.last = now;
      const dt = Math.min(rawDt, 0.05);
      this.fpsFrames++; this.fpsT += rawDt;
      if (this.fpsT >= 0.5) {
        this.$("fps").textContent = Math.round(this.fpsFrames / this.fpsT) + " FPS";
        this.fpsFrames = 0; this.fpsT = 0;
      }
      if (this.killcam) {
        this.updateKillcam(dt);
      } else if (!this.paused && !this.over) {
        this.update(dt);
        this.autoResolution(rawDt);
      }
      this.renderer.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(loop);
  }

  // adaptive resolution: if the phone can't hold frame time, step the pixel
  // ratio down (and back up when there's headroom)
  autoResolution(rawDt) {
    this.perfAccum += rawDt; this.perfFrames++;
    if (rawDt >= 0.004) {
      if (rawDt < this.perfMin1) { this.perfMin2 = this.perfMin1; this.perfMin1 = rawDt; }
      else if (rawDt < this.perfMin2) { this.perfMin2 = rawDt; }
    }
    if (this.perfFrames < 120) return;
    const avg = this.perfAccum / this.perfFrames;
    const floor = this.perfMin2 === Infinity ? 0.0167 : this.perfMin2;
    this.perfAccum = 0; this.perfFrames = 0;
    this.perfMin1 = Infinity; this.perfMin2 = Infinity;
    const scales = [1, 0.8, 0.65];
    if (avg > floor * 1.7 && this.perfLevel < 2) this.perfLevel++;
    else if (avg < floor * 1.25 && this.perfLevel > 0) this.perfLevel--;
    const target = this.basePixelRatio * scales[this.perfLevel];
    if (Math.abs(this.renderer.getPixelRatio() - target) > 0.01) {
      this.renderer.setPixelRatio(target);
      this.resize();
    }
  }

  setupScene() {
    this.basePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: this.basePixelRatio < 2,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(this.basePixelRatio);
    this.perfLevel = 0; this.perfAccum = 0; this.perfFrames = 0;
    this.perfMin1 = Infinity; this.perfMin2 = Infinity;
    this.geoCache = new THREE.BoxGeometry(1, 1, 1);
    this.matCache = new Map();
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(DARK.bg);
    this.scene.fog = new THREE.Fog(DARK.bg, 34, 118);
    this.baseFov = settings.fov;
    this.camera = new THREE.PerspectiveCamera(this.baseFov, 1, 0.06, 240);
    this.resize();
    this._onResize = () => this.resize();
    window.addEventListener("resize", this._onResize);

    const hemi = new THREE.HemisphereLight(0xaebac6, 0x38302c, 1.2);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xfff0e4, 1.5);
    key.position.set(30, 60, -20);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x93b0cc, 0.6);
    fill.position.set(-42, 26, 38);
    this.scene.add(fill);
    const bounce = new THREE.DirectionalLight(0xffd9c2, 0.24);
    bounce.position.set(6, -20, 12);
    this.scene.add(bounce);
    // muzzle flash light — one reused point light, pulsed per shot
    this.flashLight = new THREE.PointLight(0xffbb77, 0, 14, 2);
    this.scene.add(this.flashLight);
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

  // Live settings changes (the pause menu can open the settings screen).
  applySettings() {
    this.baseFov = settings.fov;
    this.sfx.setVolume(settings.volume);
    this.camera.updateProjectionMatrix();
  }

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
    for (const [color, list] of byColor) {
      const im = new THREE.InstancedMesh(this.geoCache, this.mat(color), list.length);
      list.forEach((s, i) => {
        _m4.makeScale(s.w, s.h, s.d);
        _m4.setPosition(s.x, s.y, s.z);
        im.setMatrixAt(i, _m4);
      });
      im.instanceMatrix.needsUpdate = true;
      im.frustumCulled = false;
      this.scene.add(im);
    }
    this.boxSpecs = null;
  }

  buildMap() {
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

    const W = ARENA + 1;
    this.addBox(0, -W - 1.5, W * 2 + 8, 3, 7, 0x322e2c);
    this.addBox(0, W + 1.5, W * 2 + 8, 3, 7, 0x322e2c);
    this.addBox(-W - 1.5, 0, 3, W * 2 + 8, 7, 0x322e2c);
    this.addBox(W + 1.5, 0, 3, W * 2 + 8, 7, 0x322e2c);

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
    // low cover — waist-high walls you can shoot over prone or crouched
    for (let i = 0; i < 18; i++) {
      const x = (rnd() * 2 - 1) * 40, z = (rnd() * 2 - 1) * 40;
      let clash = false;
      for (const b of this.boxes) {
        if (x > b.minX - 2.5 && x < b.maxX + 2.5 && z > b.minZ - 2.5 && z < b.maxZ + 2.5 && b.y0 === 0) { clash = true; break; }
      }
      if (clash) continue;
      const long = rnd() < 0.5;
      this.addBox(x, z, long ? 5.5 : 1.6, long ? 1.6 : 5.5, 0.95, grays[Math.floor(rnd() * grays.length)]);
    }
    for (let i = 0; i < 22; i++) {
      const x = (rnd() * 2 - 1) * 40, z = (rnd() * 2 - 1) * 40;
      let clash = false;
      for (const b of this.boxes) {
        if (x > b.minX - 2 && x < b.maxX + 2 && z > b.minZ - 2 && z < b.maxZ + 2 && b.y0 === 0) { clash = true; break; }
      }
      if (clash) continue;
      this.addBox(x, z, 1.9, 1.9, 1.25, grays[Math.floor(rnd() * grays.length)]);
    }
    this.addBox(0, 0, 3.5, 3.5, 6.5, DARK.red);

    this.buildStaticMeshes();
    this.grid = new SpatialHash(this.boxes);
    this._q = [];
  }

  /* ---------- collision & rays ---------- */
  collides(x, z, r, feet, head) {
    if (Math.abs(x) > ARENA || Math.abs(z) > ARENA) return true;
    const hits = this.grid.query(x - r, x + r, z - r, z + r, this._q);
    for (let i = 0; i < hits.length; i++) {
      const b = this.boxes[hits[i]];
      if (b.top <= feet + 0.55 || b.y0 >= head) continue;
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

  rayWorldDist(ox, oy, oz, dx, dy, dz, maxDist) {
    let best = Infinity;
    if (dy < -1e-9) {
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
      if (nextT > maxDist || best <= nextT) break;
      if (tMaxX < tMaxZ) { t = tMaxX; cx += stepX; tMaxX += tDeltaX; }
      else { t = tMaxZ; cz += stepZ; tMaxZ += tDeltaZ; }
      if (t > maxDist) break;
    }
    return best;
  }

  raycastBots(ox, oy, oz, dx, dy, dz, maxT) {
    let bestT = maxT, bestBot = null, bestPart = null;
    for (const b of this.bots) {
      if (!b.alive || b.team === 0) continue;
      const rx = b.pos.x - ox, ry = (b.pos.y + 0.9) - oy, rz = b.pos.z - oz;
      const along = rx * dx + ry * dy + rz * dz;
      if (along < -1.2 || along > bestT + 1.2) continue;
      const perp2 = (rx * rx + ry * ry + rz * rz) - along * along;
      if (perp2 > 1.44) continue;
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
      isPlayer: true, name: this.playerName, team: 0,
      pos: this.spawnFor(0), yaw: 0, pitch: 0,
      vy: 0, grounded: true,
      alive: true, hp: 100, radius: 0.4, height: STANCE_HEIGHT[STAND],
      speedVal: 0, kills: 0, deaths: 0,
      ammo: L.mag, reserve: L.reserve,
      reloading: 0, shotT: 0, lastHurt: -10,
      respawnT: 0, vaultT: 0,
      eyeH: STANCE_EYE[STAND], sprintOutT: 0,
      stance: STAND, stanceLock: 0,
      slideT: 0, slideDir: new THREE.Vector3(), slideSpeed: 0, slideVel: 0,
      slideDist: 0, diving: false,
      chestY: 1.15,
      vaultFrom: new THREE.Vector3(), vaultTo: new THREE.Vector3(),
    };
    this.assistSlow = 1;
    this.sprinting = false;
    this.player.yaw = Math.atan2(this.player.pos.x, this.player.pos.z);
    // recoil is a camera offset that recovers to zero when the trigger rests
    this.recoilPitch = 0; this.recoilYaw = 0;
    this.shotIdx = 0; this.sinceShot = 9;
    this.shake = 0;
    this.bobT = 0; this.bobAmt = 0;
    this.swayX = 0; this.swayY = 0;
    this.deathCam = null;
  }

  setupBots() {
    this.bots = [];
    for (let i = 1; i < SQUAD_ALLY.length; i++) this.bots.push(new Bot(SQUAD_ALLY[i], 0));
    for (const n of SQUAD_ENEMY) this.bots.push(new Bot(n, 1));
    for (const b of this.bots) b.mesh = this.makeBotMesh(b.team);
    this.combatants = [this.player, ...this.bots];
    // the player only gets a body for the kill cam
    this.playerMesh = this.makeBotMesh(0);
    this.botCtx = {
      combatants: this.combatants,
      escalation: 0,
      skill: [0.72, 1, 1.28][this.skill] ?? 1,
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
    part(0.62, 1.12, 0.4, 0, 0.94, 0, bodyCol);
    part(0.3, 0.3, 0.3, 0, 1.68, 0, bodyCol);
    part(0.32, 0.07, 0.31, 0, 1.7, -0.01, accCol);
    part(0.66, 0.12, 0.44, 0, 1.32, 0, accCol);
    part(0.5, 0.42, 0.34, 0, 0.21, 0, 0x1e1b1a);
    part(0.1, 0.12, 0.7, 0.22, 1.18, -0.36, 0x151312);
    grp.visible = false;
    this.scene.add(grp);
    return grp;
  }

  /* ---------- viewmodel ---------- */
  setupViewmodel() {
    const L = this.loadout;
    const keys = attKeys(ATTS, L.atts);
    const model = buildWeaponModel(THREE, L.model, keys);
    this.wm = model;

    const holder = new THREE.Group();          // sway/bob/recoil transform
    const gun = model.group;
    gun.scale.setScalar(VM_SCALE * (model.vmScale ?? 1));
    holder.add(gun);
    this.viewmodel = holder;
    this.gun = gun;

    const vs = VM_SCALE * (model.vmScale ?? 1);
    // Classic ADS (958776f): hip is lower-right; ADS applies a fixed offset
    // toward center + a FOV zoom so the *whole view* tightens. Scoped rifles
    // still hide the mesh and show the scope overlay at full aim.
    this.vmHip = new THREE.Vector3(0.26, -0.24, -0.52);
    this.vmAds = new THREE.Vector3(
      this.vmHip.x - 0.26,   // → ~0 (centered)
      this.vmHip.y + 0.055,
      this.vmHip.z + 0.10
    );
    this.vmHipRot = new THREE.Euler(0.03, 0.10, -0.05, "XYZ");
    this.vmAdsRot = new THREE.Euler(0, 0, 0, "XYZ");
    this.vmScaleFactor = vs;
    this.spinBarrels = !!model.spinBarrels;
    this._spin = 0;
    this._spinAng = 0;
    this.muzzleLocal = new THREE.Vector3(model.muzzle.x, model.muzzle.y, model.muzzle.z).multiplyScalar(vs);
    this.ejectLocal = new THREE.Vector3(model.eject.x, model.eject.y, model.eject.z).multiplyScalar(vs);

    // muzzle flash: a stubby additive cone plus a bloom sphere
    const flash = new THREE.Group();
    const coneGeo = new THREE.ConeGeometry(0.028, 0.10, 7, 1, true);
    const flashMat = new THREE.MeshBasicMaterial({
      color: 0xffd9a0, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const cone = new THREE.Mesh(coneGeo, flashMat);
    cone.rotation.x = -Math.PI / 2;
    cone.position.z = -0.05;
    flash.add(cone);
    const bloom = new THREE.Mesh(new THREE.SphereGeometry(0.03, 7, 5), flashMat);
    flash.add(bloom);
    flash.position.copy(this.muzzleLocal);
    flash.visible = false;
    holder.add(flash);
    this.vmFlash = flash;
    this.flashMat = flashMat;

    // A short-range key light rides the camera. The world lights are angled for
    // the arena and leave the weapon a black cutout; this one only reaches as
    // far as the player's hands.
    this.vmLight = new THREE.PointLight(0xffeedd, 2.6, 1.5, 1.4);
    this.vmLight.position.set(0.34, 0.30, 0.12);
    this.camera.add(this.vmLight);

    this.camera.add(holder);
    this.scene.add(this.camera);
    this.vmKick = 0; this.vmKickRot = 0;
    this._rlPhase = -1;
    this.sprintBlend = 0;
    this.runT = 0;
    this.magBase = model.magGroup.position.clone();
  }

  /* ---------- effects ---------- */
  setupFx() {
    // tracers and impact sparks share the line-buffer approach: one draw call
    // each, no per-shot allocation
    this.tracerMax = 48;
    this.tracerPos = new Float32Array(this.tracerMax * 6);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute("position", new THREE.BufferAttribute(this.tracerPos, 3));
    tg.setDrawRange(0, 0);
    this.tracerMat = new THREE.LineBasicMaterial({ color: 0xffc9a6, transparent: true, opacity: 0.75 });
    this.tracerMesh = new THREE.LineSegments(tg, this.tracerMat);
    this.tracerMesh.frustumCulled = false;
    this.scene.add(this.tracerMesh);

    this.sparkMax = 80;
    this.sparkPos = new Float32Array(this.sparkMax * 6);
    const sg = new THREE.BufferGeometry();
    sg.setAttribute("position", new THREE.BufferAttribute(this.sparkPos, 3));
    sg.setDrawRange(0, 0);
    this.sparkMat = new THREE.LineBasicMaterial({
      color: 0xffd9a0, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.sparkMesh = new THREE.LineSegments(sg, this.sparkMat);
    this.sparkMesh.frustumCulled = false;
    this.scene.add(this.sparkMesh);

    // ejected brass — a small instanced pool with cheap ballistics
    this.brassMax = 14;
    this.brass = [];
    this.brassGeo = new THREE.BoxGeometry(0.012, 0.012, 0.03);
    this.brassMesh = new THREE.InstancedMesh(
      this.brassGeo, new THREE.MeshPhongMaterial({ color: 0xc79a45, shininess: 70 }), this.brassMax
    );
    this.brassMesh.frustumCulled = false;
    this.brassMesh.count = 0;
    this.scene.add(this.brassMesh);
  }

  spawnTracer(from, to) {
    if (this.tracers.length >= this.tracerMax) this.tracers.shift();
    this.tracers.push({
      ax: from.x, ay: from.y, az: from.z,
      bx: to.x, by: to.y, bz: to.z, t: 0.055,
    });
  }

  spawnImpact(x, y, z) {
    for (let i = 0; i < 4; i++) {
      if (this.sparks.length >= this.sparkMax) this.sparks.shift();
      const dx = (Math.random() - 0.5), dy = Math.random() * 0.8, dz = (Math.random() - 0.5);
      const l = 0.08 + Math.random() * 0.14;
      const n = Math.hypot(dx, dy, dz) || 1;
      this.sparks.push({
        ax: x, ay: y, az: z,
        bx: x + dx / n * l, by: y + dy / n * l, bz: z + dz / n * l,
        t: 0.09 + Math.random() * 0.07,
      });
    }
  }

  spawnBrass() {
    if (this.brass.length >= this.brassMax) this.brass.shift();
    const p = _a.copy(this.ejectLocal);
    this.viewmodel.localToWorld(p);
    const right = _b.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const up = _c.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
    this.brass.push({
      x: p.x, y: p.y, z: p.z,
      vx: right.x * 1.9 + up.x * 1.1 + (Math.random() - 0.5) * 0.4,
      vy: right.y * 1.9 + up.y * 1.1 + 0.8,
      vz: right.z * 1.9 + up.z * 1.1 + (Math.random() - 0.5) * 0.4,
      rx: Math.random() * 6, ry: Math.random() * 6, rz: Math.random() * 6,
      sx: (Math.random() - 0.5) * 22, sy: (Math.random() - 0.5) * 22,
      t: 1.6, landed: false,
    });
    this.sfx.brass();
  }

  updateFx(dt) {
    const writeLines = (arr, pos, mesh) => {
      let n = 0;
      for (let i = 0; i < arr.length; i++) {
        const tr = arr[i];
        tr.t -= dt;
        if (tr.t <= 0) continue;
        arr[n] = tr;
        const o = n * 6;
        pos[o] = tr.ax; pos[o + 1] = tr.ay; pos[o + 2] = tr.az;
        pos[o + 3] = tr.bx; pos[o + 4] = tr.by; pos[o + 5] = tr.bz;
        n++;
      }
      arr.length = n;
      mesh.geometry.setDrawRange(0, n * 2);
      mesh.geometry.attributes.position.needsUpdate = true;
    };
    writeLines(this.tracers, this.tracerPos, this.tracerMesh);
    writeLines(this.sparks, this.sparkPos, this.sparkMesh);

    // brass
    let n = 0;
    for (let i = 0; i < this.brass.length; i++) {
      const b = this.brass[i];
      b.t -= dt;
      if (b.t <= 0) continue;
      if (!b.landed) {
        b.vy -= GRAVITY * dt;
        b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
        b.rx += b.sx * dt; b.ry += b.sy * dt;
        if (b.y <= 0.01) { b.y = 0.01; b.landed = true; b.vx = b.vy = b.vz = 0; }
      }
      this.brass[n] = b;
      _eul.set(b.rx, b.ry, b.rz);
      _m4.makeRotationFromEuler(_eul);
      _m4.setPosition(b.x, b.y, b.z);
      this.brassMesh.setMatrixAt(n, _m4);
      n++;
    }
    this.brass.length = n;
    this.brassMesh.count = n;
    if (n) this.brassMesh.instanceMatrix.needsUpdate = true;

    // muzzle flash + light decay
    if (this.flashT > 0) {
      this.flashT -= dt;
      const k = Math.max(0, this.flashT / 0.045);
      this.flashMat.opacity = k;
      this.vmFlash.visible = k > 0.02;
      this.flashLight.intensity = k * 7;
      if (this.flashT <= 0) { this.vmFlash.visible = false; this.flashLight.intensity = 0; }
    }
  }

  /* ---------- kill cam recorder ----------
     A fixed ring of flat frames: every entity's transform at 20 Hz for the
     last ten seconds, so the final kill can be replayed from any angle with
     zero allocation while the match is running. */
  setupKillcamRecorder() {
    this.kcFrames = 200;
    this.kcStride = this.combatants.length * 5;
    this.kcBuf = new Float32Array(this.kcFrames * this.kcStride);
    this.kcTime = new Float32Array(this.kcFrames).fill(-1);
    this.kcHead = 0;
    this.kcAccum = 0;
    this.lastKill = null;
  }

  recordFrame() {
    const o = this.kcHead * this.kcStride;
    for (let i = 0; i < this.combatants.length; i++) {
      const c = this.combatants[i];
      const j = o + i * 5;
      this.kcBuf[j] = c.pos.x;
      this.kcBuf[j + 1] = c.pos.y;
      this.kcBuf[j + 2] = c.pos.z;
      this.kcBuf[j + 3] = c.yaw;
      this.kcBuf[j + 4] = c.alive ? 1 : 0;
    }
    this.kcTime[this.kcHead] = this.elapsed;
    this.kcHead = (this.kcHead + 1) % this.kcFrames;
  }

  // Interpolated pose for entity `i` at absolute match time `t`.
  kcSample(t, i, out) {
    let loT = -1, hiT = Infinity, lo = -1, hi = -1;
    for (let f = 0; f < this.kcFrames; f++) {
      const ft = this.kcTime[f];
      if (ft < 0) continue;
      if (ft <= t && ft > loT) { loT = ft; lo = f; }
      if (ft >= t && ft < hiT) { hiT = ft; hi = f; }
    }
    if (lo < 0 && hi < 0) return null;
    if (lo < 0) { lo = hi; loT = hiT; }
    if (hi < 0) { hi = lo; hiT = loT; }
    const k = hiT > loT ? (t - loT) / (hiT - loT) : 0;
    const a = lo * this.kcStride + i * 5, b = hi * this.kcStride + i * 5;
    out.x = this.kcBuf[a] + (this.kcBuf[b] - this.kcBuf[a]) * k;
    out.y = this.kcBuf[a + 1] + (this.kcBuf[b + 1] - this.kcBuf[a + 1]) * k;
    out.z = this.kcBuf[a + 2] + (this.kcBuf[b + 2] - this.kcBuf[a + 2]) * k;
    let dy = this.kcBuf[b + 3] - this.kcBuf[a + 3];
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    out.yaw = this.kcBuf[a + 3] + dy * k;
    out.alive = this.kcBuf[a + 4] > 0.5;
    return out;
  }

  startKillcam(onDone) {
    const kill = this.lastKill;
    if (!settings.killcam || !kill) { onDone(); return; }
    const ki = this.combatants.indexOf(kill.killer);
    const vi = this.combatants.indexOf(kill.victim);
    if (ki < 0 || vi < 0) { onDone(); return; }

    this.sfx.stopSting(0.3);
    document.body.classList.remove("wasted");
    this.$("wasted").classList.remove("active");
    this.$("hud").classList.remove("active");
    this.$("killcam").classList.add("active");
    this.$("kc-title").textContent = `${kill.killer.name}  ✕  ${kill.victim.name}`;
    this.$("kc-sub").textContent =
      `${kill.part ? kill.part + " · " : ""}${Math.round(kill.dist)} m · ${kill.weapon || "SMALL ARMS"}`;
    this.$("kc-fill").style.width = "0%";

    // hide the live viewmodel and put a body on the player for the replay
    this.viewmodel.visible = false;
    this.$("scope-overlay").style.display = "none";
    // the recorder stops the moment the match ends, so hold on the last frame
    // only briefly rather than staring at a freeze for over a second
    let latest = 0;
    for (const t of this.kcTime) if (t > latest) latest = t;
    this.killcam = {
      ki, vi, onDone,
      t: Math.max(0, kill.time - 3.0),
      from: Math.max(0, kill.time - 3.0),
      to: Math.min(kill.time + 1.3, latest + 0.7),
      killTime: kill.time,
      pose: { x: 0, y: 0, z: 0, yaw: 0, alive: true },
      pose2: { x: 0, y: 0, z: 0, yaw: 0, alive: true },
      orbit: 0,
    };
    const skip = () => this.endKillcam();
    this._kcSkip = skip;
    this.$("kc-skip").addEventListener("click", skip);
  }

  updateKillcam(dt) {
    const kc = this.killcam;
    // slow down through the moment of the kill for readability
    const near = Math.abs(kc.t - kc.killTime) < 0.55;
    kc.t += dt * (near ? 0.35 : 1);
    kc.orbit += dt * 0.22;
    this.$("kc-fill").style.width =
      Math.min(100, Math.max(0, (kc.t - kc.from) / (kc.to - kc.from) * 100)).toFixed(1) + "%";

    for (let i = 0; i < this.combatants.length; i++) {
      const c = this.combatants[i];
      const mesh = c.isPlayer ? this.playerMesh : c.mesh;
      if (!mesh) continue;
      const p = this.kcSample(kc.t, i, kc.pose);
      if (!p) { mesh.visible = false; continue; }
      mesh.visible = p.alive;
      mesh.position.set(p.x, p.y, p.z);
      mesh.rotation.y = p.yaw;
    }

    const K = this.kcSample(kc.t, kc.ki, kc.pose);
    const V = this.kcSample(kc.t, kc.vi, kc.pose2);
    if (K && V) {
      /* Frame the victim from the shooter's side of the line. Orbiting the
         killer only works at brawling range — on a 77 m shot it leaves the
         target a speck — so the camera always sits a fixed few metres off the
         victim, along the direction the round came from. */
      const dx = K.x - V.x, dz = K.z - V.z;
      const len = Math.hypot(dx, dz) || 1;
      const bx = dx / len, bz = dz / len;          // victim -> killer
      const sx = -bz, sz = bx;
      const sw = Math.sin(kc.orbit) * 0.9;
      const back = Math.min(4.6, len * 0.55 + 1.6);
      this.camera.position.set(
        V.x + bx * back + sx * (1.5 + sw),
        V.y + 2.1,
        V.z + bz * back + sz * (1.5 + sw)
      );
      _a.set(V.x, V.y + 1.1, V.z);
      this.camera.lookAt(_a);
    }

    this.updateFx(dt);
    if (kc.t >= kc.to) this.endKillcam();
  }

  endKillcam() {
    if (!this.killcam) return;
    const done = this.killcam.onDone;
    this.killcam = null;
    if (this._kcSkip) this.$("kc-skip").removeEventListener("click", this._kcSkip);
    this._kcSkip = null;
    this.$("killcam").classList.remove("active");
    this.playerMesh.visible = false;
    this.viewmodel.visible = true;
    done();
  }

  /* ---------- input ---------- */
  setupInput() {
    this.keys = {};
    this.stick = { id: -1, ox: 0, oy: 0, x: 0, y: 0, mag: 0 };
    this.look = { id: -1, lx: 0, ly: 0 };
    this.fireLookId = -1;
    this.firing = false;
    this.pointerLocked = false;
    this.ads = 0;
    this.adsOn = false;
    this.lookScale = 1;

    const kd = e => {
      if (e.repeat) return;
      this.keys[e.code] = true;
      if (e.code === "KeyR") this.startReload();
      if (e.code === "Space") { e.preventDefault(); this.doVault(); }
      if (e.code === "KeyC") this.stanceInput(false);
      if (e.code === "KeyZ" || e.code === "ControlLeft") { e.preventDefault(); this.stanceInput(true); }
      if (e.code === "ShiftLeft" || e.code === "ShiftRight") this.setSprint(true);
    };
    const ku = e => {
      this.keys[e.code] = false;
      if (e.code === "ShiftLeft" || e.code === "ShiftRight") this.setSprint(false);
    };
    this.bind(window, "keydown", kd);
    this.bind(window, "keyup", ku);
    this.bind(window, "blur", () => this.resetInput());

    this.bind(this.canvas, "contextmenu", e => e.preventDefault());
    this.bind(document, "pointerlockchange", () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
    });

    this.bindHold("btn-fire", {
      down: e => {
        this.sfx.ensure();
        this.firing = true;
        this.setSprint(false);
        if (e.pointerType !== "mouse" && this.look.id === -1) {
          this.look.id = e.pointerId;
          this.look.lx = e.clientX;
          this.look.ly = e.clientY;
          this.fireLookId = e.pointerId;
        }
      },
      up: () => {
        this.firing = false;
        if (this.fireLookId !== -1 && this.look.id === this.fireLookId) this.look.id = -1;
        this.fireLookId = -1;
      },
    });
    this.bindPress("btn-ads", () => this.toggleAds());
    this.bindPress("btn-reload", () => this.startReload());
    this.bindPress("btn-vault", () => this.doVault());
    // STANCE: tap cycles stand/crouch, hold drops straight to prone
    this.bindHold("btn-stance", {
      down: () => { this._stanceHeld = performance.now(); this._stanceLong = this.after(() => this.stanceInput(true), 260); },
      up: () => {
        clearTimeout(this._stanceLong);
        if (performance.now() - this._stanceHeld < 260) this.stanceInput(false);
      },
    });
    this.bindPress("btn-prone", () => this.stanceInput(true));

    const stage = this.$("stage");
    this.bind(stage, "pointerdown", e => {
      if (e.target?.closest?.("button")) return;
      if (this.paused || this.over) return;
      e.preventDefault();
      if (e.pointerType === "mouse") {
        if (!this.pointerLocked) { this.canvas.requestPointerLock?.(); return; }
        if (e.button === 0) this.firing = true;
        if (e.button === 2) this.toggleAds();
        return;
      }
      const stickSide = settings.southpaw
        ? e.clientX > window.innerWidth * 0.58
        : e.clientX < window.innerWidth * 0.42;
      if (stickSide && this.stick.id === -1) {
        this.stick.id = e.pointerId;
        this.stick.ox = e.clientX; this.stick.oy = e.clientY;
        this.stick.x = 0; this.stick.y = 0; this.stick.mag = 0;
      } else if (this.look.id === -1 || this.look.id === this.fireLookId) {
        this.fireLookId = -1;
        this.look.id = e.pointerId;
        this.look.lx = e.clientX; this.look.ly = e.clientY;
      }
    });

    this.bind(stage, "pointermove", e => {
      if (e.pointerType === "mouse") {
        if (!this.pointerLocked || this.paused) return;
        this.applyLook(-e.movementX * 0.0023, -e.movementY * 0.0023);
        return;
      }
      if (e.pointerId === this.stick.id) {
        const dx = e.clientX - this.stick.ox, dy = e.clientY - this.stick.oy;
        const m = Math.hypot(dx, dy), cap = 52;
        const k = m > cap ? cap / m : 1;
        this.stick.x = (dx * k) / cap;
        this.stick.y = (dy * k) / cap;
        this.stick.mag = m / cap;
      } else if (e.pointerId === this.look.id) {
        this.applyLook(-(e.clientX - this.look.lx) * 0.0052, -(e.clientY - this.look.ly) * 0.0052);
        this.look.lx = e.clientX; this.look.ly = e.clientY;
      }
    });

    const release = e => {
      if (e.pointerType === "mouse") {
        // ADS is toggle (button + RMB); only FIRE releases on pointerup
        this.firing = false;
        return;
      }
      if (e.pointerId === this.stick.id) {
        this.stick.id = -1; this.stick.x = 0; this.stick.y = 0; this.stick.mag = 0;
        this.setSprint(false);
      }
      if (e.pointerId === this.look.id) this.look.id = -1;
    };
    this.bind(stage, "pointerup", release);
    this.bind(stage, "pointercancel", release);
    this.bind(window, "pointerup", release);

    this.bind(document, "visibilitychange", () => {
      if (document.hidden && !this.paused && !this.over) {
        this.setPaused(true);
        this.$("overlay-pause").classList.add("active");
      }
    });
  }

  // Look input funnels through here so sensitivity, invert and the aim-assist
  // slowdown apply to mouse and touch identically.
  applyLook(dYaw, dPitch) {
    const p = this.player;
    const sens = settings.sens * (this.ads > 0.5 ? settings.adsSens / 0.75 : 1);
    const slow = this.assistSlow ?? 1;
    p.yaw += dYaw * this.lookScale * sens * slow;
    p.pitch += dPitch * this.lookScale * sens * slow * (settings.invertY ? -1 : 1);
    this.clampPitch();
    this.swayX -= dYaw * 6;
    this.swayY -= dPitch * 6;
  }

  bindHold(id, { down, up }) {
    const el = this.$(id);
    let held = -1;
    this.bind(el, "pointerdown", e => {
      if (held !== -1 || this.paused || this.over) return;
      e.preventDefault();
      e.stopPropagation();
      held = e.pointerId;
      try { el.setPointerCapture(e.pointerId); } catch { /* already gone */ }
      el.classList.add("held");
      down?.(e);
    });
    const end = e => {
      if (e.pointerId !== held) return;
      held = -1;
      el.classList.remove("held");
      up?.(e);
    };
    this.bind(el, "pointerup", end);
    this.bind(el, "pointercancel", end);
    this.bind(el, "lostpointercapture", end);
  }

  bindPress(id, fn) {
    const el = this.$(id);
    this.bind(el, "pointerdown", e => {
      if (this.paused || this.over) return;
      e.preventDefault();
      e.stopPropagation();
      el.classList.add("held");
      this.after(() => el.classList.remove("held"), 110);
      fn(e);
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
    this.$("hit-dir").innerHTML = "";
    this.$("reload-ring").style.display = "none";
    this.$("reload-fill").style.width = "0%";
    this.$("wasted").classList.remove("active");
    this.$("killcam").classList.remove("active");
    document.body.classList.remove("wasted");
    this.setPrompt("");
    this.moveLabel = "STAND";
    this.hudCache = {};
    this.mmTimer = 0;
    this.sfx.setVolume(settings.volume);
  }

  hudSet(key, value, apply) {
    if (this.hudCache[key] === value) return;
    this.hudCache[key] = value;
    apply(value);
  }

  setPrompt(t, hold = 1.8) {
    this.$("hud-prompt").textContent = t;
    this.promptT = t ? hold : 0;
  }

  addFeed(a, b, allyKill) {
    const feed = this.$("killfeed");
    const row = document.createElement("div");
    row.className = "feedrow";
    row.style.borderLeftColor = allyKill ? "var(--red)" : "var(--text)";
    row.innerHTML = `<span>${a}</span><span class="x">✕</span><span class="b">${b}</span>`;
    feed.prepend(row);
    while (feed.children.length > 4) feed.lastChild.remove();
    this.after(() => { if (row.parentNode) row.remove(); }, 4200);
  }

  // A short arrow at the screen edge pointing at whoever just hit you.
  showHitDirection(attacker) {
    if (!attacker) return;
    const p = this.player;
    const ang = Math.atan2(attacker.pos.x - p.pos.x, attacker.pos.z - p.pos.z);
    let rel = ang - p.yaw + Math.PI;
    while (rel > Math.PI) rel -= Math.PI * 2;
    while (rel < -Math.PI) rel += Math.PI * 2;
    const el = document.createElement("div");
    el.className = "hitarrow";
    el.style.transform = `translate(-50%,-50%) rotate(${(rel * 180 / Math.PI).toFixed(1)}deg) translateY(-130px)`;
    this.$("hit-dir").appendChild(el);
    this.after(() => { el.style.opacity = "0"; }, 700);
    this.after(() => el.remove(), 1300);
  }

  /* ---------- combat events ---------- */
  handleBotShot(bot, target, hit, dmg) {
    const distToPlayer = bot.pos.distanceTo(this.player.pos);
    if (distToPlayer < 62) this.sfx.enemyFire(distToPlayer, bot.arch.dmg > 18 ? 0.8 : 0.35);
    bot.eyePos(_a);
    if (target.isPlayer) { _b.copy(this.player.pos); _b.y += this.player.chestY; }
    else { target.chestPos(_b); }
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
    this.shake = Math.min(1.2, this.shake + 0.35);
    this.showHitDirection(attacker);
    if (p.hp <= 0) this.playerDie(attacker);
  }

  playerDie(killer) {
    const p = this.player;
    p.alive = false;
    p.deaths++;
    p.respawnT = 4.4;
    p.respawnTotal = 4.4;
    p.reloading = 0;
    p.vaultT = 0;
    p.slideT = 0; p.slideVel = 0; p.slideDist = 0;
    p.stance = STAND; p.stanceLock = 0;
    this.adsOn = false;
    this.firing = false;
    this.sprinting = false;
    this.$("reload-ring").style.display = "none";
    this.score[1]++;
    if (killer) killer.kills = (killer.kills || 0) + 1;
    this.addFeed(killer ? killer.name : "RAVENGLASS", p.name, false);
    this.noteKill(killer, p, null, killer ? killer.pos.distanceTo(p.pos) : 0);

    // death camera: the body drops and the view rolls toward the killer
    this.deathCam = {
      t: 0,
      x: p.pos.x, y: p.pos.y, z: p.pos.z,
      yaw: p.yaw, pitch: p.pitch, roll: 0,
      targetYaw: killer ? Math.atan2(-(killer.pos.x - p.pos.x), -(killer.pos.z - p.pos.z)) : p.yaw,
    };

    // WASTED
    document.body.classList.add("wasted");
    this.$("wasted-killer").textContent = killer ? `DOWNED BY ${killer.name}` : "KILLED IN ACTION";
    this.$("wasted-sub").textContent = "REDEPLOYING";
    this.$("respawn-fill").style.width = "0%";
    this.$("wasted").classList.add("active");
    this.sfx.startSting();
    this.checkEnd();
  }

  clearWasted() {
    document.body.classList.remove("wasted");
    this.$("wasted").classList.remove("active");
    this.sfx.stopSting();
    this.deathCam = null;
  }

  // Remember the most recent kill in the match so the final one can be replayed.
  noteKill(killer, victim, part, dist) {
    if (!killer) return;
    this.lastKill = {
      killer, victim, part, dist,
      time: this.elapsed,
      weapon: killer.isPlayer ? this.loadout.name : (killer.arch?.weapon ?? "SMALL ARMS"),
    };
  }

  handleDeath(bot, killer) {
    bot.mesh.visible = false;
    this.score[bot.team === 1 ? 0 : 1]++;
    if (killer) {
      killer.kills = (killer.kills || 0) + 1;
      this.addFeed(killer.name, bot.name, killer.team === 0);
      this.noteKill(killer, bot, killer.isPlayer ? this._lastPart : null, killer.pos.distanceTo(bot.pos));
      if (killer.isPlayer) {
        this.sfx.kill();
        this.setPrompt(`ELIMINATED ${bot.name}`);
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
      this.firing = false;
      const rows = this.combatants
        .map(c => ({ name: c.name, team: c.team, kills: c.kills || 0, deaths: c.deaths || 0, me: !!c.isPlayer }))
        .sort((a, b) => b.kills - a.kills);
      const finish = () => this.onEnd({
        won: this.score[0] > this.score[1],
        ally: this.score[0], enemy: this.score[1], rows,
      });
      // the final kill earns a replay before the scoreboard
      this.after(() => {
        this.clearWasted();
        this.startKillcam(finish);
      }, 700);
    }
  }

  /* ---------- player actions ---------- */
  startReload() {
    const p = this.player, L = this.loadout;
    if (this.paused || this.over) return;
    if (!p.alive || p.reloading > 0 || p.ammo >= L.mag || p.reserve <= 0) return;
    p.reloading = L.reloadTime;
    this._rlPhase = -1;
    this.setSprint(false);
    this.moveLabel = "RELOADING";
    this.$("reload-fill").style.width = "0%";
    this.$("reload-cuff").style.width = "0%";
    this.$("reload-ring").style.display = "flex";
  }

  toggleAds() {
    if (!this.player.alive || this.paused || this.over) return;
    this.adsOn = !this.adsOn;
    if (this.adsOn) this.setSprint(false);
  }

  setSprint(on) {
    const p = this.player;
    if (on && (!p.alive || this.paused || this.over || p.stance !== STAND || p.slideT > 0)) return;
    if (on === this.sprinting) return;
    this.sprinting = on;
    if (on) this.adsOn = false;
    else p.sprintOutT = SPRINT_OUT;
  }

  /* Stance input from one button or key. `deep` asks for prone; otherwise it
     toggles stand/crouch. While moving, crouch starts a slide; sprint+prone
     is still a dive. */
  stanceInput(deep) {
    const p = this.player;
    if (!p.alive || this.paused || this.over) return;
    const stickMag = this.stick.mag ?? 0;
    const moving = p.speedVal > 1.4 || stickMag > 0.4
      || !!(this.keys["KeyW"] || this.keys["KeyA"] || this.keys["KeyS"] || this.keys["KeyD"]);
    if (!deep && moving && p.grounded && p.slideT <= 0 && p.stance === STAND) {
      this.doSlide();
      return;
    }
    if (deep && this.sprinting && moving && p.grounded && p.slideT <= 0) {
      this.doDive();
      return;
    }
    if (deep) this.setStance(p.stance === PRONE ? STAND : PRONE);
    else this.setStance(p.stance === CROUCH ? STAND : CROUCH);
  }

  setStance(s) {
    const p = this.player;
    if (!p.alive || s === p.stance || p.stanceLock > 0) return;
    if (s !== STAND && !p.grounded) return;
    if (STANCE_HEIGHT[s] > STANCE_HEIGHT[p.stance]) {
      // rising: only if there is headroom for the taller silhouette
      if (this.collides(p.pos.x, p.pos.z, p.radius, p.pos.y, p.pos.y + STANCE_HEIGHT[s])) {
        this.setPrompt("NO HEADROOM · STAY LOW", 1.2);
        return;
      }
    }
    this.setSprint(false);
    p.stanceLock = STANCE_LOCK[p.stance][s];
    p.stance = s;
    p.height = STANCE_HEIGHT[s];
    if (s === PRONE) this.sfx.prone();
    else this.sfx.vault();
  }

  doSlide() {
    const p = this.player;
    if (p.slideT > 0 || !p.grounded) return;
    // Prefer the current move direction; fall back to facing.
    let fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
    const mx = (this.keys["KeyD"] ? 1 : 0) - (this.keys["KeyA"] ? 1 : 0) + this.stick.x;
    const mz = (this.keys["KeyW"] ? 1 : 0) - (this.keys["KeyS"] ? 1 : 0) - this.stick.y;
    if (Math.hypot(mx, mz) > 0.2) {
      const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
      const wx = (-sin * mz) + (cos * mx);
      const wz = (-cos * mz) + (-sin * mx);
      const len = Math.hypot(wx, wz) || 1;
      fx = wx / len; fz = wz / len;
    }
    p.slideDir.set(fx, 0, fz);
    const base = this.loadout.moveSpeed * (this.sprinting ? SPRINT_MULT * 1.18 : 1.35);
    p.slideSpeed = Math.max(base, p.speedVal * 1.05);
    p.slideVel = p.slideSpeed;
    p.slideDist = 0;
    p.slideT = SLIDE_MAX_TIME;
    p.stance = CROUCH;
    p.height = STANCE_HEIGHT[CROUCH];
    p.stanceLock = 0.12;
    this.sprinting = false;
    this.adsOn = false;
    this.sfx.slide();
    this.moveLabel = "SLIDE";
  }

  doDive() {
    const p = this.player;
    if (!p.grounded) return;
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
    p.vy = 4.0;
    p.grounded = false;
    p.diving = true;
    p.slideDir.set(fx, 0, fz);
    p.slideSpeed = this.loadout.moveSpeed * SPRINT_MULT * 1.15;
    p.stanceLock = 0.35;
    this.sprinting = false;
    this.adsOn = false;
    this.sfx.vault();
    this.moveLabel = "DIVE";
  }

  resetInput() {
    this.keys = {};
    this.stick.id = -1; this.stick.x = 0; this.stick.y = 0; this.stick.mag = 0;
    this.look.id = -1;
    this.fireLookId = -1;
    this.firing = false;
    this.adsOn = false;
    this.sprinting = false;
    for (const id of ["btn-fire", "btn-ads", "btn-reload", "btn-vault", "btn-stance", "btn-prone"]) {
      this.$(id)?.classList.remove("held");
    }
  }

  unstick(e) {
    const r = e.radius, feet = e.pos.y, head = e.pos.y + (e.height || 1.8);
    for (const b of this.boxes) {
      if (b.top <= feet + 0.05 || b.y0 >= head) continue;
      if (e.pos.x + r <= b.minX || e.pos.x - r >= b.maxX) continue;
      if (e.pos.z + r <= b.minZ || e.pos.z - r >= b.maxZ) continue;
      const outMinX = (e.pos.x + r) - b.minX;
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
    if (e.pos.y < -2) { e.pos.copy(this.spawnFor(e.team)); e.vy = 0; }
  }

  doVault() {
    const p = this.player;
    if (!p.alive || p.vaultT > 0) return;
    if (p.stance !== STAND) { this.setStance(STAND); return; }  // stand up first
    if (p.slideT > 0) p.slideT = 0;                              // cancel a slide into a jump
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
      if (this.collides(to.x, to.z, p.radius, to.y, to.y + p.height)) {
        if (p.grounded) { p.vy = 5.6; p.grounded = false; this.moveLabel = "AIRBORNE"; }
        return;
      }
      p.vaultT = 0.36;
      p.vaultFrom.copy(p.pos);
      p.vaultTo.copy(to);
      this.moveLabel = "MANTLE";
    } else if (p.grounded) {
      p.vy = 5.6;
      p.grounded = false;
      this.moveLabel = "AIRBORNE";
    }
  }

  /* ---------- aim assist ----------
     Touch aiming needs help that a mouse does not: a gentle pull toward the
     nearest visible enemy inside a small cone, plus a look slowdown while the
     reticle is on a target. Both scale with the player's setting and vanish
     at zero. */
  updateAimAssist(dt) {
    this.assistSlow = 1;
    const amt = settings.aimAssist;
    const p = this.player;
    if (amt <= 0 || !p.alive || this.pointerLocked) return;
    // assist only reacts to what the player is already doing — a camera that
    // drifts onto targets while the thumbs are off the glass feels haunted
    const engaged = this.look.id !== -1 || this.stick.id !== -1 || this.firing;
    const cone = (this.ads > 0.5 ? 7 : 4.5) * DEG;
    const oy = p.pos.y + p.eyeH;
    const vYaw = p.yaw + this.recoilYaw, vPitch = p.pitch + this.recoilPitch;
    const dx = -Math.sin(vYaw) * Math.cos(vPitch);
    const dy = Math.sin(vPitch);
    const dz = -Math.cos(vYaw) * Math.cos(vPitch);
    let best = null, bestAng = cone;
    for (const b of this.bots) {
      if (!b.alive || b.team === 0) continue;
      const rx = b.pos.x - p.pos.x, ry = (b.pos.y + 1.15) - oy, rz = b.pos.z - p.pos.z;
      const len = Math.hypot(rx, ry, rz);
      if (len < 1.5 || len > 70) continue;
      const dot = (rx * dx + ry * dy + rz * dz) / len;
      if (dot < 0.2) continue;
      const ang = Math.acos(Math.min(1, dot));
      if (ang < bestAng && !this.losBlocked(p.pos.x, oy, p.pos.z, b.pos.x, b.pos.y + 1.15, b.pos.z)) {
        bestAng = ang; best = b;
      }
    }
    if (!best) return;
    this.assistSlow = 1 - 0.42 * amt * (1 - bestAng / cone);
    if (!engaged) return;
    // rotate a little toward the target; strength falls off at the cone edge
    const wantYaw = Math.atan2(-(best.pos.x - p.pos.x), -(best.pos.z - p.pos.z));
    const flat = Math.hypot(best.pos.x - p.pos.x, best.pos.z - p.pos.z);
    const wantPitch = Math.atan2((best.pos.y + 1.15) - oy, flat);
    let dYaw = wantYaw - p.yaw;
    while (dYaw > Math.PI) dYaw -= Math.PI * 2;
    while (dYaw < -Math.PI) dYaw += Math.PI * 2;
    const dPitch = wantPitch - p.pitch;
    const pull = amt * 3.2 * (1 - bestAng / cone) * dt;
    p.yaw += dYaw * Math.min(0.5, pull);
    p.pitch += dPitch * Math.min(0.5, pull);
    this.clampPitch();
  }

  tryFire() {
    const p = this.player, L = this.loadout;
    if (!p.alive || p.reloading > 0) return;
    if (this.sprinting || p.sprintOutT > 0 || p.stanceLock > 0 || p.slideVel > 1.0) return;
    if (p.shotT > 0) return;
    if (p.ammo <= 0) { this.startReload(); return; }
    if (!L.auto && this._semiHeld) return;
    this._semiHeld = true;

    // Rotary guns must spool before rounds leave the barrel.
    if (L.spinUp > 0 && this._spin < 0.98) return;

    p.shotT = 60 / L.rpm;
    p.ammo--;
    this.sinceShot = 0;
    const fireW = Math.min(1, L.damage / 70) * (L.spinUp > 0 ? 0.55 : 1);
    this.sfx.fire(fireW, L.suppressed);

    const aim = this.ads;
    const stance = p.stance;
    const spreadMult = (L.hipSpreadMult + (L.adsSpreadMult - L.hipSpreadMult) * aim) * STANCE_SPREAD[stance];
    const moveP = p.speedVal > 0.5 ? L.moveSpreadDeg * (1 - 0.7 * aim) : 0;
    const spread = (L.spreadDeg * spreadMult + moveP) * DEG;
    const vYaw = p.yaw + this.recoilYaw, vPitch = p.pitch + this.recoilPitch;
    const yaw = vYaw + (Math.random() - 0.5) * spread;
    const pitch = vPitch + (Math.random() - 0.5) * spread;
    const dx = -Math.sin(yaw) * Math.cos(pitch);
    const dy = Math.sin(pitch);
    const dz = -Math.cos(yaw) * Math.cos(pitch);
    const ox = p.pos.x, oy = p.pos.y + p.eyeH, oz = p.pos.z;

    const wallT = this.rayWorldDist(ox, oy, oz, dx, dy, dz, 200);
    const shot = this.raycastBots(ox, oy, oz, dx, dy, dz, Math.min(wallT, 200));
    const hitBot = shot?.bot ?? null;
    const hitT = shot?.t ?? Infinity;
    const part = shot?.part ?? null;
    const headshot = part?.name === "HEAD";

    // tracer from the real muzzle, so it lines up with the model
    const muzzleWorld = _a.copy(this.muzzleLocal);
    this.viewmodel.localToWorld(muzzleWorld);
    const endT = Math.min(hitT, wallT, 200);
    const ix = ox + dx * endT, iy = oy + dy * endT, iz = oz + dz * endT;
    _b.set(ix, iy, iz);
    this.spawnTracer(muzzleWorld, _b);
    if (!hitBot && wallT < 200) this.spawnImpact(ix, iy, iz);
    if (!hitBot && wallT < 60) this.sfx.impact(true);

    // muzzle flash + light
    this.flashT = 0.045;
    this.vmFlash.visible = true;
    this.vmFlash.rotation.z = Math.random() * 6.28;
    this.flashLight.position.copy(muzzleWorld);
    this.spawnBrass();   // clobbers the shared scratch vectors — read them first

    // recoil: walk the weapon's learnable pattern, scaled by stance and ADS
    const pat = L.recoil.pattern;
    const idx = Math.min(this.shotIdx, pat.length - 1);
    const [ph, pv] = pat[idx];
    const wrap = this.shotIdx >= pat.length ? (this.shotIdx % 2 ? -1 : 1) : 1;
    const rs = STANCE_RECOIL[stance] * (1 - 0.18 * aim);
    this.recoilPitch += L.recoil.v * pv * rs * DEG * (0.9 + Math.random() * 0.2);
    this.recoilYaw += L.recoil.h * ph * wrap * rs * DEG * (0.85 + Math.random() * 0.3);
    this.shotIdx++;
    this.vmKick = Math.min(1.4, this.vmKick + 0.9 + L.recoil.kickback * 3);
    this.vmKickRot = Math.min(1.4, this.vmKickRot + 0.7 + L.recoil.kickback * 2.4);
    this.shake = Math.min(1.5, this.shake + L.recoil.kickback * 2.2 * settings.shake);

    if (hitBot) {
      let dmg = L.damage * part.mult;
      const dist = hitT;
      if (dist > L.falloffStart) {
        const f = Math.max(0.45, 1 - (dist - L.falloffStart) / Math.max(1, L.falloffEnd - L.falloffStart) * 0.55);
        dmg *= f;
      }
      if (headshot) this.sfx.headshot(); else this.sfx.hit();
      this.spawnImpact(ix, iy, iz);
      const hm = this.$("hitmarker");
      hm.classList.remove("show", "head"); void hm.offsetWidth;
      hm.classList.add("show"); if (headshot) hm.classList.add("head");
      this._lastPart = part.name;
      hitBot.damage(dmg, this.player, this.botCtx);
    }

    if (p.ammo === 0) this.startReload();
  }

  /* ---------- per-frame ---------- */
  update(dt) {
    const p = this.player, L = this.loadout;
    this.time -= dt;
    this.elapsed += dt;
    if (this.time <= 0) { this.time = 0; this.checkEnd(); }

    // kill cam recorder
    this.kcAccum += dt;
    if (this.kcAccum >= 0.05) { this.kcAccum = 0; this.recordFrame(); }

    // ---- respawn ----
    if (!p.alive) {
      p.respawnT -= dt;
      this.$("respawn-fill").style.width =
        Math.min(100, (1 - p.respawnT / p.respawnTotal) * 100).toFixed(1) + "%";
      if (p.respawnT <= 0 && !this.over) {
        p.pos.copy(this.spawnFor(0));
        p.hp = 100; p.alive = true; p.pitch = 0;
        p.yaw = Math.atan2(p.pos.x, p.pos.z);
        p.ammo = L.mag; p.reserve = L.reserve; p.reloading = 0;
        p.stance = STAND; p.height = STANCE_HEIGHT[STAND]; p.eyeH = STANCE_EYE[STAND];
        this.recoilPitch = this.recoilYaw = 0;
        this.$("reload-ring").style.display = "none";
        this.clearWasted();
        this.setPrompt("");
        this.moveLabel = "STAND";
      }
    }

    // ---- ADS lerp ----
    const adsTarget = (this.adsOn && p.alive && p.reloading <= 0 && p.vaultT <= 0 && p.slideT <= 0) ? 1 : 0;
    const adsStep = dt / Math.max(0.05, L.adsTime);
    this.ads += Math.sign(adsTarget - this.ads) * Math.min(Math.abs(adsTarget - this.ads), adsStep);

    if (p.alive) {
      this.updateAimAssist(dt);
      this.updateMovement(dt);

      if (p.stanceLock > 0) p.stanceLock -= dt;
      if (p.sprintOutT > 0) p.sprintOutT -= dt;

      // stance heights ease in so the camera never snaps
      const wantEye = STANCE_EYE[p.stance] + (p.slideT > 0 ? -0.12 : 0);
      p.eyeH += (wantEye - p.eyeH) * Math.min(1, dt * 9);
      p.chestY = p.eyeH * 0.74;

      if (p.reloading > 0) {
        p.reloading -= dt;
        if (p.reloading <= 0) {
          const need = L.mag - p.ammo;
          const take = Math.min(need, p.reserve);
          p.ammo += take; p.reserve -= take;
          this.$("reload-ring").style.display = "none";
          this.$("reload-cuff").style.width = "0%";
          this.moveLabel = STANCE_NAME[p.stance];
        }
      }

      p.shotT -= dt;

      // Minigun spool: climb while holding fire, coast down when released.
      if (L.spinUp > 0) {
        const want = (this.firing && p.alive && p.reloading <= 0 && !this.sprinting) ? 1 : 0;
        const rate = want ? (1 / L.spinUp) : (1 / Math.max(0.18, L.spinUp * 0.55));
        this._spin = Math.max(0, Math.min(1, this._spin + (want ? rate : -rate) * dt));
        this._spinAng += dt * (8 + this._spin * 42);
      } else {
        this._spin = 0;
      }

      if (this.firing) this.tryFire();
      else this._semiHeld = false;

      if (p.hp < 100 && this.timeSinceHurt() > 4.5) p.hp = Math.min(100, p.hp + 13 * dt);
    }

    // ---- recoil recovery ----
    this.sinceShot += dt;
    if (this.sinceShot > 0.35) this.shotIdx = 0;
    if (this.sinceShot > 0.1) {
      const k = Math.min(1, L.recoil.recover * dt * (this.ads > 0.5 ? 1.25 : 1));
      this.recoilPitch -= this.recoilPitch * k;
      this.recoilYaw -= this.recoilYaw * k;
    }
    this.shake = Math.max(0, this.shake - dt * 3.4);

    // ---- bots ----
    const byTime = 1 - this.time / MATCH.timeLimit;
    const byScore = Math.max(this.score[0], this.score[1]) / MATCH.killTarget;
    this.botCtx.escalation = Math.min(1, Math.max(byTime, byScore));

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
          if (!b.goal) b.goal = new THREE.Vector3();
          b.goal.copy(this.player.pos);
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

    this.updateFx(dt);
    this.updateCamera(dt);
    this.updateViewmodel(dt);
    this.updateHud(dt);
  }

  updateMovement(dt) {
    const p = this.player, L = this.loadout;

    if (p.vaultT > 0) {
      p.vaultT -= dt;
      const k = 1 - Math.max(0, p.vaultT) / 0.36;
      p.pos.lerpVectors(p.vaultFrom, p.vaultTo, k);
      p.pos.y = p.vaultFrom.y + (p.vaultTo.y - p.vaultFrom.y) * k + Math.sin(k * Math.PI) * 0.35;
      if (p.vaultT <= 0) { p.pos.copy(p.vaultTo); p.grounded = true; p.vy = 0; }
      p.speedVal = 3;
      return;
    }

    let mx = 0, mz = 0;
    if (this.keys["KeyW"]) mz -= 1;
    if (this.keys["KeyS"]) mz += 1;
    if (this.keys["KeyA"]) mx -= 1;
    if (this.keys["KeyD"]) mx += 1;
    mx += this.stick.x; mz += this.stick.y;
    const mlen = Math.hypot(mx, mz);
    if (mlen > 1) { mx /= mlen; mz /= mlen; }

    // Sprint is a stick gesture: shove the stick past the ring while heading
    // forward. Combat always outranks it.
    const busy = this.firing || this.adsOn || p.reloading > 0 || p.stance !== STAND || p.slideT > 0;
    const forward = this.stick.y < -0.35;
    const pushedToRing = (this.stick.mag ?? 0) >= 0.95 && forward;
    const autoSprint = settings.autoSprint && (this.stick.mag ?? 0) >= 0.6 && forward;
    const backOff = (this.stick.mag ?? 0) < 0.8 || this.stick.y > -0.15;
    if (busy) this.setSprint(false);
    else if (this.stick.id !== -1) {
      if (pushedToRing || autoSprint) this.setSprint(true);
      else if (backOff) this.setSprint(false);
    }
    if (this.sprinting && mlen < 0.35) this.setSprint(false);
    if (this.keys["ShiftLeft"] && mlen > 0.35 && !busy) this.setSprint(true);

    const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
    let wx, wz, speed;

    if (p.slideT > 0) {
      // Smooth glide, then friction brakes over distance into a crouch.
      p.slideT -= dt;
      const fric = p.slideDist < SLIDE_GLIDE_DIST ? SLIDE_FRIC_GLIDE : SLIDE_FRIC_BRAKE;
      p.slideVel = Math.max(0, p.slideVel - fric * dt);
      speed = p.slideVel;
      wx = p.slideDir.x; wz = p.slideDir.z;
      const step = speed * dt;
      p.slideDist += step;
      if (p.slideVel <= SLIDE_END_SPEED
        || p.slideDist >= SLIDE_GLIDE_DIST + SLIDE_BRAKE_DIST
        || p.slideT <= 0) {
        p.slideT = 0;
        p.slideVel = 0;
        p.stanceLock = 0.14;
        this.moveLabel = "CROUCH";
      }
    } else if (p.diving && !p.grounded) {
      speed = p.slideSpeed;
      wx = p.slideDir.x; wz = p.slideDir.z;
    } else {
      wx = (-sin * -mz) + (cos * mx);
      wz = (-cos * -mz) + (-sin * mx);
      speed = L.moveSpeed * (1 + (L.adsMoveMult - 1) * this.ads) * STANCE_SPEED[p.stance];
      if (this.sprinting) speed *= SPRINT_MULT;
      if (p.stanceLock > 0) speed *= 0.45;
      speed *= mlen > 0 ? 1 : 0;
    }

    this.moveEntity(p, wx * speed * dt, wz * speed * dt);
    p.speedVal = (p.slideT > 0 || p.diving) ? speed : mlen * speed;

    if (p.reloading <= 0 && p.vaultT <= 0 && !this.firing && p.grounded && p.slideT <= 0) {
      this.moveLabel = this.sprinting ? "SPRINT"
        : p.stance === PRONE ? "PRONE"
        : p.stance === CROUCH ? "CROUCH"
        : this.ads > 0.6 ? (L.scope ? "SCOPED" : "ADS")
        : mlen > 0.05 ? "MOVE" : "STAND";
    }

    // gravity / ground
    const ground = this.groundHeight(p.pos.x, p.pos.z, p.radius, p.pos.y);
    p.vy -= GRAVITY * dt;
    p.pos.y += p.vy * dt;
    if (p.pos.y <= ground) {
      p.pos.y = ground; p.vy = 0;
      if (!p.grounded && p.diving) {          // a dive lands you flat
        p.diving = false;
        p.stance = PRONE;
        p.height = STANCE_HEIGHT[PRONE];
        p.stanceLock = 0.5;
        this.sfx.prone();
        this.shake = Math.min(1.4, this.shake + 0.5);
        this.moveLabel = "PRONE";
      }
      p.grounded = true;
    } else if (p.pos.y > ground + 0.05) {
      p.grounded = false;
    }
    this.unstick(p);
  }

  updateCamera(dt) {
    const p = this.player, L = this.loadout;
    const cam = this.camera;
    cam.rotation.order = "YXZ";

    if (!p.alive && this.deathCam) {
      // death cam: the view drops to the deck and turns toward the killer
      const d = this.deathCam;
      d.t += dt;
      const k = Math.min(1, d.t / 1.1);
      const ease = k * k * (3 - 2 * k);
      cam.position.set(d.x, d.y + 1.5 - 1.16 * ease, d.z);
      let dy = d.targetYaw - d.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      cam.rotation.y = d.yaw + dy * Math.min(1, d.t / 2.2);
      cam.rotation.x = d.pitch + (-0.22 - d.pitch) * ease;
      cam.rotation.z = 0.5 * ease + Math.sin(d.t * 0.6) * 0.02;
      if (Math.abs(cam.fov - this.baseFov) > 0.01) {
        cam.fov = this.baseFov;
        cam.updateProjectionMatrix();
      }
      return;
    }

    // walk bob: amplitude follows real speed, frequency follows stance
    const moving = p.grounded && p.speedVal > 0.4 && p.slideT <= 0;
    this.bobAmt += ((moving ? Math.min(1, p.speedVal / (L.moveSpeed * SPRINT_MULT)) : 0) - this.bobAmt)
      * Math.min(1, dt * 7);
    this.bobT += dt * (this.sprinting ? 13 : 9) * (0.4 + this.bobAmt);
    const bobScale = (1 - 0.75 * this.ads) * (p.stance === PRONE ? 0.3 : 1);
    const bobY = Math.sin(this.bobT * 2) * 0.026 * this.bobAmt * bobScale;
    const bobX = Math.cos(this.bobT) * 0.03 * this.bobAmt * bobScale;

    // impact shake, damped and scaled by the comfort setting
    const sh = this.shake * settings.shake;
    const shx = sh * (Math.random() - 0.5) * 0.016;
    const shy = sh * (Math.random() - 0.5) * 0.016;

    cam.position.set(p.pos.x + bobX * 0.35, p.pos.y + p.eyeH + bobY, p.pos.z);
    cam.rotation.y = p.yaw + this.recoilYaw + shx;
    cam.rotation.x = p.pitch + this.recoilPitch + shy;
    // lean into a slide, and roll slightly with strafe
    const slideBlend = p.slideT > 0 && p.slideSpeed > 0 ? Math.min(1, p.slideVel / p.slideSpeed) : 0;
    const slideRoll = 0.16 * slideBlend;
    const strafeRoll = -this.stick.x * 0.016 * (1 - this.ads);
    cam.rotation.z = slideRoll + strafeRoll + bobX * 0.25;

    const fov = this.baseFov / (1 + (L.adsZoom - 1) * this.ads);
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    this.lookScale = fov / this.baseFov;
  }

  /* Viewmodel: rest pose, then reload, sprint, sway, bob and recoil layered on
     top. Every offset is additive so no two states fight each other. */
  updateViewmodel(dt) {
    const p = this.player, L = this.loadout;
    const vm = this.viewmodel;
    const mag = this.wm.magGroup, bolt = this.wm.boltGroup;

    vm.rotation.set(0, 0, 0);
    mag.position.copy(this.magBase);
    mag.rotation.set(0, 0, 0);
    mag.visible = true;
    if (this.spinBarrels) {
      bolt.position.set(0, this.wm.boreY ?? 0, 0);
      bolt.rotation.set(0, 0, this._spinAng);
    } else {
      bolt.position.set(0, 0, 0);
      bolt.rotation.set(0, 0, 0);
    }

    // hip <-> ADS position; cant eases toward a slight ADS rest pose
    const t = this.ads;
    _a.copy(this.vmHip).lerp(this.vmAds, t);
    vm.rotation.x += this.vmHipRot.x * (1 - t) + this.vmAdsRot.x * t;
    vm.rotation.y += this.vmHipRot.y * (1 - t) + this.vmAdsRot.y * t;
    vm.rotation.z += this.vmHipRot.z * (1 - t) + this.vmAdsRot.z * t;

    if (p.alive && p.reloading > 0) {
      this.animateReload(1 - p.reloading / L.reloadTime, vm, mag, bolt);
      // rotary barrel cluster must stay on the bore axis after reload anim
      if (this.spinBarrels) {
        bolt.position.set(0, this.wm.boreY ?? 0, 0);
        bolt.rotation.set(0, 0, this._spinAng);
      }
    } else {
      this._rlPhase = -1;
    }

    // sprint pose: cant the weapon down and across with a two-step run cycle
    const wantSprint = (this.sprinting && p.alive) ? 1
      : p.sprintOutT > 0 ? p.sprintOutT / SPRINT_OUT : 0;
    this.sprintBlend += (wantSprint - this.sprintBlend) * Math.min(1, dt * 11);
    if (this.sprintBlend > 0.002) {
      const s = this.sprintBlend * (1 - t);
      this.runT += dt * 11;
      vm.rotation.z += 0.52 * s;
      vm.rotation.x += 0.40 * s;
      vm.rotation.y += 0.28 * s;
      _a.y += (-0.11 + Math.sin(this.runT) * 0.02) * s;
      _a.x += (0.05 + Math.cos(this.runT * 0.5) * 0.011) * s;
      _a.z += 0.05 * s;
    }

    // stance offsets: prone tucks the weapon in, a slide throws it wide
    if (p.stance === PRONE) { _a.y += 0.02 * (1 - t); _a.z += 0.02 * (1 - t); }
    if (p.slideT > 0 && p.slideSpeed > 0) {
      const k = Math.min(1, p.slideVel / p.slideSpeed);
      vm.rotation.z += 0.34 * k;
      vm.rotation.x += 0.22 * k;
      _a.y -= 0.05 * k;
    }

    // look sway — the weapon lags the camera, then settles
    this.swayX += (0 - this.swayX) * Math.min(1, dt * 9);
    this.swayY += (0 - this.swayY) * Math.min(1, dt * 9);
    const swayK = (1 - 0.7 * t);
    _a.x += Math.max(-0.05, Math.min(0.05, this.swayX * 0.03)) * swayK;
    _a.y += Math.max(-0.05, Math.min(0.05, this.swayY * 0.03)) * swayK;
    vm.rotation.y += Math.max(-0.1, Math.min(0.1, this.swayX * 0.05)) * swayK;
    vm.rotation.x += Math.max(-0.1, Math.min(0.1, -this.swayY * 0.05)) * swayK;

    // idle breathing + walk bob
    this.idleT = (this.idleT || 0) + dt;
    const breathe = (1 - 0.8 * t) * (p.stance === PRONE ? 0.35 : 1);
    _a.y += Math.sin(this.idleT * 1.6) * 0.0035 * breathe;
    _a.x += Math.cos(this.idleT * 1.1) * 0.0028 * breathe;
    _a.y += Math.sin(this.bobT * 2) * 0.012 * this.bobAmt * (1 - 0.8 * t);
    _a.x += Math.cos(this.bobT) * 0.016 * this.bobAmt * (1 - 0.8 * t);

    // recoil kick on the model itself
    this.vmKick = Math.max(0, this.vmKick - dt * 8);
    this.vmKickRot = Math.max(0, this.vmKickRot - dt * 7);
    _a.z += this.vmKick * 0.05;
    _a.y += this.vmKick * 0.012;
    vm.rotation.x += this.vmKickRot * 0.06;
    vm.rotation.z += this.vmKickRot * 0.012;

    vm.position.copy(_a);
    // a scoped rifle hides the model behind the scope overlay
    vm.visible = !(L.scope && this.ads > 0.9) && !!p.alive;
  }

  // Staged reload: tilt in → mag drops → grab pause → new mag seats → rack.
  animateReload(t, vm, mag, bolt) {
    const ph = t < 0.15 ? 0 : t < 0.45 ? 1 : t < 0.55 ? 2 : t < 0.8 ? 3 : 4;
    if (ph !== this._rlPhase) {
      this._rlPhase = ph;
      if (ph === 1) this.sfx.magOut();
      if (ph === 3) this.sfx.magIn();
      if (ph === 4) this.sfx.rack();
    }
    const ease = x => x * x * (3 - 2 * x);
    const tilt = t < 0.15 ? ease(t / 0.15) : t > 0.8 ? 1 - ease((t - 0.8) / 0.2) : 1;
    vm.rotation.z += 0.24 * tilt;
    vm.rotation.x += 0.14 * tilt;
    _a.y -= 0.05 * tilt;

    let magY = 0, magRX = 0, magVisible = true;
    if (t >= 0.15 && t < 0.45) {
      const k = ease((t - 0.15) / 0.3);
      magY = -0.34 * k; magRX = -0.7 * k;
    } else if (t >= 0.45 && t < 0.55) {
      magVisible = false;
    } else if (t >= 0.55 && t < 0.8) {
      const k = ease((t - 0.55) / 0.25);
      magY = -0.34 * (1 - k); magRX = -0.7 * (1 - k);
    } else if (t >= 0.8) {
      // charging handle jerks back and rides forward
      bolt.position.z = 0.055 * Math.sin(((t - 0.8) / 0.2) * Math.PI);
      _a.z += 0.03 * Math.sin(((t - 0.8) / 0.2) * Math.PI);
    }
    mag.position.y = this.magBase.y + magY;
    mag.rotation.x = magRX;
    mag.visible = magVisible;
    const pctText = (t * 100).toFixed(0) + "%";
    this.$("reload-fill").style.width = pctText;
    this.$("reload-cuff").style.width = pctText;
  }

  timeSinceHurt() { return (this.player.lastHurt === -10) ? 999 : Math.max(0, this.player.lastHurt - this.time); }

  updateHud(dt) {
    const p = this.player, L = this.loadout;
    this.hudSet("ammo", `${p.ammo}<span> / ${p.reserve}</span>`,
      v => { this.$("ammo-count").innerHTML = v; });
    this.hudSet("ammoLow", p.ammo <= Math.max(3, L.mag * 0.25),
      v => this.$("ammo-count").classList.toggle("low", v));
    this.hudSet("hp", Math.max(0, Math.round(p.hp)),
      v => { this.$("hp-fill").style.width = v + "%"; });
    this.hudSet("move", p.alive ? this.moveLabel : "DOWN",
      v => { this.$("move-state").textContent = v; });
    this.hudSet("scoreA", this.score[0], v => { this.$("score-ally").textContent = v; });
    this.hudSet("scoreB", this.score[1], v => { this.$("score-enemy").textContent = v; });
    const t = Math.max(0, Math.ceil(this.time));
    this.hudSet("clock", `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`,
      v => { this.$("hud-clock").textContent = v; });
    this.hudSet("joy", `${Math.round(this.stick.x * 26)},${Math.round(this.stick.y * 26)}`, () => {
      this.$("joy-knob").style.transform =
        `translate(calc(-50% + ${Math.round(this.stick.x * 26)}px), calc(-50% + ${Math.round(this.stick.y * 26)}px))`;
    });

    // transient status line fades on its own instead of sticking around
    if (this.promptT > 0) {
      this.promptT -= dt;
      if (this.promptT <= 0) this.$("hud-prompt").textContent = "";
    }

    // Crosshair: bloom from spread, plus the classic ADS tighten (958776f).
    const bloom = Math.round(
      (L.spreadDeg * (L.hipSpreadMult + (L.adsSpreadMult - L.hipSpreadMult) * this.ads)
        * STANCE_SPREAD[p.stance] + (p.speedVal > 0.5 ? 1.4 : 0)) * 4
      + Math.min(8, this.shotIdx * 0.7)
    );
    const chHidden = (L.scope && this.ads > 0.6) || !p.alive;
    const chScale = (0.72 + bloom * 0.05) * (1 - 0.4 * this.ads);
    this.hudSet("ch", `${bloom}|${chHidden ? 1 : 0}|${chScale.toFixed(3)}`, () => {
      const ch = this.$("crosshair");
      ch.style.opacity = chHidden ? 0 : 1;
      ch.style.transform = `translate(-50%,-50%) scale(${chScale.toFixed(3)})`;
    });
    this.hudSet("scope", L.scope && this.ads > 0.92,
      v => { this.$("scope-overlay").style.display = v ? "block" : "none"; });

    const hurtAge = this.timeSinceHurt();
    const vig = !p.alive ? 0
      : hurtAge < 0.25 ? Math.min(1, 0.35 + (100 - p.hp) / 120)
      : p.hp < 35 ? 0.4
      : 0;
    this.hudSet("vig", vig.toFixed(2), v => { this.$("dmg-vignette").style.opacity = v; });
    this.hudSet("sprintRing", this.sprinting,
      v => this.$("joy-zone").classList.toggle("sprint", v));
    this.hudSet("stanceBtn", p.stance, v => {
      this.$("btn-stance").classList.toggle("on", v === CROUCH);
      this.$("btn-stance").firstChild.nodeValue = v === PRONE ? "STAND" : "CROUCH";
      this.$("btn-prone").classList.toggle("on", v === PRONE);
    });
    this.hudSet("adsBtnHeld", this.adsOn,
      v => this.$("btn-ads").classList.toggle("on", v));

    const yawDeg = ((-this.player.yaw * 180 / Math.PI) % 360 + 360) % 360;
    const px = Math.round((-(yawDeg / 45) * 42 - 42 * 8 + 84 - 21) * 2) / 2;
    this.hudSet("compass", px, v => { this.$("compass-strip").style.transform = `translateX(${v}px)`; });

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
      this.resetInput();
      this.sfx.stopSting(0.2);
      document.exitPointerLock?.();
    } else {
      this.last = performance.now();
      if (!this.player.alive) this.sfx.startSting();
    }
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    for (const t of this._timeouts) clearTimeout(t);
    this._timeouts = [];
    for (const [el, ev, fn, opts] of this._bound) el.removeEventListener(ev, fn, opts);
    this._bound = [];
    if (this._kcSkip) this.$("kc-skip").removeEventListener("click", this._kcSkip);
    window.removeEventListener("resize", this._onResize);
    document.exitPointerLock?.();
    this.sfx.stopSting(0.1);
    this.clearWasted();
    this.$("killcam").classList.remove("active");
    this.$("hud-prompt").textContent = "";
    // pull the viewmodel out first: its materials are a module-level cache
    // shared with the next match and must survive this teardown
    this.camera.remove(this.viewmodel);
    this.scene.traverse(o => {
      if (o.isInstancedMesh) o.dispose();
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => {
        if (m.map) m.map.dispose();
        m.dispose();
      });
    });
    this.viewmodel.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    this.flashMat.dispose();
    this.tracerMat.dispose();
    this.sparkMat.dispose();
    this.renderer.dispose();
    this.sfx.ctx?.close?.();
    if (window.__game === this) window.__game = null;
  }
}
