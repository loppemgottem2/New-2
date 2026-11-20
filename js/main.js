// =====================================================================
//  MAIN.JS — boots the game: screens, settings, the menu pedestal,
//  local (bot) / host / guest sessions, and the frame loop.
// =====================================================================
import { CONFIG } from './config.js';
import { World } from './physics.js';
import { Fighter, fighterPairFilter, LIMB_NAMES, SWORD_GEO } from './fighter.js';
import { Match } from './match.js';
import { Bot } from './bot.js';
import { GameRenderer, THREE } from './render.js';
import { TouchSticks } from './input.js';
import { Sound } from './audio.js';
import { Hud } from './hud.js';
import * as Net from './net.js';
import { encodeSnapshot, Mirror } from './netsync.js';
import { V3, Quat, clamp } from './math.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const DEV_DESKTOP = params.has('desktop');
const STEP = CONFIG.PHYSICS.STEP;

// ------------------------------------------------------------- settings
const DEFAULTS = { quality: 'medium', shadows: true, blood: 'normal', volume: 0.8, shake: true, stick: 62, vibrate: true, fps: false, name: '', botLevel: 5 };
function loadSettings() { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('rd-settings') || '{}') }; } catch { return { ...DEFAULTS }; } }
const settings = loadSettings();
function saveSettings() { try { localStorage.setItem('rd-settings', JSON.stringify(settings)); } catch { /* private mode */ } }
function playerName() { return (settings.name || '').trim().slice(0, 14) || 'Duelist'; }

// ------------------------------------------------------------- device gate
const isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
const mobileUA = /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const MOBILE_OK = DEV_DESKTOP || (isTouch && (mobileUA || matchMedia('(pointer: coarse)').matches));

// ------------------------------------------------------------- core objects
const canvas = $('c');
const renderer = new GameRenderer(canvas, settings);
const sound = new Sound(); sound.setVolume(settings.volume);
const hud = new Hud();
const sticks = new TouchSticks($('touch'), { radius: settings.stick });
window.addEventListener('resize', () => { renderer.resize(); checkOrientation(); });

// ------------------------------------------------------------- screens
const SCREENS = ['splash', 'menu', 'private', 'searching', 'settings', 'howto', 'results', 'left', 'gate'];
let current = 'menu';
function show(name) {
  for (const s of SCREENS) { const el = $(s); if (el) el.hidden = s !== name; }
  current = name;
  $('menu-x').hidden = !(name === 'menu');
}
function notice(msg) { const n = $('menu-notice'); n.textContent = msg; n.hidden = !msg; }
function checkOrientation() {
  const portrait = window.innerHeight > window.innerWidth * 1.05;
  $('rotate').hidden = !(portrait && MOBILE_OK);
}

// ------------------------------------------------------------- menu pedestal
const PED_H = 1.1;
class MenuScene {
  constructor() {
    this.world = new World({ substeps: CONFIG.PHYSICS.SUBSTEPS, arenaRadius: CONFIG.PHYSICS.MENU_PEDESTAL_RADIUS - 0.1 });
    this.world.pairFilter = fighterPairFilter;
    this.fighter = new Fighter(this.world, { x: 0, z: 0, yaw: 0.5, pedestal: true, name: 'Hero' });
    this.view = renderer.addFighterView(0);
    renderer.views.length = 0; // not part of a duel
    this.view.group.position.y = PED_H;
    const ped = new THREE.Group();
    const marble = new THREE.MeshStandardMaterial({ color: 0xf1ece2, roughness: 0.45, metalness: 0 });
    const R = CONFIG.PHYSICS.MENU_PEDESTAL_RADIUS;
    const col = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.82, R * 0.9, PED_H - 0.22, 40), marble); col.position.y = (PED_H - 0.22) / 2 + 0.1; ped.add(col);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 0.12, 48), marble); cap.position.y = PED_H - 0.06; ped.add(cap);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.05, R * 1.12, 0.12, 48), marble); base.position.y = 0.06; ped.add(base);
    ped.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    renderer.scene.add(ped);
    this.ped = ped;
    this.acc = 0; this.swingT = 0; this.t = 0;
    for (let i = 0; i < 30; i++) { this.fighter.update(STEP); this.world.step(STEP); }
  }
  setVisible(v) { this.view.group.visible = v; this.ped.visible = v; }
  swing() {
    // a random direction in front (and sometimes a wind-up over the shoulder)
    const a = (Math.random() * 2 - 1) * 2.4, r = 0.75 + Math.random() * 0.25;
    this.fighter.input.sx = Math.sin(a) * r; this.fighter.input.sy = Math.cos(a) * r;
    this.swingT = 0.32 + Math.random() * 0.15;
    sound.swish(8);
  }
  update(dt) {
    this.t += dt;
    this.acc += dt;
    let n = 0;
    while (this.acc >= STEP && n < 3) {
      if (this.swingT > 0) { this.swingT -= STEP; if (this.swingT <= 0) { this.fighter.input.sx = 0; this.fighter.input.sy = 0; } }
      this.fighter.update(STEP); this.world.step(STEP); this.acc -= STEP; n++;
    }
    if (this.acc > STEP) this.acc = 0;
    this.view.sync(this.fighter, null);
    renderer.updateMenuCamera(this.t, { x: 0, y: PED_H, z: 0 });
  }
}

// ------------------------------------------------------------- helpers shared by sessions
const tmpV = new THREE.Vector3();
function cameraRelativeMove(mx, my) {
  const f = renderer.cameraForward();
  const r = { x: -f.z, z: f.x };
  return { x: r.x * mx + f.x * my, z: r.z * mx + f.z * my };
}
function vibrate(ms) { if (settings.vibrate && navigator.vibrate) { try { navigator.vibrate(ms); } catch { /* */ } } }

class Interp {
  constructor() { this.a = 1; this._p = new V3(); this._q = new Quat(); }
  pos(b) { if (!b._pp) return b.pos; return this._p.copy(b._pp).lerp(b.pos, this.a); }
  rot(b) { if (!b._pq) return b.q; return this._q.copy(b._pq).slerp(b.q, this.a); }
}

// ------------------------------------------------------------- session base
class Session {
  constructor(names, me) {
    this.names = names; this.me = me;
    renderer.removeAllViews();
    this.views = [renderer.addFighterView(0), renderer.addFighterView(1)];
    renderer.effects.clear();
    this.severs = []; // {body, t}
    this.tipPrev = [new V3(), new V3()]; this.swishCool = [0, 0];
    this.time = 0;
    this.woundCounts = [0, 0];
    this.lastState = '';
    this.paused = false;
    this.resultsShown = false;
    hud.resetBars();
    hud.setNames(names[me], names[1 - me]);
    sticks.setEnabled(true);
    menuScene.setVisible(false);
    renderer.camState.dist = 4.5;
    show(null);
    $('hud').hidden = false;
    $('results').hidden = true;
  }
  get fighters() { return this.src.fighters; }
  // effects + sounds + banners for a batch of events
  handleEvents(cev, gev) {
    const F = this.fighters;
    renderer.handleEvents(cev, F);
    for (const e of cev) {
      switch (e.type) {
        case 'clash': sound.clash(e.power); if (e.power > 0.3) vibrate(12); break;
        case 'thud': sound.thud(e.power); break;
        case 'slash': sound.slash(0.5); if (e.victim === this.me) vibrate(25); break;
        case 'stab': sound.stab(); if (e.victim === this.me) vibrate(40); break;
        case 'sever': sound.sever(); vibrate(e.victim === this.me ? 90 : 30);
          for (const n of e.removed || []) this.severs.push({ f: e.victim, limb: n, t: this.time });
          break;
        case 'death': sound.death(); if (e.victim === this.me) vibrate(160); break;
        default: break;
      }
    }
    for (const e of gev) this.gameEvent(e);
  }
  gameEvent(e) {
    const me = this.me;
    switch (e.type) {
      case 'roundStart':
        hud.show(e.round === 1 ? 'ROUND 1' : `ROUND ${e.round}`, this.src.scores[0] === 2 && this.src.scores[1] === 2 ? 'Final round' : 'First to 3 wins', 1.8);
        for (const v of this.views) v.clearWounds();
        renderer.effects.clear();
        this.severs.length = 0; this.woundCounts = [0, 0];
        hud.resetBars();
        break;
      case 'fight': hud.show('FIGHT!', '', 0.9, 'fight'); sound.gong(); break;
      case 'firstDeath':
        if (e.dead === me) hud.show('YOU DIED', this.fighters[1 - me].bleedRate > 0.3 ? 'If they bleed out too, it is a draw' : '', 2.4, 'bad');
        else hud.show('OPPONENT DOWN', this.fighters[me].bleedRate > 0.3 ? 'Survive your bleeding to win the round' : '', 2.4, 'good');
        break;
      case 'roundEnd':
        if (e.winner === -1) { hud.show('DRAW', 'Nobody scores', 3, ''); sound.bell(false); }
        else if (e.winner === me) { hud.show('ROUND WON', `${e.scores[me]} – ${e.scores[1 - me]}`, 3, 'good'); sound.bell(true); }
        else { hud.show('ROUND LOST', `${e.scores[me]} – ${e.scores[1 - me]}`, 3, 'bad'); sound.bell(false); }
        break;
      case 'matchEnd':
        setTimeout(() => this.showResults(e.winner), 900);
        break;
      default: break;
    }
  }
  showResults(winner) {
    if (!session || session !== this) return;
    const me = this.me, s = this.src.scores;
    $('results-title').textContent = winner === me ? 'VICTORY' : 'DEFEAT';
    $('results-title').className = winner === me ? 'good' : 'bad';
    $('results-score').textContent = `${s[me]} – ${s[1 - me]}`;
    $('results-sub').textContent = winner === me ? `You beat ${this.names[1 - me]}.` : `${this.names[1 - me]} wins the duel.`;
    $('btn-rematch').hidden = !this.canRematch;
    $('results-wait').hidden = this.canRematch;
    $('results').hidden = false;
    this.resultsShown = true;
    sticks.setEnabled(false);
  }
  hideResults() { $('results').hidden = true; this.resultsShown = false; sticks.setEnabled(true); }
  // camera points: flying / recently severed limbs
  extraPoints() {
    const pts = [];
    for (const s of this.severs) {
      const f = this.fighters[s.f]; const b = f.parts[s.limb];
      const spd = b.vel ? Math.hypot(b.vel.x, b.vel.y, b.vel.z) : 0;
      if (this.time - s.t < 2.2 || spd > 1.0) pts.push(b.pos);
    }
    for (const f of this.fighters) if (!f.swordHeld) { const sp = f.sword.vel ? Math.hypot(f.sword.vel.x, f.sword.vel.y, f.sword.vel.z) : 0; if (sp > 1.5) pts.push(f.sword.pos); }
    return pts;
  }
  frameCommon(dt, interp) {
    const F = this.fighters;
    for (let i = 0; i < 2; i++) {
      if (F[i].wounds.length < this.views[i].woundCount) this.views[i].clearWounds();
      this.views[i].sync(F[i], interp);
      renderer.emitBleeding(F[i], this.views[i], dt, interp);
      // swish sounds from fast blades
      const tip = F[i].sword.pos; // approximate with sword centre + orientation
      const q = interp ? interp.rot(F[i].sword) : F[i].sword.q;
      const p = interp ? interp.pos(F[i].sword) : F[i].sword.pos;
      const t = tmpV.set(0, SWORD_GEO.tipY, 0).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
      const tx = p.x + t.x, ty = p.y + t.y, tz = p.z + t.z;
      const sp = Math.hypot(tx - this.tipPrev[i].x, ty - this.tipPrev[i].y, tz - this.tipPrev[i].z) / Math.max(dt, 1e-3);
      this.tipPrev[i].set(tx, ty, tz);
      this.swishCool[i] -= dt;
      if (sp > 7.5 && sp < 60 && this.swishCool[i] <= 0 && F[i].swordHeld) { sound.swish(sp); this.swishCool[i] = 0.32; }
      void tip;
    }
    renderer.effects.update(dt);
    renderer.updateClouds(dt);
    const me = F[this.me], other = F[1 - this.me];
    renderer.setMarker(me.parts.torso.pos, me.alive);
    renderer.updateDuelCamera(dt, me, other, this.extraPoints(), settings.shake);
    const order = [me, other];
    const sc = [this.src.scores[this.me], this.src.scores[1 - this.me]];
    hud.update(dt, order, sc, this.src.round);
  }
  end() {
    sticks.setEnabled(false);
    renderer.setMarker(null, false);
    renderer.removeAllViews();
    renderer.effects.clear();
    $('hud').hidden = true; $('results').hidden = true;
  }
}

// local physics (vs bot, or hosting an online match)
class LocalSession extends Session {
  constructor(kind, opts) {
    const names = kind === 'bot' ? [playerName(), `Bot · Lv ${opts.level}`] : [playerName(), opts.link.remoteName];
    super(names, 0);
    this.kind = kind;
    this.match = new Match({ names });
    this.src = this.match;
    this.canRematch = true;
    this.human = { update: (dt, f) => { const s = sticks.read(); const m = cameraRelativeMove(s.mx, s.my); f.input.mx = m.x; f.input.mz = m.z; f.input.sx = s.sx; f.input.sy = s.sy; } };
    this.match.controllers[0] = this.human;
    if (kind === 'bot') { this.bot = new Bot(opts.level); this.match.controllers[1] = this.bot; }
    else {
      this.link = opts.link;
      this.remoteInput = { mx: 0, mz: 0, sx: 0, sy: 0 };
      this.match.controllers[1] = { update: (dt, f) => { Object.assign(f.input, this.remoteInput); } };
      this.link.on('message', (m) => { if (m.t === 'in') { this.remoteInput.mx = clamp(+m.mx || 0, -1, 1); this.remoteInput.mz = clamp(+m.mz || 0, -1, 1); this.remoteInput.sx = clamp(+m.sx || 0, -1, 1); this.remoteInput.sy = clamp(+m.sy || 0, -1, 1); } else if (m.t === 'bye') leaveToMenu('Your opponent left the match.'); });
      this.link.on('close', () => { if (session === this) leaveToMenu('Connection to your opponent was lost.'); });
      this.seq = 0; this.netEvents = [];
    }
    this.acc = 0;
    this.interp = new Interp();
    this.handleEvents([], this.match.events.splice(0));
  }
  update(dt) {
    this.time += dt;
    if (!this.paused) {
      this.acc += dt;
      let n = 0;
      while (this.acc >= STEP && n < 4) {
        for (const b of this.match.world.bodies) { (b._pp || (b._pp = new V3())).copy(b.pos); (b._pq || (b._pq = new Quat())).copy(b.q); }
        this.match.step(STEP);
        const cev = this.match.combat.events.splice(0), gev = this.match.events.splice(0);
        this.handleEvents(cev, gev);
        if (this.link) {
          for (const e of cev) if (e.type !== 'cutting' || Math.random() < 0.5) this.netEvents.push(e);
          for (const e of gev) this.netEvents.push(e);
          if (this.match.frame % 2 === 0) { this.link.send(encodeSnapshot(this.match, this.seq++, this.netEvents.splice(0, 40))); }
        }
        this.acc -= STEP; n++;
      }
      if (this.acc > STEP * 2) this.acc = 0;
      this.interp.a = clamp(this.acc / STEP, 0, 1);
    }
    this.frameCommon(dt, this.paused ? null : this.interp);
    if (this.resultsShown && this.match.state !== 'matchEnd') this.hideResults();
  }
  rematch() { this.match.rematch(); this.hideResults(); }
  end() { super.end(); if (this.link) this.link.close(); }
}

// guest: shows the host's simulation, sends joysticks
class GuestSession extends Session {
  constructor(link) {
    super([link.remoteName, playerName()], 1);
    this.link = link;
    this.mirror = new Mirror(this.names);
    this.src = this.mirror;
    this.canRematch = false;
    this.inputT = 0;
    link.on('message', (m) => {
      if (m.t === 's') this.mirror.push(m, performance.now() / 1000);
      else if (m.t === 'bye') leaveToMenu('The host left the match.');
    });
    link.on('close', () => { if (session === this) leaveToMenu('Connection to the host was lost.'); });
    this.prevState = '';
  }
  update(dt) {
    this.time += dt;
    const now = performance.now() / 1000;
    this.mirror.update(now);
    // events from the host
    const ev = this.mirror.events.splice(0);
    const cev = ev.filter((e) => !['roundStart', 'fight', 'firstDeath', 'roundEnd', 'matchEnd'].includes(e.type));
    const gev = ev.filter((e) => ['roundStart', 'fight', 'firstDeath', 'roundEnd', 'matchEnd'].includes(e.type));
    this.handleEvents(cev, gev);
    // inputs
    this.inputT -= dt;
    if (this.inputT <= 0) {
      const s = sticks.read(); const m = cameraRelativeMove(s.mx, s.my);
      this.link.send({ t: 'in', mx: +m.x.toFixed(3), mz: +m.z.toFixed(3), sx: +s.sx.toFixed(3), sy: +s.sy.toFixed(3) });
      this.inputT = 1 / CONFIG.NET.INPUT_HZ;
    }
    if (!this.mirror.got) { hud.show('CONNECTING…', '', 0.3); return; }
    this.frameCommon(dt, null);
    if (this.resultsShown && this.mirror.state !== 'matchEnd') this.hideResults();
  }
  end() { super.end(); this.link.close(); }
}

// ------------------------------------------------------------- flow
let session = null;
const menuScene = new MenuScene();

function startBot() {
  sound.unlock(); goFullscreen();
  session = new LocalSession('bot', { level: settings.botLevel });
}
function leaveToMenu(msg) {
  if (session) { const s = session; session = null; s.end(); }
  menuScene.setVisible(true);
  show('menu');
  notice(msg || '');
  xArmed = 0;
}

// X button (in game): first tap arms, second tap leaves
let xArmed = 0;
$('btn-x').addEventListener('click', () => {
  sound.click();
  if (xArmed > 0) { leaveToMenu(''); return; }
  xArmed = 2.5;
  $('leave-hint').hidden = false;
});
// X on the main menu: leave the game entirely
$('menu-x').addEventListener('click', () => {
  sound.click();
  show('left');
  menuScene.setVisible(true);
  try { if (document.fullscreenElement) document.exitFullscreen(); } catch { /* */ }
  try { window.close(); } catch { /* browsers only allow this for script-opened tabs */ }
});
$('btn-come-back').addEventListener('click', () => show('menu'));

// gear: in-game settings
$('btn-gear').addEventListener('click', () => {
  sound.click();
  openSettings(true);
});
function openSettings(inGame) {
  settingsInGame = inGame;
  syncSettingsUI();
  if (inGame) { $('settings').hidden = false; sticks.setEnabled(false); if (session && session.kind === 'bot') session.paused = true; $('settings-paused').hidden = !(session && session.kind === 'bot'); }
  else show('settings');
}
let settingsInGame = false;
$('btn-settings-done').addEventListener('click', () => {
  sound.click(); saveSettings();
  if (settingsInGame && session) { $('settings').hidden = true; sticks.setEnabled(!session.resultsShown); session.paused = false; }
  else show('menu');
});

// ------------------------------------------------------------- settings UI
function segmented(id, key, values) {
  const el = $(id);
  el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    settings[key] = b.dataset.v; syncSettingsUI(); applySettings();
  }));
}
segmented('set-quality', 'quality');
segmented('set-blood', 'blood');
function toggle(id, key) { $(id).addEventListener('change', (e) => { settings[key] = e.target.checked; applySettings(); }); }
toggle('set-shadows', 'shadows'); toggle('set-shake', 'shake'); toggle('set-vibrate', 'vibrate'); toggle('set-fps', 'fps');
$('set-volume').addEventListener('input', (e) => { settings.volume = +e.target.value / 100; sound.setVolume(settings.volume); $('set-volume-out').textContent = e.target.value; });
$('set-stick').addEventListener('input', (e) => { settings.stick = +e.target.value; sticks.setRadius(settings.stick); $('set-stick-out').textContent = e.target.value; });
function syncSettingsUI() {
  for (const [id, key] of [['set-quality', 'quality'], ['set-blood', 'blood']]) $(id).querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === settings[key]));
  $('set-shadows').checked = !!settings.shadows; $('set-shake').checked = !!settings.shake; $('set-vibrate').checked = !!settings.vibrate; $('set-fps').checked = !!settings.fps;
  $('set-volume').value = Math.round(settings.volume * 100); $('set-volume-out').textContent = Math.round(settings.volume * 100);
  $('set-stick').value = settings.stick; $('set-stick-out').textContent = settings.stick;
}
function applySettings() { renderer.applySettings(settings); $('fps').hidden = !settings.fps; saveSettings(); }

// ------------------------------------------------------------- menu buttons
$('bot-level').value = settings.botLevel;
$('bot-level-out').textContent = settings.botLevel;
$('bot-level').addEventListener('input', (e) => { settings.botLevel = +e.target.value; $('bot-level-out').textContent = e.target.value; $('bot-level-desc').textContent = botDesc(settings.botLevel); saveSettings(); });
function botDesc(l) { return ['', 'Wobbly beginner', 'Clumsy', 'Novice', 'Squire', 'Swordsman', 'Skilled', 'Veteran', 'Duelist', 'Master', 'Legend'][l]; }
$('bot-level-desc').textContent = botDesc(settings.botLevel);
$('name').value = settings.name;
$('name').addEventListener('input', (e) => { settings.name = e.target.value.slice(0, 14); saveSettings(); });

$('btn-bot').addEventListener('click', () => { sound.unlock(); sound.click(); startBot(); });
$('btn-settings').addEventListener('click', () => { sound.unlock(); sound.click(); openSettings(false); });
$('btn-howto').addEventListener('click', () => { sound.unlock(); sound.click(); show('howto'); });
$('btn-howto-done').addEventListener('click', () => { sound.click(); show('menu'); });
$('btn-private').addEventListener('click', () => { sound.unlock(); sound.click(); if (requireNet()) { show('private'); $('private-status').textContent = ''; } });
$('btn-private-back').addEventListener('click', () => { sound.click(); show('menu'); });
$('btn-quick').addEventListener('click', () => { sound.unlock(); sound.click(); if (requireNet()) quick(); });
$('btn-search-cancel').addEventListener('click', () => { sound.click(); if (searchCancel) searchCancel(); searchCancel = null; show('menu'); });
$('btn-rematch').addEventListener('click', () => { sound.click(); if (session && session.rematch) session.rematch(); });
$('btn-results-menu').addEventListener('click', () => { sound.click(); leaveToMenu(''); });

const PREVIEW = !!window.RD_PREVIEW; // single-page preview build: no peer-to-peer allowed
function requireNet() {
  if (PREVIEW) { notice('Online matches work in the full version of the game (hosted on GitHub Pages). This preview can fight bots.'); return false; }
  if (Net.netAvailable()) return true;
  notice('Online play could not load (are you offline?). You can still fight bots.');
  return false;
}

// ------------------------------------------------------------- online flow
let searchCancel = null;
function searching(title, status, code) {
  show('searching');
  $('search-title').textContent = title;
  $('search-status').textContent = status;
  $('search-code').hidden = !code;
  if (code) $('search-code-value').textContent = code;
}
function quick() {
  goFullscreen();
  searching('Quick Match', 'Looking for an opponent…');
  const q = Net.quickMatch(playerName(), (s) => { if (current === 'searching') $('search-status').textContent = s; });
  searchCancel = q.cancel;
  q.promise.then((link) => { searchCancel = null; startOnline(link); })
    .catch((e) => { searchCancel = null; if (e && e.type === 'cancelled') return; show('menu'); notice(friendlyNetError(e)); });
}
$('btn-create').addEventListener('click', () => {
  sound.click(); goFullscreen();
  const code = Net.randomCode();
  searching('Private Match', 'Share this code with your friend. Waiting for them to join…', code);
  const h = Net.hostAndWait(Net.privateId(code), playerName(), null, false);
  searchCancel = h.cancel;
  h.promise.then((link) => { searchCancel = null; startOnline(link); })
    .catch((e) => { searchCancel = null; if (e && e.type === 'cancelled') return; show('menu'); notice(e && e.type === 'unavailable-id' ? 'That code is in use. Please try again.' : friendlyNetError(e)); });
});
$('btn-join').addEventListener('click', () => joinCode());
$('code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinCode(); });
$('code-input').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5); });
function joinCode() {
  const code = $('code-input').value.trim().toUpperCase();
  if (code.length !== 5) { $('private-status').textContent = 'Codes have 5 letters or numbers.'; return; }
  sound.click(); goFullscreen();
  searching('Private Match', `Joining ${code}…`);
  let cancelled = false;
  searchCancel = () => { cancelled = true; };
  Net.joinHost(Net.privateId(code), playerName())
    .then((link) => { if (cancelled) { link.close(); return; } searchCancel = null; startOnline(link); })
    .catch((e) => { if (cancelled) return; searchCancel = null; show('private'); $('private-status').textContent = e && e.message ? e.message : 'Could not join that code.'; });
}
function friendlyNetError(e) {
  if (!e) return 'Something went wrong with online play.';
  if (e.type === 'busy') return e.message;
  if (e.type === 'timeout' || e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error') return 'Could not reach the online service. Check your internet and try again.';
  return e.message || 'Online play failed. Try again.';
}
function startOnline(link) {
  if (link.role === 'host') session = new LocalSession('host', { link });
  else session = new GuestSession(link);
}

// ------------------------------------------------------------- fullscreen / orientation
// Android / most browsers: real fullscreen (hides the address bar). It has to be requested
// from a tap, so we ask when a match starts and again on the next tap if it was left.
// iPhone Safari does not allow web pages to go fullscreen: there the only way is to
// add the game to the home screen, so the menu shows a short tip instead.
const docEl = document.documentElement;
const FS_SUPPORTED = !!((docEl.requestFullscreen || docEl.webkitRequestFullscreen) && (document.fullscreenEnabled || document.webkitFullscreenEnabled));
const IS_IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_STANDALONE = matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true;
function isFullscreen() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
function goFullscreen() {
  if (DEV_DESKTOP || !FS_SUPPORTED || IS_STANDALONE || isFullscreen()) return;
  try {
    const p = docEl.requestFullscreen ? docEl.requestFullscreen({ navigationUI: 'hide' }) : docEl.webkitRequestFullscreen();
    Promise.resolve(p).then(() => {
      try { const o = screen.orientation; if (o && o.lock) o.lock('landscape').catch(() => {}); } catch { /* */ }
    }).catch(() => {});
  } catch { /* not allowed here */ }
}
// any tap (touchend counts as a user gesture) brings fullscreen back during a match,
// and the first tap on the menu enters it too
// (browsers only allow fullscreen from a tap, so the very first screen is "tap to play")
window.addEventListener('touchend', () => {
  if (!MOBILE_OK || current === 'left' || current === 'gate') return;
  goFullscreen();
}, { capture: true, passive: true });
window.addEventListener('click', () => { if (current !== 'left' && current !== 'gate') goFullscreen(); }, { capture: true });
const NEEDS_SPLASH = MOBILE_OK && !DEV_DESKTOP && FS_SUPPORTED && !IS_STANDALONE;
function leaveSplash() {
  if (current !== 'splash') return;
  goFullscreen();
  sound.unlock();
  show('menu');
}
$('splash').addEventListener('touchend', (e) => { e.preventDefault(); leaveSplash(); });
$('splash').addEventListener('click', leaveSplash);

// Android: offer to install the game as an app (it then always opens full screen)
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; $('btn-install').hidden = IS_STANDALONE; });
window.addEventListener('appinstalled', () => { installEvt = null; $('btn-install').hidden = true; });
$('btn-install').addEventListener('click', async () => {
  if (!installEvt) return;
  const ev = installEvt; installEvt = null;
  try { ev.prompt(); await ev.userChoice; } catch { /* dismissed */ }
  $('btn-install').hidden = true;
});
if ('serviceWorker' in navigator && location.protocol === 'https:' && !window.RD_PREVIEW) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* not essential */ });
}
// tip for phones where the page itself can't go fullscreen
function setupFullscreenTip() {
  const tip = $('fs-tip');
  let dismissed = false;
  try { dismissed = localStorage.getItem('rd-fs-tip') === '1'; } catch { /* */ }
  if (DEV_DESKTOP || IS_STANDALONE || FS_SUPPORTED || dismissed || !MOBILE_OK) return;
  $('fs-tip-text').textContent = PREVIEW
    ? 'This preview can\'t hide the top bar. Open the game from its own web address for full screen.'
    : IS_IOS
      ? 'Full screen on iPhone: tap Share, then "Add to Home Screen", and open the game from your home screen.'
      : 'Full screen: open the game in your phone\'s browser (not inside another app), or use "Add to Home screen".';
  tip.hidden = false;
  $('fs-tip-close').addEventListener('click', () => { tip.hidden = true; try { localStorage.setItem('rd-fs-tip', '1'); } catch { /* */ } });
}

// menu: tap anywhere that isn't a control -> the hero swings
$('menu').addEventListener('pointerdown', (e) => {
  sound.unlock();
  if (e.target.closest('button, input, label, .menu-panel, .fs-tip')) return;
  menuScene.swing();
});

// ------------------------------------------------------------- loop
let last = performance.now(), fpsAcc = 0, fpsN = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (xArmed > 0) { xArmed -= dt; if (xArmed <= 0) $('leave-hint').hidden = true; }
  if (session) session.update(dt);
  else { menuScene.update(dt); renderer.effects.update(dt); renderer.updateClouds(dt); }
  renderer.render();
  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.5) { if (settings.fps) $('fps').textContent = Math.round(fpsN / fpsAcc) + ' fps'; fpsAcc = 0; fpsN = 0; }
}

// ------------------------------------------------------------- boot
applySettings();
syncSettingsUI();
checkOrientation();
show(NEEDS_SPLASH && !isFullscreen() ? 'splash' : 'menu');
setupFullscreenTip();
if (!MOBILE_OK) { show('gate'); $('gate-url').textContent = location.href.split('#')[0]; }
document.body.classList.add('ready');
requestAnimationFrame(frame);
// debug handle
window.RD = { get session() { return session; }, settings, renderer, startBot, menuScene };
