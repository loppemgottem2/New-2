// =====================================================================
//  INPUT.JS — two fixed touch joysticks that always stay in place.
//   bottom-left  : walk (relative to the camera)
//   bottom-right : sword (where the blade points / swings)
//  A touch near a stick grabs it; the stick reads the thumb's position
//  relative to its own fixed centre. The sword knob rests at the guard
//  position (near the top of its circle); letting go returns it there.
//  ?desktop=1 adds a mouse/keyboard fallback for development only.
// =====================================================================
import { SWORD_GUARD } from './fighter.js';

export class TouchSticks {
  constructor(root, opts = {}) {
    this.root = root;
    this.radius = opts.radius || 62;
    this.sticks = {
      move: { kind: 'move', x: 0, y: 0, id: null, cx: 0, cy: 0, el: this._makeEl('move') },
      sword: { kind: 'sword', x: SWORD_GUARD.x, y: SWORD_GUARD.y, id: null, cx: 0, cy: 0, el: this._makeEl('sword') },
    };
    this.enabled = false;
    this.onTap = null; // tap when sticks are disabled (menu)
    this._bind();
    this.keys = new Set();
    this.mouse = null;
    window.addEventListener('resize', () => this._layout());
  }
  _makeEl(kind) {
    const base = document.createElement('div'); base.className = 'stick ' + kind; base.hidden = true;
    const knob = document.createElement('div'); knob.className = 'knob'; base.appendChild(knob);
    const label = document.createElement('span'); label.className = 'stick-label'; label.textContent = kind === 'move' ? 'MOVE' : 'SWORD'; base.appendChild(label);
    this.root.appendChild(base);
    return { base, knob };
  }
  setRadius(r) { this.radius = r; this._layout(); }
  setEnabled(on) {
    this.enabled = on;
    for (const s of Object.values(this.sticks)) { this._release(s); s.el.base.hidden = !on; }
    this.root.classList.toggle('sticks-on', on);
    this._layout();
  }
  // size the circles and remember where their centres are on screen (CSS places them,
  // including the phone's safe-area insets)
  _layout() {
    const R = this.radius;
    for (const s of Object.values(this.sticks)) {
      const b = s.el.base;
      b.style.width = b.style.height = R * 2 + 'px';
      if (b.hidden) continue;
      const r = b.getBoundingClientRect();
      s.cx = r.left + r.width / 2; s.cy = r.top + r.height / 2;
      this._draw(s);
    }
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
  // the free stick closest to the touch, if the touch is reasonably near it
  _stickAt(x, y) {
    let best = null, bd = Infinity;
    for (const s of Object.values(this.sticks)) {
      if (s.id !== null) continue;
      const d = Math.hypot(x - s.cx, y - s.cy);
      if (d < bd) { bd = d; best = s; }
    }
    return best && bd < this.radius * 2.6 ? best : null;
  }
  _start(e) {
    if (!this.enabled) {
      for (const t of e.changedTouches) if (this.onTap) this.onTap(t.clientX, t.clientY);
      return;
    }
    e.preventDefault();
    if (!this.sticks.move.cx) this._layout();
    for (const t of e.changedTouches) {
      const s = this._stickAt(t.clientX, t.clientY);
      if (!s) continue;
      s.id = t.identifier;
      this._set(s, t.clientX, t.clientY);
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
  _set(s, px, py) {
    const R = this.radius;
    let nx = (px - s.cx) / R, ny = -(py - s.cy) / R;
    const l = Math.hypot(nx, ny); if (l > 1) { nx /= l; ny /= l; }
    s.x = nx; s.y = ny;
    s.el.base.classList.add('active');
    this._draw(s);
  }
  _draw(s) {
    const R = this.radius;
    s.el.knob.style.transform = `translate(${s.x * R}px, ${-s.y * R}px)`;
  }
  _release(s) {
    s.id = null;
    if (s.kind === 'sword') { s.x = SWORD_GUARD.x; s.y = SWORD_GUARD.y; } else { s.x = 0; s.y = 0; }
    s.el.base.classList.remove('active');
    this._draw(s);
  }
  _mouse(type, e) {
    if (!this.enabled) { if (type === 'down' && this.onTap) this.onTap(e.clientX, e.clientY); return; }
    if (type === 'down') {
      const s = this._stickAt(e.clientX, e.clientY); if (!s) return;
      this.mouse = s; s.id = 'm'; this._set(s, e.clientX, e.clientY);
    } else if (type === 'move' && this.mouse) this._set(this.mouse, e.clientX, e.clientY);
    else if (type === 'up' && this.mouse) { this._release(this.mouse); this.mouse = null; }
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
    return { mx, my, sx: s.x, sy: s.y };
  }
}
