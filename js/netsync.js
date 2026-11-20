// =====================================================================
//  NETSYNC.JS — what the host sends to the guest (snapshots) and the
//  guest-side "mirror" that replays them smoothly.
// =====================================================================
import { LIMB_NAMES } from './fighter.js';
import { V3, Quat } from './math.js';

const r3 = (v) => Math.round(v * 1000) / 1000;
const r4 = (v) => Math.round(v * 10000) / 10000;
const r1 = (v) => Math.round(v * 10) / 10;
const BODY_ORDER = [...LIMB_NAMES, 'sword'];

export function encodeSnapshot(match, seq, events) {
  const b = [];
  for (const f of match.fighters) for (const n of BODY_ORDER) {
    const body = n === 'sword' ? f.sword : f.parts[n];
    b.push(r3(body.pos.x), r3(body.pos.y), r3(body.pos.z), r4(body.q.x), r4(body.q.y), r4(body.q.z), r4(body.q.w));
  }
  const fs = match.fighters.map((f) => ({
    hp: r1(f.hp), a: f.alive ? 1 : 0, fl: f.fallen ? 1 : 0, br: r1(f.bleedRate || 0), bp: r1(f.bleedPending || 0),
    lh: LIMB_NAMES.map((n) => Math.round(f.limbHp[n])),
    dt: LIMB_NAMES.reduce((a, n, i) => a | (f.detached[n] ? 1 << i : 0), 0),
    ds: LIMB_NAMES.reduce((a, n, i) => a | (f.disabled[n] ? 1 << i : 0), 0),
    sh: f.swordHeld ? 1 : 0,
    w: f.wounds.map((w) => [LIMB_NAMES.indexOf(w.limb), r3(w.local.x), r3(w.local.y), r3(w.local.z), r1(w.rate || 0), (w.stump ? 1 : 0) | (w.detachedPart ? 2 : 0), r1(w.size ?? 0.5)]),
  }));
  return { t: 's', n: seq, b, g: [match.state, r1(match.timer), match.round, match.scores[0], match.scores[1], match.matchWinner, match.survivor ?? -1], f: fs, ev: events };
}

function mirrorBody() { return { pos: new V3(), q: new Quat(), vel: new V3(), _a: new V3(), _b: new V3(), _qa: new Quat(), _qb: new Quat() }; }

export class Mirror {
  constructor(names) {
    this.names = names;
    this.fighters = [0, 1].map((id) => {
      const parts = {};
      for (const n of LIMB_NAMES) parts[n] = mirrorBody();
      const limbHp = {}, detached = {}, disabled = {};
      for (const n of LIMB_NAMES) { limbHp[n] = 100; detached[n] = false; disabled[n] = false; }
      return { id, name: names[id], parts, sword: mirrorBody(), limbHp, detached, disabled, alive: true, hp: 100, bleedRate: 0, bleedPending: 0, wounds: [], swordHeld: true, fallen: false };
    });
    this.scores = [0, 0]; this.round = 1; this.state = 'intro'; this.timer = 0; this.matchWinner = -1; this.survivor = -1;
    this.buf = [];
    this.events = [];
    this.delay = 0.1;
    this.got = false;
  }
  push(s, now) {
    this.got = true;
    this.buf.push({ time: now, b: s.b });
    if (this.buf.length > 6) this.buf.shift();
    const [st, tm, round, s0, s1, mw, sv] = s.g;
    this.state = st; this.timer = tm; this.round = round; this.scores = [s0, s1]; this.matchWinner = mw; this.survivor = sv;
    s.f.forEach((d, i) => {
      const f = this.fighters[i];
      f.hp = d.hp; f.alive = !!d.a; f.fallen = !!d.fl; f.bleedRate = d.br; f.bleedPending = d.bp; f.swordHeld = !!d.sh;
      LIMB_NAMES.forEach((n, k) => { f.limbHp[n] = d.lh[k]; f.detached[n] = !!(d.dt & (1 << k)); f.disabled[n] = !!(d.ds & (1 << k)); });
      if (d.w.length < f.wounds.length) f.wounds = [];
      d.w.forEach((w, k) => {
        const o = f.wounds[k] || (f.wounds[k] = { local: new V3() });
        o.limb = LIMB_NAMES[w[0]]; o.local.set(w[1], w[2], w[3]); o.rate = w[4]; o.stump = !!(w[5] & 1); o.detachedPart = !!(w[5] & 2); o.size = w[6];
      });
    });
    for (const e of s.ev || []) this.events.push(e);
  }
  // interpolate body transforms for "now - delay"
  update(now) {
    if (this.buf.length === 0) return;
    const t = now - this.delay;
    let a = this.buf[0], b = this.buf[this.buf.length - 1];
    for (let i = 0; i < this.buf.length - 1; i++) {
      if (this.buf[i].time <= t && this.buf[i + 1].time >= t) { a = this.buf[i]; b = this.buf[i + 1]; break; }
    }
    const span = b.time - a.time;
    const k = span > 1e-4 ? Math.max(0, Math.min(1.2, (t - a.time) / span)) : 1;
    let idx = 0;
    for (const f of this.fighters) {
      for (const n of [...LIMB_NAMES, 'sword']) {
        const body = n === 'sword' ? f.sword : f.parts[n];
        const o = idx * 7; idx++;
        body._a.set(a.b[o], a.b[o + 1], a.b[o + 2]); body._b.set(b.b[o], b.b[o + 1], b.b[o + 2]);
        const px = body.pos.x, py = body.pos.y, pz = body.pos.z;
        body.pos.copy(body._a).lerp(body._b, k);
        body._qa.set(a.b[o + 3], a.b[o + 4], a.b[o + 5], a.b[o + 6]); body._qb.set(b.b[o + 3], b.b[o + 4], b.b[o + 5], b.b[o + 6]);
        body.q.copy(body._qa).slerp(body._qb, Math.min(1, k));
        body.vel.set((body.pos.x - px) * 60, (body.pos.y - py) * 60, (body.pos.z - pz) * 60);
      }
    }
  }
}
