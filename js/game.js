// ECHELON — client runtime: rendering, input, HUD, audio.
//
// All simulation lives in js/sim/ and is shared verbatim with the server. This
// file owns nothing authoritative: it collects input into a command, steps the
// sim on a fixed timestep, and draws whatever came out. Everything here is
// presentation, which is why none of it needs to exist on the Pi.
import * as THREE from "three";
import { Sim, FIXED_DT, makeInput } from "./sim/index.js";
import { ARENA, SPRINT_OUT } from "./sim/world.js";
import { timeSinceHurt } from "./sim/player.js";
import { MATCH } from "./data.js";

const DARK = { bg: 0x151312, surface: 0x211f1e, text: 0xf3f2f2, red: 0xff563c };

// Beyond this many sim steps in one frame, drop the backlog rather than trying
// to catch up — chasing it makes the next frame later still (the spiral).
const MAX_STEPS = 5;

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
    this.accum = 0;
    this.tracers = [];
    this.botMeshes = new Map();   // bot id -> THREE.Group (render state, not sim state)
    this._bound = [];
    this.$ = id => document.getElementById(id);
  }

  /* ---------- setup ---------- */
  start() {
    this.setupScene();

    // The simulation. Map seed is fixed so the dockyard is the designed one;
    // the match seed varies so bot rosters and spawns differ between rounds.
    this.sim = new Sim({ seed: 1337, matchSeed: (Math.random() * 0x7fffffff) | 0 });
    this.player = this.sim.addPlayer({ name: "VIPER-04", team: 0, loadout: this.loadout });
    this.sim.fillBots(6);

    this.buildStaticMeshes(this.sim.world.specs);
    this.buildGround();
    this.setupBotMeshes();
    this.setupViewmodel();
    this.setupInput();
    this.setupHud();

    this.last = performance.now();
    this.fpsFrames = 0; this.fpsT = 0;
    window.__game = this; // debug/QA handle

    const loop = (now) => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      const rawDt = (now - this.last) / 1000;
      this.last = now;

      // fps readout (status strip) — counts real rAF cadence, updates 2x/s
      this.fpsFrames++; this.fpsT += rawDt;
      if (this.fpsT >= 0.5) {
        this.$("fps").textContent = Math.round(this.fpsFrames / this.fpsT) + " FPS";
        this.fpsFrames = 0; this.fpsT = 0;
      }

      const running = !this.paused && !this.over;
      if (running) {
        /* Fixed timestep. The sim previously advanced by whatever rAF delta
           arrived, which made the physics frame-rate dependent and impossible
           to replay — both fatal for prediction and reconciliation. */
        this.syncInput();
        this.accum += Math.min(rawDt, 0.25);
        let steps = 0;
        while (this.accum >= FIXED_DT && steps < MAX_STEPS) {
          this.stepSim(FIXED_DT);
          this.accum -= FIXED_DT;
          steps++;
        }
        if (steps === MAX_STEPS) this.accum = 0;
        this.adaptResolution(rawDt);
      }
      this.present(running ? rawDt : 0);
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

  // adaptive resolution: if the phone can't hold frame time, step the pixel
  // ratio down (and back up when there's headroom)
  adaptResolution(rawDt) {
    this.perfAccum += rawDt; this.perfFrames++;
    // 0.004 guard: ignore implausible sub-4ms deltas (rAF never legitimately
    // paces above 250 Hz)
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
    // missing >~40% of vsyncs -> downscale; comfortably hitting them -> restore
    if (avg > floor * 1.7 && this.perfLevel < 2) this.perfLevel++;
    else if (avg < floor * 1.25 && this.perfLevel > 0) this.perfLevel--;
    const target = this.basePixelRatio * scales[this.perfLevel];
    if (Math.abs(this.renderer.getPixelRatio() - target) > 0.01) {
      this.renderer.setPixelRatio(target);
      this.resize();
    }
  }

  /* ---------- world rendering ----------
     The sim hands over draw specs generated by the same addBox calls that made
     the collision AABBs, so geometry and collision cannot disagree. */
  buildGround() {
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
  }

  // One InstancedMesh per colour, which is what keeps the draw-call count flat.
  buildStaticMeshes(specs) {
    const byColor = new Map();
    for (const s of specs) {
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
  }

  setupBotMeshes() {
    for (const b of this.sim.bots) this.botMeshes.set(b.id, this.makeBotMesh(b.team));
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

  /* ---------- input ----------
     Handlers write into a single input command rather than mutating the player,
     which is exactly the packet a networked client will send. Look angles stay
     client-owned (recoil included) and are reported as absolutes. */
  setupInput() {
    this.keys = {};
    this.stick = { id: -1, ox: 0, oy: 0, x: 0, y: 0, mag: 0 };
    this.look = { id: -1, lx: 0, ly: 0 };
    this.fireLookId = -1;
    this.firing = false;
    this.pointerLocked = false;
    this.lookScale = 1;    // sensitivity follows fov while aiming

    this.input = makeInput();
    this.input.yaw = this.player.yaw;
    this.input.pitch = this.player.pitch;
    this.inputs = new Map([[this.player.name, this.input]]);

    const kd = e => {
      if (e.repeat) return;
      this.keys[e.code] = true;
      if (e.code === "KeyR") this.input.actions.reload = true;
      if (e.code === "Space") { e.preventDefault(); this.input.actions.vault = true; }
      if (e.code === "KeyC") this.input.actions.toggleCrouch = true;
    };
    const ku = e => { this.keys[e.code] = false; };
    this.bind(window, "keydown", kd);
    this.bind(window, "keyup", ku);
    // any focus loss drops every held input — a key/touch released off-window
    // would otherwise stay latched and leave the player running or firing
    this.bind(window, "blur", () => this.resetInput());

    /* ---- Pointer Events, one independent stream per finger ----
       `click` is single-pointer and the browser suppresses it entirely once
       preventDefault() runs on another active touch, which is why only one
       control could be used at a time. Every control below reacts to
       pointerdown and tracks its own pointerId, so move + look + fire +
       reload + crouch all work simultaneously — the standard mobile-shooter
       input model. */
    this.bind(this.canvas, "contextmenu", e => e.preventDefault());
    this.bind(document, "pointerlockchange", () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
    });

    // FIRE: momentary, and the same finger also aims (drag off the button)
    this.bindHold("btn-fire", {
      down: e => {
        this.sfx.ensure();
        this.firing = true;
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
    // ADS toggles: tap to enter the sights, tap again to drop back to hip.
    // A hold would occupy a thumb you need for the trigger.
    this.bindPress("btn-ads", () => { this.input.actions.toggleAds = true; });
    this.bindPress("btn-reload", () => { this.input.actions.reload = true; });
    this.bindPress("btn-vault", () => { this.input.actions.vault = true; });
    this.bindPress("btn-crouch", () => { this.input.actions.toggleCrouch = true; });

    // stage: free pointers drive the move stick (left) and the look camera
    const stage = this.$("stage");
    this.bind(stage, "pointerdown", e => {
      if (e.target?.closest?.("button")) return;   // buttons own their pointers
      if (this.paused || this.over) return;
      e.preventDefault();
      if (e.pointerType === "mouse") {
        if (!this.pointerLocked) { this.canvas.requestPointerLock?.(); return; }
        if (e.button === 0) this.firing = true;
        if (e.button === 2) this.requestAds(true);
        return;
      }
      if (e.clientX < window.innerWidth * 0.42 && this.stick.id === -1) {
        this.stick.id = e.pointerId;
        this.stick.ox = e.clientX; this.stick.oy = e.clientY;
        this.stick.x = 0; this.stick.y = 0; this.stick.mag = 0;
      } else if (this.look.id === -1 || this.look.id === this.fireLookId) {
        // a deliberate drag takes the camera over from the fire button's
        // finger, so aiming works whether you drag off FIRE or use a second
        // finger while holding it
        this.fireLookId = -1;
        this.look.id = e.pointerId;
        this.look.lx = e.clientX; this.look.ly = e.clientY;
      }
    });

    this.bind(stage, "pointermove", e => {
      if (e.pointerType === "mouse") {
        if (!this.pointerLocked || this.paused) return;
        this.addLook(-e.movementX * 0.0023, -e.movementY * 0.0023);
        return;
      }
      if (e.pointerId === this.stick.id) {
        const dx = e.clientX - this.stick.ox, dy = e.clientY - this.stick.oy;
        const m = Math.hypot(dx, dy), cap = 52;
        const k = m > cap ? cap / m : 1;
        this.stick.x = (dx * k) / cap;
        this.stick.y = (dy * k) / cap;
        this.stick.mag = m / cap;         // uncapped: >1 means pushed past the ring
      } else if (e.pointerId === this.look.id) {
        this.addLook(
          -(e.clientX - this.look.lx) * 0.0052,
          -(e.clientY - this.look.ly) * 0.0052
        );
        this.look.lx = e.clientX; this.look.ly = e.clientY;
      }
    });

    const release = e => {
      if (e.pointerType === "mouse") {
        if (e.button === 2) this.requestAds(false);
        this.firing = false;
        return;
      }
      if (e.pointerId === this.stick.id) {
        this.stick.id = -1; this.stick.x = 0; this.stick.y = 0; this.stick.mag = 0;
      }
      if (e.pointerId === this.look.id) this.look.id = -1;
    };
    this.bind(stage, "pointerup", release);
    this.bind(stage, "pointercancel", release);
    this.bind(window, "pointerup", release);

    // mobile: tabbing away / locking the screen pauses the match
    this.bind(document, "visibilitychange", () => {
      if (document.hidden && !this.paused && !this.over) {
        this.setPaused(true);
        this.$("overlay-pause").classList.add("active");
      }
    });
  }

  // Look is accumulated on the command, scaled by the current fov so aiming
  // through a scope stays steady.
  addLook(dYaw, dPitch) {
    this.input.yaw += dYaw * this.lookScale;
    this.input.pitch = Math.max(-1.35, Math.min(1.35, this.input.pitch + dPitch * this.lookScale));
  }

  /* The right mouse button is a hold while the on-screen button is a toggle.
     The sim only understands a toggle — deliberately, since sprinting cancels
     ADS and an absolute "still aiming" flag would immediately re-enable it. So
     a hold is expressed as a toggle requested only when the state disagrees. */
  requestAds(want) {
    if (want !== this.player.adsOn) this.input.actions.toggleAds = true;
  }

  /* A momentary control: fires `down` on press and `up` on release, tracking
     exactly one pointerId. Pointer capture keeps the release bound to this
     element even if the finger slides off, so the control can never latch. */
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

  // A one-shot control: acts immediately on press, no release semantics.
  bindPress(id, fn) {
    const el = this.$(id);
    this.bind(el, "pointerdown", e => {
      if (this.paused || this.over) return;
      e.preventDefault();
      e.stopPropagation();
      el.classList.add("held");
      setTimeout(() => el.classList.remove("held"), 110);
      fn(e);
    });
  }

  bind(el, ev, fn, opts) {
    el.addEventListener(ev, fn, opts);
    this._bound.push([el, ev, fn, opts]);
  }

  // Fold continuous input state into the command, once per frame.
  syncInput() {
    let mx = 0, mz = 0;
    if (this.keys["KeyW"]) mz -= 1;
    if (this.keys["KeyS"]) mz += 1;
    if (this.keys["KeyA"]) mx -= 1;
    if (this.keys["KeyD"]) mx += 1;
    mx += this.stick.x; mz += this.stick.y;
    const i = this.input;
    i.moveX = mx; i.moveZ = mz;
    i.stickMag = this.stick.mag;
    i.stickY = this.stick.y;
    i.stickActive = this.stick.id !== -1;
    i.sprintKey = !!(this.keys["ShiftLeft"] || this.keys["ShiftRight"]);
    i.firing = this.firing;
  }

  resetInput() {
    this.keys = {};
    this.stick.id = -1; this.stick.x = 0; this.stick.y = 0; this.stick.mag = 0;
    this.look.id = -1;
    this.fireLookId = -1;
    this.firing = false;
    const i = this.input;
    i.moveX = 0; i.moveZ = 0; i.stickMag = 0; i.stickActive = false;
    i.sprintKey = false; i.firing = false;
    for (const id of ["btn-fire", "btn-ads", "btn-reload", "btn-vault", "btn-crouch"]) {
      this.$(id).classList.remove("held");
    }
  }

  /* ---------- sim driving ---------- */
  stepSim(dt) {
    const events = this.sim.step(dt, this.inputs);
    for (const ev of events) this.handleEvent(ev);
    if (this.sim.match.over && !this.over) this.endMatch();
  }

  // Everything audible or visible about what the sim just did.
  handleEvent(ev) {
    const p = this.player;
    switch (ev.type) {
      case "fire": {
        this.sfx.fire();
        this.vmKick = 1;
        // recoil is client-side: it moves this player's own aim, and the
        // resulting absolute angle is what gets reported back
        const L = this.loadout;
        this.input.pitch += L.recoilKick * (0.7 + Math.random() * 0.5) * Math.PI / 180;
        this.input.yaw += (Math.random() - 0.5) * L.recoilKick * 0.35 * Math.PI / 180;
        this.input.pitch = Math.max(-1.35, Math.min(1.35, this.input.pitch));

        const mz = this.$("muzzle");
        mz.classList.remove("show"); void mz.offsetWidth; mz.classList.add("show");
        this.vmFlash.visible = true;
        clearTimeout(this._mf);
        this._mf = setTimeout(() => { this.vmFlash.visible = false; }, 45);
        const hudEl = this.$("hud");
        hudEl.classList.remove("kick"); void hudEl.offsetWidth; hudEl.classList.add("kick");

        if (ev.hit) {
          this.sfx.hit();
          const hm = this.$("hitmarker");
          hm.classList.remove("show", "head"); void hm.offsetWidth;
          hm.classList.add("show");
          if (ev.hit.part === "HEAD") hm.classList.add("head");
          if (!ev.hit.killed) {
            this.setPrompt(`TARGET · ${Math.round(ev.hit.dist)}m · ${ev.hit.part}`);
          }
        }
        break;
      }
      case "bot-shot": {
        const dist = ev.bot.pos.distanceTo(p.pos);
        if (dist < 60) this.sfx.enemyFire(dist);
        ev.bot.eyePos(_a);
        if (ev.target.isPlayer) { _b.copy(ev.target.pos); _b.y += 1.2; }
        else ev.target.chestPos(_b);
        if (!ev.hit) {
          _b.x += (Math.random() - 0.5) * 2.4;
          _b.y += (Math.random() - 0.2) * 1.4;
          _b.z += (Math.random() - 0.5) * 2.4;
        }
        this.spawnTracer(_a, _b);
        break;
      }
      case "hurt":
        if (ev.victim === p) this.sfx.hurt();
        break;
      case "death": {
        const victim = ev.victim, killer = ev.killer;
        const mesh = this.botMeshes.get(victim.id);
        if (mesh) mesh.visible = false;
        this.addFeed(killer ? killer.name : "RAVENGLASS", victim.name,
          killer ? killer.team === 0 : victim.team === 1);
        if (victim === p) {
          this.$("reload-ring").style.display = "none";
          this.firing = false;
          this.setPrompt("REDEPLOYING · STAND BY");
        } else if (killer === p) {
          this.sfx.kill();
          this.setPrompt(`ELIMINATED ${victim.name} · +100`);
        }
        break;
      }
      case "respawn": {
        const mesh = this.botMeshes.get(ev.ent.id);
        if (mesh) mesh.visible = true;
        if (ev.ent === p) { this.setPrompt(""); this.$("reload-ring").style.display = "none"; }
        break;
      }
      case "reload-start":
        this._rlPhase = -1;
        this.setPrompt(`MAG SWAP · ${ev.time.toFixed(1)}s`);
        this.$("reload-fill").style.width = "0%";
        this.$("reload-cuff").style.width = "0%";
        this.$("reload-ring").style.display = "flex";
        break;
      case "reload-complete":
        this.$("reload-ring").style.display = "none";
        this.$("reload-cuff").style.width = "0%";
        this.setPrompt("");
        break;
      case "crouch-blocked":
        this.setPrompt("NO HEADROOM · STAY LOW");
        break;
      case "vault-attempt":
        this.sfx.vault();
        break;
      case "vault-mantle":
        this.setPrompt("PARKOUR CHAIN ×2 · +4 TEMPO");
        break;
      default:
        break;
    }
  }

  endMatch() {
    this.over = true;
    const m = this.sim.match;
    const rows = m.scoreboard();
    setTimeout(() => this.onEnd({
      won: m.score[0] > m.score[1],
      ally: m.score[0], enemy: m.score[1], rows,
    }), 900);
  }

  /* ---------- presentation ---------- */
  present(dt) {
    const p = this.player, L = this.loadout;

    // bot transforms
    for (const b of this.sim.bots) {
      const mesh = this.botMeshes.get(b.id);
      if (!mesh) continue;
      mesh.position.set(b.pos.x, b.pos.y, b.pos.z);
      mesh.rotation.y = b.yaw;
    }

    this.updateTracers(dt);

    // ---- camera ----
    this.camera.position.set(p.pos.x, p.pos.y + p.eyeH, p.pos.z);
    this.camera.rotation.order = "YXZ";
    this.camera.rotation.y = p.yaw;
    this.camera.rotation.x = p.pitch;
    // ADS fov zoom; look sensitivity tracks the zoom so aiming feels stable
    const fov = 74 / (1 + (L.adsZoom - 1) * p.ads);
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
      this.animateReload(1 - p.reloading / L.reloadTime);
    } else {
      this._rlPhase = -1;
    }

    // sprint pose: weapon canted down and across, with a two-step run bob.
    // sprintBlend also covers the raise back to centre via sprintOutT.
    const wantSprint = (p.sprinting && p.alive) ? 1
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
    vm.position.x = -0.26 * p.ads;
    vm.position.y += 0.055 * p.ads;
    vm.position.z += 0.1 * p.ads;
    vm.visible = !(L.scope && p.ads > 0.9);

    this.updateHud(dt);
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

  /* The movement readout used to be assigned from a dozen scattered places,
     which meant it could linger on a stale value. Deriving it from state each
     frame is both shorter and always correct. */
  moveLabel() {
    const p = this.player, L = this.loadout;
    if (!p.alive) return "DOWN";
    if (p.reloading > 0) return "RELOADING";
    if (p.vaultT > 0) return "VAULT · MANTLE";
    if (!p.grounded) return "AIRBORNE";
    if (this.firing) return "FIRING";
    if (p.sprinting) return "SPRINT";
    if (p.crouching) return "CROUCH";
    if (p.ads > 0.6) return L.scope ? "SCOPED" : "ADS";
    return p.speedVal > 0.05 ? "MOVE" : "HOLD";
  }

  updateHud(dt) {
    const p = this.player, L = this.loadout, m = this.sim.match;
    this.hudSet("ammo", `${p.ammo}<span> / ${p.reserve}</span>`,
      v => { this.$("ammo-count").innerHTML = v; });
    this.hudSet("armor", Math.max(0, Math.round(p.hp)),
      v => { this.$("armor-fill").style.width = v + "%"; });
    this.hudSet("move", this.moveLabel(),
      v => { this.$("move-state").textContent = v; });
    this.hudSet("scoreA", m.score[0], v => { this.$("score-ally").textContent = v; });
    this.hudSet("scoreB", m.score[1], v => { this.$("score-enemy").textContent = v; });
    const t = Math.max(0, Math.ceil(m.time));
    this.hudSet("clock", `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`,
      v => { this.$("hud-clock").textContent = v; });
    this.hudSet("joy", `${Math.round(this.stick.x * 30)},${Math.round(this.stick.y * 30)}`, () => {
      this.$("joy-knob").style.transform =
        `translate(calc(-50% + ${Math.round(this.stick.x * 30)}px), calc(-50% + ${Math.round(this.stick.y * 30)}px))`;
    });

    // ADS visuals: crosshair tightens (hides behind a scope), overlay at full zoom
    this.hudSet("ch", Math.round(p.ads * 24), () => {
      const ch = this.$("crosshair");
      ch.style.opacity = (L.scope && p.ads > 0.6) ? 0 : 1;
      ch.style.transform = `translate(-50%,-50%) scale(${(1 - 0.4 * p.ads).toFixed(3)})`;
    });
    this.hudSet("scope", L.scope && p.ads > 0.92,
      v => { this.$("scope-overlay").style.display = v ? "block" : "none"; });
    // vignette is derived from state every frame, never from a timer that a
    // respawn or a forced heal could outlive
    const hurtAge = timeSinceHurt(p, m.time);
    const vig = !p.alive ? 0.85
      : hurtAge < 0.25 ? Math.min(1, 0.35 + (100 - p.hp) / 120)
      : p.hp < 35 ? 0.4
      : 0;
    this.hudSet("vig", vig.toFixed(2), v => { this.$("dmg-vignette").style.opacity = v; });
    this.hudSet("sprintRing", p.sprinting,
      v => this.$("joy-zone").classList.toggle("sprint", v));
    this.hudSet("crouchBtn", p.crouching,
      v => this.$("btn-crouch").classList.toggle("on", v));
    this.hudSet("adsBtnHeld", p.adsOn,
      v => this.$("btn-ads").classList.toggle("on", v));

    // compass: strip spans are 55px per 45°
    const yawDeg = ((-p.yaw * 180 / Math.PI) % 360 + 360) % 360;
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
    for (const b of this.sim.bots) {
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
      this.resetInput();       // nothing may stay held across a pause
      document.exitPointerLock?.();
    } else {
      this.last = performance.now();
      this.accum = 0;          // don't replay the paused interval
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
