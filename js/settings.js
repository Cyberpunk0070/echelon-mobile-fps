// ECHELON — persistent settings + HUD customization.
//
// Everything the player can tune lives in one object that round-trips through
// localStorage. The HUD is a plain DOM overlay, so "customizable and resizable"
// is implemented as (a) CSS custom properties for the global scale/opacity,
// (b) a per-element {x,y,scale} layout map, and (c) visibility flags. The
// layout editor writes into the same map, so a saved layout is just data.

const KEY = "echelon.settings.v2";

export const DEFAULTS = {
  hudScale: 1,
  hudAlpha: 0.92,
  fov: 78,
  sens: 1,
  adsSens: 0.75,
  invertY: false,
  aimAssist: 0.6,        // 0 = off, 1 = strong rotational assist while aimed
  southpaw: false,       // mirror the two thumb clusters
  autoSprint: false,
  volume: 0.55,
  wastedSting: true,
  killcam: true,
  shake: 1,              // camera shake multiplier
  callsign: "VIPER-04",
  killTarget: 40,
  matchMinutes: 8,
  botSkill: 1,           // 0 recruit · 1 regular · 2 veteran
  show: {
    minimap: true, compass: true, killfeed: true, fps: false,
    prompt: true, ammo: true, vitals: true, score: true, stanceBtn: true,
  },
  crosshair: { size: 1, gap: 1, dot: true },
  layout: {},            // id -> {x,y,s}  (x/y are viewport fractions of top-left)
  // Per-weapon attachment fits, so switching guns in the armory keeps the
  // build you set up for each one.
  loadout: {
    weapon: 0,
    atts: [
      [1, 1, 0, 1, 0, 1],   // KM-7  red dot · compensator · std · vert grip · std · skeleton
      [1, 0, 2, 1, 0, 1],   // VZ-9  red dot · std · CQB · vert grip · std · skeleton
      [1, 1, 0, 0, 0, 0],   // PK-74 red dot · comp · std · none · std · std
      [2, 2, 1, 2, 0, 2],   // LR-13 prism · suppressed · long · bipod · std · heavy
      [2, 0, 1, 2, 0, 2],   // AM-50 prism · brake · long · bipod · std · heavy
    ],
  },
};

/* Controls the layout editor knows about. `label` shows in the editor,
   `min`/`max` bound the per-element scale. */
export const HUD_ELEMENTS = [
  { id: "joy-zone",       label: "MOVE STICK", min: 0.7, max: 1.6 },
  { id: "btn-fire",       label: "FIRE",       min: 0.7, max: 1.7 },
  { id: "btn-ads",        label: "ADS",        min: 0.7, max: 1.6 },
  { id: "btn-reload",     label: "RELOAD",     min: 0.7, max: 1.6 },
  { id: "btn-vault",      label: "JUMP",       min: 0.7, max: 1.6 },
  { id: "btn-stance",     label: "STANCE",     min: 0.7, max: 1.6 },
  { id: "btn-prone",      label: "PRONE",      min: 0.7, max: 1.6 },
  { id: "ammo-block",     label: "AMMO",       min: 0.6, max: 1.6 },
  { id: "hud-vitals",     label: "VITALS",     min: 0.6, max: 1.6 },
  { id: "minimap-wrap",   label: "MINIMAP",    min: 0.6, max: 1.8 },
  { id: "killfeed",       label: "KILL FEED",  min: 0.6, max: 1.5 },
  { id: "hud-meta",       label: "SCORE/CLOCK", min: 0.6, max: 1.5 },
  { id: "compass",        label: "COMPASS",    min: 0.6, max: 1.5 },
];

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(over || {})) {
    const v = over[k];
    if (v && typeof v === "object" && !Array.isArray(v) && typeof base[k] === "object" && base[k]) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return deepMerge(DEFAULTS, {});
    return deepMerge(DEFAULTS, JSON.parse(raw));
  } catch {
    return deepMerge(DEFAULTS, {});
  }
}

export const settings = load();

export function saveSettings() {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* private mode */ }
}

export function resetSettings() {
  const fresh = deepMerge(DEFAULTS, {});
  for (const k of Object.keys(settings)) delete settings[k];
  Object.assign(settings, fresh);
  saveSettings();
  applyHud();
}

export function resetLayout() {
  settings.layout = {};
  saveSettings();
  applyHud();
}

/* ---------------- applying ---------------- */

const $ = id => document.getElementById(id);

// Elements dimmed by the HUD opacity slider. The crosshair, hitmarker and
// damage vignette are deliberately excluded — they are read at a glance and
// must never be faded out by a comfort setting.
const DIMMABLE = [
  "joy-zone", "btn-fire", "btn-ads", "btn-reload", "btn-vault", "btn-stance",
  "btn-prone", "ammo-block", "hud-vitals", "minimap-wrap", "killfeed",
  "hud-meta", "compass", "btn-menu",
];

export function applyHud() {
  const r = document.documentElement.style;
  r.setProperty("--hud-scale", String(settings.hudScale));
  r.setProperty("--hud-alpha", String(settings.hudAlpha));
  r.setProperty("--ch-size", String(settings.crosshair.size));
  r.setProperty("--ch-gap", String(settings.crosshair.gap));
  document.body.classList.toggle("southpaw", !!settings.southpaw);
  document.body.classList.toggle("no-ch-dot", !settings.crosshair.dot);

  for (const id of DIMMABLE) {
    const el = $(id);
    if (el) el.style.opacity = String(settings.hudAlpha);
  }

  const vis = {
    "minimap-wrap": settings.show.minimap,
    "compass": settings.show.compass,
    "killfeed": settings.show.killfeed,
    "fps": settings.show.fps,
    "hud-prompt": settings.show.prompt,
    "ammo-block": settings.show.ammo,
    "hud-vitals": settings.show.vitals,
    "hud-meta": settings.show.score,
    "btn-stance": settings.show.stanceBtn,
  };
  for (const [id, on] of Object.entries(vis)) {
    const el = $(id);
    if (el) el.classList.toggle("hud-off", !on);
  }

  applyLayout();
}

// Custom positions are stored as viewport fractions so a rotation or a
// different device keeps the thumb clusters in the same relative place.
export function applyLayout() {
  for (const spec of HUD_ELEMENTS) {
    const el = $(spec.id);
    if (!el) continue;
    const e = settings.layout[spec.id];
    if (!e) {
      el.style.left = el.style.top = el.style.right = el.style.bottom = "";
      el.style.transform = "";
      el.style.transformOrigin = "";
      continue;
    }
    el.style.left = (e.x * 100).toFixed(3) + "vw";
    el.style.top = (e.y * 100).toFixed(3) + "vh";
    el.style.right = "auto";
    el.style.bottom = "auto";
    el.style.transformOrigin = "top left";
    el.style.transform = `scale(${(e.s ?? 1).toFixed(3)})`;
  }
}

// Snapshot an element's live geometry into the layout map — used when the
// editor first touches a control that is still on its CSS default position.
export function captureLayout(id) {
  const el = $(id);
  if (!el) return null;
  const cur = settings.layout[id];
  if (cur) return cur;
  const r = el.getBoundingClientRect();
  const e = { x: r.left / window.innerWidth, y: r.top / window.innerHeight, s: 1 };
  settings.layout[id] = e;
  return e;
}
