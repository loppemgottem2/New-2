// =====================================================================
//  COMBAT.JS — cutting, stabbing, damage and bleeding.
//
//  When the moving edge of a blade touches a limb hard enough, the
//  normal collision between that blade and that limb is switched off
//  and a SLASH constraint takes over: the blade may only keep moving in
//  its own plane (fixed rotation, linear movement). Flesh drags on it,
//  and the deeper the edge travels through the limb's thickness the
//  more damage it does. Cut ~80 % through and the limb comes off at its
//  joint (both the stump and the flying limb bleed).
//
//  A fast push along the blade with the tip leading starts a STAB: the
//  sword locks its rotation to the limb and can only slide along its own
//  axis. If it keeps pushing it goes deeper; if it stalls it is released
//  and collision comes back once the blade is out. Stabbing the heart or
//  the head is instantly fatal; going all the way through a limb
//  disables it.
// =====================================================================
import { V3, Quat, quatToRotVec, clamp, closestSegSeg, smoothstep } from './math.js';
import { World, applyLinear, applyAngular, applyVelImpulse, genInvMassPos } from './physics.js';
import { LIMB_INFO, SWORD_GEO } from './fighter.js';
import { CONFIG } from './config.js';

const _a = new V3(), _b = new V3(), _c = new V3(), _d = new V3(), _e = new V3(), _q = new Quat(), _q2 = new Quat();
const _c1 = new V3(), _c2 = new V3(), _v1 = new V3(), _v2 = new V3(), _r1 = new V3(), _r2 = new V3(), _n = new V3();

// damage numbers per limb kind for a cut all the way through (fraction 1.0)
const KIND = {
  torso: { hp: 70, limb: 120, bleed: 6.5, resist: 1.6, stabHp: 55 },
  head:  { hp: 110, limb: 150, bleed: 8.0, resist: 1.3, stabHp: 100 },
  arm:   { hp: 20, limb: 135, bleed: 3.4, resist: 1.0, stabHp: 16 },
  hand:  { hp: 10, limb: 140, bleed: 2.0, resist: 0.8, stabHp: 8 },
  leg:   { hp: 24, limb: 135, bleed: 4.4, resist: 1.15, stabHp: 18 },
  foot:  { hp: 9, limb: 140, bleed: 2.0, resist: 0.8, stabHp: 7 },
};
const STUMP_BLEED = { head: 0, arm: 6.5, hand: 3.2, leg: 8.5, foot: 3.2 };
// heart: torso local position (character's left = +x local), radius
const HEART = new V3(0.055, 0.07, 0.04), HEART_R = 0.065;

function limbAxis(body, outA, outB) {
  const c = body.capsules[0];
  outA.copy(c.a).applyQuat(body.q).add(body.pos);
  outB.copy(c.b).applyQuat(body.q).add(body.pos);
  return c.r;
}

// ---------------------------------------------------------------------
class SlashCut {
  constructor(cm, sword, body, contactBlade, contactLimb, edgeSign) {
    this.type = 'slash';
    this.cm = cm; this.sword = sword; this.body = body;
    this.attacker = sword.owner; this.victim = body.owner; this.limb = body.limb;
    this.kind = LIMB_INFO[this.limb].kind;
    // plane = the blade plane at entry, stored in the limb frame
    const flat = _a.set(1, 0, 0).applyQuat(sword.q);
    this.nL = body.worldToLocal(_b.copy(flat).add(body.pos), new V3()).normalize();
    this.pL = body.worldToLocal(contactBlade, new V3());
    this.swordPt = sword.worldToLocal(contactBlade, new V3());
    this.flatSign = 1;
    // entry direction: from the entry point toward the limb axis (perpendicular to it)
    const A = new V3(), B = new V3();
    this.r = limbAxis(body, A, B);
    const axis = new V3().subVectors(B, A);
    const u = new V3().subVectors(contactLimb, contactBlade);
    if (axis.lenSq() > 1e-8) { axis.normalize(); u.addScaled(axis, -u.dot(axis)); }
    if (u.lenSq() < 1e-8) u.copy(_a.set(0, 0, 1).applyQuat(sword.q)).scale(edgeSign);
    u.normalize();
    this.uL = u.applyQuatInv(body.q).clone();
    this.progress = 0; this.depth = 0;
    this.age = 0; this.stall = 0; this.done = false; this.maxLambda = 0; this.maxAng = 0;
    this.entryWorld = contactBlade.clone();
    this.speed = 0;
  }
  solvePos(h) {
    const S = this.sword, Bd = this.body;
    const p = _c1.copy(this.swordPt).applyQuat(S.q).add(S.pos);
    const n = _n.copy(this.nL).applyQuat(Bd.q);
    const q = _c2.copy(this.pL).applyQuat(Bd.q).add(Bd.pos);
    const C = _d.subVectors(p, q).dot(n);
    _r1.subVectors(p, Bd.pos); _r2.subVectors(p, S.pos);
    const l = applyLinear(Bd, S, _r1, _r2, n, C, 1e-6, h);
    this.maxLambda = Math.max(this.maxLambda, Math.abs(l) / (h * h));
    // keep the blade's flat normal aligned with the cut plane
    const x = _e.set(1, 0, 0).applyQuat(S.q);
    if (x.dot(n) < 0) x.scale(-1);
    const rv = _d.crossVectors(x, n);
    const la = applyAngular(S, Bd, rv.x, rv.y, rv.z, 1e-5, h);
    this.maxAng = Math.max(this.maxAng, la / (h * h));
  }
  solveVel(h) {
    // flesh drags on the blade (in-plane relative motion)
    const S = this.sword, Bd = this.body;
    const p = _c1.copy(this.swordPt).applyQuat(S.q).add(S.pos);
    S.pointVelocity(p, _v1); Bd.pointVelocity(p, _v2);
    const dv = _v1.sub(_v2);
    const n = _n.copy(this.nL).applyQuat(Bd.q);
    dv.addScaled(n, -dv.dot(n));
    const m = dv.len(); if (m < 1e-5) return;
    const dir = _d.copy(dv).scale(1 / m);
    _r1.subVectors(p, S.pos); _r2.subVectors(p, Bd.pos);
    const w = genInvMassPos(S, _r1, dir) + genInvMassPos(Bd, _r2, dir);
    const f = Math.min(0.9, CONFIG.COMBAT.CUT_DRAG * KIND[this.kind].resist * h);
    dir.scale(-(m * f) / w);
    applyVelImpulse(S, Bd, _r1, _r2, dir);
  }
  // per frame: measure depth, deal damage, decide whether to finish
  update(dt) {
    const S = this.sword, Bd = this.body, CC = CONFIG.COMBAT;
    this.age += dt;
    const blade = S.capsules[0];
    const A = _a, B = _b; limbAxis(Bd, A, B);
    closestSegSeg(blade.wa, blade.wb, A, B, _c1, _c2);
    const u = _e.copy(this.uL).applyQuat(Bd.q);
    const dist = _c1.distTo(_c2);
    const d = this.r + _d.subVectors(_c1, _c2).dot(u);
    this.depth = d;
    // speed of the blade through the limb
    S.pointVelocity(_c1, _v1); Bd.pointVelocity(_c1, _v2);
    this.speed = _v1.sub(_v2).len();
    if (d > this.progress) {
      const frac = (d - this.progress) / (2 * this.r);
      this.progress = d;
      this.cm.damageCut(this, frac);
    }
    if (this.speed < CC.CUT_MIN_SPEED) this.stall += dt; else this.stall = 0;
    const out = d < -0.015 || dist > this.r + SWORD_GEO.bladeR + 0.03;
    if (this.progress / (2 * this.r) >= CC.SEVER_DEPTH && this.kind !== 'torso') { this.cm.severFromCut(this); return this.finish('sever'); }
    if (this.progress / (2 * this.r) >= 0.62 && this.kind === 'torso') { this.cm.fatalTorso(this); }
    if (out) return this.finish('out');
    if (this.stall > CC.STALL_TIME) return this.finish('stall');
    if (this.maxLambda > CC.BREAK_FORCE || this.maxAng > 140) return this.finish('break');
    if (this.age > 0.7 || this.victim.detached[this.limb] || !this.attacker.swordHeld) return this.finish('end');
    this.maxLambda = 0; this.maxAng = 0;
  }
  finish(why) { this.done = true; this.why = why; }
}

// ---------------------------------------------------------------------
class StabCut {
  constructor(cm, sword, body, tipWorld) {
    this.type = 'stab';
    this.cm = cm; this.sword = sword; this.body = body;
    this.attacker = sword.owner; this.victim = body.owner; this.limb = body.limb;
    this.kind = LIMB_INFO[this.limb].kind;
    const A = new V3(), B = new V3();
    this.r = limbAxis(body, A, B);
    this.entryL = body.worldToLocal(tipWorld, new V3());
    this.qRel = body.q.clone().conjugate().multiply(sword.q);
    this.tipLocal = new V3(0, SWORD_GEO.tipY - 0.01, 0);
    this.progress = 0; this.depth = 0; this.age = 0; this.stall = 0; this.done = false; this.maxLambda = 0;
    this.through = false;
    this.entryWorld = tipWorld.clone();
  }
  solvePos(h) {
    const S = this.sword, Bd = this.body;
    // rotation locked to the limb
    _q.copy(Bd.q).multiply(this.qRel);
    _q2.copy(S.q).conjugate(); _q.multiply(_q2);
    const rv = quatToRotVec(_q, _d);
    applyAngular(S, Bd, rv.x, rv.y, rv.z, 2e-5, h);
    // blade line passes through the entry point
    const T = _c1.copy(this.tipLocal).applyQuat(S.q).add(S.pos);
    const a = _e.set(0, 1, 0).applyQuat(S.q);
    const E = _c2.copy(this.entryL).applyQuat(Bd.q).add(Bd.pos);
    const c = _a.copy(T).addScaled(a, _b.subVectors(E, T).dot(a));
    const err = _b.subVectors(E, c);
    const el = err.len();
    if (el > 1e-7) {
      err.scale(1 / el);
      _r1.subVectors(c, S.pos); _r2.subVectors(E, Bd.pos);
      const l = applyLinear(S, Bd, _r1, _r2, err, el, 1e-6, h);
      this.maxLambda = Math.max(this.maxLambda, Math.abs(l) / (h * h));
    }
  }
  solveVel(h) {
    const S = this.sword, Bd = this.body;
    const T = _c1.copy(this.tipLocal).applyQuat(S.q).add(S.pos);
    const a = _e.set(0, 1, 0).applyQuat(S.q);
    S.pointVelocity(T, _v1); Bd.pointVelocity(T, _v2);
    const along = _v1.sub(_v2).dot(a);
    if (Math.abs(along) < 1e-5) return;
    _r1.subVectors(T, S.pos); _r2.subVectors(T, Bd.pos);
    const w = genInvMassPos(S, _r1, a) + genInvMassPos(Bd, _r2, a);
    const f = Math.min(0.9, CONFIG.COMBAT.STAB_DRAG * KIND[this.kind].resist * h * (along < 0 ? 0.5 : 1));
    _d.copy(a).scale(-(along * f) / w);
    applyVelImpulse(S, Bd, _r1, _r2, _d);
  }
  update(dt) {
    const S = this.sword, Bd = this.body, CC = CONFIG.COMBAT;
    this.age += dt;
    const T = _c1.copy(this.tipLocal).applyQuat(S.q).add(S.pos);
    const a = _e.set(0, 1, 0).applyQuat(S.q);
    const E = _c2.copy(this.entryL).applyQuat(Bd.q).add(Bd.pos);
    const d = _d.subVectors(T, E).dot(a);
    this.depth = d;
    S.pointVelocity(T, _v1); Bd.pointVelocity(T, _v2);
    const along = _v1.sub(_v2).dot(a);
    if (d > this.progress) {
      const frac = (d - this.progress) / (2 * this.r);
      this.progress = d;
      this.cm.damageStab(this, frac, T);
    }
    // gone all the way through?
    if (!this.through && this.kind !== 'torso' && this.kind !== 'head') {
      const A = _a, B = _b; limbAxis(Bd, A, B);
      closestSegSeg(T, T, A, B, _v1, _v2);
      if (_v1.distTo(_v2) > this.r && d > this.r * 1.2) { this.through = true; this.cm.stabThrough(this); }
    }
    if (along < 0.25) this.stall += dt; else this.stall = 0;
    if (d < -0.01) return this.finish('out');
    if (this.stall > 0.35) return this.finish('stall');
    if (this.maxLambda > CC.BREAK_FORCE * 1.3) return this.finish('break');
    if (this.age > 1.6 || this.victim.detached[this.limb] || !this.attacker.swordHeld) return this.finish('end');
    this.maxLambda = 0;
  }
  finish(why) { this.done = true; this.why = why; }
}

// ---------------------------------------------------------------------
export class Combat {
  constructor(world, fighters) {
    this.world = world;
    this.fighters = fighters;
    this.cuts = [];
    this.separating = []; // {sword, body, key, t}
    this.events = [];
    this.time = 0;
    this.clashCool = 0;
    this.enabled = true;
    world.contactHook = (a, b, ia, ib, c, pa, pb) => this._onContact(a, b, ia, ib, c, pa, pb);
    world.onBodyImpact = (a, b, speed, c) => this._onImpact(a, b, speed, c);
  }

  _onContact(a, b, ia, ib, c, pa, pb) {
    if (!this.enabled) return true;
    const sa = a.tag === 'sword', sb = b.tag === 'sword';
    if (sa && sb) {
      if (this.clashCool <= 0) {
        a.pointVelocity(pa, _v1); b.pointVelocity(pb, _v2);
        const sp = _v1.sub(_v2).len();
        if (sp > 1.4) { this.events.push({ type: 'clash', x: pa.x, y: pa.y, z: pa.z, power: Math.min(1, sp / 8) }); this.clashCool = 0.09; }
      }
      return true;
    }
    if (sa === sb) return true;
    const sword = sa ? a : b, body = sa ? b : a;
    const swordPt = sa ? pa : pb, limbPt = sa ? pb : pa;
    const sIdx = sa ? ia : ib;
    if (sIdx !== 0 || body.tag !== 'limb') return true;
    const att = sword.owner, vic = body.owner;
    if (!att || !vic || att === vic || !att.alive || !att.swordHeld) return true;
    if (vic.detached[body.limb]) return true;
    // one stab at a time per sword, max two cuts
    let active = 0;
    for (const ct of this.cuts) if (ct.sword === sword) { active++; if (ct.type === 'stab' || ct.body === body) return true; }
    if (active >= 2) return true;
    // relative velocity of the blade at the contact
    sword.pointVelocity(swordPt, _v1); body.pointVelocity(swordPt, _v2);
    const v = _v1.sub(_v2);
    const Y = _a.set(0, 1, 0).applyQuat(sword.q), Z = _b.set(0, 0, 1).applyQuat(sword.q), X = _c.set(1, 0, 0).applyQuat(sword.q);
    // into-limb direction (from blade toward limb axis)
    const into = _d.subVectors(limbPt, swordPt); const il = into.len();
    if (il > 1e-6) into.scale(1 / il); else into.copy(c.n).scale(sa ? -1 : 1);
    // position along the blade (0 guard .. 1 tip)
    const bl = sword.capsules[0];
    const segL = bl.wb.distTo(bl.wa);
    const t = segL > 1e-6 ? _e.subVectors(swordPt, bl.wa).dot(Y) / segL : 0;
    const CC = CONFIG.COMBAT;
    const va = v.dot(Y), ve = v.dot(Z), vf = v.dot(X);
    const yIn = Y.dot(into);
    const fastStab = va > CC.STAB_SPEED && yIn > 0.3;
    const pressStab = (att.thrust || 0) > 0.55 && va > 0.2 && yIn > 0.45; // pushing a thrust into the body
    if (t > 0.86 && (fastStab || pressStab)) {
      const tip = new V3(0, SWORD_GEO.tipY - 0.01, 0).applyQuat(sword.q).add(sword.pos);
      this._start(new StabCut(this, sword, body, tip));
      return false;
    }
    const edgeSign = Math.sign(ve) || 1;
    if (Math.abs(ve) > CC.SLASH_SPEED && Math.abs(ve) > Math.abs(vf) * 1.1 && Z.dot(into) * edgeSign > 0.15) {
      this._start(new SlashCut(this, sword, body, swordPt.clone(), limbPt.clone(), edgeSign));
      return false;
    }
    // blunt hit with the flat or a slow edge
    const vn = Math.abs(v.dot(into));
    if (vn > 3.5 && this.clashCool <= 0) {
      this.events.push({ type: 'thud', x: swordPt.x, y: swordPt.y, z: swordPt.z, power: Math.min(1, vn / 9) });
      this.clashCool = 0.06;
    }
    return true;
  }

  _onImpact(a, b, speed, c) {
    // body-body thumps (limbs hitting each other) -> sound only
    if (speed > 3 && this.clashCool <= 0 && a.tag === 'limb' && b.tag === 'limb' && a.owner !== b.owner) {
      const p = _a.addVectors(a.pos, c.r1);
      this.events.push({ type: 'thud', x: p.x, y: p.y, z: p.z, power: Math.min(1, speed / 8) * 0.6 });
      this.clashCool = 0.06;
    }
  }

  _start(cut) {
    this.cuts.push(cut);
    this.world.addConstraint(cut);
    cut.key = World.pairKey(cut.sword, cut.body);
    this.world.ignore.add(cut.key);
    const p = cut.entryWorld;
    this.events.push({ type: cut.type === 'stab' ? 'stab' : 'slash', x: p.x, y: p.y, z: p.z, victim: cut.victim.id, limb: cut.limb });
  }

  update(dt) {
    this.time += dt;
    this.clashCool -= dt;
    for (const cut of this.cuts) if (!cut.done) cut.update(dt);
    for (let i = this.cuts.length - 1; i >= 0; i--) {
      const cut = this.cuts[i];
      if (!cut.done) continue;
      this.world.removeConstraint(cut);
      this.cuts.splice(i, 1);
      this.separating.push({ sword: cut.sword, body: cut.body, key: cut.key, t: 0 });
    }
    // keep collision off until the blade has left the limb
    for (let i = this.separating.length - 1; i >= 0; i--) {
      const s = this.separating[i];
      s.t += dt;
      const busy = this.cuts.some((c) => c.key === s.key);
      if (busy) { this.separating.splice(i, 1); continue; }
      const blade = s.sword.capsules[0], lc = s.body.capsules[0];
      closestSegSeg(blade.wa, blade.wb, lc.wa, lc.wb, _c1, _c2);
      if (_c1.distTo(_c2) > blade.r + lc.r + 0.01 || s.t > 1.2) {
        this.world.ignore.delete(s.key);
        this.separating.splice(i, 1);
      }
    }
    // bleeding
    for (const f of this.fighters) this._bleed(f, dt);
  }

  // ------------------------------------------------------------ damage
  _hit(f, limb, hpDmg, limbDmg) {
    if (!f.alive) { f.limbHp[limb] = Math.max(0, f.limbHp[limb] - limbDmg); return; }
    f.hp -= hpDmg;
    f.limbHp[limb] = Math.max(0, f.limbHp[limb] - limbDmg);
    f.lastHitTime = f.time;
    if (f.limbHp[limb] <= 0) {
      if (limb === 'head' || limb === 'torso') this.kill(f, limb === 'head' ? 'head' : 'torso');
      else if (!f.disabled[limb]) { f.disable(limb); this.events.push({ type: 'disable', victim: f.id, limb }); }
    }
    if (f.hp <= 0) this.kill(f, 'damage');
  }
  _addWound(f, body, worldPt, rate, opts = {}) {
    if (rate <= 0.05) return;
    // merge with a close existing wound on the same body
    const local = body.worldToLocal(worldPt, new V3());
    for (const w of f.wounds) {
      if (w.body === body && !w.stump && !opts.stump && w.local.distTo(local) < 0.05) { w.rate0 = w.rate0 * Math.exp(-(this.time - w.t0) / CONFIG.COMBAT.BLEED_DECAY) + rate; w.t0 = this.time; return w; }
    }
    const w = { body, local, rate0: rate, t0: this.time, stump: !!opts.stump, detachedPart: !!opts.detachedPart, size: opts.size ?? clamp(rate / 5, 0.25, 1) };
    f.wounds.push(w);
    return w;
  }
  damageCut(cut, frac) {
    const K = KIND[cut.kind], f = cut.victim;
    this._hit(f, cut.limb, K.hp * frac, K.limb * frac);
    const depthFrac = cut.progress / (2 * cut.r);
    if (depthFrac > 0.06) {
      const pt = cut.entryWorld;
      this._addWound(f, cut.body, pt, K.bleed * frac * 2.2, { size: clamp(depthFrac, 0.3, 1) });
    }
    this.events.push({ type: 'cutting', x: cut.entryWorld.x, y: cut.entryWorld.y, z: cut.entryWorld.z, amount: frac, victim: f.id, limb: cut.limb });
  }
  damageStab(cut, frac, tipWorld) {
    const K = KIND[cut.kind], f = cut.victim;
    this._hit(f, cut.limb, K.stabHp * frac, K.limb * frac * 0.8);
    if (cut.progress / (2 * cut.r) > 0.05) this._addWound(f, cut.body, cut.entryWorld, K.bleed * frac * 2.4, { size: 0.5 });
    // vital organs
    if (cut.kind === 'head' && cut.progress > CONFIG.COMBAT.HEAD_STAB_KILL * cut.r) this.kill(f, 'head-stab');
    if (cut.kind === 'torso') {
      const local = cut.body.worldToLocal(tipWorld, _a);
      if (local.distTo(HEART) < HEART_R) { this.kill(f, 'heart'); this.events.push({ type: 'vital', victim: f.id, x: tipWorld.x, y: tipWorld.y, z: tipWorld.z }); }
      else if (cut.progress > cut.r * 1.7) this._hit(f, 'torso', 1.2 * frac * 60, 0);
    }
    this.events.push({ type: 'cutting', x: tipWorld.x, y: tipWorld.y, z: tipWorld.z, amount: frac, victim: f.id, limb: cut.limb });
  }
  stabThrough(cut) {
    const f = cut.victim;
    f.limbHp[cut.limb] = 0;
    this._hit(f, cut.limb, KIND[cut.kind].hp * 0.4, 0);
    this._addWound(f, cut.body, cut.entryWorld, KIND[cut.kind].bleed * 0.8, { size: 0.7 });
    if (!f.disabled[cut.limb]) { f.disable(cut.limb); this.events.push({ type: 'disable', victim: f.id, limb: cut.limb }); }
  }
  fatalTorso(cut) {
    if (cut.victim.alive) { this._addWound(cut.victim, cut.body, cut.entryWorld, 9, { size: 1 }); this.kill(cut.victim, 'torso-cut'); }
  }
  severFromCut(cut) { this.sever(cut.victim, cut.limb, cut.entryWorld); }
  sever(f, limb, at) {
    if (f.detached[limb]) return;
    const info = LIMB_INFO[limb];
    const j = f.joints[info.joint];
    const parent = f.parts[info.parent], child = f.parts[limb];
    const anchorP = j ? parent.localToWorld(j.r1, new V3()) : child.pos.clone();
    const anchorC = j ? child.localToWorld(j.r2, new V3()) : child.pos.clone();
    const removed = f.sever(limb);
    // give the flying part a little extra kick away from the body
    const away = new V3().subVectors(child.pos, parent.pos); away.y = Math.max(away.y, 0) + 0.3; away.normalize();
    child.vel.addScaled(away, 1.2);
    const kind = info.kind;
    if (f.alive) this._addWound(f, parent, anchorP, STUMP_BLEED[kind] ?? 4, { stump: true, size: 1 });
    this._addWound(f, child, anchorC, 4, { stump: true, detachedPart: true, size: 0.9 });
    this._hit(f, limb, KIND[kind].hp * 0.35, 0);
    if (limb === 'head') this.kill(f, 'decapitated');
    this.events.push({ type: 'sever', victim: f.id, limb, removed, x: anchorP.x, y: anchorP.y, z: anchorP.z });
    void at;
  }
  kill(f, why) {
    if (!f.alive) return;
    f.kill();
    this.events.push({ type: 'death', victim: f.id, why });
  }

  _bleed(f, dt) {
    const tau = CONFIG.COMBAT.BLEED_DECAY;
    let rate = 0, pending = 0;
    for (let i = f.wounds.length - 1; i >= 0; i--) {
      const w = f.wounds[i];
      const age = this.time - w.t0;
      w.rate = w.rate0 * Math.exp(-age / tau);
      if (w.rate < 0.02 && age > 2) { if (!w.stump && !w.mark) w.mark = true; }
      if (w.detachedPart) continue;
      rate += w.rate; pending += w.rate * tau;
    }
    f.bleedRate = rate;
    f.bleedPending = pending; // hp this fighter is still going to lose if nothing else happens
    if (f.alive && rate > 0) {
      f.hp -= rate * dt;
      if (f.hp <= 0) this.kill(f, 'bled out');
    }
  }

  // remove all cut state (new round)
  reset() {
    for (const c of this.cuts) this.world.removeConstraint(c);
    this.cuts.length = 0;
    this.separating.length = 0;
    this.world.ignore.clear();
    this.events.length = 0;
  }
}
