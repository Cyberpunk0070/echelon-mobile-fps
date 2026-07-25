// ECHELON — game runtime: dockyard arena, player controller, combat, HUD.
import * as THREE from "three";
import { Bot } from "./bots.js";
import { SQUAD_ALLY, SQUAD_ENEMY, MATCH } from "./data.js";

const DARK = { bg: 0x151312, surface: 0x211f1e, text: 0xf3f2f2, red: 0xff563c };
const ARENA = 47;              // half-extent of playable area
const GRAVITY = 16;
const EYE = 1.55;

const _a = new THREE.Vector3(), _b = new THREE.Vector3();

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
    window.__game = this; // debug/QA handle
    const loop = (now) => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      const rawDt = (now - this.last) / 1000;
      this.last = now;
      const dt = Math.min(rawDt, 0.05);
      if (!this.paused && !this.over) {
        this.update(dt);
        // adaptive resolution: if the phone can't hold frame time, step the
        // pixel ratio down (and back up when there's headroom)
        this.perfAccum += rawDt; this.perfFrames++;
        if (this.perfFrames >= 120) {
          const avg = this.perfAccum / this.perfFrames;
          this.perfAccum = 0; this.perfFrames = 0;
          const scales = [1, 0.8, 0.65];
          if (avg > 0.020 && this.perfLevel < 2) this.perfLevel++;
          else if (avg < 0.011 && this.perfLevel > 0) this.perfLevel--;
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
    this.geoCache = new THREE.BoxGeometry(1, 1, 1);
    this.matCache = new Map();
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(DARK.bg);
    this.scene.fog = new THREE.Fog(DARK.bg, 30, 110);
    this.camera = new THREE.PerspectiveCamera(74, 1, 0.08, 240);
    this.resize();
    this._onResize = () => this.resize();
    window.addEventListener("resize", this._onResize);

    const hemi = new THREE.HemisphereLight(0xb5b0ac, 0x2a2725, 1.7);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xf3f2f2, 1.35);
    sun.position.set(30, 60, -20);
    this.scene.add(sun);
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

  addBox(cx, cz, w, d, h, color, y0 = 0, stripe = null) {
    // one shared unit-box geometry + cached materials keeps draw-call state
    // and GPU memory small on mobile
    const m = new THREE.Mesh(this.geoCache, this.mat(color));
    m.scale.set(w, h, d);
    m.position.set(cx, y0 + h / 2, cz);
    this.scene.add(m);
    if (stripe) {
      const sg = new THREE.Mesh(this.geoCache, this.mat(stripe));
      sg.scale.set(w + 0.04, h * 0.18, d + 0.04);
      sg.position.set(cx, y0 + h * 0.62, cz);
      this.scene.add(sg);
    }
    this.boxes.push({ minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2, y0, top: y0 + h });
    return m;
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
  }

  /* ---------- collision & rays ---------- */
  collides(x, z, r, feet, head) {
    for (const b of this.boxes) {
      if (b.top <= feet + 0.55 || b.y0 >= head) continue; // can step on / walk under
      if (x + r > b.minX && x - r < b.maxX && z + r > b.minZ && z - r < b.maxZ) return true;
    }
    if (Math.abs(x) > ARENA || Math.abs(z) > ARENA) return true;
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
    for (const b of this.boxes) {
      if (x + r > b.minX && x - r < b.maxX && z + r > b.minZ && z - r < b.maxZ) {
        if (b.top <= feet + 0.55 && b.top > g) g = b.top;
      }
    }
    return g;
  }

  // ray vs AABBs — returns nearest hit t along dir (len = maxDist), or Infinity
  rayWorldDist(ox, oy, oz, dx, dy, dz, maxDist) {
    let best = Infinity;
    for (const b of this.boxes) {
      let tmin = 0, tmax = maxDist;
      // X slab
      if (Math.abs(dx) < 1e-9) { if (ox < b.minX || ox > b.maxX) continue; }
      else {
        let t1 = (b.minX - ox) / dx, t2 = (b.maxX - ox) / dx;
        if (t1 > t2) [t1, t2] = [t2, t1];
        tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
        if (tmin > tmax) continue;
      }
      // Y slab
      if (Math.abs(dy) < 1e-9) { if (oy < b.y0 || oy > b.top) continue; }
      else {
        let t1 = (b.y0 - oy) / dy, t2 = (b.top - oy) / dy;
        if (t1 > t2) [t1, t2] = [t2, t1];
        tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
        if (tmin > tmax) continue;
      }
      // Z slab
      if (Math.abs(dz) < 1e-9) { if (oz < b.minZ || oz > b.maxZ) continue; }
      else {
        let t1 = (b.minZ - oz) / dz, t2 = (b.maxZ - oz) / dz;
        if (t1 > t2) [t1, t2] = [t2, t1];
        tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
        if (tmin > tmax) continue;
      }
      if (tmin < best) best = tmin;
    }
    // ground plane
    if (dy < -1e-9) {
      const tg = -oy / dy;
      if (tg > 0 && tg < best) best = tg;
    }
    return best;
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
    };
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

    // tracer material (lines share it)
    this.tracerMat = new THREE.LineBasicMaterial({ color: 0xffb3a6, transparent: true, opacity: 0.7 });
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
    this.$("reload-fill").style.width = (t * 100).toFixed(0) + "%";
  }

  spawnTracer(from, to) {
    const geo = new THREE.BufferGeometry().setFromPoints([from.clone(), to.clone()]);
    const line = new THREE.Line(geo, this.tracerMat);
    this.scene.add(line);
    this.tracers.push({ line, t: 0.06 });
  }

  /* ---------- input ---------- */
  setupInput() {
    this.keys = {};
    this.stick = { active: false, id: -1, ox: 0, oy: 0, x: 0, y: 0 };
    this.look = { id: -1, lx: 0, ly: 0 };
    this.firing = false;
    this.pointerLocked = false;

    const kd = e => {
      if (e.repeat) return;
      this.keys[e.code] = true;
      if (e.code === "KeyR") this.startReload();
      if (e.code === "Space") { e.preventDefault(); this.doVault(); }
    };
    const ku = e => { this.keys[e.code] = false; };
    this.bind(window, "keydown", kd);
    this.bind(window, "keyup", ku);

    // desktop: pointer lock look + click fire
    this.bind(this.canvas, "mousedown", e => {
      if (this.paused || this.over || !this.player.alive) return;
      if (!this.pointerLocked) { this.canvas.requestPointerLock?.(); return; }
      if (e.button === 0) this.firing = true;
    });
    this.bind(window, "mouseup", () => { this.firing = this.fireBtnHeld || false; });
    this.bind(document, "pointerlockchange", () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
    });
    this.bind(window, "mousemove", e => {
      if (!this.pointerLocked || this.paused) return;
      this.player.yaw -= e.movementX * 0.0023;
      this.player.pitch -= e.movementY * 0.0023;
      this.clampPitch();
    });

    // touch: left = move stick, right = look. The HUD layer is
    // pointer-events:none, so free touches land on the stage; touches that
    // start on HUD buttons are skipped here and handled by the buttons.
    const surface = this.$("stage");
    this.bind(surface, "touchstart", e => {
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
          this.player.yaw -= (t.clientX - this.look.lx) * 0.0052;
          this.player.pitch -= (t.clientY - this.look.ly) * 0.0052;
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
      }
    };
    this.bind(surface, "touchend", touchEnd);
    this.bind(surface, "touchcancel", touchEnd);

    // buttons
    const fireBtn = this.$("btn-fire");
    const fstart = e => { e.preventDefault(); this.sfx.ensure(); this.fireBtnHeld = true; this.firing = true; };
    const fend = e => { e.preventDefault(); this.fireBtnHeld = false; if (!this.pointerLocked) this.firing = false; };
    this.bind(fireBtn, "touchstart", fstart, { passive: false });
    this.bind(fireBtn, "touchend", fend, { passive: false });
    this.bind(fireBtn, "mousedown", fstart);
    this.bind(fireBtn, "mouseup", fend);
    this.bind(this.$("btn-reload"), "click", () => this.startReload());
    this.bind(this.$("btn-vault"), "click", () => this.doVault());

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
    this.setPrompt("HOLD LEFT EDGE TO SLIDE");
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
    const v = this.$("dmg-vignette");
    v.style.opacity = Math.min(1, 0.35 + (100 - p.hp) / 120);
    clearTimeout(this._vt);
    this._vt = setTimeout(() => { v.style.opacity = p.hp < 35 ? 0.4 : 0; }, 220);
    if (p.hp <= 0) this.playerDie(attacker);
  }

  playerDie(killer) {
    const p = this.player;
    p.alive = false;
    p.deaths++;
    p.respawnT = 3.2;
    p.reloading = 0;
    this.$("reload-ring").style.display = "none";
    this.firing = false;
    this.score[1]++;
    if (killer) killer.kills = (killer.kills || 0) + 1;
    this.addFeed(killer ? killer.name : "RAVENGLASS", p.name, false);
    this.setPrompt("REDEPLOYING · STAND BY");
    this.$("dmg-vignette").style.opacity = 0.85;
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
    if (!p.alive || p.reloading > 0 || p.ammo >= L.mag || p.reserve <= 0) return;
    p.reloading = L.reloadTime;
    this._rlPhase = -1;
    this.moveLabel = "RELOADING";
    this.setPrompt(`MAG SWAP · ${L.reloadTime.toFixed(1)}s`);
    this.$("reload-fill").style.width = "0%";
    this.$("reload-ring").style.display = "flex";
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
      p.vaultT = 0.36;
      p.vaultFrom = p.pos.clone();
      p.vaultTo = new THREE.Vector3(
        Math.max(ledge.minX + 0.5, Math.min(ledge.maxX - 0.5, px)),
        ledge.top,
        Math.max(ledge.minZ + 0.5, Math.min(ledge.maxZ - 0.5, pz))
      );
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
    if (p.shotT > 0) return;
    if (p.ammo <= 0) { this.startReload(); return; }
    if (!L.auto && this._semiHeld) return;
    this._semiHeld = true;

    p.shotT = 60 / L.rpm;
    p.ammo--;
    this.sfx.fire();
    this.vmKick = 1;
    this.moveLabel = "FIRING";

    // spread grows with movement
    const spread = (L.spreadDeg + (p.speedVal > 0.5 ? L.moveSpreadDeg : 0)) * Math.PI / 180;
    const yawOff = (Math.random() - 0.5) * spread;
    const pitchOff = (Math.random() - 0.5) * spread;
    const yaw = p.yaw + yawOff, pitch = p.pitch + pitchOff;
    const dx = -Math.sin(yaw) * Math.cos(pitch);
    const dy = Math.sin(pitch);
    const dz = -Math.cos(yaw) * Math.cos(pitch);
    const ox = p.pos.x, oy = p.pos.y + EYE, oz = p.pos.z;

    const wallT = this.rayWorldDist(ox, oy, oz, dx, dy, dz, 200);

    // ray vs bot capsules (vertical segment + radius)
    let hitBot = null, hitT = Infinity, headshot = false;
    for (const b of this.bots) {
      if (!b.alive || b.team === 0) continue;
      // closest approach of ray to vertical segment at (b.x,z), y in [y, y+1.8]
      const cx = b.pos.x - ox, cz = b.pos.z - oz;
      const tFlat = (cx * dx + cz * dz) / (dx * dx + dz * dz + 1e-9);
      if (tFlat < 0 || tFlat > Math.min(wallT, 200)) continue;
      const hx = ox + dx * tFlat, hz = oz + dz * tFlat;
      const distSq = (hx - b.pos.x) ** 2 + (hz - b.pos.z) ** 2;
      if (distSq > 0.42 * 0.42) continue;
      const hy = oy + dy * tFlat;
      if (hy < b.pos.y || hy > b.pos.y + 1.86) continue;
      if (tFlat < hitT) { hitT = tFlat; hitBot = b; headshot = hy > b.pos.y + 1.5; }
    }

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
      let dmg = L.damage * (headshot ? L.headshotMult : 1);
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
      if (!killed) this.setPrompt(`TARGET · ${Math.round(dist)}m · ${headshot ? "HEADSHOT" : "CENTER MASS"}`);
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
        this.$("dmg-vignette").style.opacity = 0;
        this.setPrompt("HOLD LEFT EDGE TO SLIDE");
        this.moveLabel = "SPRINT";
      }
    }

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
        const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
        const wx = (-sin * -mz) + (cos * mx);
        const wz = (-cos * -mz) + (-sin * mx);
        const speed = L.moveSpeed;
        this.moveEntity(p, wx * speed * dt, wz * speed * dt);
        p.speedVal = mlen * speed;
        if (p.reloading <= 0 && p.vaultT <= 0 && !this.firing && p.grounded) {
          this.moveLabel = mlen > 0.05 ? (mlen > 0.75 ? "SPRINT" : "MOVE") : "HOLD";
        }

        // gravity / ground
        const ground = this.groundHeight(p.pos.x, p.pos.z, p.radius, p.pos.y);
        p.vy -= GRAVITY * dt;
        p.pos.y += p.vy * dt;
        if (p.pos.y <= ground) { p.pos.y = ground; p.vy = 0; p.grounded = true; }
        else if (p.pos.y > ground + 0.05) p.grounded = false;
      }

      // reload
      if (p.reloading > 0) {
        p.reloading -= dt;
        if (p.reloading <= 0) {
          const need = L.mag - p.ammo;
          const take = Math.min(need, p.reserve);
          p.ammo += take; p.reserve -= take;
          this.$("reload-ring").style.display = "none";
          this.moveLabel = "SPRINT";
          this.setPrompt("HOLD LEFT EDGE TO SLIDE");
        }
      }

      // fire
      p.shotT -= dt;
      if (this.firing) this.tryFire();
      else this._semiHeld = false;

      // hp regen after 4s
      if (p.hp < 100 && this.timeSinceHurt() > 4) {
        p.hp = Math.min(100, p.hp + 14 * dt);
        if (p.hp > 35) this.$("dmg-vignette").style.opacity = 0;
      }
    }

    // ---- bots ----
    for (const b of this.bots) {
      b.update(dt, this.botCtx);
      if (b.mesh) {
        b.mesh.position.copy(b.pos);
        b.mesh.rotation.y = b.yaw;
      }
    }

    // ---- tracers ----
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.t -= dt;
      if (t.t <= 0) {
        this.scene.remove(t.line);
        t.line.geometry.dispose();
        this.tracers.splice(i, 1);
      }
    }

    // ---- camera ----
    this.camera.position.set(p.pos.x, p.pos.y + EYE, p.pos.z);
    this.camera.rotation.order = "YXZ";
    this.camera.rotation.y = p.yaw;
    this.camera.rotation.x = p.pitch;
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
    this.vmKick = Math.max(0, this.vmKick - dt * 9);
    vm.position.z += this.vmKick * 0.06;
    vm.rotation.x += this.vmKick * 0.05;

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
    if (v) { this.firing = false; document.exitPointerLock?.(); }
    else this.last = performance.now();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    for (const [el, ev, fn, opts] of this._bound) el.removeEventListener(ev, fn, opts);
    this._bound = [];
    window.removeEventListener("resize", this._onResize);
    document.exitPointerLock?.();
    this.scene.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
    });
    this.renderer.dispose();
  }
}
