// =====================================================================
//  INPUT.JS — two floating touch joysticks.
//   left half of the screen  : walk (relative to the camera)
//   right half of the screen : sword (where the blade points / swings)
//  Each stick appears under the thumb where it touches down. Letting go
//  returns the sword to the guard position.
//  ?desktop=1 adds a mouse/keyboard fallback for development only.
// =====================================================================
import { SWORD_GUARD } from './fighter.js';

export class TouchSticks {
  constructor(root, opts = {}) {
    this.root = root;
    this.radius = opts.radius || 62;
    this.sticks = {
      move: { x: 0, y: 0, id: null, ox: 0, oy: 0, el: this._makeEl('move') },
      sword: { x: 0, y: 0, id: null, ox: 0, oy: 0, el: this._makeEl('sword') },
    };
    this.enabled = false;
    this.onTap = null; // tap on the right side when sticks are disabled (menu)
    this._bind();
    this.keys = new Set();
    this.mouse = null;
  }
  _makeEl(kind) {
    const base = document.createElement('div'); base.className = 'stick ' + kind; base.hidden = true;
    const knob = document.createElement('div'); knob.className = 'knob'; base.appendChild(knob);
    const label = document.createElement('span'); label.className = 'stick-label'; label.textContent = kind === 'move' ? 'MOVE' : 'SWORD'; base.appendChild(label);
    this.root.appendChild(base);
    return { base, knob };
  }
  setRadius(r) { this.radius = r; }
  setEnabled(on) {
    this.enabled = on;
    if (!on) for (const s of Object.values(this.sticks)) this._release(s);
    this.root.classList.toggle('sticks-on', on);
  }
  _bind() {
    const opt = { passive: false };
    const target = this.root;
    target.addEventListener('touchstart', (e) => this._start(e), opt);
    target.addEventListener('touchmove', (e) => this._move(e), opt);
    target.addEventListener('touchend', (e) => this._end(e), opt);
    target.addEventListener('touchcancel', (e) => this._end(e), opt);
    if (new URLSearchParams(location.search).has('desktop')) {
      target.addEventListener('mousedown', (e) => this._mouse('down', e));
      window.addEventListener('mousemove', (e) => this._mouse('move', e));
      window.addEventListener('mouseup', (e) => this._mouse('up', e));
      window.addEventListener('keydown', (e) => this.keys.add(e.key.toLowerCase()));
      window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    }
  }
  _stickFor(x) { return x < window.innerWidth * 0.5 ? this.sticks.move : this.sticks.sword; }
  _start(e) {
    if (!this.enabled) {
      for (const t of e.changedTouches) if (this.onTap) this.onTap(t.clientX, t.clientY);
      return;
    }
    e.preventDefault();
    for (const t of e.changedTouches) {
      const s = this._stickFor(t.clientX);
      if (s.id !== null) continue;
      s.id = t.identifier;
      this._place(s, t.clientX, t.clientY);
    }
  }
  _move(e) {
    if (!this.enabled) return;
    e.preventDefault();
    for (const t of e.changedTouches) for (const s of Object.values(this.sticks)) if (s.id === t.identifier) this._set(s, t.clientX, t.clientY);
  }
  _end(e) {
    for (const t of e.changedTouches) for (const s of Object.values(this.sticks)) if (s.id === t.identifier) this._release(s);
  }
  // a new touch: the walk stick starts centred; the sword stick starts at the guard
  // position so the blade doesn't jump — drag from there to aim the tip
  _place(s, cx, cy) {
    s.ox = cx; s.oy = cy; s.x = 0; s.y = 0;
    if (s === this.sticks.sword) { s.ox = cx - SWORD_GUARD.x * this.radius; s.oy = cy + SWORD_GUARD.y * this.radius; s.x = SWORD_GUARD.x; s.y = SWORD_GUARD.y; }
    this._show(s);
  }
  _set(s, cx, cy) {
    let dx = cx - s.ox, dy = cy - s.oy;
    const d = Math.hypot(dx, dy), R = this.radius;
    // the move stick follows the thumb if it drags far away (comfortable)
    if (s === this.sticks.move && d > R * 1.6) { s.ox += dx * (1 - R * 1.6 / d); s.oy += dy * (1 - R * 1.6 / d); dx = cx - s.ox; dy = cy - s.oy; }
    let nx = dx / R, ny = -dy / R;
    const l = Math.hypot(nx, ny); if (l > 1) { nx /= l; ny /= l; }
    s.x = nx; s.y = ny;
    this._show(s);
  }
  _show(s) {
    const b = s.el.base, R = this.radius;
    b.hidden = false;
    b.style.width = b.style.height = R * 2 + 'px';
    b.style.transform = `translate(${s.ox - R}px, ${s.oy - R}px)`;
    s.el.knob.style.transform = `translate(${s.x * R}px, ${-s.y * R}px)`;
  }
  _release(s) { s.id = null; s.x = 0; s.y = 0; s.el.base.hidden = true; }
  _mouse(type, e) {
    if (!this.enabled) { if (type === 'down' && this.onTap) this.onTap(e.clientX, e.clientY); return; }
    const s = this.sticks.sword;
    if (type === 'down') { this.mouse = true; s.id = 'm'; this._place(s, e.clientX, e.clientY); }
    else if (type === 'move' && this.mouse) this._set(s, e.clientX, e.clientY);
    else if (type === 'up' && this.mouse) { this.mouse = false; this._release(s); }
  }
  // returns {mx, my (forward), sx, sy}
  read() {
    const m = this.sticks.move, s = this.sticks.sword;
    let mx = m.x, my = m.y;
    if (this.keys.size) {
      const k = this.keys;
      mx = (k.has('d') ? 1 : 0) - (k.has('a') ? 1 : 0); my = (k.has('w') ? 1 : 0) - (k.has('s') ? 1 : 0);
      const l = Math.hypot(mx, my); if (l > 1) { mx /= l; my /= l; }
    }
    // no thumb on the sword stick = upright guard
    if (s.id === null) return { mx, my, sx: SWORD_GUARD.x, sy: SWORD_GUARD.y };
    return { mx, my, sx: s.x, sy: s.y };
  }
}
