// ECHELON — app shell: boot sequence, lobby, armory, settings, match flow.
import {
  LOG, DEPLOY_LOG, PARTS, PHASES, DEPLOY_PHASES,
  WEAPONS, ATTS, STAT_NAMES, statsFor, buildLoadout, MATCH,
} from "./data.js";
import { Game } from "./game.js";
import {
  settings, saveSettings, resetSettings, resetLayout,
  applyHud, applyLayout, captureLayout, HUD_ELEMENTS,
} from "./settings.js";
import { describeWeapon, sideViewSvg, attKeys } from "./weapons3d.js";

const BUILD = "5.2.0";
const $ = id => document.getElementById(id);
const state = { screen: "boot", game: null, bootDone: null };

const curWeapon = () => settings.loadout.weapon;
const curAtts = () => settings.loadout.atts[curWeapon()];

/* ---------------- screen switching ---------------- */
function showScreen(name) {
  state.screen = name;
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  $("hud").classList.remove("active");
  if (name === "hud") $("hud").classList.add("active");
  else $("screen-" + name)?.classList.add("active");
  document.body.classList.toggle("in-match", name === "hud");
}

/* ---------------- boot sequence ---------------- */
let bootTimer = 0;
function runBoot(mode, onDone) {
  clearInterval(bootTimer);
  showScreen("boot");
  const deploy = mode === "deploy";
  const log = deploy ? DEPLOY_LOG : LOG;
  const phases = deploy ? DEPLOY_PHASES : PHASES;
  const viz = $("boot-viz");
  viz.innerHTML = "";
  $("boot-log").innerHTML = "";
  $("boot-footer").textContent = "DO NOT CLOSE THE APP";
  $("boot-caption").textContent = deploy
    ? "TERRAIN MESH · RAVENGLASS DOCKYARD · 2.1km²"
    : "ASSEMBLING VIEWMODEL · " + WEAPONS[curWeapon()].name;

  if (!$("boot-ticks").children.length) {
    for (let i = 0; i < 24; i++) $("boot-ticks").appendChild(document.createElement("div"));
  }

  let cells = [], partEls = [], scanEl = null;
  if (deploy) {
    const grid = document.createElement("div");
    grid.id = "boot-cells";
    for (let i = 0; i < 84; i++) {
      const c = document.createElement("div");
      grid.appendChild(c);
      cells.push(c);
    }
    viz.appendChild(grid);
  } else {
    const wrap = document.createElement("div");
    wrap.id = "boot-parts";
    for (const [label, w] of PARTS) {
      const row = document.createElement("div");
      row.className = "boot-part";
      row.innerHTML = `<div class="blk" style="width:${w}px"></div><div class="accent"></div><div class="lbl">${label}</div>`;
      wrap.appendChild(row);
      partEls.push(row);
    }
    viz.appendChild(wrap);
    scanEl = document.createElement("div");
    scanEl.id = "boot-scan";
    viz.appendChild(scanEl);
  }

  let pct = 0, logN = 0, hold = 0;
  const render = () => {
    $("boot-pct").innerHTML = `${String(pct).padStart(2, "0")}<span>%</span>`;
    $("boot-fill").style.width = pct + "%";
    const phase = phases.filter(p => pct >= p[0]).pop();
    $("boot-phase").textContent = phase ? phase[1] : phases[0][1];
    const targetN = Math.min(log.length, Math.round(pct / 100 * log.length));
    while (logN < targetN) {
      const l = log[logN++];
      const row = document.createElement("div");
      row.className = "logline";
      row.innerHTML = `<span class="code">${l[0]}</span><span class="txt">${l[1]}</span><span class="ms">${l[2]}</span>`;
      $("boot-log").appendChild(row);
      while ($("boot-log").children.length > 7) $("boot-log").firstChild.remove();
    }
    if (deploy) {
      cells.forEach((c, i) => {
        const on = (i * 7 % 84) / 84 * 100 < pct;
        c.style.opacity = on ? 1 : 0.18;
        c.style.background = on && i % 11 === 3 ? "var(--red)" : "transparent";
      });
    } else {
      partEls.forEach((el, i) => el.classList.toggle("on", pct >= PARTS[i][2]));
      if (scanEl) scanEl.style.transform = `translateX(${Math.round(pct / 100 * (viz.clientWidth - 4))}px)`;
    }
  };
  render();

  const finish = () => {
    clearInterval(bootTimer);
    state.bootDone = null;
    onDone();
  };
  state.bootDone = finish;

  bootTimer = setInterval(() => {
    if (hold > 0) { hold--; return; }
    if (pct >= 100) {
      clearInterval(bootTimer);
      $("boot-footer").textContent = deploy ? "DEPLOYING ▸" : "ENTERING LOBBY";
      setTimeout(() => { if (state.bootDone) finish(); }, 420);
      return;
    }
    const next = Math.min(100, pct + 3 + Math.floor(Math.random() * 11));
    const crossed = phases.some(ph => pct < ph[0] && next >= ph[0]);
    pct = next;
    render();
    if (crossed) {
      hold = 3;
      $("boot-pct").classList.add("glitching");
      setTimeout(() => $("boot-pct").classList.remove("glitching"), 160);
    }
  }, 80);
}

// Real device facts instead of invented ping/region numbers.
function fillSystemInfo() {
  let gpu = "WEBGL";
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2") || c.getContext("webgl");
    const dbg = gl?.getExtension("WEBGL_debug_renderer_info");
    const raw = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER);
    if (raw) gpu = String(raw).replace(/\s*\(.*?\)\s*/g, " ").trim().slice(0, 26);
  } catch { /* blocked by privacy settings */ }
  $("sys-gpu").textContent = gpu;
  $("sys-res").textContent = `${window.innerWidth}×${window.innerHeight} @${(window.devicePixelRatio || 1).toFixed(1)}x`;
  $("sys-weapon").textContent = WEAPONS[curWeapon()].name;
  $("sys-build").textContent = BUILD;
}

/* ---------------- weapon schematic ---------------- */
// Cache SVG by weapon + atts + panel size so cycling attachments does not
// rebuild geometry descriptions from scratch every click.
const schematicCache = new Map();
const schemKey = (weaponIdx, atts, w, h, pins) =>
  `${weaponIdx}|${atts.join(",")}|${w}x${h}|${pins ? 1 : 0}`;

// Side elevation of the exact build the player is carrying, with leader lines
// drawn to real part positions rather than hand-placed coordinates.
function weaponSchematic(weaponIdx, atts, { w = 520, h = 260, pins = true } = {}) {
  const key = schemKey(weaponIdx, atts, w, h, pins);
  const hit = schematicCache.get(key);
  if (hit) return hit;

  const spec = describeWeapon(WEAPONS[weaponIdx].model, attKeys(ATTS, atts));
  const gutter = pins ? Math.min(132, Math.max(96, w * 0.16)) : 18;
  const view = sideViewSvg(spec, { w, h, padX: gutter, padY: pins ? 26 : 16 });

  // technical-drawing furniture: a faint grid and a real overall-length
  // dimension taken straight off the model, which is built at life size
  const grid = Array.from({ length: Math.ceil(w / 40) }, (_, i) =>
    `<line x1="${i * 40}" y1="0" x2="${i * 40}" y2="${h}"/>`).join("")
    + Array.from({ length: Math.ceil(h / 40) }, (_, i) =>
      `<line x1="0" y1="${i * 40}" x2="${w}" y2="${i * 40}"/>`).join("");
  let dim = "";
  if (pins) {
    const b = view.bounds;
    const x0 = view.X(b.minU), x1 = view.X(b.maxU);
    const yb = Math.min(h - 30, view.Y(b.minV) + 34);
    const mm = Math.round((b.maxU - b.minU) * 1000);
    dim = `<g stroke="rgba(243,242,242,.3)" stroke-width="1">
      <line x1="${x0.toFixed(1)}" y1="${yb}" x2="${x1.toFixed(1)}" y2="${yb}"/>
      <line x1="${x0.toFixed(1)}" y1="${yb - 5}" x2="${x0.toFixed(1)}" y2="${yb + 5}"/>
      <line x1="${x1.toFixed(1)}" y1="${yb - 5}" x2="${x1.toFixed(1)}" y2="${yb + 5}"/>
    </g>
    <text x="${((x0 + x1) / 2).toFixed(1)}" y="${yb + 17}" text-anchor="middle"
      font-family="Archivo,sans-serif" font-size="9" font-weight="700"
      letter-spacing="1.4" fill="rgba(243,242,242,.42)">OVERALL ${mm} mm</text>`;
  }

  let pinSvg = "";
  if (pins) {
    // Labels live in fixed gutters either side and stack downward, so no
    // callout can ever run off the panel or collide with another.
    const entries = Object.entries(spec.anchors || {})
      .map(([label, [z, y]]) => ({ label, p: view.project(z, y) }))
      .sort((a, b) => a.p[1] - b.p[1]);
    const cols = { L: [], R: [] };
    for (const e of entries) cols[e.p[0] < w / 2 ? "L" : "R"].push(e);
    pinSvg = ["L", "R"].flatMap(side => {
      const right = side === "R";
      const colX = Math.round(right ? w - gutter + 16 : gutter - 16);
      const list = cols[side];
      const top = (h - (list.length - 1) * 24) / 2;
      return list.map((e, i) => {
        const [px, py] = e.p;
        const ly = Math.round(top + i * 24);
        const stub = colX + (right ? 12 : -12);
        return `<g>
          <polyline points="${px.toFixed(1)},${py.toFixed(1)} ${colX},${ly} ${stub},${ly}"
            fill="none" stroke="#ff563c" stroke-width="1.2" opacity=".75"/>
          <rect x="${(px - 3).toFixed(1)}" y="${(py - 3).toFixed(1)}" width="6" height="6" fill="#ff563c"/>
          <text x="${stub + (right ? 5 : -5)}" y="${ly + 3.5}" text-anchor="${right ? "start" : "end"}"
            font-family="Archivo,sans-serif" font-size="9" font-weight="800"
            letter-spacing=".9" fill="#f3f2f2" textLength="${Math.min(gutter - 24, e.label.length * 7.4).toFixed(0)}"
            lengthAdjust="spacingAndGlyphs">${e.label}</text>
        </g>`;
      });
    }).join("");
  }
  const svg = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">
    <g stroke="rgba(243,242,242,.045)" stroke-width="1">${grid}</g>
    <line x1="${gutter - 26}" y1="${h / 2}" x2="${w - gutter + 26}" y2="${h / 2}" stroke="rgba(243,242,242,.10)" stroke-width="1"/>
    ${view.body}${dim}${pinSvg}
  </svg>`;
  if (schematicCache.size > 48) schematicCache.clear();
  schematicCache.set(key, svg);
  return svg;
}

// The viewBox is sized to the panel it lands in, so the weapon fills the
// frame instead of letterboxing inside a fixed 2:1 box.
function schematicInto(el, weaponIdx, atts, pins, { animate = false } = {}) {
  const w = Math.max(260, Math.round(el.clientWidth || 520));
  const h = Math.max(150, Math.round(el.clientHeight || 260));
  el.innerHTML = weaponSchematic(weaponIdx, atts, { w, h, pins });
  if (animate) {
    el.classList.remove("fade");
    void el.offsetWidth;
    el.classList.add("fade");
  }
}

/* ---------------- lobby ---------------- */
const KILL_OPTS = [25, 40, 60];
const TIME_OPTS = [5, 8, 12];
const SKILL_OPTS = ["RECRUIT", "REGULAR", "VETERAN"];

function segbar(el, opts, current, onPick, fmt = v => v) {
  el.innerHTML = "";
  opts.forEach((o, i) => {
    const b = document.createElement("button");
    b.textContent = fmt(o);
    if (i === current) b.classList.add("on");
    b.addEventListener("click", () => { onPick(i, o); });
    el.appendChild(b);
  });
}

function renderLobby() {
  $("lobby-callsign").textContent = settings.callsign;
  const w = WEAPONS[curWeapon()];
  schematicInto($("kit-art"), curWeapon(), curAtts(), false);
  $("kit-name").textContent = w.name;
  $("kit-atts").innerHTML = ATTS.map((a, i) => {
    const oi = curAtts()[i];
    const cls = oi === 0 ? "tag tag-neutral" : "tag tag-outline";
    return `<span class="${cls}">${a.opts[oi][0]}</span>`;
  }).join("");
  $("hero-meta").textContent =
    `6v6 · ${settings.killTarget} KILLS · ${settings.matchMinutes} MIN · ${SKILL_OPTS[settings.botSkill]}`;

  segbar($("seg-kills"), KILL_OPTS, KILL_OPTS.indexOf(settings.killTarget),
    (i, v) => { settings.killTarget = v; saveSettings(); renderLobby(); });
  segbar($("seg-time"), TIME_OPTS, TIME_OPTS.indexOf(settings.matchMinutes),
    (i, v) => { settings.matchMinutes = v; saveSettings(); renderLobby(); }, v => v + " MIN");
  segbar($("seg-skill"), SKILL_OPTS, settings.botSkill,
    i => { settings.botSkill = i; saveSettings(); renderLobby(); });
}

function initLobby() {
  const nav = [["LOBBY", "lobby"], ["ARMORY", "gunsmith"], ["SETTINGS", "settings"]];
  $("lobby-nav").innerHTML = "";
  for (const [label, target] of nav) {
    const b = document.createElement("button");
    b.textContent = label;
    if (target === "lobby") b.classList.add("on");
    b.addEventListener("click", () => goto(target));
    $("lobby-nav").appendChild(b);
  }
  $("btn-play").addEventListener("click", deploy);
  $("lobby-callsign").addEventListener("click", () => {
    const v = prompt("CALLSIGN", settings.callsign);
    if (v && v.trim()) {
      settings.callsign = v.trim().toUpperCase().slice(0, 12);
      saveSettings();
      renderLobby();
    }
  });
}

/* ---------------- armory ---------------- */
let _gsListBuilt = false;
let _gsLastWeapon = -1;

function ensureGunsmithList() {
  const list = $("gs-weapons");
  if (_gsListBuilt && list.children.length === WEAPONS.length) return;
  list.innerHTML = "";
  WEAPONS.forEach((wp, i) => {
    const b = document.createElement("button");
    b.className = "wbtn";
    b.dataset.idx = String(i);
    b.innerHTML = `<div class="cls">${wp.cls}</div><div class="nm">${wp.name}</div><div class="meta">${wp.origin}</div>`;
    b.addEventListener("click", () => {
      if (settings.loadout.weapon === i) return;
      settings.loadout.weapon = i;
      saveSettings();
      renderGunsmith({ weaponChanged: true });
    });
    list.appendChild(b);
  });
  _gsListBuilt = true;
}

function renderGunsmithStats(wi, atts) {
  const st = statsFor(wi, atts);
  $("gs-stats").innerHTML = STAT_NAMES.map((n, i) => {
    const s = st[i];
    const arrow = s.d ? (s.d > 0 ? " ▲" : " ▼") : "";
    const col = s.d > 0 ? "var(--red)" : "var(--text)";
    const fill = s.d ? "var(--red)" : "var(--text)";
    return `<div class="statrow">
      <div class="r1"><span class="sn">${n}</span><span class="sv" style="color:${col}">${s.v}${arrow}</span></div>
      <div class="track"><div class="fill" style="width:${s.v}%;background:${fill}"></div></div>
    </div>`;
  }).join("");
}

function renderGunsmithAtts(atts) {
  const atEl = $("gs-atts");
  if (atEl.children.length !== ATTS.length) {
    atEl.innerHTML = "";
    ATTS.forEach((a, ai) => {
      const b = document.createElement("button");
      b.className = "attbtn";
      b.addEventListener("click", () => {
        const cur = curAtts();
        cur[ai] = (cur[ai] + 1) % a.opts.length;
        saveSettings();
        renderGunsmith({ weaponChanged: false });
      });
      atEl.appendChild(b);
    });
  }
  ATTS.forEach((a, ai) => {
    const oi = atts[ai];
    const b = atEl.children[ai];
    b.className = "attbtn" + (oi !== 0 ? " on" : "");
    b.innerHTML = `<div class="kind">${a.kind}</div><div class="nm">${a.opts[oi][0]}</div>`;
  });
}

function renderGunsmith({ weaponChanged = true } = {}) {
  const wi = curWeapon(), atts = curAtts();
  const w = WEAPONS[wi];
  ensureGunsmithList();

  for (const b of $("gs-weapons").children) {
    b.classList.toggle("sel", Number(b.dataset.idx) === wi);
  }

  $("gs-name").textContent = w.name;
  $("gs-sub").textContent = w.origin;
  $("gs-real").textContent = "ANALOGUE · " + w.real;
  $("gs-note").textContent = w.note;
  schematicInto($("gs-stage"), wi, atts, true, {
    animate: weaponChanged || _gsLastWeapon !== wi,
  });
  renderGunsmithAtts(atts);
  renderGunsmithStats(wi, atts);
  _gsLastWeapon = wi;
}

/* ---------------- settings screen ---------------- */
const SETTINGS_SPEC = [
  {
    group: "DISPLAY", rows: [
      { t: "range", k: "hudScale", label: "HUD SCALE", min: 0.7, max: 1.4, step: 0.02, fmt: v => Math.round(v * 100) + "%" },
      { t: "range", k: "hudAlpha", label: "HUD OPACITY", min: 0.3, max: 1, step: 0.02, fmt: v => Math.round(v * 100) + "%" },
      { t: "range", k: "fov", label: "FIELD OF VIEW", min: 62, max: 100, step: 1, fmt: v => Math.round(v) + "°" },
      { t: "range", k: "shake", label: "CAMERA SHAKE", min: 0, max: 1.6, step: 0.05, fmt: v => Math.round(v * 100) + "%" },
    ],
  },
  {
    group: "CONTROLS", rows: [
      { t: "range", k: "sens", label: "LOOK SENSITIVITY", min: 0.3, max: 2.4, step: 0.05, fmt: v => v.toFixed(2) + "×" },
      { t: "range", k: "adsSens", label: "ADS SENSITIVITY", min: 0.2, max: 1.6, step: 0.05, fmt: v => v.toFixed(2) + "×" },
      { t: "range", k: "aimAssist", label: "AIM ASSIST", min: 0, max: 1, step: 0.05, fmt: v => v === 0 ? "OFF" : Math.round(v * 100) + "%" },
      { t: "toggle", k: "invertY", label: "INVERT LOOK Y" },
      { t: "toggle", k: "southpaw", label: "SOUTHPAW (MIRROR)" },
      { t: "toggle", k: "autoSprint", label: "AUTO SPRINT" },
    ],
  },
  {
    group: "RETICLE", rows: [
      { t: "range", k: "crosshair.size", label: "CROSSHAIR LENGTH", min: 0.5, max: 2, step: 0.05, fmt: v => v.toFixed(2) + "×" },
      { t: "range", k: "crosshair.gap", label: "CROSSHAIR GAP", min: 0, max: 2.5, step: 0.05, fmt: v => v.toFixed(2) + "×" },
      { t: "toggle", k: "crosshair.dot", label: "CENTER DOT" },
    ],
  },
  {
    group: "HUD ELEMENTS", rows: [
      { t: "toggle", k: "show.score", label: "SCORE / CLOCK" },
      { t: "toggle", k: "show.minimap", label: "MINIMAP" },
      { t: "toggle", k: "show.compass", label: "COMPASS" },
      { t: "toggle", k: "show.killfeed", label: "KILL FEED" },
      { t: "toggle", k: "show.ammo", label: "AMMO COUNTER" },
      { t: "toggle", k: "show.vitals", label: "HEALTH / STANCE" },
      { t: "toggle", k: "show.prompt", label: "STATUS LINE" },
      { t: "toggle", k: "show.stanceBtn", label: "STANCE BUTTON" },
      { t: "toggle", k: "show.fps", label: "FPS COUNTER" },
    ],
  },
  {
    group: "AUDIO & FEEDBACK", rows: [
      { t: "range", k: "volume", label: "MASTER VOLUME", min: 0, max: 1, step: 0.02, fmt: v => Math.round(v * 100) + "%" },
      { t: "toggle", k: "wastedSting", label: "DOWNED STING" },
      { t: "toggle", k: "killcam", label: "FINAL KILL CAM" },
    ],
  },
  {
    group: "IDENTITY", rows: [
      { t: "text", k: "callsign", label: "CALLSIGN" },
    ],
  },
];

const getPath = (o, p) => p.split(".").reduce((a, k) => a?.[k], o);
function setPath(o, p, v) {
  const parts = p.split(".");
  const last = parts.pop();
  parts.reduce((a, k) => a[k], o)[last] = v;
}

function renderSettings() {
  const host = $("set-scroll");
  host.innerHTML = "";
  for (const g of SETTINGS_SPEC) {
    const sec = document.createElement("div");
    sec.className = "setgroup";
    sec.innerHTML = `<div class="gh">${g.group}</div>`;
    for (const row of g.rows) {
      if (row.t === "range") {
        const wrap = document.createElement("div");
        wrap.className = "setrow";
        const val = getPath(settings, row.k);
        wrap.innerHTML = `<div class="r1"><span class="nm">${row.label}</span><span class="val">${row.fmt(val)}</span></div>`;
        const input = document.createElement("input");
        input.type = "range";
        input.min = row.min; input.max = row.max; input.step = row.step; input.value = val;
        input.addEventListener("input", () => {
          const v = parseFloat(input.value);
          setPath(settings, row.k, v);
          wrap.querySelector(".val").textContent = row.fmt(v);
          applyHud();
          state.game?.applySettings?.();
        });
        input.addEventListener("change", saveSettings);
        wrap.appendChild(input);
        sec.appendChild(wrap);
      } else if (row.t === "toggle") {
        const b = document.createElement("button");
        b.className = "toggle" + (getPath(settings, row.k) ? " on" : "");
        b.innerHTML = `<span>${row.label}</span><span class="sw"></span>`;
        b.addEventListener("click", () => {
          const v = !getPath(settings, row.k);
          setPath(settings, row.k, v);
          b.classList.toggle("on", v);
          saveSettings();
          applyHud();
          state.game?.applySettings?.();
        });
        sec.appendChild(b);
      } else if (row.t === "text") {
        const wrap = document.createElement("div");
        wrap.className = "setrow";
        wrap.innerHTML = `<div class="r1"><span class="nm">${row.label}</span></div>`;
        const input = document.createElement("input");
        input.id = "set-callsign";
        input.value = settings.callsign;
        input.maxLength = 12;
        input.addEventListener("change", () => {
          settings.callsign = (input.value || "VIPER-04").toUpperCase().slice(0, 12);
          input.value = settings.callsign;
          saveSettings();
        });
        wrap.appendChild(input);
        sec.appendChild(wrap);
      }
    }
    host.appendChild(sec);
  }
}

/* ---------------- HUD layout editor ----------------
   The HUD is plain DOM, so "customizable and resizable" is a drag plus a
   scale factor per control, written straight into the saved layout map. */
const editor = { on: false, sel: null, drag: null, returnTo: "settings" };

function openLayoutEditor(returnTo = "settings") {
  editor.on = true;
  editor.returnTo = returnTo;
  editor.sel = null;
  showScreen("hud");
  document.body.classList.add("layout-edit");
  $("edit-bar").classList.add("active");
  $("edit-sel").textContent = "SELECT A CONTROL";
  $("edit-size").disabled = true;
  // sample content so empty panels are still grabbable
  if (!$("killfeed").children.length) {
    $("killfeed").innerHTML = `<div class="feedrow"><span>${settings.callsign}</span><span class="x">✕</span><span class="b">KOR-11</span></div>`;
  }
  if (!$("compass-strip").children.length) {
    $("compass-strip").innerHTML = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
      .map(s => `<span class="${s.length === 1 ? "card" : ""}">${s}</span>`).join("");
  }
  for (const spec of HUD_ELEMENTS) {
    const el = $(spec.id);
    if (!el) continue;
    el.classList.add("editable");
    el.classList.remove("hud-off");
    el.addEventListener("pointerdown", onEditDown);
  }
}

function closeLayoutEditor() {
  editor.on = false;
  document.body.classList.remove("layout-edit");
  $("edit-bar").classList.remove("active");
  for (const spec of HUD_ELEMENTS) {
    const el = $(spec.id);
    if (!el) continue;
    el.classList.remove("editable", "sel");
    el.removeEventListener("pointerdown", onEditDown);
  }
  applyHud();
  saveSettings();
  goto(editor.returnTo);
}

function selectEditable(id) {
  editor.sel = id;
  for (const spec of HUD_ELEMENTS) $(spec.id)?.classList.toggle("sel", spec.id === id);
  const spec = HUD_ELEMENTS.find(s => s.id === id);
  const e = captureLayout(id);
  $("edit-sel").textContent = spec.label;
  const sl = $("edit-size");
  sl.disabled = false;
  sl.min = spec.min; sl.max = spec.max;
  sl.value = e.s ?? 1;
}

function onEditDown(ev) {
  if (!editor.on) return;
  ev.preventDefault();
  ev.stopPropagation();
  const el = ev.currentTarget;
  selectEditable(el.id);
  const e = captureLayout(el.id);
  const r = el.getBoundingClientRect();
  editor.drag = {
    id: el.id, pointer: ev.pointerId,
    dx: ev.clientX - r.left, dy: ev.clientY - r.top,
    w: r.width, h: r.height,
  };
  try { el.setPointerCapture(ev.pointerId); } catch { /* gone */ }
}

function onEditMove(ev) {
  const d = editor.drag;
  if (!d || ev.pointerId !== d.pointer) return;
  const W = window.innerWidth, H = window.innerHeight;
  const x = Math.max(0, Math.min(W - d.w, ev.clientX - d.dx));
  const y = Math.max(0, Math.min(H - d.h, ev.clientY - d.dy));
  const e = settings.layout[d.id];
  e.x = x / W; e.y = y / H;
  applyLayout();
}

function onEditUp(ev) {
  if (editor.drag && ev.pointerId === editor.drag.pointer) {
    editor.drag = null;
    saveSettings();
  }
}

function initLayoutEditor() {
  window.addEventListener("pointermove", onEditMove);
  window.addEventListener("pointerup", onEditUp);
  window.addEventListener("pointercancel", onEditUp);
  $("edit-size").addEventListener("input", () => {
    if (!editor.sel) return;
    const e = captureLayout(editor.sel);
    e.s = parseFloat($("edit-size").value);
    applyLayout();
  });
  $("edit-size").addEventListener("change", saveSettings);
  $("edit-reset").addEventListener("click", () => {
    resetLayout();
    editor.sel = null;
    $("edit-sel").textContent = "SELECT A CONTROL";
    $("edit-size").disabled = true;
    for (const spec of HUD_ELEMENTS) $(spec.id)?.classList.remove("sel");
  });
  $("edit-done").addEventListener("click", closeLayoutEditor);
}

/* ---------------- navigation ---------------- */
function goto(name) {
  // show first: the schematics size their viewBox off the live panel, which
  // only has a box once the screen is displayed
  showScreen(name);
  if (name === "lobby") renderLobby();
  if (name === "gunsmith") renderGunsmith();
  if (name === "settings") renderSettings();
  if (name === "lobby") {
    document.querySelectorAll("#lobby-nav button").forEach((b, i) => b.classList.toggle("on", i === 0));
  }
}

/* ---------------- match flow ---------------- */
async function goImmersive() {
  try {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    }
  } catch { /* not supported / denied */ }
  try { await screen.orientation?.lock?.("landscape"); } catch { /* desktop */ }
}

function deploy() {
  goImmersive();
  MATCH.killTarget = settings.killTarget;
  MATCH.timeLimit = settings.matchMinutes * 60;
  runBoot("deploy", startMatch);
}

function startMatch() {
  const loadout = buildLoadout(curWeapon(), curAtts());
  showScreen("hud");
  applyHud();
  $("overlay-end").classList.remove("active");
  $("overlay-pause").classList.remove("active");
  if (history.state?.inMatch !== 1) history.pushState({ inMatch: 1 }, "");
  state.game = new Game({
    canvas: $("gl"),
    loadout,
    playerName: settings.callsign,
    skill: settings.botSkill,
    onEnd: showMatchEnd,
  });
  state.game.start();
}

function endGame() {
  if (state.game) { state.game.dispose(); state.game = null; }
}

function showMatchEnd(result) {
  $("overlay-pause").classList.remove("active");
  $("end-verdict").textContent = result.won ? "VICTORY" : "DEFEAT";
  $("end-verdict").style.color = result.won ? "var(--red)" : "var(--text)";
  $("end-title").textContent = "MATCH COMPLETE · RAVENGLASS DOCKYARD";
  $("end-score").textContent = `ALLIES ${result.ally} — ${result.enemy} ENEMY · TARGET ${MATCH.killTarget}`;
  $("score-body").innerHTML = result.rows.map(r => `
    <tr class="${r.me ? "me" : ""}">
      <td>${r.name}${r.me ? " · YOU" : ""}</td>
      <td>${r.team === 0 ? "ALLY" : "ENEMY"}</td>
      <td class="num" style="text-align:right">${r.kills}</td>
      <td class="num" style="text-align:right">${r.deaths}</td>
    </tr>`).join("");
  $("overlay-end").classList.add("active");
}

/* ---------------- overlays ---------------- */
function initOverlays() {
  $("btn-menu").addEventListener("click", () => {
    if (!state.game) return;
    state.game.setPaused(true);
    $("overlay-pause").classList.add("active");
  });
  $("btn-resume").addEventListener("click", () => {
    $("overlay-pause").classList.remove("active");
    goImmersive();
    state.game?.setPaused(false);
  });
  // settings mid-match: the game stays paused underneath and BACK returns to it
  $("btn-settings-match").addEventListener("click", () => {
    $("overlay-pause").classList.remove("active");
    renderSettings();
    showScreen("settings");
  });
  $("set-back").addEventListener("click", () => {
    if (state.game && !state.game.over) {
      showScreen("hud");
      $("overlay-pause").classList.add("active");
    } else {
      goto("lobby");
    }
  });
  $("set-layout").addEventListener("click", () => openLayoutEditor("settings"));
  $("set-reset").addEventListener("click", () => {
    resetSettings();
    renderSettings();
    state.game?.applySettings?.();
  });
  $("btn-abandon").addEventListener("click", () => {
    $("overlay-pause").classList.remove("active");
    endGame();
    goto("lobby");
  });
  $("btn-requeue").addEventListener("click", () => {
    $("overlay-end").classList.remove("active");
    endGame();
    goImmersive();
    runBoot("deploy", startMatch);
  });
  $("btn-tolobby").addEventListener("click", () => {
    $("overlay-end").classList.remove("active");
    endGame();
    goto("lobby");
  });
  $("boot-skip").addEventListener("click", () => { state.bootDone?.(); });

  window.addEventListener("keydown", e => {
    if (e.code === "Escape") {
      if (editor.on) { closeLayoutEditor(); return; }
      if (state.game && !state.game.over) {
        const pauseOpen = $("overlay-pause").classList.contains("active");
        if (pauseOpen) { $("overlay-pause").classList.remove("active"); state.game.setPaused(false); }
        else { state.game.setPaused(true); $("overlay-pause").classList.add("active"); }
      }
    }
  });

  const pauseMatch = () => {
    if (state.game && !state.game.over && !state.game.paused && state.screen === "hud") {
      state.game.setPaused(true);
      $("overlay-pause").classList.add("active");
    }
  };
  window.addEventListener("popstate", () => {
    if (!state.game) return;
    history.pushState({ inMatch: 1 }, "");
    if (state.game.over) {
      $("overlay-end").classList.remove("active");
      endGame();
      goto("lobby");
    } else {
      pauseMatch();
    }
  });
  window.addEventListener("beforeunload", e => {
    if (state.game && !state.game.over) { e.preventDefault(); e.returnValue = ""; }
  });
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement) pauseMatch();
  });
  matchMedia("(orientation: portrait)").addEventListener("change", e => {
    if (e.matches) pauseMatch();
  });
  window.addEventListener("resize", () => { if (editor.on) applyLayout(); });
}

/* ---------------- init ---------------- */
applyHud();
initLobby();
initOverlays();
initLayoutEditor();
$("gs-back").addEventListener("click", () => goto("lobby"));
$("gs-deploy").addEventListener("click", deploy);
fillSystemInfo();

// #lobby / #armory / #settings / #play jump straight to a screen after boot —
// used for QA captures and for deep links back into the app
function afterBoot() {
  const [h, arg] = (location.hash || "").replace("#", "").split(":");
  if (arg !== undefined && WEAPONS[+arg]) settings.loadout.weapon = +arg;
  if (h === "play") { deploy(); return; }
  goto({ armory: "gunsmith", settings: "settings", lobby: "lobby" }[h] || "lobby");
}

runBoot("cold", afterBoot);
