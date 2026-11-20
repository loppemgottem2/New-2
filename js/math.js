// =====================================================================
//  MATH.JS — tiny allocation-friendly vector / quaternion helpers used
//  by the physics engine and game logic (no three.js dependency, so the
//  simulation can also run headless in Node for tests).
// =====================================================================

export class V3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new V3(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  addScaled(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  scale(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  subVectors(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
  addVectors(a, b) { this.x = a.x + b.x; this.y = a.y + b.y; this.z = a.z + b.z; return this; }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  crossVectors(a, b) {
    const x = a.y * b.z - a.z * b.y, y = a.z * b.x - a.x * b.z, z = a.x * b.y - a.y * b.x;
    this.x = x; this.y = y; this.z = z; return this;
  }
  len() { return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z); }
  lenSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  normalize() { const l = this.len(); if (l > 1e-12) { this.x /= l; this.y /= l; this.z /= l; } return this; }
  distTo(v) { const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z; return Math.sqrt(dx * dx + dy * dy + dz * dz); }
  lerp(v, t) { this.x += (v.x - this.x) * t; this.y += (v.y - this.y) * t; this.z += (v.z - this.z) * t; return this; }
  applyQuat(q) {
    // v' = q v q*
    const x = this.x, y = this.y, z = this.z;
    const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
    this.x = x + qw * tx + qy * tz - qz * ty;
    this.y = y + qw * ty + qz * tx - qx * tz;
    this.z = z + qw * tz + qx * ty - qy * tx;
    return this;
  }
  applyQuatInv(q) {
    const x = this.x, y = this.y, z = this.z;
    const qx = -q.x, qy = -q.y, qz = -q.z, qw = q.w;
    const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
    this.x = x + qw * tx + qy * tz - qz * ty;
    this.y = y + qw * ty + qz * tx - qx * tz;
    this.z = z + qw * tz + qx * ty - qy * tx;
    return this;
  }
  isFinite() { return Number.isFinite(this.x) && Number.isFinite(this.y) && Number.isFinite(this.z); }
}

export class Quat {
  constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
  set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
  copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
  clone() { return new Quat(this.x, this.y, this.z, this.w); }
  identity() { this.x = 0; this.y = 0; this.z = 0; this.w = 1; return this; }
  normalize() {
    let l = Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w);
    if (l < 1e-12) { this.identity(); return this; }
    l = 1 / l; this.x *= l; this.y *= l; this.z *= l; this.w *= l; return this;
  }
  conjugate() { this.x = -this.x; this.y = -this.y; this.z = -this.z; return this; }
  // this = a * b
  multiplyQuats(a, b) {
    const ax = a.x, ay = a.y, az = a.z, aw = a.w, bx = b.x, by = b.y, bz = b.z, bw = b.w;
    this.x = ax * bw + aw * bx + ay * bz - az * by;
    this.y = ay * bw + aw * by + az * bx - ax * bz;
    this.z = az * bw + aw * bz + ax * by - ay * bx;
    this.w = aw * bw - ax * bx - ay * by - az * bz;
    return this;
  }
  multiply(b) { return this.multiplyQuats(this, b); }
  premultiply(a) { return this.multiplyQuats(a, this); }
  setFromAxisAngle(ax, ay, az, angle) {
    const h = angle / 2, s = Math.sin(h);
    this.x = ax * s; this.y = ay * s; this.z = az * s; this.w = Math.cos(h); return this;
  }
  // rotation vector (axis * angle)
  setFromRotVec(rx, ry, rz) {
    const a = Math.sqrt(rx * rx + ry * ry + rz * rz);
    if (a < 1e-9) return this.set(rx / 2, ry / 2, rz / 2, 1).normalize();
    return this.setFromAxisAngle(rx / a, ry / a, rz / a, a);
  }
  setFromUnitVectors(from, to) {
    let r = from.x * to.x + from.y * to.y + from.z * to.z + 1;
    if (r < 1e-7) {
      r = 0;
      if (Math.abs(from.x) > Math.abs(from.z)) { this.x = -from.y; this.y = from.x; this.z = 0; this.w = r; }
      else { this.x = 0; this.y = -from.z; this.z = from.y; this.w = r; }
    } else {
      this.x = from.y * to.z - from.z * to.y;
      this.y = from.z * to.x - from.x * to.z;
      this.z = from.x * to.y - from.y * to.x;
      this.w = r;
    }
    return this.normalize();
  }
  // From orthonormal basis columns (x axis, y axis, z axis)
  setFromBasis(xa, ya, za) {
    const m11 = xa.x, m12 = ya.x, m13 = za.x;
    const m21 = xa.y, m22 = ya.y, m23 = za.y;
    const m31 = xa.z, m32 = ya.z, m33 = za.z;
    const trace = m11 + m22 + m33;
    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1.0);
      this.w = 0.25 / s; this.x = (m32 - m23) * s; this.y = (m13 - m31) * s; this.z = (m21 - m12) * s;
    } else if (m11 > m22 && m11 > m33) {
      const s = 2.0 * Math.sqrt(1.0 + m11 - m22 - m33);
      this.w = (m32 - m23) / s; this.x = 0.25 * s; this.y = (m12 + m21) / s; this.z = (m13 + m31) / s;
    } else if (m22 > m33) {
      const s = 2.0 * Math.sqrt(1.0 + m22 - m11 - m33);
      this.w = (m13 - m31) / s; this.x = (m12 + m21) / s; this.y = 0.25 * s; this.z = (m23 + m32) / s;
    } else {
      const s = 2.0 * Math.sqrt(1.0 + m33 - m11 - m22);
      this.w = (m21 - m12) / s; this.x = (m13 + m31) / s; this.y = (m23 + m32) / s; this.z = 0.25 * s;
    }
    return this.normalize();
  }
  setFromYaw(yaw) { return this.setFromAxisAngle(0, 1, 0, yaw); }
  slerp(qb, t) {
    if (t <= 0) return this; if (t >= 1) return this.copy(qb);
    const x = this.x, y = this.y, z = this.z, w = this.w;
    let cosHalf = w * qb.w + x * qb.x + y * qb.y + z * qb.z;
    let bx = qb.x, by = qb.y, bz = qb.z, bw = qb.w;
    if (cosHalf < 0) { cosHalf = -cosHalf; bx = -bx; by = -by; bz = -bz; bw = -bw; }
    if (cosHalf >= 0.9995) {
      this.x = x + (bx - x) * t; this.y = y + (by - y) * t; this.z = z + (bz - z) * t; this.w = w + (bw - w) * t;
      return this.normalize();
    }
    const half = Math.acos(cosHalf), sinHalf = Math.sqrt(1 - cosHalf * cosHalf);
    const ra = Math.sin((1 - t) * half) / sinHalf, rb = Math.sin(t * half) / sinHalf;
    this.x = x * ra + bx * rb; this.y = y * ra + by * rb; this.z = z * ra + bz * rb; this.w = w * ra + bw * rb;
    return this;
  }
  isFinite() { return Number.isFinite(this.x) && Number.isFinite(this.y) && Number.isFinite(this.z) && Number.isFinite(this.w); }
}

// rotation vector (axis*angle) of quaternion q (shortest path)
export function quatToRotVec(q, out) {
  let x = q.x, y = q.y, z = q.z, w = q.w;
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
  const s = Math.sqrt(x * x + y * y + z * z);
  if (s < 1e-9) return out.set(2 * x, 2 * y, 2 * z);
  const angle = 2 * Math.atan2(s, w);
  const k = angle / s;
  return out.set(x * k, y * k, z * k);
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
export function wrapAngle(a) { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; }
export function rand(a = 0, b = 1) { return a + Math.random() * (b - a); }

// Closest points between segments p1-q1 and p2-q2. Writes into c1,c2, returns {s,t}
const _d1 = new V3(), _d2 = new V3(), _r = new V3();
export const segResult = { s: 0, t: 0 };
export function closestSegSeg(p1, q1, p2, q2, c1, c2) {
  _d1.subVectors(q1, p1); _d2.subVectors(q2, p2); _r.subVectors(p1, p2);
  const a = _d1.dot(_d1), e = _d2.dot(_d2), f = _d2.dot(_r);
  let s, t;
  if (a <= 1e-10 && e <= 1e-10) { s = 0; t = 0; }
  else if (a <= 1e-10) { s = 0; t = clamp(f / e, 0, 1); }
  else {
    const c = _d1.dot(_r);
    if (e <= 1e-10) { t = 0; s = clamp(-c / a, 0, 1); }
    else {
      const b = _d1.dot(_d2), denom = a * e - b * b;
      s = denom > 1e-10 ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  c1.copy(p1).addScaled(_d1, s);
  c2.copy(p2).addScaled(_d2, t);
  segResult.s = s; segResult.t = t;
  return segResult;
}

// Closest point on segment a-b to point p, returns t, writes out
export function closestPointSeg(p, a, b, out) {
  _d1.subVectors(b, a);
  const l2 = _d1.lenSq();
  let t = l2 > 1e-12 ? _r.subVectors(p, a).dot(_d1) / l2 : 0;
  t = clamp(t, 0, 1);
  out.copy(a).addScaled(_d1, t);
  return t;
}

// Simple seeded RNG (mulberry32) for reproducible tests
export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
