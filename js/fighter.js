// =====================================================================
//  FIGHTER.JS — the 14-part physical stickman and his muscles.
//
//  Body parts (all real rigid bodies in the physics world):
//    torso, head,
//    upper arm / forearm / ball hand  (x2),
//    thigh / shin / rounded box foot  (x2)
//  plus the sword, held by both hands (two ball-joint "grips").
//
//  Nothing is animated: every pose comes from joint motors ("muscles")
//  pulling the limbs toward targets computed each frame by
//    * a stepping controller: feet are lifted and placed by IK, the
//      stance leg pushes the body over its feet, and new steps are
//      taken whenever the capture point (where the body is falling to)
//      leaves the area between the feet,
//    * stance-hip torque that holds the torso upright against the leg
//      that stands on the ground (so balance needs a foot on the floor),
//    * an arm controller that drives the sword toward a target pose
//      chosen with the right joystick. The force goes through the torso,
//      so hard swings really do push the swordsman around.
// =====================================================================
import { V3, Quat, clamp, lerp, smoothstep, wrapAngle } from './math.js';
import {
  Body, Joint, capsuleInertia, sphereInertia, boxInertia,
  DRIVE_OFF, DRIVE_REL, DRIVE_CHILD_WORLD, DRIVE_PARENT_WORLD,
  applyLinear, applyAngular, applyVelImpulse, applyAngVelImpulse, genInvMassPos, genInvMassRot,
} from './physics.js';
import { CONFIG } from './config.js';

const UP = new V3(0, 1, 0);

// ---------------------------------------------------------------------
//  Static description of the body
// ---------------------------------------------------------------------
// kind: used by combat for damage / bleeding rules
export const LIMB_INFO = {
  torso:  { kind: 'torso', mass: 32,  r: 0.15,  hpMul: 1.0,  bleed: 1.0 },
  head:   { kind: 'head',  mass: 5,   r: 0.12,  hpMul: 1.4,  bleed: 1.2, parent: 'torso', joint: 'neck' },
  uArmR:  { kind: 'arm',   mass: 2.2, r: 0.055, hpMul: 0.45, bleed: 0.8, parent: 'torso', joint: 'shoulderR' },
  fArmR:  { kind: 'arm',   mass: 1.5, r: 0.05,  hpMul: 0.4,  bleed: 0.7, parent: 'uArmR', joint: 'elbowR' },
  handR:  { kind: 'hand',  mass: 0.5, r: 0.055, hpMul: 0.3,  bleed: 0.5, parent: 'fArmR', joint: 'wristR' },
  uArmL:  { kind: 'arm',   mass: 2.2, r: 0.055, hpMul: 0.45, bleed: 0.8, parent: 'torso', joint: 'shoulderL' },
  fArmL:  { kind: 'arm',   mass: 1.5, r: 0.05,  hpMul: 0.4,  bleed: 0.7, parent: 'uArmL', joint: 'elbowL' },
  handL:  { kind: 'hand',  mass: 0.5, r: 0.055, hpMul: 0.3,  bleed: 0.5, parent: 'fArmL', joint: 'wristL' },
  thighR: { kind: 'leg',   mass: 8,   r: 0.075, hpMul: 0.55, bleed: 1.0, parent: 'torso', joint: 'hipR' },
  shinR:  { kind: 'leg',   mass: 3.8, r: 0.06,  hpMul: 0.45, bleed: 0.8, parent: 'thighR', joint: 'kneeR' },
  footR:  { kind: 'foot',  mass: 1.2, r: 0.05,  hpMul: 0.3,  bleed: 0.5, parent: 'shinR', joint: 'ankleR' },
  thighL: { kind: 'leg',   mass: 8,   r: 0.075, hpMul: 0.55, bleed: 1.0, parent: 'torso', joint: 'hipL' },
  shinL:  { kind: 'leg',   mass: 3.8, r: 0.06,  hpMul: 0.45, bleed: 0.8, parent: 'thighL', joint: 'kneeL' },
  footL:  { kind: 'foot',  mass: 1.2, r: 0.05,  hpMul: 0.3,  bleed: 0.5, parent: 'shinL', joint: 'ankleL' },
};
export const LIMB_NAMES = Object.keys(LIMB_INFO);
export const CHILDREN = {};
for (const n of LIMB_NAMES) CHILDREN[n] = [];
for (const n of LIMB_NAMES) if (LIMB_INFO[n].parent) CHILDREN[LIMB_INFO[n].parent].push(n);

// geometry (character local: forward +Z, up +Y, right = -X)
export const GEO = {
  torsoY: 1.20, torsoHalf: 0.15, torsoR: 0.15,
  headY: 1.655, headR: 0.12, neckY: 1.535,
  shoulderX: 0.21, shoulderY: 1.42, uArmLen: 0.28, fArmLen: 0.26, handR: 0.055, handOff: 0.05,
  hipX: 0.10, hipY: 0.96, thighLen: 0.43, shinLen: 0.43,
  foot: { w: 0.10, h: 0.08, l: 0.25, fwd: 0.05 }, ankleY: 0.10,
};

// sword geometry (sword local: +Y blade axis toward tip, +Z edge direction, +X flat normal)
export const SWORD_GEO = {
  pommelY: -0.36, gripTop: -0.135, gripBottom: -0.33, guardY: -0.12, guardHalf: 0.105,
  bladeStart: -0.11, tipY: 0.80, bladeWidth: 0.046, bladeThick: 0.009,
  gripR: new V3(0, -0.175, 0), gripL: new V3(0, -0.29, 0), gripCenter: new V3(0, -0.232, 0),
  bladeR: 0.022,
};

// ---------------------------------------------------------------------
//  Small helpers
// ---------------------------------------------------------------------
const _a = new V3(), _b = new V3(), _c = new V3(), _d = new V3(), _e = new V3(), _f = new V3();
const _q = new Quat(), _q2 = new Quat();

// Two-bone IK. Writes unit directions of both bones; returns the clamped reach.
function ik2(root, target, l1, l2, pole, outD1, outD2) {
  const u = _a.subVectors(target, root);
  let D = u.len();
  if (D < 1e-6) { u.set(0, -1, 0); D = 1e-6; } else u.scale(1 / D);
  const Dc = clamp(D, Math.abs(l1 - l2) + 0.02, l1 + l2 - 0.002);
  const cosA = clamp((l1 * l1 + Dc * Dc - l2 * l2) / (2 * l1 * Dc), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  const pp = _b.copy(pole).addScaled(u, -pole.dot(u));
  if (pp.lenSq() < 1e-8) { pp.set(0, 0, 1).addScaled(u, -u.z); }
  pp.normalize();
  // joint position relative to root
  _c.copy(u).scale(l1 * cosA).addScaled(pp, l1 * sinA);
  outD1.copy(_c).scale(1 / l1);
  // end = u*Dc
  outD2.copy(u).scale(Dc).sub(_c).normalize();
  return Dc;
}

// Orientations of a two-bone limb (hinge between them about local X).
// bendSign +1: child bends toward +Z of parent (arms); -1: toward -Z (legs).
const _x1 = new V3(), _y1 = new V3(), _z1 = new V3(), _y2 = new V3(), _z2 = new V3();
function limbOrient(d1, d2, bendSign, fallbackZ, q1, q2) {
  _y1.copy(d1).scale(-1);
  _z1.copy(d2).addScaled(d1, -d2.dot(d1));
  if (_z1.lenSq() < 1e-6) _z1.copy(fallbackZ).addScaled(_y1, -fallbackZ.dot(_y1));
  _z1.normalize().scale(bendSign);
  _x1.crossVectors(_y1, _z1).normalize();
  _z1.crossVectors(_x1, _y1);
  q1.setFromBasis(_x1, _y1, _z1);
  _y2.copy(d2).scale(-1);
  _z2.crossVectors(_x1, _y2).normalize();
  q2.setFromBasis(_x1, _y2, _z2);
}

function setDrive(j, mode, k, damp, maxT) {
  j.driveMode = k > 0 ? mode : DRIVE_OFF; j.stiffness = k; j.damping = damp; j.maxTorque = maxT;
}

// ---------------------------------------------------------------------
//  Sword drive: soft 6-DOF link torso -> sword (the arms' strength)
// ---------------------------------------------------------------------
class SwordDrive {
  constructor(f) {
    this.f = f;
    this.localPos = new V3();  // target grip-center in torso local frame
    this.localQ = new Quat();  // target sword orientation in torso local frame
    this.strength = 1;
    this.enabled = true;
    this._tw = new V3(); this._gw = new V3(); this._r1 = new V3(); this._r2 = new V3(); this._n = new V3();
    this._q = new Quat(); this._rv = new V3(); this._v1 = new V3(); this._v2 = new V3();
  }
  solvePos(h) {
    const s = this.strength; if (!this.enabled || s <= 0.01) return;
    const torso = this.f.parts.torso, sword = this.f.sword, C = CONFIG.SWORD;
    const tw = this._tw.copy(this.localPos).applyQuat(torso.q).add(torso.pos);
    const gw = this._gw.copy(SWORD_GEO.gripCenter).applyQuat(sword.q).add(sword.pos);
    const n = this._n.subVectors(tw, gw); const dist = n.len();
    if (dist > 1e-7) {
      n.scale(1 / dist);
      this._r1.subVectors(gw, sword.pos); this._r2.subVectors(tw, torso.pos);
      applyLinear(sword, torso, this._r1, this._r2, n, dist, 1 / (C.LIN_STIFF * s), h, C.MAX_FORCE * s * h * h);
    }
    const q = this._q.copy(torso.q).multiply(this.localQ);
    _q2.copy(sword.q).conjugate(); q.multiply(_q2);
    if (q.w < 0) { q.x = -q.x; q.y = -q.y; q.z = -q.z; q.w = -q.w; }
    const sn = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z);
    if (sn > 1e-8) {
      const ang = 2 * Math.atan2(sn, q.w), k = ang / sn;
      applyAngular(sword, torso, q.x * k, q.y * k, q.z * k, 1 / (C.ANG_STIFF * s), h, C.MAX_TORQUE * s * h * h);
    }
  }
  solveVel(h) {
    const s = this.strength; if (!this.enabled || s <= 0.01) return;
    const torso = this.f.parts.torso, sword = this.f.sword, C = CONFIG.SWORD;
    const gw = this._gw.copy(SWORD_GEO.gripCenter).applyQuat(sword.q).add(sword.pos);
    sword.pointVelocity(gw, this._v1); torso.pointVelocity(gw, this._v2);
    const dv = this._v1.sub(this._v2);
    const m = dv.len();
    if (m > 1e-6) {
      const n = this._n.copy(dv).scale(1 / m);
      this._r1.subVectors(gw, sword.pos); this._r2.subVectors(gw, torso.pos);
      const w = genInvMassPos(sword, this._r1, n) + genInvMassPos(torso, this._r2, n);
      const f = Math.min(1, C.LIN_DAMP * s * h);
      n.scale(-(m * f) / w);
      applyVelImpulse(sword, torso, this._r1, this._r2, n);
    }
    const dw = this._rv.subVectors(sword.angVel, torso.angVel);
    const mw = dw.len();
    if (mw > 1e-6) {
      const n = this._n.copy(dw).scale(1 / mw);
      const w = genInvMassRot(sword, n) + genInvMassRot(torso, n);
      const f = Math.min(1, C.ANG_DAMP * s * h);
      n.scale(-(mw * f) / w);
      applyAngVelImpulse(sword, torso, n);
    }
  }
}

// ---------------------------------------------------------------------
//  Fighter
// ---------------------------------------------------------------------
let FIGHTER_ID = 0;

export class Fighter {
  constructor(world, o = {}) {
    this.id = o.id ?? FIGHTER_ID++;
    this.world = world;
    this.name = o.name || 'Fighter';
    this.yaw = o.yaw ?? 0;
    this.origin = new V3(o.x ?? 0, 0, o.z ?? 0);
    this.parts = {};
    this.joints = {};
    this.bodies = [];
    this.input = { mx: 0, mz: 0, sx: 0, sy: 0 }; // world move dir (x,z) & sword stick
    this.opponent = null;
    this.alive = true;
    this.deathTime = 0;
    this.hp = CONFIG.FIGHTER.HP;
    this.limbHp = {}; this.disabled = {}; this.detached = {};
    for (const n of LIMB_NAMES) { this.limbHp[n] = CONFIG.FIGHTER.LIMB_HP; this.disabled[n] = false; this.detached[n] = false; }
    this.wounds = [];        // {body, local:V3, normal:V3, rate, t0, severed}
    this.bleedRate = 0;      // hp per second currently draining
    this.swordHeld = true;
    this.gripActive = { R: true, L: true };
    this.fallen = false; this.fallenTime = 0; this.gettingUp = 0;
    this.time = 0;
    this.lastHitTime = -10;
    this.pedestal = !!o.pedestal; // menu mode: never walk
    this._initControl();
    this._build(o);
  }

  // ------------------------------------------------------------- build
  _local(x, y, z, out) {
    // local character coords -> world
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    return out.set(this.origin.x + x * c + z * s, y, this.origin.z - x * s + z * c);
  }
  _part(name, mass, inertia, pos, opts = {}) {
    const b = new Body({ mass, inertia, friction: opts.friction ?? 0.8, angDamping: 0.6, linDamping: 0.03 });
    b.name = name; b.owner = this; b.tag = 'limb'; b.limb = name;
    b.pos.copy(pos); b.q.setFromYaw(this.yaw);
    this.parts[name] = b; this.bodies.push(b);
    this.world.add(b);
    return b;
  }

  _build() {
    const G = GEO, w = this.world;
    const p = new V3();
    // torso
    const torso = this._part('torso', 32, capsuleInertia(32, G.torsoR, G.torsoHalf), this._local(0, G.torsoY, 0, p));
    torso.addCapsule(0, -G.torsoHalf, 0, 0, G.torsoHalf, 0, G.torsoR)
      .addGroundPoint(0, -G.torsoHalf, 0, G.torsoR).addGroundPoint(0, G.torsoHalf, 0, G.torsoR);
    // head
    const head = this._part('head', 5, sphereInertia(5, G.headR), this._local(0, G.headY, 0, p));
    head.addCapsule(0, 0, 0, 0, 0, 0, G.headR).addGroundPoint(0, 0, 0, G.headR);
    for (const side of ['R', 'L']) {
      const sx = side === 'R' ? -1 : 1;
      const ua = G.uArmLen / 2, fa = G.fArmLen / 2;
      const uArm = this._part('uArm' + side, 2.2, capsuleInertia(2.2, 0.055, ua), this._local(sx * G.shoulderX, G.shoulderY - ua, 0, p));
      uArm.addCapsule(0, -ua, 0, 0, ua, 0, 0.055).addGroundPoint(0, -ua, 0, 0.055).addGroundPoint(0, ua, 0, 0.055);
      const fArm = this._part('fArm' + side, 1.5, capsuleInertia(1.5, 0.05, fa), this._local(sx * G.shoulderX, G.shoulderY - G.uArmLen - fa, 0, p));
      fArm.addCapsule(0, -fa, 0, 0, fa, 0, 0.05).addGroundPoint(0, -fa, 0, 0.05).addGroundPoint(0, fa, 0, 0.05);
      const hand = this._part('hand' + side, 0.5, sphereInertia(0.5, G.handR), this._local(sx * G.shoulderX, G.shoulderY - G.uArmLen - G.fArmLen - G.handOff, 0, p));
      hand.addCapsule(0, 0, 0, 0, 0, 0, G.handR).addGroundPoint(0, 0, 0, G.handR);
      const th = G.thighLen / 2, sh = G.shinLen / 2;
      const thigh = this._part('thigh' + side, 8, capsuleInertia(8, 0.075, th), this._local(sx * G.hipX, G.hipY - th, 0, p));
      thigh.addCapsule(0, -th, 0, 0, th, 0, 0.075).addGroundPoint(0, -th, 0, 0.075).addGroundPoint(0, th, 0, 0.075);
      const shin = this._part('shin' + side, 3.8, capsuleInertia(3.8, 0.06, sh), this._local(sx * G.hipX, G.hipY - G.thighLen - sh, 0, p));
      shin.addCapsule(0, -sh, 0, 0, sh, 0, 0.06).addGroundPoint(0, -sh, 0, 0.06).addGroundPoint(0, sh, 0, 0.06);
      const F = G.foot;
      const foot = this._part('foot' + side, 1.2, boxInertia(1.2, F.w, F.h, F.l), this._local(sx * G.hipX, F.h / 2, F.fwd, p), { friction: 2.2 });
      foot.addCapsule(0, 0, -F.l / 2 + 0.04, 0, 0, F.l / 2 - 0.04, 0.045);
      const cr = 0.012;
      for (const ix of [-1, 1]) for (const iy of [-1, 1]) for (const iz of [-1, 1]) {
        foot.addGroundPoint(ix * (F.w / 2 - cr), iy * (F.h / 2 - cr), iz * (F.l / 2 - cr), cr);
      }
    }

    // joints (built in the rest pose: everything has the same orientation)
    const J = (name, a, b, anchorLocal, o = {}) => {
      const anchor = this._local(anchorLocal[0], anchorLocal[1], anchorLocal[2], new V3());
      const yawQ = new Quat().setFromYaw(this.yaw);
      const rot = (v) => v && v.clone().applyQuat(yawQ);
      const j = new Joint(this.parts[a], this.parts[b], anchor, {
        name,
        hingeAxis: rot(o.hingeAxis), hingeRef: rot(o.hingeRef), hingeMin: o.hingeMin, hingeMax: o.hingeMax,
        coneAxis: rot(o.coneAxis), coneAxisChild: rot(o.coneAxisChild), coneMax: o.coneMax,
        twistAxis: rot(o.twistAxis), twistRef: rot(o.twistRef), twistMax: o.twistMax,
      });
      j.limb = b;
      this.joints[name] = j; w.addJoint(j);
      return j;
    };
    const down = new V3(0, -1, 0), up = new V3(0, 1, 0), fwd = new V3(0, 0, 1), xAxis = new V3(1, 0, 0);
    J('neck', 'torso', 'head', [0, G.neckY, 0], { coneAxis: up, coneMax: 0.75, twistAxis: up, twistRef: fwd, twistMax: 1.1 });
    for (const side of ['R', 'L']) {
      const sx = side === 'R' ? -1 : 1;
      const out = new V3(sx, 0, 0);
      const shoulderCone = new V3(0, -1, 0).addScaled(fwd, 1.1).addScaled(out, 0.25).normalize();
      J('shoulder' + side, 'torso', 'uArm' + side, [sx * G.shoulderX, G.shoulderY, 0], { coneAxis: shoulderCone, coneAxisChild: down, coneMax: 1.95 });
      J('elbow' + side, 'uArm' + side, 'fArm' + side, [sx * G.shoulderX, G.shoulderY - G.uArmLen, 0], { hingeAxis: xAxis, hingeRef: fwd, hingeMin: -2.6, hingeMax: 0.05 });
      J('wrist' + side, 'fArm' + side, 'hand' + side, [sx * G.shoulderX, G.shoulderY - G.uArmLen - G.fArmLen, 0], { coneAxis: down, coneMax: 1.2 });
      const hipCone = new V3(0, -1, 0).addScaled(fwd, 0.55).addScaled(out, 0.15).normalize();
      J('hip' + side, 'torso', 'thigh' + side, [sx * G.hipX, G.hipY, 0], { coneAxis: hipCone, coneAxisChild: down, coneMax: 1.45, twistAxis: down, twistRef: fwd, twistMax: 0.7 });
      J('knee' + side, 'thigh' + side, 'shin' + side, [sx * G.hipX, G.hipY - G.thighLen, 0], { hingeAxis: xAxis, hingeRef: fwd, hingeMin: -0.05, hingeMax: 2.6 });
      J('ankle' + side, 'shin' + side, 'foot' + side, [sx * G.hipX, G.ankleY, 0], { coneAxis: up, coneMax: 0.75, twistAxis: up, twistRef: fwd, twistMax: 0.45 });
    }

    this._poseLegs();

    // sword
    const sw = new Body({ mass: CONFIG.SWORD.MASS, inertia: [0.13, 0.018, 0.13], friction: 0.45, restitution: 0.15, angDamping: 0.4, linDamping: 0.02 });
    sw.name = 'sword'; sw.owner = this; sw.tag = 'sword';
    const S = SWORD_GEO;
    sw.addCapsule(0, S.bladeStart + 0.02, 0, 0, S.tipY - S.bladeR, 0, S.bladeR);    // 0: blade
    sw.addCapsule(0, S.guardY, -S.guardHalf, 0, S.guardY, S.guardHalf, 0.016);      // 1: guard
    sw.addCapsule(0, S.pommelY + 0.02, 0, 0, S.gripTop, 0, 0.02);                    // 2: handle
    sw.addGroundPoint(0, S.tipY - 0.01, 0, 0.01).addGroundPoint(0, S.pommelY + 0.02, 0, 0.025)
      .addGroundPoint(0, S.guardY, S.guardHalf, 0.016).addGroundPoint(0, S.guardY, -S.guardHalf, 0.016);
    this.sword = sw; this.bodies.push(sw);
    w.add(sw);
    this.swordDrive = new SwordDrive(this);
    w.addConstraint(this.swordDrive);

    this._poseArmsAndSword(true);
    for (const b of this.bodies) b.updateWorldShapes();
  }

  // Spawn pose: knees slightly bent at standing height, right foot a little forward
  _poseLegs() {
    const drop = GEO.hipY - CONFIG.FIGHTER.STAND_HEIGHT;
    for (const n of ['torso', 'head', 'uArmR', 'fArmR', 'handR', 'uArmL', 'fArmL', 'handL']) this.parts[n].pos.y -= drop;
    const yawQ = new Quat().setFromYaw(this.yaw);
    const F = new V3(0, 0, 1).applyQuat(yawQ);
    for (const side of ['R', 'L']) {
      const sx = side === 'R' ? -1 : 1;
      const fwd = side === 'R' ? 0.07 : -0.06;
      const foot = this.parts['foot' + side];
      foot.pos.addScaled(F, fwd);
      const hip = this._local(sx * GEO.hipX, CONFIG.FIGHTER.STAND_HEIGHT, 0, new V3());
      const ankle = this._local(sx * GEO.hipX, GEO.ankleY, fwd, new V3());
      const d1 = new V3(), d2 = new V3(), q1 = new Quat(), q2 = new Quat();
      ik2(hip, ankle, GEO.thighLen, GEO.shinLen, F, d1, d2);
      limbOrient(d1, d2, -1, F, q1, q2);
      const th = this.parts['thigh' + side], sh = this.parts['shin' + side];
      th.q.copy(q1); th.pos.copy(hip).addScaled(d1, GEO.thighLen / 2);
      const knee = new V3().copy(hip).addScaled(d1, GEO.thighLen);
      sh.q.copy(q2); sh.pos.copy(knee).addScaled(d2, GEO.shinLen / 2);
      foot.lastGround = 0;
    }
  }

  // Place arms + sword in the guard pose instantly (used at spawn)
  _poseArmsAndSword(createGrips) {
    this._computeSwordTarget(0, 0, true);
    const sw = this.sword;
    sw.pos.copy(this.swTargetPos).sub(_a.copy(SWORD_GEO.gripCenter).applyQuat(this.swTargetQ));
    sw.q.copy(this.swTargetQ);
    sw.vel.set(0, 0, 0); sw.angVel.set(0, 0, 0);
    for (const side of ['R', 'L']) {
      const r = this._armIK(side, true);
      if (!r) continue;
    }
    if (createGrips) {
      this.grips = {};
      for (const side of ['R', 'L']) {
        const hand = this.parts['hand' + side];
        const gp = side === 'R' ? SWORD_GEO.gripR : SWORD_GEO.gripL;
        const anchor = sw.localToWorld(gp, new V3());
        hand.pos.copy(anchor);
        const j = new Joint(hand, sw, anchor, { name: 'grip' + side });
        j.r1.set(0, 0, 0); j.r2.copy(gp);
        this.grips[side] = j; this.world.addJoint(j);
      }
    }
  }

  // ------------------------------------------------------------- control state
  _initControl() {
    this.facing = this.yaw;
    this.gait = {
      swing: null, phase: 0, start: new V3(), target: new V3(), dur: CONFIG.FIGHTER.STEP_TIME,
      cooldown: 0, lastSwing: 'L', stepCount: 0,
    };
    this.com = new V3(); this.comVel = new V3();
    this.swTargetPos = this.swTargetPos || new V3(); this.swTargetQ = this.swTargetQ || new Quat();
    this.tipDir = new V3(0, 1, 0); this.prevTipDir = new V3(0, 1, 0); this.edgeDir = new V3(0, 0, 1);
    this.stickSmooth = { x: 0, y: 0 };
  }

  get attachedBodies() { return this.bodies.filter((b) => b === this.sword ? this.swordHeld : !this.detached[b.limb]); }

  _computeCOM() {
    let m = 0; this.com.set(0, 0, 0); this.comVel.set(0, 0, 0);
    for (const b of this.bodies) {
      if (b === this.sword ? !this.swordHeld : this.detached[b.limb]) continue;
      m += b.mass; this.com.addScaled(b.pos, b.mass); this.comVel.addScaled(b.vel, b.mass);
    }
    this.com.scale(1 / m); this.comVel.scale(1 / m);
    this.attachedMass = m;
  }

  heading(out) { return out.set(Math.sin(this.facing), 0, Math.cos(this.facing)); }

  // world-space sword target from the stick (tip direction on a frontal hemisphere)
  _computeSwordTarget(sx, sy, instant = false, dt = 1 / 60) {
    const torso = this.parts.torso;
    // body heading from the actual torso (forward axis projected)
    const tf = _d.set(0, 0, 1).applyQuat(torso.q); tf.y = 0;
    if (tf.lenSq() < 1e-4) tf.set(Math.sin(this.facing), 0, Math.cos(this.facing));
    tf.normalize();
    const F = _e.copy(tf), R = _f.set(-F.z, 0, F.x); // right = F x Up
    const r = Math.min(1, Math.hypot(sx, sy));
    const phi = Math.atan2(sx, sy); // 0 = forward, +pi/2 = right
    const back = Math.max(0, -Math.cos(phi));
    // max tilt from vertical: level when pointing at the enemy, lower out to the sides
    // (wide sweeps), much less toward the back (wind-up only — never a full 360)
    const side = Math.abs(Math.sin(phi));
    const thetaMax = lerp(lerp(1.62, 2.05, side), 0.95, smoothstep((Math.abs(phi) - 1.6) / 1.5));
    // pointing forward: the first ~60% of the stick levels the blade, the rest thrusts it
    const fwd = Math.pow(Math.max(0, Math.cos(phi)), 2);
    const rT = lerp(r, Math.min(1, r / 0.6), fwd);
    const thrust = fwd * smoothstep((r - 0.58) / 0.4);
    const theta = rT * thetaMax;
    const cp = Math.cos(phi), sp = Math.sin(phi);
    // tip direction (rest: upright, tilted slightly toward the opponent)
    const d = new V3().copy(UP).scale(Math.cos(theta))
      .addScaled(F, Math.sin(theta) * cp + 0.24 * (1 - r)).addScaled(R, Math.sin(theta) * sp).normalize();
    // grip center position (world), relative to the torso center
    const base = torso.pos;
    const P = this.swTargetPos.copy(base)
      .addScaled(UP, -0.13 + 0.16 * back * r + 0.05 * r * (1 - fwd) + 0.06 * thrust)
      .addScaled(F, 0.32 + 0.1 * Math.max(0, cp) * r * (1 - side) + 0.3 * thrust - 0.06 * back * r)
      .addScaled(R, 0.15 * sp * r - 0.03 * (1 - thrust));
    this.thrust = thrust;
    // keep within arm reach of both shoulders
    const sh = _a.copy(base).addScaled(UP, GEO.shoulderY - GEO.torsoY);
    const off = _b.subVectors(P, sh); const ol = off.len();
    if (ol > 0.58) P.copy(sh).addScaled(off, 0.58 / ol);
    // edge direction follows the motion of the tip
    this.prevTipDir.copy(this.tipDir);
    this.tipDir.copy(d);
    if (instant) {
      this.edgeDir.copy(F).addScaled(d, -F.dot(d)).normalize();
    } else {
      const mv = _c.subVectors(this.tipDir, this.prevTipDir);
      mv.addScaled(d, -mv.dot(d));
      const speed = mv.len() / dt;
      if (speed > 0.8) {
        mv.normalize();
        this.edgeDir.lerp(mv, Math.min(1, dt * 18 * Math.min(1, speed / 3)));
      }
      // default edge: toward the front
      _c.copy(F).addScaled(d, -F.dot(d));
      if (_c.lenSq() > 1e-4) { _c.normalize(); this.edgeDir.lerp(_c, Math.min(1, dt * 1.5)); }
      this.edgeDir.addScaled(d, -this.edgeDir.dot(d));
      if (this.edgeDir.lenSq() < 1e-6) this.edgeDir.copy(F).addScaled(d, -F.dot(d));
      this.edgeDir.normalize();
    }
    const X = _c.crossVectors(d, this.edgeDir).normalize();
    const Z = _a.crossVectors(X, d).normalize();
    this.swTargetQ.setFromBasis(X, d, Z);
    // each hand must be able to reach its grip: pull the target in if not
    const reach = GEO.uArmLen + GEO.fArmLen + GEO.handOff - 0.035;
    for (let it = 0; it < 3; it++) {
      for (const side of ['R', 'L']) {
        const shoulder = _a.copy(base).addScaled(UP, GEO.shoulderY - GEO.torsoY).addScaled(R, (side === 'R' ? 1 : -1) * GEO.shoulderX);
        const gp = side === 'R' ? SWORD_GEO.gripR : SWORD_GEO.gripL;
        const grip = _b.copy(gp).sub(SWORD_GEO.gripCenter).applyQuat(this.swTargetQ).add(P);
        const dv = grip.sub(shoulder); const dl = dv.len();
        if (dl > reach) P.addScaled(dv, -(dl - reach) / dl);
      }
    }
  }

  // IK for one arm toward the sword grip (target pose). Optionally snaps bodies (spawn).
  _armIK(side, snap) {
    const torso = this.parts.torso;
    const sx = side === 'R' ? -1 : 1;
    const shoulder = torso.localToWorld(_d.set(sx * GEO.shoulderX, GEO.shoulderY - GEO.torsoY, 0), new V3());
    const gp = side === 'R' ? SWORD_GEO.gripR : SWORD_GEO.gripL;
    const target = new V3().copy(gp).sub(SWORD_GEO.gripCenter).applyQuat(this.swTargetQ).add(this.swTargetPos);
    // elbow pole: down, outward, slightly back
    const right = _e.set(-1, 0, 0).applyQuat(torso.q);
    const pole = new V3(0, -1, 0).addScaled(right, -sx * 0.9).addScaled(_f.set(0, 0, 1).applyQuat(torso.q), -0.3);
    const d1 = new V3(), d2 = new V3();
    ik2(shoulder, target, GEO.uArmLen, GEO.fArmLen + GEO.handOff, pole, d1, d2);
    const q1 = new Quat(), q2 = new Quat();
    limbOrient(d1, d2, 1, _f.set(0, 0, 1).applyQuat(torso.q), q1, q2);
    if (snap) {
      const ua = this.parts['uArm' + side], fa = this.parts['fArm' + side], hd = this.parts['hand' + side];
      ua.q.copy(q1); ua.pos.copy(shoulder).addScaled(d1, GEO.uArmLen / 2);
      const elbow = _a.copy(shoulder).addScaled(d1, GEO.uArmLen);
      fa.q.copy(q2); fa.pos.copy(elbow).addScaled(d2, GEO.fArmLen / 2);
      hd.q.copy(q2); hd.pos.copy(elbow).addScaled(d2, GEO.fArmLen + GEO.handOff);
    }
    return { q1, q2 };
  }

  // ------------------------------------------------------------- per-frame control
  update(dt) {
    this.time += dt;
    for (const side of ['R', 'L']) {
      const ft = this.parts['foot' + side];
      if (ft.grounded) ft.lastGround = this.time;
      ft.planted = this.time - (ft.lastGround ?? -1) < 0.15;
      ft.groundTime = ft.grounded ? (ft.groundTime || 0) + dt : 0; // continuous contact time
    }
    this._computeCOM();
    const P = this.parts, J = this.joints, FC = CONFIG.FIGHTER;
    const torso = P.torso;
    if (!this.alive) { this._limp(); return; }

    // ---- fallen detection
    const tUp = _a.set(0, 1, 0).applyQuat(torso.q);
    const tilt = Math.acos(clamp(tUp.y, -1, 1));
    this.tilt = tilt;
    const lowHead = P.head.pos.y < 0.85 && !this.detached.head;
    if (!this.fallen && (tilt > FC.FALL_TILT || lowHead)) { this.fallen = true; this.fallenTime = 0; this.gettingUp = 0; }
    if (this.fallen) {
      this.fallenTime += dt;
      if (this.fallenTime > FC.GETUP_DELAY && this.canGetUp()) this.gettingUp = Math.min(1, this.gettingUp + dt / 1.2);
      if (tilt < 0.35 && torso.pos.y > 1.05) { this.fallen = false; this.gettingUp = 0; }
    }

    // ---- facing
    let wantYaw = this.facing;
    if (this.opponent && !this.pedestal) {
      const o = this.opponent.parts.torso.pos;
      const dx = o.x - torso.pos.x, dz = o.z - torso.pos.z;
      if (dx * dx + dz * dz > 0.04) wantYaw = Math.atan2(dx, dz);
    } else if (this.faceMove && this.input.mx * this.input.mx + this.input.mz * this.input.mz > 0.04 && !this.pedestal) {
      wantYaw = Math.atan2(this.input.mx, this.input.mz);
    }
    const dyaw = wrapAngle(wantYaw - this.facing);
    this.facing = wrapAngle(this.facing + clamp(dyaw, -FC.TURN_RATE * dt, FC.TURN_RATE * dt));

    // ---- strength from limb state
    const legOK = { R: this._legStrength('R'), L: this._legStrength('L') };

    this._gaitUpdate(dt, legOK);
    this._legsControl(dt, legOK);
    this._legPush(dt, legOK);
    this._torsoAssist(dt, tilt);
    this._armsControl(dt);
    // neck
    const neckK = this.disabled.head ? 0 : 55;
    _q.setFromYaw(this.facing);
    _q2.setFromAxisAngle(1, 0, 0, 0.12); _q.multiply(_q2);
    J.neck.driveTarget.copy(_q);
    setDrive(J.neck, DRIVE_CHILD_WORLD, neckK, 18, 60);
  }

  canGetUp() {
    // needs at least one working leg and the head on
    return !this.detached.head && (this._legStrength('R') > 0.3 || this._legStrength('L') > 0.3);
  }

  _legStrength(side) {
    if (this.detached['thigh' + side] || this.detached['shin' + side]) return 0;
    if (this.disabled['thigh' + side] || this.disabled['shin' + side]) return 0.0;
    let s = 1;
    if (this.detached['foot' + side]) s *= 0.55;
    else if (this.disabled['foot' + side]) s *= 0.7;
    return s;
  }

  footCenter(side, out) {
    const f = this.parts['foot' + side];
    return out.copy(f.pos);
  }

  _gaitUpdate(dt, legOK) {
    const g = this.gait, FC = CONFIG.FIGHTER, P = this.parts;
    const F = this.heading(new V3()), R = new V3(-F.z, 0, F.x);
    g.cooldown -= dt;
    const vd = new V3(this.input.mx, 0, this.input.mz);
    if (this.pedestal) vd.set(0, 0, 0);
    const vdLen = Math.min(1, vd.len());
    if (vdLen > 0) vd.normalize().scale(vdLen * FC.WALK_SPEED);
    this.desiredVel = vd;
    const footR = P.footR.pos, footL = P.footL.pos;
    const hc = Math.max(0.5, this.com.y);
    const cp = new V3(this.com.x + this.comVel.x * Math.sqrt(hc / 9.81), 0, this.com.z + this.comVel.z * Math.sqrt(hc / 9.81));
    this.capturePoint = cp;
    const canStepR = legOK.R > 0.3 && !this.detached.footR, canStepL = legOK.L > 0.3 && !this.detached.footL;

    if (g.swing) {
      g.phase += dt / g.dur;
      const side = g.swing;
      // update target until late in the swing
      if (g.phase < 0.7) this._stepTarget(side, cp, vd, F, R, g.target);
      const swingFoot = P['foot' + side];
      const landed = g.phase > 0.72 && swingFoot.grounded;
      if (landed || g.phase > 1.8 || this.fallen || legOK[side] <= 0.3) {
        g.lastSwing = side; g.swing = null; g.cooldown = vdLen > 0.1 ? 0 : 0.06; g.stepCount++;
      }
    }
    if (!g.swing && g.cooldown <= 0 && !this.fallen) {
      // decide whether to step
      let want = null;
      const mid = new V3().addVectors(footR, footL).scale(0.5); mid.y = 0;
      const err = new V3().subVectors(cp, mid); err.y = 0;
      const errF = err.dot(F), errR = err.dot(R);
      const feetSep = new V3().subVectors(footR, footL); feetSep.y = 0;
      const sepR = feetSep.dot(R), sepF = feetSep.dot(F);
      // support region: segment between feet with some radius
      const segLen = feetSep.len();
      let outside;
      {
        const t = segLen > 1e-3 ? clamp(new V3().subVectors(cp, footL).dot(feetSep) / (segLen * segLen), 0, 1) : 0.5;
        const closest = new V3().copy(footL).addScaled(feetSep, t); closest.y = 0;
        outside = Math.hypot(cp.x - closest.x, cp.z - closest.z);
      }
      const reachR = this._footReach('R'), reachL = this._footReach('L');
      if (Math.max(reachR, reachL) > 0.3) {
        want = reachR > reachL ? 'R' : 'L';
      } else if (vdLen > 0.12) {
        // walking: step the foot that is farthest from where it should go (alternating when equal)
        const tR = this._stepTarget('R', cp, vd, F, R, new V3()), tL = this._stepTarget('L', cp, vd, F, R, new V3());
        const dR = Math.hypot(footR.x - tR.x, footR.z - tR.z), dL = Math.hypot(footL.x - tL.x, footL.z - tL.z);
        const bias = 0.05;
        want = dR + (g.lastSwing === 'R' ? -bias : bias) > dL ? 'R' : 'L';
        if (Math.max(dR, dL) < 0.06) want = null;
      } else if (outside > 0.075) {
        if (Math.abs(errR) > Math.abs(errF) * 0.8) want = errR > 0 ? 'R' : 'L';
        else {
          // forward/back: move the foot that is farther from the capture point
          want = new V3().subVectors(footR, cp).lenSq() > new V3().subVectors(footL, cp).lenSq() ? 'R' : 'L';
        }
      } else {
        // tidy up stance: wrong width, crossed feet, or feet not facing forward
        const yawR = this._footYawErr('R'), yawL = this._footYawErr('L');
        if (sepR < 0.12 || sepR > 0.55 || Math.abs(sepF) > 0.55) want = Math.abs(errR) > 0.02 ? (errR > 0 ? 'R' : 'L') : (g.lastSwing === 'R' ? 'L' : 'R');
        else if (Math.abs(yawR) > 0.6) want = 'R';
        else if (Math.abs(yawL) > 0.6) want = 'L';
        else {
          // idle stance offsets: right foot slightly forward (fencing stance)
          const idealR = this._idealFoot('R', F, R), idealL = this._idealFoot('L', F, R);
          const dR = Math.hypot(footR.x - idealR.x, footR.z - idealR.z), dL = Math.hypot(footL.x - idealL.x, footL.z - idealL.z);
          if (Math.max(dR, dL) > 0.24 && this.comVel.len() < 0.4) want = dR > dL ? 'R' : 'L';
        }
      }
      if (want === 'R' && !canStepR) want = canStepL ? 'L' : null;
      if (want === 'L' && !canStepL) want = canStepR ? 'R' : null;
      // can only lift a foot if the other one is on the ground
      if (want) {
        const other = want === 'R' ? 'L' : 'R';
        if (!(P['foot' + other].groundTime > 0.07) && !P['shin' + other].grounded) want = null;
      }
      if (want) {
        g.swing = want; g.phase = 0;
        g.start.copy(P['foot' + want].pos); g.start.y = 0;
        g.dur = vdLen > 0.12 ? FC.STEP_TIME : FC.STEP_TIME * 0.9;
        this._stepTarget(want, cp, vd, F, R, g.target);
      }
    }
  }

  // horizontal distance from a foot's ankle to its hip
  _footReach(side) {
    const P = this.parts;
    const ank = P['shin' + side].localToWorld(_b.set(0, -GEO.shinLen / 2, 0), _c);
    const hip = P.torso.localToWorld(_b.set((side === 'R' ? -1 : 1) * GEO.hipX, GEO.hipY - GEO.torsoY, 0), _d);
    return Math.hypot(hip.x - ank.x, hip.z - ank.z);
  }

  _footYawErr(side) {
    const f = _a.set(0, 0, 1).applyQuat(this.parts['foot' + side].q);
    return wrapAngle(Math.atan2(f.x, f.z) - this.facing);
  }

  _idealFoot(side, F, R) {
    const s = side === 'R' ? 1 : -1;
    return new V3(this.com.x, 0, this.com.z).addScaled(R, s * 0.14).addScaled(F, s * 0.07 + 0.02);
  }

  _stepTarget(side, cp, vd, F, R, out) {
    const s = side === 'R' ? 1 : -1;
    const other = side === 'R' ? 'L' : 'R';
    const stance = this.parts['foot' + other].pos;
    out.copy(cp).addScaled(R, s * 0.13).addScaled(F, s * 0.06);
    out.addScaled(vd, this.gait.dur * 0.55);
    out.y = 0;
    // no crossing (and not too wide): keep the swing foot on its own side of the stance foot
    const rel = _a.subVectors(out, stance); rel.y = 0;
    const lat = rel.dot(R) * s;
    if (lat < 0.17) out.addScaled(R, s * (0.17 - lat));
    else if (lat > 0.42) out.addScaled(R, -s * (lat - 0.42));
    // limit step length
    rel.subVectors(out, stance); rel.y = 0;
    const L = rel.len();
    if (L > 0.62) out.copy(stance).addScaled(rel, 0.62 / L);
    out.y = 0;
    // keep inside the arena wall
    const rr = Math.hypot(out.x, out.z), lim = this.world.arenaRadius - 0.25;
    if (rr > lim) { out.x *= lim / rr; out.z *= lim / rr; }
    return out;
  }

  _legsControl(dt, legOK) {
    const P = this.parts, J = this.joints, FC = CONFIG.FIGHTER, g = this.gait;
    const torso = P.torso;
    const F = this.heading(new V3()), R = new V3(-F.z, 0, F.x);
    const fallenScale = this.fallen ? (0.25 + 0.75 * this.gettingUp) : 1;
    // desired torso orientation: upright, facing, leaning into acceleration
    const vd = this.desiredVel || new V3();
    const velErr = new V3().subVectors(vd, this.comVel); velErr.y = 0;
    const leanF = clamp(velErr.dot(F) * 0.08, -0.1, 0.16), leanR = clamp(velErr.dot(R) * 0.05, -0.08, 0.08);
    const torsoTarget = new Quat().setFromYaw(this.facing);
    torsoTarget.premultiply(_q.setFromAxisAngle(R.x, R.y, R.z, -leanF)); // pitch forward about the right axis
    torsoTarget.premultiply(_q.setFromAxisAngle(F.x, F.y, F.z, leanR));
    this.torsoTarget = torsoTarget;

    // which legs stand on the floor
    const stanceSides = [], airSides = [];
    for (const side of ['R', 'L']) {
      if (legOK[side] <= 0 || g.swing === side) continue;
      if (P['foot' + side].planted) stanceSides.push(side); else airSides.push(side);
    }
    // desired pelvis (point between the hips)
    const pelvis = torso.localToWorld(_a.set(0, GEO.hipY - GEO.torsoY, 0), new V3());
    const sup = new V3();
    for (const sd of stanceSides) sup.add(P['foot' + sd].pos);
    if (stanceSides.length) sup.scale(1 / stanceSides.length); else sup.copy(this.com);
    sup.y = 0;
    const comXZ = new V3(this.com.x, 0, this.com.z);
    const pelvisOffset = new V3(pelvis.x - comXZ.x, 0, pelvis.z - comXZ.z);
    const walking = vd.lenSq() > 0.02;
    const pd = new V3();
    if (walking) {
      const push = new V3().copy(velErr).scale(0.07);
      const pl = push.len(); if (pl > 0.12) push.scale(0.12 / pl);
      pd.copy(pelvis).add(push);
    } else {
      // move the centre of mass over the support centre (ankle strategy)
      pd.copy(sup).add(pelvisOffset);
      if (g.swing) pd.lerp(pelvis, 0.4);
      pd.addScaled(this.comVel, -0.1);
    }
    pd.y = FC.STAND_HEIGHT - (walking ? 0.02 : 0);
    // keep within reach of the stance feet
    for (const sd of stanceSides) {
      const ank = P['shin' + sd].localToWorld(_b.set(0, -GEO.shinLen / 2, 0), new V3());
      const hip = new V3().copy(pd).addScaled(R, (sd === 'R' ? 1 : -1) * GEO.hipX);
      const dx = hip.x - ank.x, dz = hip.z - ank.z, horiz = Math.hypot(dx, dz);
      if (horiz > 0.36) { pd.x -= dx * (1 - 0.36 / horiz); pd.z -= dz * (1 - 0.36 / horiz); }
    }

    const pole = new V3().copy(F);
    const nStance = Math.max(1, stanceSides.length);
    const d1 = new V3(), d2 = new V3(), qT = new Quat(), qS = new Quat();

    for (const side of ['R', 'L']) {
      const s = side === 'R' ? 1 : -1;
      const hipJ = J['hip' + side], kneeJ = J['knee' + side], ankJ = J['ankle' + side];
      const strength = legOK[side];
      const shin = P['shin' + side], foot = P['foot' + side];
      hipJ.groundChild = kneeJ.groundChild = ankJ.groundChild = false;
      if (strength <= 0 || this.detached['thigh' + side]) {
        hipJ.driveTarget.identity(); kneeJ.driveTarget.identity(); ankJ.driveTarget.identity();
        setDrive(hipJ, DRIVE_REL, this.detached['thigh' + side] ? 0 : 6, 4, 20);
        setDrive(kneeJ, DRIVE_REL, 3, 3, 10);
        setDrive(ankJ, DRIVE_REL, 2, 2, 5);
        continue;
      }
      if (stanceSides.includes(side)) {
        // ---- stance: the leg is a grounded chain foot -> shin -> thigh -> torso
        const ank = shin.localToWorld(_b.set(0, -GEO.shinLen / 2, 0), new V3());
        ank.y = GEO.ankleY; // a stance foot belongs on the floor: reach for it
        const hipD = new V3().copy(pd).addScaled(R, s * GEO.hipX);
        ik2(hipD, ank, GEO.thighLen, GEO.shinLen, pole, d1, d2);
        limbOrient(d1, d2, -1, F, qT, qS);
        hipJ.driveTarget.copy(torsoTarget);
        hipJ.groundChild = true;
        setDrive(hipJ, DRIVE_PARENT_WORLD, (1500 * strength * fallenScale) / nStance, 30, (560 * strength) / nStance + 40);
        kneeJ.driveTarget.copy(qT).conjugate().multiply(qS);
        setDrive(kneeJ, DRIVE_REL, 1000 * strength * fallenScale, 45, 400 * strength);
        ankJ.driveTarget.copy(qS);
        ankJ.groundChild = true;
        setDrive(ankJ, DRIVE_PARENT_WORLD, 520 * strength * fallenScale, 25, 85 * strength);
      } else {
        // ---- swing (or reaching down for the floor)
        const hipPos = torso.localToWorld(_b.set(-s * GEO.hipX, GEO.hipY - GEO.torsoY, 0), new V3());
        const fp = new V3();
        if (g.swing === side) {
          const t = g.phase;
          const st = smoothstep(Math.min(1, t * 1.1));
          fp.copy(g.start).lerp(g.target, st);
          fp.y = t < 1 ? 0.10 * Math.sin(Math.PI * t) + 0.012 : -0.05 * Math.min(1, (t - 1) * 2);
        } else {
          fp.copy(foot.pos); fp.y = -0.04;
        }
        const ankT = new V3().copy(fp).addScaled(UP, GEO.ankleY).addScaled(F, -GEO.foot.fwd);
        ik2(hipPos, ankT, GEO.thighLen, GEO.shinLen, pole, d1, d2);
        limbOrient(d1, d2, -1, F, qT, qS);
        hipJ.driveTarget.copy(qT);
        setDrive(hipJ, DRIVE_CHILD_WORLD, 420 * strength * fallenScale, 40, 220 * strength);
        kneeJ.driveTarget.copy(qT).conjugate().multiply(qS);
        setDrive(kneeJ, DRIVE_REL, 380 * strength * fallenScale, 34, 160 * strength);
        ankJ.driveTarget.copy(_q.setFromYaw(this.facing));
        setDrive(ankJ, DRIVE_CHILD_WORLD, 70 * strength, 16, 40);
      }
    }
  }

  // Virtual leg force: the standing leg(s) push the body toward where it should be
  // (over the feet when idle, along the stick when walking). Applied as an equal and
  // opposite pair between torso and the planted feet, so the floor's friction is what
  // really moves the fighter — a foot in the air or a slipping foot can't push.
  _legPush(dt, legOK) {
    const P = this.parts, FC = CONFIG.FIGHTER, g = this.gait;
    const stance = [];
    let settle = 0;
    for (const side of ['R', 'L']) if (g.swing !== side && legOK[side] > 0.3 && P['foot' + side].planted) {
      stance.push(side); settle = Math.max(settle, smoothstep((P['foot' + side].groundTime || 0) / 0.1));
    }
    this.pushForce = this.pushForce || new V3();
    this.pushForce.set(0, 0, 0);
    if (!stance.length || (this.fallen && this.gettingUp < 0.5)) return;
    const m = this.attachedMass, str = Math.min(1, stance.reduce((a, sd) => a + legOK[sd], 0) / stance.length);
    const vd = this.desiredVel || new V3();
    const walking = vd.lenSq() > 0.02;
    const F = new V3();
    if (walking) {
      F.set(vd.x - this.comVel.x, 0, vd.z - this.comVel.z).scale(m * 7);
      // don't outrun the feet: fade the push (and brake) when a planted foot trails too far
      let worst = 0;
      for (const sd of stance) worst = Math.max(worst, this._footReach(sd));
      const k = smoothstep((worst - 0.32) / 0.14);
      if (k > 0) F.scale(1 - k * 0.85);
    } else {
      const sup = new V3();
      for (const sd of stance) sup.add(P['foot' + sd].pos);
      sup.scale(1 / stance.length);
      const H = this.heading(new V3());
      sup.addScaled(H, -0.015);
      F.set((sup.x - this.com.x) * 22 - this.comVel.x * 7, 0, (sup.z - this.com.z) * 22 - this.comVel.z * 7).scale(m);
    }
    // leash: a leg can't push the hips further away than it can reach. Only the foot that
    // is furthest along the push matters (the rear foot of a walking stride is about to lift).
    let lead = stance[0];
    if (stance.length > 1) {
      const pa = P['foot' + stance[0]].pos, pb = P['foot' + stance[1]].pos;
      lead = (pa.x - pb.x) * F.x + (pa.z - pb.z) * F.z >= 0 ? stance[0] : stance[1];
    }
    for (const sd of [lead]) {
      const ank = P['shin' + sd].localToWorld(_b.set(0, -GEO.shinLen / 2, 0), new V3());
      const hip = P.torso.localToWorld(_b.set((sd === 'R' ? -1 : 1) * GEO.hipX, GEO.hipY - GEO.torsoY, 0), new V3());
      const dx = hip.x - ank.x, dz = hip.z - ank.z, dl = Math.hypot(dx, dz);
      if (dl > 0.22) {
        const ux = dx / dl, uz = dz / dl;
        const along = F.x * ux + F.z * uz;
        if (along > 0) {
          const k = smoothstep((dl - 0.22) / 0.14);
          F.x -= ux * along * k; F.z -= uz * along * k;
        }
      }
    }
    // height support: help the knees hold the hips at standing height (legs only push)
    const pelvisY = P.torso.pos.y + (GEO.hipY - GEO.torsoY);
    const hErr = FC.STAND_HEIGHT - pelvisY;
    F.y = clamp(m * (hErr * 22 - P.torso.vel.y * 11), 0, 0.55 * m * 9.81) * str;
    // friction cone: sideways push limited by the weight actually on the feet
    const n = this.world.substeps, sdt = dt;
    let load = 0;
    for (const sd of stance) load += P['foot' + sd].groundNormalForce * n / (sdt * sdt);
    load = Math.max(load, 0) + F.y;
    const maxF = Math.min(0.8 * load, 420) * str * (0.25 + 0.75 * settle);
    const fh = Math.hypot(F.x, F.z); if (fh > maxF) { F.x *= maxF / fh; F.z *= maxF / fh; }
    P.torso.force.add(F);
    for (const sd of stance) P['foot' + sd].force.addScaled(F, -1 / stance.length);
    this.pushForce.copy(F);
  }

  // weak "core" torque toward upright that fades out when badly tilted (so falls happen),
  // plus the get-up assist after a fall
  _torsoAssist(dt, tilt) {
    const P = this.parts, torso = P.torso, FC = CONFIG.FIGHTER;
    const anyFoot = P.footR.grounded || P.footL.grounded || P.shinR.grounded || P.shinL.grounded;
    let k = 0;
    if (this.fallen) k = this.gettingUp;
    else if (anyFoot) k = 1 - smoothstep((tilt - 0.35) / (FC.FALL_TILT - 0.35));
    const legs = Math.max(this._legStrength('R'), this._legStrength('L'));
    k *= Math.max(0.15, legs);
    if (k <= 0.001) return;
    const tq = this.torsoTarget || _q.setFromYaw(this.facing);
    const err = _q2.copy(tq).multiply(_q.copy(torso.q).conjugate());
    if (err.w < 0) { err.x = -err.x; err.y = -err.y; err.z = -err.z; err.w = -err.w; }
    const ex = err.x * 2, ez = err.z * 2; // ignore yaw (y)
    const maxT = FC.UPRIGHT_ASSIST * (this.fallen ? 4 : 1);
    let tx = (ex * 900 - torso.angVel.x * 80) * k, tz = (ez * 900 - torso.angVel.z * 80) * k;
    const m = Math.hypot(tx, tz);
    if (m > maxT * k) { tx *= (maxT * k) / m; tz *= (maxT * k) / m; }
    torso.torque.x += tx; torso.torque.z += tz;
    if (this.fallen && this.gettingUp > 0) {
      // lift toward standing height
      const lift = clamp((1.22 - torso.pos.y) * 2500 - torso.vel.y * 300, 0, this.attachedMass * 9.81 * 1.3) * this.gettingUp;
      torso.force.y += lift;
    }
  }

  _armsControl(dt) {
    const P = this.parts, J = this.joints;
    // smooth the stick a little (finger noise) but keep flicks fast
    const ss = this.stickSmooth, k = Math.min(1, dt * 30);
    ss.x += (this.input.sx - ss.x) * k; ss.y += (this.input.sy - ss.y) * k;
    this._computeSwordTarget(ss.x, ss.y, false, dt);
    // sword drive strength from the arms holding it
    let armStr = 0;
    for (const side of ['R', 'L']) armStr += this._armWorks(side) ? 0.5 : 0;
    if (!this.swordHeld) armStr = 0;
    if (this.fallen) armStr *= 0.5;
    this.swordDrive.strength = armStr;
    const torso = P.torso;
    this.swordDrive.localPos.copy(this.swTargetPos).sub(torso.pos).applyQuatInv(torso.q);
    this.swordDrive.localQ.copy(torso.q).conjugate().multiply(this.swTargetQ);
    for (const side of ['R', 'L']) {
      const sh = J['shoulder' + side], el = J['elbow' + side], wr = J['wrist' + side];
      if (this.detached['uArm' + side]) { setDrive(sh, DRIVE_OFF, 0, 0, 0); setDrive(el, DRIVE_REL, 2, 2, 5); setDrive(wr, DRIVE_REL, 1, 1, 2); continue; }
      const works = this._armWorks(side) && this.swordHeld;
      const ik = this._armIK(side, false);
      if (works) {
        sh.driveTarget.copy(ik.q1); setDrive(sh, DRIVE_CHILD_WORLD, 110, 20, 120);
        el.driveTarget.copy(ik.q1).conjugate().multiply(ik.q2); setDrive(el, DRIVE_REL, 60, 15, 70);
        wr.driveTarget.copy(this.swTargetQ); setDrive(wr, DRIVE_CHILD_WORLD, 4, 4, 6);
      } else {
        // free (no sword or disabled): hang loosely / guard pose if healthy
        const healthy = !this.disabled['uArm' + side] && !this.disabled['fArm' + side];
        if (healthy) {
          _q.copy(torso.q).multiply(_q2.setFromAxisAngle(1, 0, 0, -0.5));
          sh.driveTarget.copy(_q); setDrive(sh, DRIVE_CHILD_WORLD, 40, 10, 50);
          el.driveTarget.setFromAxisAngle(1, 0, 0, -1.2); setDrive(el, DRIVE_REL, 25, 8, 30);
        } else {
          setDrive(sh, DRIVE_REL, 2, 2, 4); el.driveTarget.identity(); setDrive(el, DRIVE_REL, 2, 2, 4);
        }
        setDrive(wr, DRIVE_REL, 1, 1, 2);
      }
    }
  }

  _armWorks(side) {
    if (!this.gripActive[side]) return false;
    for (const n of ['uArm', 'fArm', 'hand']) if (this.detached[n + side] || this.disabled[n + side]) return false;
    return true;
  }

  _limp() {
    for (const j of Object.values(this.joints)) {
      if (!j.enabled) continue;
      j.driveTarget.identity();
      setDrive(j, DRIVE_REL, 1.5, 3, 4);
    }
    this.swordDrive.strength = 0;
    if (this.swordHeld && this.time - this.deathTime > 0.25) this.dropSword();
  }

  // ------------------------------------------------------------- damage-related state changes
  dropSword() {
    for (const side of ['R', 'L']) this.releaseGrip(side);
    this.swordHeld = false;
    this.swordDrive.strength = 0;
  }
  releaseGrip(side) {
    if (!this.gripActive[side]) return;
    this.gripActive[side] = false;
    const g = this.grips[side];
    if (g) this.world.removeJoint(g);
    if (!this.gripActive.R && !this.gripActive.L) { this.swordHeld = false; this.swordDrive.strength = 0; }
  }
  // detach limb (and its sub-tree) at its joint to the parent
  sever(limb) {
    const info = LIMB_INFO[limb];
    if (!info.parent || this.detached[limb]) return [];
    const j = this.joints[info.joint];
    if (j) this.world.removeJoint(j);
    const removed = [];
    const mark = (n) => { this.detached[n] = true; removed.push(n); for (const c of CHILDREN[n]) mark(c); };
    mark(limb);
    for (const side of ['R', 'L']) if (removed.includes('hand' + side) || removed.includes('fArm' + side) || removed.includes('uArm' + side)) this.releaseGrip(side);
    // limp joints inside the severed part
    for (const n of removed) for (const c of CHILDREN[n]) {
      const cj = this.joints[LIMB_INFO[c].joint];
      if (cj) { cj.driveTarget.identity(); setDrive(cj, DRIVE_REL, 1, 2, 3); }
    }
    return removed;
  }
  disable(limb) {
    if (this.disabled[limb]) return;
    this.disabled[limb] = true;
    const side = limb.endsWith('R') ? 'R' : limb.endsWith('L') ? 'L' : null;
    if (side && (limb.startsWith('uArm') || limb.startsWith('fArm') || limb.startsWith('hand'))) this.releaseGrip(side);
  }
  kill() {
    if (!this.alive) return;
    this.alive = false; this.deathTime = this.time; this.hp = 0;
  }

  // Teleport the whole fighter to a fresh standing pose (new round)
  respawn(x, z, yaw) {
    // remove from world and rebuild bodies in place
    for (const b of this.bodies) { const i = this.world.bodies.indexOf(b); if (i >= 0) this.world.bodies.splice(i, 1); }
    for (const j of Object.values(this.joints)) this.world.removeJoint(j);
    if (this.grips) for (const j of Object.values(this.grips)) this.world.removeJoint(j);
    this.world.removeConstraint(this.swordDrive);
    this.parts = {}; this.joints = {}; this.bodies = [];
    this.origin.set(x, 0, z); this.yaw = yaw;
    this.alive = true; this.hp = CONFIG.FIGHTER.HP; this.wounds = []; this.bleedRate = 0;
    for (const n of LIMB_NAMES) { this.limbHp[n] = CONFIG.FIGHTER.LIMB_HP; this.disabled[n] = false; this.detached[n] = false; }
    this.swordHeld = true; this.gripActive = { R: true, L: true };
    this.fallen = false; this.fallenTime = 0; this.gettingUp = 0;
    this.input.mx = this.input.mz = this.input.sx = this.input.sy = 0;
    this._initControl();
    this._build();
    this.facing = yaw;
  }
}

// ---------------------------------------------------------------------
//  Which pairs of bodies may collide.
//  * different fighters: always
//  * own sword (while held): only with own legs and head
//  * severed parts: with everything except the part they're still jointed to
//  * own body: left leg parts vs right leg parts only
// ---------------------------------------------------------------------
const LEG_RE = /^(thigh|shin|foot)/;
export function fighterPairFilter(a, b) {
  const f = a.owner;
  if (!f || f !== b.owner) return true;
  const sa = a === f.sword, sb = b === f.sword;
  if (sa || sb) {
    const other = sa ? b : a;
    if (!f.swordHeld) return true;
    const n = other.limb;
    if (f.detached[n]) return true;
    return LEG_RE.test(n) || n === 'head';
  }
  const na = a.limb, nb = b.limb;
  const da = f.detached[na], db = f.detached[nb];
  if (da || db) {
    if (da && db && (LIMB_INFO[na].parent === nb || LIMB_INFO[nb].parent === na)) return false;
    return true;
  }
  if (LEG_RE.test(na) && LEG_RE.test(nb) && na.slice(-1) !== nb.slice(-1)) return true;
  return false;
}
