// ECHELON — app shell: boot sequence, lobby, loadout, gunsmith, match flow.
import {
  LOG, DEPLOY_LOG, PARTS, PHASES, DEPLOY_PHASES,
  WEAPONS, ATTS, STAT_NAMES, statsFor, buildLoadout, MATCH,
} from "./data.js";
import { Game } from "./game.js";

const $ = id => document.getElementById(id);
const state = {
  screen: "boot",
  weapon: 0,
  atts: [0, 1, 0, 1, 0, 1],   // matches the design's default fit
  game: null,
};

/* ---------------- screen switching ---------------- */
function showScreen(name) {
  state.screen = name;
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  $("hud").classList.remove("active");
  if (name === "hud") $("hud").classList.add("active");
  else $("screen-" + name)?.classList.add("active");
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
    : "ASSEMBLING VIEWMODEL · " + WEAPONS[state.weapon].name + " · 214k TRIS";

  // ticks (once)
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

  bootTimer = setInterval(() => {
    if (hold > 0) { hold--; return; }
    if (pct >= 100) {
      clearInterval(bootTimer);
      $("boot-footer").textContent = deploy ? "DEPLOYING ▸" : "SQUAD LINKED · ENTERING LOBBY";
      setTimeout(onDone, 520);
      return;
    }
    const next = Math.min(100, pct + 2 + Math.floor(Math.random() * 9));
    const crossed = phases.some(ph => pct < ph[0] && next >= ph[0]);
    pct = next;
    render();
    if (crossed) {
      hold = 4;
      $("boot-pct").classList.add("glitching");
      setTimeout(() => $("boot-pct").classList.remove("glitching"), 160);
    }
  }, 90);
}

/* ---------------- lobby ---------------- */
function initLobby() {
  const squad = [
    ["1", "VIPER-04", "YOU"], ["2", "HALVARD", "READY"], ["3", "SIX-TEN", "IN GUNSMITH"],
    ["4", "MARROW", "READY"], ["5", "TALLINN", "READY"],
  ];
  $("lobby-squad").innerHTML = squad.map(([i, n, s]) =>
    `<div class="squadrow"><div class="num">${i}</div><span class="nm">${n}</span><span class="st">${s}</span></div>`
  ).join("");

  const nav = [["LOBBY", "lobby"], ["LOADOUT", "loadout"], ["GUNSMITH", "gunsmith"], ["STORE", null]];
  $("lobby-nav").innerHTML = "";
  for (const [label, target] of nav) {
    const b = document.createElement("button");
    b.textContent = label;
    if (target === "lobby") b.classList.add("on");
    if (!target) b.style.opacity = 0.4;
    b.addEventListener("click", () => { if (target) goto(target); });
    $("lobby-nav").appendChild(b);
  }
  $("btn-play").addEventListener("click", deploy);

  // operator art — geometric modernist figure
  $("op-art").innerHTML = `
  <svg viewBox="0 0 200 260" preserveAspectRatio="xMidYMid slice">
    <rect width="200" height="260" fill="#211f1e"/>
    <g fill="none" stroke="rgba(243,242,242,.12)" stroke-width="1">
      ${Array.from({ length: 6 }, (_, i) => `<line x1="${i * 40}" y1="0" x2="${i * 40}" y2="260"/>`).join("")}
      ${Array.from({ length: 7 }, (_, i) => `<line x1="0" y1="${i * 40}" x2="200" y2="${i * 40}"/>`).join("")}
    </g>
    <rect x="72" y="38" width="56" height="52" fill="#3a3634"/>
    <rect x="68" y="58" width="64" height="9" fill="#ff563c"/>
    <rect x="58" y="96" width="84" height="88" fill="#413c3a"/>
    <rect x="58" y="112" width="84" height="10" fill="#2b2827"/>
    <rect x="46" y="100" width="12" height="62" fill="#353130"/>
    <rect x="142" y="100" width="12" height="62" fill="#353130"/>
    <rect x="70" y="184" width="24" height="60" fill="#2e2b29"/>
    <rect x="106" y="184" width="24" height="60" fill="#2e2b29"/>
    <rect x="94" y="140" width="52" height="12" fill="#151312"/>
    <rect x="140" y="136" width="26" height="7" fill="#151312"/>
    <rect x="60" y="96" width="4" height="88" fill="#ff563c" opacity=".8"/>
  </svg>`;
}

/* ---------------- loadout ---------------- */
function renderLoadout() {
  const cur = WEAPONS[state.weapon];
  const slots = [
    { kind: "PRIMARY", name: cur.name, meta: cur.origin, hint: "6 ATTACHMENTS", go: "gunsmith", sel: true },
    { kind: "SECONDARY", name: "TR-2 SPIKE", meta: ".45 · MACHINE PISTOL", hint: "2 ATTACHMENTS", go: "gunsmith" },
    { kind: "LETHAL", name: "FRAG ×2", meta: "3.5s FUSE", hint: "TAP TO SWAP" },
    { kind: "TACTICAL", name: "SIGNAL SMOKE", meta: "9s BLOOM", hint: "TAP TO SWAP" },
    { kind: "PERK LINE", name: "TRACEUR", meta: "VAULT SPEED +18%", hint: "3 SLOTS" },
  ];
  const cols = $("loadout-cols");
  cols.innerHTML = "";
  for (const s of slots) {
    const b = document.createElement("button");
    b.className = "slotbtn" + (s.sel ? " sel" : "");
    b.innerHTML = `<div class="kind">${s.kind}</div><div class="nm">${s.name}</div><div class="meta">${s.meta}</div><div class="hint">${s.hint}</div>`;
    b.addEventListener("click", () => { if (s.go) goto(s.go); });
    cols.appendChild(b);
  }
}

/* ---------------- gunsmith ---------------- */
const PINS = [
  { x: 52, y: 22, label: "OPTIC" }, { x: 22, y: 62, label: "MUZZLE" },
  { x: 62, y: 68, label: "GRIP" }, { x: 80, y: 34, label: "STOCK" },
];

function weaponSvg(idx) {
  // honest schematic silhouettes per class — receiver/barrel/mag/stock blocks
  const acc = "#ff563c";
  const ink = "#3d3835", dark = "#2b2827", mid = "#4b4644";
  if (idx === 1) return `
    <rect x="120" y="118" width="150" height="34" fill="${ink}"/>
    <rect x="264" y="124" width="90" height="18" fill="${mid}"/>
    <rect x="352" y="128" width="34" height="10" fill="${dark}"/>
    <rect x="150" y="150" width="26" height="58" fill="${dark}" transform="skewX(-8)"/>
    <rect x="196" y="150" width="20" height="44" fill="${ink}"/>
    <rect x="66" y="122" width="56" height="22" fill="${dark}"/>
    <rect x="168" y="104" width="42" height="16" fill="${dark}"/>
    <rect x="182" y="98" width="6" height="8" fill="${acc}"/>`;
  if (idx === 2) return `
    <rect x="90" y="120" width="210" height="26" fill="${ink}"/>
    <rect x="292" y="112" width="150" height="14" fill="${mid}"/>
    <rect x="436" y="108" width="30" height="22" fill="${dark}"/>
    <rect x="150" y="144" width="18" height="70" fill="${dark}"/>
    <rect x="216" y="144" width="22" height="52" fill="${ink}" transform="skewX(-6)"/>
    <rect x="34" y="112" width="58" height="34" fill="${dark}"/>
    <rect x="34" y="124" width="58" height="4" fill="${acc}"/>
    <rect x="196" y="96" width="70" height="20" fill="${dark}"/>
    <rect x="226" y="90" width="8" height="8" fill="${acc}"/>
    <rect x="300" y="132" width="70" height="30" fill="${dark}"/>`;
  return `
    <rect x="100" y="112" width="180" height="38" fill="${ink}"/>
    <rect x="272" y="120" width="120" height="20" fill="${mid}"/>
    <rect x="386" y="124" width="40" height="12" fill="${dark}"/>
    <rect x="140" y="148" width="28" height="62" fill="${dark}" transform="skewX(-8)"/>
    <rect x="206" y="148" width="24" height="52" fill="${ink}" transform="skewX(-4)"/>
    <rect x="44" y="116" width="58" height="30" fill="${dark}"/>
    <rect x="44" y="128" width="58" height="5" fill="${acc}"/>
    <rect x="176" y="94" width="56" height="20" fill="${dark}"/>
    <rect x="198" y="86" width="8" height="10" fill="${acc}"/>
    <rect x="286" y="138" width="52" height="26" fill="${dark}"/>`;
}

function renderGunsmith() {
  const w = WEAPONS[state.weapon];
  // armory list
  const list = $("gs-weapons");
  list.innerHTML = "";
  WEAPONS.forEach((wp, i) => {
    const b = document.createElement("button");
    b.className = "wbtn" + (i === state.weapon ? " sel" : "");
    b.innerHTML = `<div class="cls">${wp.cls}</div><div class="nm">${wp.name}</div><div class="lv">LVL ${wp.lvl} · 6 ATT</div>`;
    b.addEventListener("click", () => { state.weapon = i; renderGunsmith(); });
    list.appendChild(b);
  });

  $("gs-name").textContent = w.name;
  $("gs-sub").textContent = `${w.cls} · ${w.origin}`;
  $("gs-note").textContent = w.note;

  // stage
  $("gs-stage").innerHTML = `
    <svg viewBox="0 0 520 260" preserveAspectRatio="xMidYMid meet">
      <line x1="0" y1="122" x2="520" y2="122" stroke="rgba(243,242,242,.16)" stroke-width="1"/>
      ${weaponSvg(state.weapon)}
    </svg>` +
    PINS.map(p => `<div class="pin" style="left:${p.x}%;top:${p.y}%"><div class="dot"></div><div class="plbl">${p.label}</div></div>`).join("");

  // attachment slots
  const atts = $("gs-atts");
  atts.innerHTML = "";
  ATTS.forEach((a, ai) => {
    const oi = state.atts[ai];
    const b = document.createElement("button");
    b.className = "attbtn" + (oi !== 0 ? " on" : "");
    b.innerHTML = `<div class="kind">${a.kind}</div><div class="nm">${a.opts[oi][0]}</div>`;
    b.addEventListener("click", () => {
      state.atts[ai] = (state.atts[ai] + 1) % a.opts.length;
      renderGunsmith();
    });
    atts.appendChild(b);
  });

  // stats
  const st = statsFor(state.weapon, state.atts);
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

/* ---------------- navigation ---------------- */
function goto(name) {
  if (name === "loadout") renderLoadout();
  if (name === "gunsmith") renderGunsmith();
  showScreen(name);
  if (name === "lobby") {
    document.querySelectorAll("#lobby-nav button").forEach((b, i) => b.classList.toggle("on", i === 0));
  }
}

/* ---------------- match flow ---------------- */
// On Android, go fullscreen + lock landscape from the PLAY gesture.
// Both calls are best-effort; desktop browsers just ignore the lock.
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
  runBoot("deploy", startMatch);
}

function startMatch() {
  const loadout = buildLoadout(state.weapon, state.atts);
  showScreen("hud");
  $("overlay-end").classList.remove("active");
  $("overlay-pause").classList.remove("active");
  // sentinel history entry: Android's back gesture pops this (and pauses via
  // the popstate listener) instead of unloading the page mid-match
  if (history.state?.inMatch !== 1) history.pushState({ inMatch: 1 }, "");
  state.game = new Game({
    canvas: $("gl"),
    loadout,
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
    goImmersive(); // valid user gesture: restore fullscreen + landscape lock
    state.game?.setPaused(false);
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
  window.addEventListener("keydown", e => {
    if (e.code === "Escape" && state.game && !state.game.over) {
      const pauseOpen = $("overlay-pause").classList.contains("active");
      if (pauseOpen) { $("overlay-pause").classList.remove("active"); state.game.setPaused(false); }
      else { state.game.setPaused(true); $("overlay-pause").classList.add("active"); }
    }
  });

  const pauseMatch = () => {
    if (state.game && !state.game.over && !state.game.paused) {
      state.game.setPaused(true);
      $("overlay-pause").classList.add("active");
    }
  };
  // Android back gesture: swallow the pop, re-arm the sentinel, pause
  window.addEventListener("popstate", () => {
    if (state.game && !state.game.over) {
      history.pushState({ inMatch: 1 }, "");
      pauseMatch();
    }
  });
  window.addEventListener("beforeunload", e => {
    if (state.game && !state.game.over) { e.preventDefault(); e.returnValue = ""; }
  });
  // losing fullscreen (back swipe, shade pull) or rotating to portrait
  // releases the orientation lock — pause instead of playing blind
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement) pauseMatch();
  });
  matchMedia("(orientation: portrait)").addEventListener("change", e => {
    if (e.matches) pauseMatch();
  });
}

/* ---------------- misc ---------------- */
function tickClock() {
  const d = new Date();
  $("clock-real").textContent =
    `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/* ---------------- init ---------------- */
initLobby();
initOverlays();
$("lo-back").addEventListener("click", () => goto("lobby"));
$("lo-gunsmith").addEventListener("click", () => goto("gunsmith"));
$("lo-deploy").addEventListener("click", deploy);
$("gs-back").addEventListener("click", () => goto("loadout"));
$("gs-deploy").addEventListener("click", deploy);
tickClock();
setInterval(tickClock, 20000);

runBoot("cold", () => goto("lobby"));
