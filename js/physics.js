// =====================================================================
//  PHYSICS.JS — a small rigid-body engine based on XPBD
//  ("Detailed Rigid Body Simulation with Extended Position Based
//  Dynamics", Müller et al. 2020).
//
//  Why a custom engine: the game needs things off-the-shelf engines make
//  awkward — muscles as soft joint "drives" that stay stable at high
//  stiffness, per-pair collision switching while a blade is inside a
//  limb, and planar / prismatic "cut" constraints that are created and
//  destroyed every few frames. XPBD with many substeps handles all of
//  these robustly, and it runs headless in Node for automated tests.
//
//  Shapes: capsules (spheres are zero-length capsules) for body-body
//  contact, plus "ground points" (sphere-swept points) for contact with
//  the arena floor and its invisible circular wall.
// =====================================================================
import { V3, Quat, quatToRotVec, closestSegSeg } from './math.js';

let BODY_ID = 0;

export class Body {
  constructor(o = {}) {
    this.id = BODY_ID++;
    this.name = o.name || '';
    this.pos = new V3(); this.q = new Quat();
    this.vel = new V3(); this.angVel = new V3();
    this.prevPos = new V3(); this.prevQ = new Quat();
    this.force = new V3(); this.torque = new V3();
    this.mass = o.mass || 1;
    this.invMass = 1 / this.mass;
    // a floor on inertia keeps tiny parts (hands, the sword's long axis) from spinning up
    const I = (o.inertia || [1, 1, 1]).map((v) => Math.max(v, o.minInertia ?? 0.004));
    this.invInertia = new V3(1 / I[0], 1 / I[1], 1 / I[2]);
    this.capsules = [];     // {a,b (local), r, wa, wb (world)}
    this.groundPts = [];    // {p (local), r, w (world)}
    this.friction = o.friction ?? 0.8;
    this.restitution = o.restitution ?? 0.0;
    this.linDamping = o.linDamping ?? 0.05;
    this.angDamping = o.angDamping ?? 0.3;
    this.owner = null;      // fighter / game object
    this.tag = o.tag || '';
    this.aabbMin = new V3(); this.aabbMax = new V3();
    this.grounded = false;      // touched the floor during the last step()
    this.groundNormalForce = 0; // sum of floor contact lambda during last step
    this.collide = true;        // participates in body-body contacts
    this.groundCollide = true;
  }
  addCapsule(ax, ay, az, bx, by, bz, r) {
    this.capsules.push({ a: new V3(ax, ay, az), b: new V3(bx, by, bz), r, wa: new V3(), wb: new V3() });
    return this;
  }
  addGroundPoint(x, y, z, r) { this.groundPts.push({ p: new V3(x, y, z), r, w: new V3(), anchor: new V3(), hasAnchor: false }); return this; }
  localToWorld(local, out) { return out.copy(local).applyQuat(this.q).add(this.pos); }
  worldToLocal(world, out) { return out.copy(world).sub(this.pos).applyQuatInv(this.q); }
  pointVelocity(worldPoint, out) {
    // v + w x r
    const rx = worldPoint.x - this.pos.x, ry = worldPoint.y - this.pos.y, rz = worldPoint.z - this.pos.z;
    const w = this.angVel;
    return out.set(this.vel.x + w.y * rz - w.z * ry, this.vel.y + w.z * rx - w.x * rz, this.vel.z + w.x * ry - w.y * rx);
  }
  updateWorldShapes() {
    let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    for (const c of this.capsules) {
      c.wa.copy(c.a).applyQuat(this.q).add(this.pos);
      c.wb.copy(c.b).applyQuat(this.q).add(this.pos);
      minx = Math.min(minx, c.wa.x - c.r, c.wb.x - c.r); maxx = Math.max(maxx, c.wa.x + c.r, c.wb.x + c.r);
      miny = Math.min(miny, c.wa.y - c.r, c.wb.y - c.r); maxy = Math.max(maxy, c.wa.y + c.r, c.wb.y + c.r);
      minz = Math.min(minz, c.wa.z - c.r, c.wb.z - c.r); maxz = Math.max(maxz, c.wa.z + c.r, c.wb.z + c.r);
    }
    for (const g of this.groundPts) g.w.copy(g.p).applyQuat(this.q).add(this.pos);
    this.aabbMin.set(minx, miny, minz); this.aabbMax.set(maxx, maxy, maxz);
  }
  kineticEnergy() {
    return 0.5 * this.mass * this.vel.lenSq();
  }
}

// ---------------------------------------------------------------------
//  Low level XPBD helpers (shared by joints, contacts and game constraints)
// ---------------------------------------------------------------------
const _t = new V3(), _t2 = new V3(), _rn = new V3(), _p = new V3(), _dq = new Quat(), _q = new Quat();

// out = I^-1 * v (world)
export function invInertiaMul(b, v, out) {
  out.copy(v).applyQuatInv(b.q);
  out.x *= b.invInertia.x; out.y *= b.invInertia.y; out.z *= b.invInertia.z;
  return out.applyQuat(b.q);
}
// generalized inverse mass for a positional correction along n at offset r
export function genInvMassPos(b, r, n) {
  if (!b || b.invMass === 0) return 0;
  _rn.crossVectors(r, n);
  invInertiaMul(b, _rn, _t2);
  return b.invMass + _rn.dot(_t2);
}
export function genInvMassRot(b, n) {
  if (!b || b.invMass === 0) return 0;
  invInertiaMul(b, n, _t2);
  return n.dot(_t2);
}
function rotateBy(b, wx, wy, wz, sign) {
  // q += 0.5 * sign * (w,0) * q
  const q = b.q;
  _dq.set(wx * sign, wy * sign, wz * sign, 0);
  _dq.multiply(q);
  q.x += 0.5 * _dq.x; q.y += 0.5 * _dq.y; q.z += 0.5 * _dq.z; q.w += 0.5 * _dq.w;
  q.normalize();
}
// apply positional impulse p at world offset r (sign +1 / -1)
export function applyPosImpulse(b, r, p, sign) {
  if (!b || b.invMass === 0) return;
  b.pos.x += p.x * b.invMass * sign; b.pos.y += p.y * b.invMass * sign; b.pos.z += p.z * b.invMass * sign;
  _rn.crossVectors(r, p);
  invInertiaMul(b, _rn, _t2);
  rotateBy(b, _t2.x, _t2.y, _t2.z, sign);
}
// Move b1's point (offset r1) along +n and b2's point (offset r2) along -n so the
// gap C closes. Returns the lambda (impulse*h^2).
export function applyLinear(b1, b2, r1, r2, n, C, compliance, h, maxLambda = Infinity) {
  const w1 = genInvMassPos(b1, r1, n), w2 = genInvMassPos(b2, r2, n);
  const w = w1 + w2 + compliance / (h * h);
  if (w < 1e-12) return 0;
  let dl = C / w;
  if (dl > maxLambda) dl = maxLambda; else if (dl < -maxLambda) dl = -maxLambda;
  _p.copy(n).scale(dl);
  applyPosImpulse(b1, r1, _p, 1);
  applyPosImpulse(b2, r2, _p, -1);
  return dl;
}
// Rotate b1 by +rotVec share and b2 by -rotVec share. Returns lambda magnitude.
const _n = new V3();
export function applyAngular(b1, b2, rx, ry, rz, compliance, h, maxLambda = Infinity) {
  const theta = Math.sqrt(rx * rx + ry * ry + rz * rz);
  if (theta < 1e-9) return 0;
  _n.set(rx / theta, ry / theta, rz / theta);
  const w1 = genInvMassRot(b1, _n), w2 = genInvMassRot(b2, _n);
  const w = w1 + w2 + compliance / (h * h);
  if (w < 1e-12) return 0;
  let dl = theta / w;
  if (dl > maxLambda) dl = maxLambda;
  _p.copy(_n).scale(dl);
  if (b1 && b1.invMass) { invInertiaMul(b1, _p, _t); rotateBy(b1, _t.x, _t.y, _t.z, 1); }
  if (b2 && b2.invMass) { invInertiaMul(b2, _p, _t); rotateBy(b2, _t.x, _t.y, _t.z, -1); }
  return dl;
}
// Velocity-level impulse p at offsets (b1 gets +p, b2 gets -p)
export function applyVelImpulse(b1, b2, r1, r2, p) {
  if (b1 && b1.invMass) {
    b1.vel.addScaled(p, b1.invMass);
    _rn.crossVectors(r1, p); invInertiaMul(b1, _rn, _t); b1.angVel.add(_t);
  }
  if (b2 && b2.invMass) {
    b2.vel.addScaled(p, -b2.invMass);
    _rn.crossVectors(r2, p); invInertiaMul(b2, _rn, _t); b2.angVel.sub(_t);
  }
}
// Angular velocity impulse (b1 +L, b2 -L)
export function applyAngVelImpulse(b1, b2, L) {
  if (b1 && b1.invMass) { invInertiaMul(b1, L, _t); b1.angVel.add(_t); }
  if (b2 && b2.invMass) { invInertiaMul(b2, L, _t); b2.angVel.sub(_t); }
}

// ---------------------------------------------------------------------
//  Joints: ball / hinge with optional cone or hinge limits and a "drive"
//  (muscle) that pulls toward a target orientation.
// ---------------------------------------------------------------------
export const DRIVE_OFF = 0, DRIVE_REL = 1, DRIVE_CHILD_WORLD = 2, DRIVE_PARENT_WORLD = 3;

export class Joint {
  constructor(b1, b2, worldAnchor, o = {}) {
    this.b1 = b1; this.b2 = b2; // b1 = parent, b2 = child
    this.r1 = b1.worldToLocal(worldAnchor, new V3());
    this.r2 = b2.worldToLocal(worldAnchor, new V3());
    this.qRest = b1.q.clone().conjugate().multiply(b2.q); // parent^-1 * child at build time
    this.enabled = true;
    this.name = o.name || '';
    this.compliance = o.compliance || 0;
    // hinge
    this.hinge = !!o.hingeAxis; // world axis at build time
    if (this.hinge) {
      this.ha1 = o.hingeAxis.clone().applyQuatInv(b1.q);
      this.ha2 = o.hingeAxis.clone().applyQuatInv(b2.q);
      const ref = o.hingeRef; // world reference vector perpendicular to axis
      this.hr1 = ref.clone().applyQuatInv(b1.q);
      this.hr2 = ref.clone().applyQuatInv(b2.q);
      this.hingeMin = o.hingeMin ?? -Math.PI; this.hingeMax = o.hingeMax ?? Math.PI;
    }
    // cone (swing) limit
    if (o.coneAxis) {
      this.ca1 = o.coneAxis.clone().applyQuatInv(b1.q);
      this.ca2 = (o.coneAxisChild || o.coneAxis).clone().applyQuatInv(b2.q);
      this.coneMax = o.coneMax ?? Math.PI / 2;
    } else this.ca1 = null;
    // twist limit about the child's axis
    if (o.twistAxis) {
      this.ta1 = o.twistAxis.clone().applyQuatInv(b1.q);
      this.ta2 = o.twistAxis.clone().applyQuatInv(b2.q);
      this.tr1 = o.twistRef.clone().applyQuatInv(b1.q);
      this.tr2 = o.twistRef.clone().applyQuatInv(b2.q);
      this.twistMax = o.twistMax ?? 0.5;
    } else this.ta1 = null;
    // drive (muscle)
    this.driveMode = DRIVE_OFF;
    this.driveTarget = new Quat();
    this.stiffness = 0;       // N m / rad
    this.damping = 0;         // 1/s fraction of relative spin removed per second
    this.maxTorque = Infinity;
    this.lastDriveLambda = 0;
    this.groundChild = false;
  }
}

const _a1 = new V3(), _a2 = new V3(), _p1 = new V3(), _p2 = new V3(), _r1 = new V3(), _r2 = new V3(), _d = new V3();
const _rv = new V3();

function solveJointPos(j, h) {
  const b1 = j.b1, b2 = j.b2;
  // --- attachment
  _r1.copy(j.r1).applyQuat(b1.q); _r2.copy(j.r2).applyQuat(b2.q);
  _p1.addVectors(b1.pos, _r1); _p2.addVectors(b2.pos, _r2);
  _d.subVectors(_p2, _p1);
  const c = _d.len();
  if (c > 1e-9) { _d.scale(1 / c); applyLinear(b1, b2, _r1, _r2, _d, c, j.compliance, h); }
  // --- hinge axis alignment + angle limit
  if (j.hinge) {
    _a1.copy(j.ha1).applyQuat(b1.q); _a2.copy(j.ha2).applyQuat(b2.q);
    _rv.crossVectors(_a1, _a2);
    applyAngular(b1, b2, _rv.x, _rv.y, _rv.z, 0, h);
    _a1.copy(j.ha1).applyQuat(b1.q);
    _p1.copy(j.hr1).applyQuat(b1.q); _p2.copy(j.hr2).applyQuat(b2.q);
    _rv.crossVectors(_p1, _p2);
    let phi = Math.atan2(_rv.dot(_a1), _p1.dot(_p2));
    if (phi < j.hingeMin || phi > j.hingeMax) {
      const lim = phi < j.hingeMin ? j.hingeMin : j.hingeMax;
      _q.setFromAxisAngle(_a1.x, _a1.y, _a1.z, lim);
      _p1.applyQuat(_q);
      _rv.crossVectors(_p1, _p2);
      applyAngular(b1, b2, _rv.x, _rv.y, _rv.z, 0, h);
    }
  }
  // --- cone limit
  if (j.ca1) {
    _a1.copy(j.ca1).applyQuat(b1.q); _a2.copy(j.ca2).applyQuat(b2.q);
    const cosA = Math.max(-1, Math.min(1, _a1.dot(_a2)));
    const ang = Math.acos(cosA);
    if (ang > j.coneMax) {
      _rv.crossVectors(_a1, _a2);
      const l = _rv.len();
      if (l > 1e-6) { _rv.scale((ang - j.coneMax) / l); applyAngular(b1, b2, _rv.x, _rv.y, _rv.z, 0, h); }
    }
  }
  // --- twist limit
  if (j.ta1) {
    _a1.copy(j.ta1).applyQuat(b1.q); _a2.copy(j.ta2).applyQuat(b2.q);
    _n.addVectors(_a1, _a2); const nl = _n.len();
    if (nl > 1e-6) {
      _n.scale(1 / nl);
      _p1.copy(j.tr1).applyQuat(b1.q); _p1.addScaled(_n, -_n.dot(_p1)).normalize();
      _p2.copy(j.tr2).applyQuat(b2.q); _p2.addScaled(_n, -_n.dot(_p2)).normalize();
      _rv.crossVectors(_p1, _p2);
      const phi = Math.atan2(_rv.dot(_n), _p1.dot(_p2));
      if (Math.abs(phi) > j.twistMax) {
        const lim = phi > 0 ? j.twistMax : -j.twistMax;
        _q.setFromAxisAngle(_n.x, _n.y, _n.z, lim);
        _p1.applyQuat(_q);
        _rv.crossVectors(_p1, _p2);
        applyAngular(b1, b2, _rv.x, _rv.y, _rv.z, 0, h);
      }
    }
  }
  // --- drive
  if (j.driveMode !== DRIVE_OFF && j.stiffness > 0) {
    const maxL = j.maxTorque * h * h;
    const comp = 1 / j.stiffness;
    if (j.driveMode === DRIVE_PARENT_WORLD) {
      _q.copy(b1.q).conjugate().premultiply(j.driveTarget);
      quatToRotVec(_q, _rv);
      // groundChild: the child (a planted foot) passes the reaction straight into the floor
      j.lastDriveLambda = applyAngular(b1, j.groundChild ? null : b2, _rv.x, _rv.y, _rv.z, comp, h, maxL);
    } else {
      if (j.driveMode === DRIVE_REL) _q.copy(b1.q).multiply(j.qRest).multiply(j.driveTarget);
      else _q.copy(j.driveTarget);
      // dq = qd * child^-1
      _dq.copy(b2.q).conjugate();
      _q.multiply(_dq);
      quatToRotVec(_q, _rv);
      // groundChild (REL only): the child is held by the floor, so only the parent turns
      if (j.groundChild && j.driveMode === DRIVE_REL) j.lastDriveLambda = applyAngular(null, b1, _rv.x, _rv.y, _rv.z, comp, h, maxL);
      else j.lastDriveLambda = applyAngular(b2, b1, _rv.x, _rv.y, _rv.z, comp, h, maxL);
    }
  }
}

function solveJointVel(j, h) {
  if (j.driveMode === DRIVE_OFF || j.damping <= 0) return;
  const b1 = j.b1, b2 = j.b2;
  let wx, wy, wz, first, second;
  if (j.driveMode === DRIVE_REL) { wx = b2.angVel.x - b1.angVel.x; wy = b2.angVel.y - b1.angVel.y; wz = b2.angVel.z - b1.angVel.z; first = j.groundChild ? null : b2; second = b1; }
  else if (j.driveMode === DRIVE_CHILD_WORLD) { wx = b2.angVel.x; wy = b2.angVel.y; wz = b2.angVel.z; first = b2; second = b1; }
  else { wx = b1.angVel.x; wy = b1.angVel.y; wz = b1.angVel.z; first = b1; second = j.groundChild ? null : b2; }
  const m = Math.sqrt(wx * wx + wy * wy + wz * wz);
  if (m < 1e-6) return;
  _n.set(wx / m, wy / m, wz / m);
  const w = genInvMassRot(first, _n) + genInvMassRot(second, _n);
  if (w < 1e-12) return;
  const f = Math.min(1, j.damping * h);
  let L = (m * f) / w;
  const maxL = j.maxTorque * h;
  if (L > maxL) L = maxL;
  _p.copy(_n).scale(-L);
  applyAngVelImpulse(first, second, _p);
}

// ---------------------------------------------------------------------
//  Contacts
// ---------------------------------------------------------------------
class Contact {
  constructor() {
    this.b1 = null; this.b2 = null;
    this.n = new V3(); this.r1 = new V3(); this.r2 = new V3();
    this.l1 = new V3(); this.l2 = new V3(); // local contact points
    this.depth = 0; this.lambdaN = 0; this.vnPrev = 0;
    this.mu = 0.8; this.e = 0;
  }
}

const _c1 = new V3(), _c2 = new V3(), _v1 = new V3(), _v2 = new V3();

export class World {
  constructor(o = {}) {
    this.gravity = o.gravity ?? -9.81;
    this.substeps = o.substeps ?? 10;
    this.arenaRadius = o.arenaRadius ?? Infinity; // invisible circular wall
    this.groundY = 0;
    this.groundFriction = o.groundFriction ?? 1.0;
    this.bodies = [];
    this.joints = [];
    this.constraints = []; // objects with solvePos(h, world) / solveVel(h, world)
    this.pairs = [];
    this.contacts = [];
    this.contactPool = [];
    this.nContacts = 0;
    this.pairFilter = null; // (b1,b2) => bool
    this.contactHook = null; // (b1,b2,ci1,ci2,c) => bool (false = ignore contact)
    this.ignore = new Set(); // pair keys to ignore temporarily
    this.time = 0;
    this.onGroundImpact = null; // (body, speed, point)
    this.onBodyImpact = null;   // (b1,b2,speed,point)
    this.impactCooldown = new Map();
  }
  add(b) { this.bodies.push(b); b.updateWorldShapes(); return b; }
  addJoint(j) { this.joints.push(j); return j; }
  removeJoint(j) { j.enabled = false; const i = this.joints.indexOf(j); if (i >= 0) this.joints.splice(i, 1); }
  addConstraint(c) { this.constraints.push(c); return c; }
  removeConstraint(c) { const i = this.constraints.indexOf(c); if (i >= 0) this.constraints.splice(i, 1); }
  static pairKey(a, b) { return a.id < b.id ? a.id * 1048576 + b.id : b.id * 1048576 + a.id; }

  _collectPairs(dt) {
    const bs = this.bodies; this.pairs.length = 0;
    for (const b of bs) b.updateWorldShapes();
    for (let i = 0; i < bs.length; i++) {
      const a = bs[i]; if (!a.collide || !a.capsules.length) continue;
      const ma = (a.vel.len() + 2) * dt + 0.02;
      for (let k = i + 1; k < bs.length; k++) {
        const b = bs[k]; if (!b.collide || !b.capsules.length) continue;
        const m = ma + (b.vel.len() + 2) * dt;
        if (a.aabbMin.x - m > b.aabbMax.x || b.aabbMin.x - m > a.aabbMax.x ||
            a.aabbMin.y - m > b.aabbMax.y || b.aabbMin.y - m > a.aabbMax.y ||
            a.aabbMin.z - m > b.aabbMax.z || b.aabbMin.z - m > a.aabbMax.z) continue;
        if (this.pairFilter && !this.pairFilter(a, b)) continue;
        this.pairs.push(a, b);
      }
    }
  }

  _newContact() {
    let c = this.contactPool[this.nContacts];
    if (!c) { c = new Contact(); this.contactPool.push(c); }
    this.nContacts++;
    return c;
  }

  step(dt) {
    const n = this.substeps, h = dt / n;
    this._collectPairs(dt);
    for (const b of this.bodies) { b.grounded = false; b.groundNormalForce = 0; }
    for (let s = 0; s < n; s++) {
      this._integrate(h);
      for (const j of this.joints) if (j.enabled) solveJointPos(j, h);
      for (const c of this.constraints) c.solvePos && c.solvePos(h, this);
      for (const b of this.bodies) b.updateWorldShapes();
      this.nContacts = 0;
      this._solveGround(h);
      this._solveBodyContacts(h);
      this._updateVelocities(h);
      this._solveContactVel(h);
      for (const j of this.joints) if (j.enabled) solveJointVel(j, h);
      for (const c of this.constraints) c.solveVel && c.solveVel(h, this);
    }
    for (const b of this.bodies) { b.force.set(0, 0, 0); b.torque.set(0, 0, 0); }
    this.time += dt;
  }

  _integrate(h) {
    const g = this.gravity;
    for (const b of this.bodies) {
      if (b.invMass === 0) continue;
      b.prevPos.copy(b.pos); b.prevQ.copy(b.q);
      // linear
      b.vel.x += h * b.force.x * b.invMass;
      b.vel.y += h * (g + b.force.y * b.invMass);
      b.vel.z += h * b.force.z * b.invMass;
      const ld = Math.max(0, 1 - b.linDamping * h);
      b.vel.scale(ld);
      const vl = b.vel.len(); if (vl > 40) b.vel.scale(40 / vl);
      b.pos.addScaled(b.vel, h);
      // angular (with external torque, gyroscopic term ignored for stability)
      if (b.torque.x || b.torque.y || b.torque.z) { invInertiaMul(b, b.torque, _t); b.angVel.addScaled(_t, h); }
      const ad = Math.max(0, 1 - b.angDamping * h);
      b.angVel.scale(ad);
      const wl = b.angVel.len(); if (wl > 60) b.angVel.scale(60 / wl);
      rotateBy(b, b.angVel.x * h, b.angVel.y * h, b.angVel.z * h, 1);
    }
  }

  _updateVelocities(h) {
    const ih = 1 / h;
    for (const b of this.bodies) {
      if (b.invMass === 0) continue;
      b.vel.subVectors(b.pos, b.prevPos).scale(ih);
      _q.copy(b.prevQ).conjugate().premultiply(b.q);
      const s = _q.w >= 0 ? 2 * ih : -2 * ih;
      b.angVel.set(_q.x * s, _q.y * s, _q.z * s);
      const wl = b.angVel.len(); if (wl > 70) b.angVel.scale(70 / wl);
    }
  }

  // floor + invisible wall
  _solveGround(h) {
    const R = this.arenaRadius, gy = this.groundY;
    for (const b of this.bodies) {
      if (b.invMass === 0 || !b.groundCollide) continue;
      for (const g of b.groundPts) {
        g.w.copy(g.p).applyQuat(b.q).add(b.pos);
        // floor
        const d = gy + g.r - g.w.y;
        if (d > 0) {
          const c = this._newContact();
          c.b1 = b; c.b2 = null;
          c.n.set(0, 1, 0);
          c.r1.set(g.w.x - b.pos.x, g.w.y - g.r - b.pos.y, g.w.z - b.pos.z);
          c.depth = d; c.mu = Math.sqrt(b.friction * this.groundFriction); c.e = 0;
          this._solveGroundContact(c, g, h);
          b.grounded = true;
          b.groundNormalForce += c.lambdaN;
        } else if (d < -0.003) g.hasAnchor = false;
        // wall
        if (R < Infinity) {
          const rho = Math.sqrt(g.w.x * g.w.x + g.w.z * g.w.z);
          const dw = rho + g.r - R;
          if (dw > 0 && rho > 1e-6) {
            const c = this._newContact();
            c.b1 = b; c.b2 = null;
            c.n.set(-g.w.x / rho, 0, -g.w.z / rho);
            c.r1.set(g.w.x + (g.w.x / rho) * g.r - b.pos.x, g.w.y - b.pos.y, g.w.z + (g.w.z / rho) * g.r - b.pos.z);
            c.depth = dw; c.mu = 0.3; c.e = 0;
            this._solveContactPos(c, h);
          }
        }
      }
    }
  }

  _solveBodyContacts(h) {
    const P = this.pairs;
    for (let i = 0; i < P.length; i += 2) {
      const a = P[i], b = P[i + 1];
      if (this.ignore.size && this.ignore.has(World.pairKey(a, b))) continue;
      for (let ia = 0; ia < a.capsules.length; ia++) {
        const ca = a.capsules[ia];
        for (let ib = 0; ib < b.capsules.length; ib++) {
          const cb = b.capsules[ib];
          closestSegSeg(ca.wa, ca.wb, cb.wa, cb.wb, _c1, _c2);
          _d.subVectors(_c1, _c2);
          const dist = _d.len(), rs = ca.r + cb.r;
          if (dist >= rs) continue;
          const c = this._newContact();
          c.b1 = a; c.b2 = b;
          if (dist > 1e-7) c.n.copy(_d).scale(1 / dist);
          else c.n.set(0, 1, 0);
          c.depth = rs - dist;
          // contact points on surfaces
          c.r1.copy(_c1).addScaled(c.n, -ca.r).sub(a.pos);
          c.r2.copy(_c2).addScaled(c.n, cb.r).sub(b.pos);
          c.mu = Math.sqrt(a.friction * b.friction);
          c.e = Math.max(a.restitution, b.restitution);
          if (this.contactHook && !this.contactHook(a, b, ia, ib, c, _c1, _c2)) { this.nContacts--; continue; }
          this._solveContactPos(c, h);
        }
      }
    }
  }

  // Floor contact with a persistent friction anchor (no creeping on resting contacts)
  _solveGroundContact(c, g, h) {
    const b = c.b1;
    b.pointVelocity(_c1.addVectors(b.pos, c.r1), _v1);
    c.vnPrev = _v1.y;
    c.lambdaN = applyLinear(b, null, c.r1, null, c.n, c.depth, 0, h);
    // contact point after the normal correction
    g.w.copy(g.p).applyQuat(b.q).add(b.pos);
    c.r1.set(g.w.x - b.pos.x, g.w.y - g.r - b.pos.y, g.w.z - b.pos.z);
    const px = g.w.x, pz = g.w.z;
    if (!g.hasAnchor) { g.anchor.set(px, 0, pz); g.hasAnchor = true; return; }
    let dx = px - g.anchor.x, dz = pz - g.anchor.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 1e-9) return;
    _d.set(dx / dist, 0, dz / dist);
    const w = genInvMassPos(b, c.r1, _d);
    if (w < 1e-12) return;
    const maxL = c.mu * c.lambdaN;
    const lt = dist / w;
    if (lt <= maxL) {
      applyLinear(b, null, c.r1, null, _d, -dist, 0, h);
    } else {
      // sliding: pull back only as far as friction allows, anchor follows
      applyLinear(b, null, c.r1, null, _d, -maxL * w, 0, h);
      const keep = dist - maxL * w;
      g.anchor.x += _d.x * keep; g.anchor.z += _d.z * keep;
    }
  }

  _solveContactPos(c, h) {
    const b1 = c.b1, b2 = c.b2;
    // relative normal velocity before the solve (for restitution)
    b1.pointVelocity(_c1.addVectors(b1.pos, c.r1), _v1);
    if (b2) b2.pointVelocity(_c2.addVectors(b2.pos, c.r2), _v2); else _v2.set(0, 0, 0);
    c.vnPrev = (_v1.x - _v2.x) * c.n.x + (_v1.y - _v2.y) * c.n.y + (_v1.z - _v2.z) * c.n.z;
    // local points for static friction
    c.l1.copy(c.r1).applyQuatInv(b1.q);
    if (b2) c.l2.copy(c.r2).applyQuatInv(b2.q);
    // normal
    c.lambdaN = applyLinear(b1, b2, c.r1, c.r2, c.n, c.depth, 0, h);
    // static friction
    c.r1.copy(c.l1).applyQuat(b1.q);
    _p1.addVectors(b1.pos, c.r1);
    _t.copy(c.l1).applyQuat(b1.prevQ).add(b1.prevPos);
    _d.subVectors(_p1, _t);
    if (b2) {
      c.r2.copy(c.l2).applyQuat(b2.q);
      _p2.addVectors(b2.pos, c.r2);
      _t.copy(c.l2).applyQuat(b2.prevQ).add(b2.prevPos);
      _d.sub(_p2.sub(_t));
    }
    _d.addScaled(c.n, -_d.dot(c.n));
    const dt = _d.len();
    if (dt > 1e-9) {
      _d.scale(1 / dt);
      const w = genInvMassPos(b1, c.r1, _d) + genInvMassPos(b2, c.r2, _d);
      if (w > 1e-12) {
        const lt = dt / w;
        if (lt < c.mu * c.lambdaN) applyLinear(b1, b2, c.r1, c.r2, _d, -dt, 0, h);
      }
    }
  }

  _solveContactVel(h) {
    const g = Math.abs(this.gravity);
    for (let i = 0; i < this.nContacts; i++) {
      const c = this.contactPool[i];
      const b1 = c.b1, b2 = c.b2;
      b1.pointVelocity(_c1.addVectors(b1.pos, c.r1), _v1);
      if (b2) b2.pointVelocity(_c2.addVectors(b2.pos, c.r2), _v2); else _v2.set(0, 0, 0);
      _v1.sub(_v2);
      const vn = _v1.dot(c.n);
      _d.copy(_v1).addScaled(c.n, -vn); // tangential
      const vt = _d.len();
      // dynamic friction: tangential impulse limited by mu * normal impulse
      if (vt > 1e-6) {
        _t.copy(_d).scale(1 / vt);
        const wt = genInvMassPos(b1, c.r1, _t) + genInvMassPos(b2, c.r2, _t);
        if (wt > 1e-12) {
          const Pt = Math.min(vt / wt, c.mu * c.lambdaN / h);
          _p.copy(_t).scale(-Pt);
          applyVelImpulse(b1, b2, c.r1, c.r2, _p);
        }
      }
      // restitution / removal of artificial separation velocity
      let e = c.e; if (Math.abs(vn) < 2 * g * h) e = 0;
      const vnTarget = Math.max(-e * c.vnPrev, 0);
      const dvn = vnTarget - vn;
      if (Math.abs(dvn) > 1e-7) {
        const wn = genInvMassPos(b1, c.r1, c.n) + genInvMassPos(b2, c.r2, c.n);
        if (wn > 1e-12) { _p.copy(c.n).scale(dvn / wn); applyVelImpulse(b1, b2, c.r1, c.r2, _p); }
      }
      // impact callbacks (use pre-solve approach speed)
      if (c.vnPrev < -1.2) {
        if (!b2) { if (this.onGroundImpact) this.onGroundImpact(b1, -c.vnPrev, c); }
        else if (this.onBodyImpact) this.onBodyImpact(b1, b2, -c.vnPrev, c);
      }
    }
  }
}

// Inertia helpers (diagonal, body frame, long axis = Y)
export function capsuleInertia(mass, r, halfLen) {
  const L = halfLen * 2 + r * 2;
  const iy = 0.5 * mass * r * r;
  const ix = mass * (3 * r * r + L * L) / 12;
  return [ix, iy, ix];
}
export function sphereInertia(mass, r) { const i = 0.4 * mass * r * r; return [i, i, i]; }
export function boxInertia(mass, sx, sy, sz) {
  return [mass * (sy * sy + sz * sz) / 12, mass * (sx * sx + sz * sz) / 12, mass * (sx * sx + sy * sy) / 12];
}
