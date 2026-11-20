// =====================================================================
//  RENDER.JS — three.js scene: bright sky arena, floating beige platform,
//  sun + shadows, shiny metal swords, the stickmen, blood and camera.
//  The renderer only READS fighter state (positions/rotations, limb
//  health, wounds), so it can draw a local match or a network mirror.
// =====================================================================
import * as THREE from '../vendor/three.module.min.js';
import { LIMB_INFO, LIMB_NAMES, GEO, SWORD_GEO } from './fighter.js';
import { CONFIG } from './config.js';

const SKY = { top: new THREE.Color(0x1f62c9), horizon: new THREE.Color(0x8fc3f2), bottom: new THREE.Color(0xd4e9fb) };
const SUN_DIR = new THREE.Vector3(-0.45, 0.78, 0.43).normalize();
const BODY_COLOR = new THREE.Color(0xdcd9d1);
const HURT_COLOR = new THREE.Color(0xa3100d);
const DEAD_TINT = new THREE.Color(0xb9b6ae);

// ---------------------------------------------------------------------
//  Geometry helpers
// ---------------------------------------------------------------------
function roundedBox(w, h, l, r, seg = 3) {
  const g = new THREE.BoxGeometry(w, h, l, seg * 2, seg * 2, seg * 2);
  const p = g.attributes.position, v = new THREE.Vector3(), inner = new THREE.Vector3(w / 2 - r, h / 2 - r, l / 2 - r);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const c = new THREE.Vector3(Math.max(-inner.x, Math.min(inner.x, v.x)), Math.max(-inner.y, Math.min(inner.y, v.y)), Math.max(-inner.z, Math.min(inner.z, v.z)));
    const n = v.clone().sub(c);
    if (n.lengthSq() > 1e-12) n.normalize().multiplyScalar(r);
    p.setXYZ(i, c.x + n.x, c.y + n.y, c.z + n.z);
  }
  g.computeVertexNormals();
  return g;
}

// diamond-section tapered blade along +Y (sword local frame: Z = edge, X = flat)
function bladeGeometry() {
  const S = SWORD_GEO;
  const y0 = S.bladeStart, y1 = S.tipY;
  const stations = [];
  const N = 14;
  for (let i = 0; i <= N; i++) {
    const t = i / N, y = y0 + (y1 - y0) * t;
    let w = S.bladeWidth / 2 * (1 - 0.28 * t);
    let th = S.bladeThick / 2 * (1 - 0.35 * t);
    if (t > 0.86) { const k = (1 - t) / 0.14; w *= Math.pow(k, 0.85); th *= k; }
    stations.push([y, Math.max(w, 0.0004), Math.max(th, 0.0003)]);
  }
  // cross-section: edge(+Z), bevel, ridge(+X), bevel, edge(-Z), ... 6 points for nicer light
  const prof = (w, t) => [[0, w], [t * 0.95, w * 0.45], [t, 0], [t * 0.95, -w * 0.45], [0, -w], [-t * 0.95, -w * 0.45], [-t, 0], [-t * 0.95, w * 0.45]];
  const pos = [], idx = [];
  const M = 8;
  for (const [y, w, t] of stations) for (const [x, z] of prof(w, t)) pos.push(x, y, z);
  for (let i = 0; i < N; i++) for (let k = 0; k < M; k++) {
    const a = i * M + k, b = i * M + (k + 1) % M, c = (i + 1) * M + k, d = (i + 1) * M + (k + 1) % M;
    idx.push(a, c, b, b, c, d);
  }
  // base cap
  const base = pos.length / 3; pos.push(0, y0, 0);
  for (let k = 0; k < M; k++) idx.push(base, k, (k + 1) % M);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function makeCloudTexture(seed) {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const x = c.getContext('2d');
  let s = seed;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  for (let i = 0; i < 22; i++) {
    const cx = 60 + rnd() * 136, cy = 90 + rnd() * 70, r = 28 + rnd() * 50;
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
    const shade = 235 + Math.floor(rnd() * 20);
    g.addColorStop(0, `rgba(${shade},${shade},255,0.55)`);
    g.addColorStop(0.6, `rgba(${shade},${shade},255,0.25)`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------------
//  Fighter view: meshes for the 14 parts + sword
// ---------------------------------------------------------------------
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _c = new THREE.Color();

class FighterView {
  constructor(renderer, style) {
    this.r = renderer;
    this.group = new THREE.Group();
    this.meshes = {};
    this.mats = {};
    this.style = style;
    const caps = {
      torso: [GEO.torsoR, GEO.torsoHalf * 2], head: [GEO.headR, 0],
      uArmR: [0.055, GEO.uArmLen], fArmR: [0.05, GEO.fArmLen], handR: [GEO.handR, 0],
      uArmL: [0.055, GEO.uArmLen], fArmL: [0.05, GEO.fArmLen], handL: [GEO.handR, 0],
      thighR: [0.075, GEO.thighLen], shinR: [0.06, GEO.shinLen],
      thighL: [0.075, GEO.thighLen], shinL: [0.06, GEO.shinLen],
    };
    for (const n of LIMB_NAMES) {
      const mat = new THREE.MeshStandardMaterial({ color: BODY_COLOR.clone(), roughness: 0.58, metalness: 0.0 });
      let geo;
      if (n.startsWith('foot')) geo = renderer.geo.foot;
      else if (caps[n][1] === 0) geo = renderer.sphereGeo(caps[n][0]);
      else geo = renderer.capsuleGeo(caps[n][0], caps[n][1]);
      const m = new THREE.Mesh(geo, mat);
      if (n.startsWith('foot')) m.userData.offset = 0;
      m.castShadow = true; m.receiveShadow = true;
      this.group.add(m);
      this.meshes[n] = m; this.mats[n] = mat;
      m.userData.wounds = [];
    }
    this.sword = this._makeSword(style);
    this.group.add(this.sword);
    this.stumps = {};
    this.woundCount = 0;
  }

  _makeSword(style) {
    const R = this.r, S = SWORD_GEO, g = new THREE.Group();
    const blade = new THREE.Mesh(R.geo.blade, R.mat.blade);
    blade.castShadow = true;
    g.add(blade);
    // blood film on the blade
    this.bladeBlood = new THREE.Mesh(R.geo.bladeBlood, new THREE.MeshStandardMaterial({ color: 0x7a0505, roughness: 0.25, metalness: 0.1, transparent: true, opacity: 0 }));
    g.add(this.bladeBlood);
    const guardMat = style === 0 ? R.mat.brass : R.mat.darkSteel;
    const guard = new THREE.Mesh(R.geo.guard, guardMat); guard.position.y = S.guardY; guard.castShadow = true; g.add(guard);
    const grip = new THREE.Mesh(R.geo.grip, style === 0 ? R.mat.gripA : R.mat.gripB);
    grip.position.y = (S.gripTop + S.gripBottom) / 2; grip.castShadow = true; g.add(grip);
    for (let i = 0; i < 5; i++) { // wrap rings
      const ring = new THREE.Mesh(R.geo.gripRing, guardMat); ring.position.y = S.gripBottom + 0.02 + i * 0.04; g.add(ring);
    }
    const pommel = new THREE.Mesh(R.geo.pommel, guardMat); pommel.position.y = S.pommelY + 0.025; pommel.castShadow = true; g.add(pommel);
    this.bloodOnBlade = 0;
    return g;
  }

  // f: fighter-like {parts:{n:{pos,q}}, sword:{pos,q}, limbHp, detached, disabled, alive, wounds}
  sync(f, interp) {
    for (const n of LIMB_NAMES) {
      const m = this.meshes[n], b = f.parts[n];
      const p = interp ? interp.pos(b) : b.pos, q = interp ? interp.rot(b) : b.q;
      m.position.set(p.x, p.y, p.z);
      m.quaternion.set(q.x, q.y, q.z, q.w);
      // damage colour
      const hp = f.limbHp[n];
      let k = Math.pow(Math.max(0, 1 - hp / 100), 0.75);
      if (f.disabled[n]) k = Math.max(k, 0.92);
      _c.copy(BODY_COLOR).lerp(HURT_COLOR, k);
      if (!f.alive) _c.lerp(DEAD_TINT, 0.12);
      this.mats[n].color.copy(_c);
    }
    const sb = f.sword, sp = interp ? interp.pos(sb) : sb.pos, sq = interp ? interp.rot(sb) : sb.q;
    this.sword.position.set(sp.x, sp.y, sp.z);
    this.sword.quaternion.set(sq.x, sq.y, sq.z, sq.w);
    this.bladeBlood.material.opacity = Math.min(0.85, this.bloodOnBlade);
    this.bladeBlood.visible = this.bloodOnBlade > 0.02;
    this._syncWounds(f);
  }

  _syncWounds(f) {
    const R = this.r;
    const list = f.wounds;
    // add new wound decals (we only ever append; a respawn clears them)
    while (this.woundCount < list.length) {
      const w = list[this.woundCount++];
      const limb = w.limb || (w.body && w.body.limb);
      const host = this.meshes[limb]; if (!host) continue;
      const lp = w.local;
      if (w.stump) {
        const r = (LIMB_INFO[limb].r || 0.06) * 1.02;
        const s = new THREE.Mesh(R.geo.stump, R.mat.stump);
        s.scale.setScalar(r);
        s.position.set(lp.x, lp.y, lp.z);
        host.add(s);
      } else {
        const s = new THREE.Mesh(R.geo.wound, R.mat.wound);
        const size = 0.018 + 0.03 * (w.size ?? 0.5);
        s.scale.set(size, size * 0.35, size * 1.6);
        // place on the surface, flattened along the normal from the limb axis
        _v.set(lp.x, 0, lp.z);
        const info = LIMB_INFO[limb];
        if (info.kind === 'head' || limb.startsWith('hand')) _v.set(lp.x, lp.y, lp.z);
        if (_v.lengthSq() < 1e-8) _v.set(0, 0, 1);
        _v.normalize();
        const rr = limb.startsWith('foot') ? 0.05 : info.r;
        s.position.set(_v.x * rr * 0.96, lp.y, _v.z * rr * 0.96);
        if (info.kind === 'head' || limb.startsWith('hand')) s.position.copy(_v).multiplyScalar(rr * 0.96);
        s.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), _v);
        s.rotateY(Math.random() * Math.PI);
        host.add(s);
      }
    }
  }

  clearWounds() {
    for (const n of LIMB_NAMES) {
      const m = this.meshes[n];
      for (let i = m.children.length - 1; i >= 0; i--) m.remove(m.children[i]);
    }
    this.woundCount = 0;
    this.bloodOnBlade = 0;
  }
}

// ---------------------------------------------------------------------
//  Blood & sparks
// ---------------------------------------------------------------------
class Effects {
  constructor(r) {
    this.r = r;
    const MAXP = 900, MAXD = 420, MAXS = 120;
    this.p = []; this.maxP = MAXP;
    this.drops = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ color: 0x6a0202, roughness: 0.2, metalness: 0.05 }), MAXP);
    this.drops.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.drops.count = 0; this.drops.frustumCulled = false; this.drops.castShadow = false;
    r.scene.add(this.drops);
    const dg = new THREE.CircleGeometry(1, 14); dg.rotateX(-Math.PI / 2);
    this.decals = new THREE.InstancedMesh(dg, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.32, metalness: 0.0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), MAXD);
    this.decals.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.decals.count = 0; this.decals.receiveShadow = true; this.decals.frustumCulled = false;
    this.decalData = []; this.decalNext = 0; this.maxD = MAXD;
    r.scene.add(this.decals);
    this.sparks = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 6, 4), new THREE.MeshBasicMaterial({ color: 0xffd9a0, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }), MAXS);
    this.sparks.count = 0; this.sparks.frustumCulled = false; this.sp = []; this.maxS = MAXS;
    r.scene.add(this.sparks);
    this.m4 = new THREE.Matrix4(); this.tmpQ = new THREE.Quaternion(); this.tmpS = new THREE.Vector3(); this.tmpP = new THREE.Vector3();
    this.amount = 1; // blood setting multiplier
  }
  clear() { this.p.length = 0; this.decalData.length = 0; this.decals.count = 0; this.decalNext = 0; this.sp.length = 0; }
  blood(x, y, z, vx, vy, vz, n, spread = 1.2, size = 1) {
    n = Math.round(n * this.amount);
    for (let i = 0; i < n; i++) {
      if (this.p.length >= this.maxP) this.p.shift();
      this.p.push({
        x, y, z,
        vx: vx + (Math.random() - 0.5) * spread, vy: vy + (Math.random() - 0.3) * spread, vz: vz + (Math.random() - 0.5) * spread,
        s: (0.006 + Math.random() * 0.011) * size, life: 2.5,
      });
    }
  }
  spark(x, y, z, power) {
    const n = 8 + Math.round(14 * power);
    for (let i = 0; i < n; i++) {
      if (this.sp.length >= this.maxS) this.sp.shift();
      const a = Math.random() * Math.PI * 2, b = Math.random() * 2 - 1, sp = 2 + Math.random() * 5 * (0.5 + power);
      const c = Math.sqrt(1 - b * b);
      this.sp.push({ x, y, z, vx: Math.cos(a) * c * sp, vy: b * sp + 1, vz: Math.sin(a) * c * sp, life: 0.15 + Math.random() * 0.25, s: 0.004 + Math.random() * 0.005 });
    }
  }
  _decal(x, z, size) {
    const R = CONFIG.PHYSICS.ARENA_RADIUS;
    if (x * x + z * z > R * R) return;
    const d = { x, z, s: size, grow: size * (1.3 + Math.random() * 0.8), rot: Math.random() * 6.28, sx: 0.8 + Math.random() * 0.5, shade: 0.12 + Math.random() * 0.1 };
    this.decalData[this.decalNext] = d;
    this.decalNext = (this.decalNext + 1) % this.maxD;
    this.decals.count = Math.max(this.decals.count, this.decalData.length);
    this._writeDecal(this.decalData.indexOf(d), d);
  }
  _writeDecal(i, d) {
    this.tmpQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0), d.rot);
    this.tmpS.set(d.s * d.sx, 1, d.s);
    this.tmpP.set(d.x, 0.003 + (i % 7) * 0.0004, d.z);
    this.m4.compose(this.tmpP, this.tmpQ, this.tmpS);
    this.decals.setMatrixAt(i, this.m4);
    _c.setRGB(d.shade, 0.004, 0.004);
    this.decals.setColorAt(i, _c);
    this.decals.instanceMatrix.needsUpdate = true;
    if (this.decals.instanceColor) this.decals.instanceColor.needsUpdate = true;
  }
  update(dt) {
    const g = 9.81, R = CONFIG.PHYSICS.ARENA_RADIUS;
    let n = 0;
    for (let i = this.p.length - 1; i >= 0; i--) {
      const p = this.p[i];
      p.vy -= g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.life -= dt;
      if (p.y <= 0.004 && p.x * p.x + p.z * p.z < R * R) {
        if (Math.random() < 0.4) this._decal(p.x, p.z, 0.008 + p.s * (2 + Math.random() * 2.4));
        this.p.splice(i, 1); continue;
      }
      if (p.life <= 0 || p.y < -30) { this.p.splice(i, 1); continue; }
    }
    for (const p of this.p) {
      const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy + p.vz * p.vz);
      this.tmpP.set(p.x, p.y, p.z);
      if (sp > 0.5) { this.tmpQ.setFromUnitVectors(new THREE.Vector3(0, 1, 0), _v.set(p.vx / sp, p.vy / sp, p.vz / sp)); this.tmpS.set(p.s, p.s * Math.min(3, 1 + sp * 0.25), p.s); }
      else { this.tmpQ.identity(); this.tmpS.set(p.s, p.s, p.s); }
      this.m4.compose(this.tmpP, this.tmpQ, this.tmpS);
      this.drops.setMatrixAt(n++, this.m4);
    }
    this.drops.count = n; this.drops.instanceMatrix.needsUpdate = true;
    // growing decals
    let changed = false;
    for (let i = 0; i < this.decalData.length; i++) {
      const d = this.decalData[i];
      if (d && d.s < d.grow) { d.s = Math.min(d.grow, d.s + dt * 0.02); this._writeDecal(i, d); changed = true; }
    }
    void changed;
    let k = 0;
    for (let i = this.sp.length - 1; i >= 0; i--) {
      const s = this.sp[i];
      s.vy -= g * dt; s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt; s.life -= dt;
      if (s.life <= 0) { this.sp.splice(i, 1); continue; }
    }
    for (const s of this.sp) {
      this.tmpP.set(s.x, s.y, s.z); this.tmpQ.identity(); this.tmpS.setScalar(s.s * (0.5 + s.life * 3));
      this.m4.compose(this.tmpP, this.tmpQ, this.tmpS);
      this.sparks.setMatrixAt(k++, this.m4);
    }
    this.sparks.count = k; this.sparks.instanceMatrix.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------
//  The renderer
// ---------------------------------------------------------------------
export class GameRenderer {
  constructor(canvas, settings) {
    this.canvas = canvas;
    this.settings = settings;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: settings.quality !== 'low', powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(SKY.horizon.clone(), 60, 260);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 600);
    this.camera.position.set(0, 2.2, -5);
    this._geoCache = new Map();
    this._buildShared();
    this._buildWorld();
    this.effects = new Effects(this);
    this.views = [];
    this.camState = { pos: new THREE.Vector3(0, 2.2, -5), look: new THREE.Vector3(0, 1, 0), side: 1, dist: 4.5, shake: 0 };
    this.applySettings(settings);
    this.resize();
  }

  sphereGeo(r) { const k = 's' + r; if (!this._geoCache.has(k)) this._geoCache.set(k, new THREE.SphereGeometry(r, 28, 20)); return this._geoCache.get(k); }
  capsuleGeo(r, len) { const k = 'c' + r + '_' + len; if (!this._geoCache.has(k)) this._geoCache.set(k, new THREE.CapsuleGeometry(r, len, 8, 20)); return this._geoCache.get(k); }

  _buildShared() {
    const S = SWORD_GEO;
    this.geo = {
      foot: roundedBox(GEO.foot.w, GEO.foot.h, GEO.foot.l, 0.03, 3),
      blade: bladeGeometry(),
      guard: roundedBox(0.032, 0.026, S.guardHalf * 2 + 0.02, 0.008, 2),
      grip: new THREE.CylinderGeometry(0.0165, 0.018, S.gripTop - S.gripBottom, 14),
      gripRing: new THREE.TorusGeometry(0.018, 0.0028, 6, 16).rotateX(Math.PI / 2),
      pommel: new THREE.SphereGeometry(0.027, 16, 12),
      wound: new THREE.SphereGeometry(1, 10, 8),
      stump: new THREE.SphereGeometry(1, 16, 12),
    };
    const bb = bladeGeometry(); bb.scale(1.25, 0.6, 1.08); bb.translate(0, 0.05, 0);
    this.geo.bladeBlood = bb;
    this.mat = {
      blade: new THREE.MeshStandardMaterial({ color: 0xf2f5f8, metalness: 1.0, roughness: 0.1, envMapIntensity: 1.7 }),
      brass: new THREE.MeshStandardMaterial({ color: 0xcfa54e, metalness: 1.0, roughness: 0.28 }),
      darkSteel: new THREE.MeshStandardMaterial({ color: 0x8d949c, metalness: 1.0, roughness: 0.32 }),
      gripA: new THREE.MeshStandardMaterial({ color: 0x3a2a1f, roughness: 0.78 }),
      gripB: new THREE.MeshStandardMaterial({ color: 0x1f2630, roughness: 0.78 }),
      wound: new THREE.MeshStandardMaterial({ color: 0x5e0303, roughness: 0.3 }),
      stump: new THREE.MeshStandardMaterial({ color: 0x7d0606, roughness: 0.35, emissive: 0x200000 }),
    };
  }

  _buildWorld() {
    const scene = this.scene;
    // sky dome
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: SKY.top }, horizon: { value: SKY.horizon }, bottom: { value: SKY.bottom }, sunDir: { value: SUN_DIR }, sunColor: { value: new THREE.Color(1.0, 0.92, 0.78) } },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }`,
      fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 bottom; uniform vec3 sunDir; uniform vec3 sunColor; varying vec3 vDir;
        void main(){ float h = vDir.y; vec3 col = mix(horizon, top, pow(clamp(h,0.0,1.0), 0.6));
          col = mix(col, bottom, smoothstep(0.0, -0.3, h));
          float s = max(dot(normalize(vDir), sunDir), 0.0);
          col += sunColor * (pow(s, 900.0) * 6.0 + pow(s, 30.0) * 0.35 + pow(s, 4.0) * 0.08);
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(500, 32, 16), skyMat);
    this.sky.frustumCulled = false;
    scene.add(this.sky);
    // environment map from the sky (for shiny metal)
    const pm = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), skyMat.clone()));
    const ground = new THREE.Mesh(new THREE.CircleGeometry(6, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x5e4c36 }));
    ground.position.y = -1.5; envScene.add(ground);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 1.2, 32, 1, true), new THREE.MeshBasicMaterial({ color: 0x3d4a5c, side: THREE.BackSide }));
    band.position.y = -0.4; envScene.add(band);
    const sunBall = new THREE.Mesh(new THREE.SphereGeometry(0.6, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(8, 7.4, 6.4) }));
    sunBall.position.copy(SUN_DIR).multiplyScalar(8); envScene.add(sunBall);
    this.envMap = pm.fromScene(envScene, 0.02).texture;
    scene.environment = this.envMap;
    pm.dispose();

    // lights
    this.hemi = new THREE.HemisphereLight(0xbcd8ff, 0xc9ae80, 0.85);
    scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff0d8, 2.35);
    this.sun.position.copy(SUN_DIR).multiplyScalar(20);
    this.sun.castShadow = true;
    const sc = this.sun.shadow.camera;
    sc.left = -5; sc.right = 5; sc.top = 5; sc.bottom = -5; sc.near = 1; sc.far = 50;
    this.sun.shadow.bias = -0.0004; this.sun.shadow.normalBias = 0.02;
    this.sun.shadow.radius = 3;
    scene.add(this.sun); scene.add(this.sun.target);

    // arena platform: beige disc with a rounded rim and a tapered underside
    const R = CONFIG.PHYSICS.ARENA_RADIUS;
    const prof = [];
    prof.push(new THREE.Vector2(0, -2.6));
    prof.push(new THREE.Vector2(R * 0.55, -1.6));
    prof.push(new THREE.Vector2(R * 0.9, -0.75));
    prof.push(new THREE.Vector2(R - 0.02, -0.32));
    for (let i = 0; i <= 8; i++) { const a = -Math.PI / 2 + (i / 8) * (Math.PI / 2); prof.push(new THREE.Vector2(R - 0.18 + Math.cos(a) * 0.18, -0.18 + Math.sin(a) * 0.18 + 0.18 * 0)); }
    prof.push(new THREE.Vector2(R - 0.18, 0));
    const plat = new THREE.Mesh(new THREE.LatheGeometry(prof, 96), new THREE.MeshStandardMaterial({ color: 0xc9ab7c, roughness: 0.9, metalness: 0 }));
    plat.receiveShadow = true;
    scene.add(plat);
    const topMat = new THREE.MeshStandardMaterial({ color: 0xd6bc8f, roughness: 0.92, metalness: 0 });
    // subtle concentric bands so motion reads on the floor
    topMat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vXZ;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvXZ = position.xz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vXZ;')
        .replace('#include <color_fragment>', `#include <color_fragment>
          float rr = length(vXZ);
          float band = smoothstep(0.02, 0.0, abs(rr - ${(CONFIG.PHYSICS.WALL_RADIUS + 0.05).toFixed(2)})) * 0.10 + smoothstep(0.015, 0.0, abs(rr - 2.2)) * 0.035;
          float n = fract(sin(dot(floor(vXZ * 3.0), vec2(12.9898, 78.233))) * 43758.5453);
          diffuseColor.rgb *= (1.0 - band) * (0.985 + n * 0.03);`);
    };
    const top = new THREE.Mesh(new THREE.CircleGeometry(R - 0.17, 96).rotateX(-Math.PI / 2), topMat);
    top.position.y = 0.0005; top.receiveShadow = true;
    scene.add(top);
    this.platform = plat; this.platformTop = top;

    // clouds around and below the platform
    this.clouds = [];
    const texs = [makeCloudTexture(7), makeCloudTexture(42), makeCloudTexture(1337)];
    for (let i = 0; i < 34; i++) {
      const m = new THREE.SpriteMaterial({ map: texs[i % 3], transparent: true, depthWrite: false, fog: false, opacity: 0.95 });
      const s = new THREE.Sprite(m);
      const a = Math.random() * Math.PI * 2, d = 45 + Math.random() * 140, y = -40 + Math.random() * 46 - (d < 70 ? 18 : 0);
      s.position.set(Math.cos(a) * d, y, Math.sin(a) * d);
      const sc2 = 30 + Math.random() * 50; s.scale.set(sc2 * 1.6, sc2, 1);
      s.userData.speed = 0.4 + Math.random() * 0.8; s.userData.a = a; s.userData.d = d;
      this.clouds.push(s); scene.add(s);
    }
  }

  applySettings(s) {
    this.settings = s;
    const dpr = window.devicePixelRatio || 1;
    const pr = s.quality === 'low' ? Math.min(1, dpr) : s.quality === 'medium' ? Math.min(1.5, dpr) : Math.min(2, dpr);
    this.renderer.setPixelRatio(pr);
    const shadows = s.shadows !== false && s.quality !== 'low';
    this.renderer.shadowMap.enabled = shadows;
    this.sun.castShadow = shadows;
    const size = s.quality === 'high' ? 2048 : 1024;
    if (this.sun.shadow.mapSize.x !== size) { this.sun.shadow.mapSize.set(size, size); if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; } }
    this.effects && (this.effects.amount = s.blood === 'off' ? 0 : s.blood === 'low' ? 0.4 : s.blood === 'lots' ? 2.2 : 1);
    this.scene.traverse((o) => { if (o.material && o.material.needsUpdate !== undefined) o.material.needsUpdate = true; });
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  addFighterView(style) { const v = new FighterView(this, style); this.scene.add(v.group); this.views.push(v); return v; }
  // soft ring on the floor under the local player so you always know which one you are
  setMarker(pos, visible) {
    if (!this.marker) {
      const g = new THREE.RingGeometry(0.34, 0.42, 48); g.rotateX(-Math.PI / 2);
      this.marker = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false }));
      this.marker.renderOrder = 2;
      this.scene.add(this.marker);
    }
    this.marker.visible = visible;
    if (visible) this.marker.position.set(pos.x, 0.006, pos.z);
  }
  removeAllViews() { for (const v of this.views) this.scene.remove(v.group); this.views.length = 0; }

  // react to combat/game events (blood bursts, sparks)
  handleEvents(events, fightersById) {
    for (const e of events) {
      switch (e.type) {
        case 'slash': case 'stab': this.effects.blood(e.x, e.y, e.z, 0, 0.8, 0, 14, 1.8); break;
        case 'cutting': this.effects.blood(e.x, e.y, e.z, 0, 0.6, 0, 4 + e.amount * 70, 2.2); this._bloodySword(e, fightersById, e.amount); break;
        case 'sever': this.effects.blood(e.x, e.y, e.z, 0, 1.5, 0, 60, 2.8, 1.3); this.camState.shake = Math.max(this.camState.shake, 0.6); break;
        case 'clash': this.effects.spark(e.x, e.y, e.z, e.power); this.camState.shake = Math.max(this.camState.shake, 0.15 * e.power); break;
        case 'vital': this.effects.blood(e.x, e.y, e.z, 0, 1, 0, 40, 2.2); this.camState.shake = Math.max(this.camState.shake, 0.4); break;
        case 'death': this.camState.shake = Math.max(this.camState.shake, 0.35); break;
        default: break;
      }
    }
  }
  _bloodySword(e, fightersById, amount) {
    // the attacker is the opponent of the victim
    const victim = fightersById[e.victim];
    if (!victim) return;
    const attackerIdx = e.victim === 0 ? 1 : 0;
    const v = this.views[attackerIdx];
    if (v) v.bloodOnBlade = Math.min(1, v.bloodOnBlade + amount * 2 + 0.08);
  }

  // continuous bleeding from wounds
  emitBleeding(f, view, dt, interp) {
    for (const w of f.wounds) {
      const rate = w.rate ?? 0;
      if (rate < 0.08) continue;
      const limb = w.limb || (w.body && w.body.limb);
      const body = f.parts[limb]; if (!body) continue;
      const expected = rate * dt * (w.stump ? 6 : 3) * this.effects.amount;
      let n = Math.floor(expected) + (Math.random() < expected % 1 ? 1 : 0);
      if (!n) continue;
      const p = interp ? interp.pos(body) : body.pos, q = interp ? interp.rot(body) : body.q;
      _q.set(q.x, q.y, q.z, q.w);
      _v.set(w.local.x, w.local.y, w.local.z).applyQuaternion(_q);
      const wx = p.x + _v.x, wy = p.y + _v.y, wz = p.z + _v.z;
      // outward direction: away from the limb centre (stumps spurt along the limb)
      const dir = _v.clone(); if (!w.stump) dir.y *= 0.3; if (dir.lengthSq() < 1e-6) dir.set(0, 1, 0); dir.normalize();
      const pulse = w.stump ? (0.7 + 0.6 * Math.max(0, Math.sin(performance.now() * 0.009))) : 1;
      const spd = (w.stump ? 1.6 : 0.5) * pulse * Math.min(1.6, 0.4 + rate * 0.15);
      this.effects.blood(wx, wy, wz, dir.x * spd + body.vel.x * 0.8, dir.y * spd + body.vel.y * 0.8, dir.z * spd + body.vel.z * 0.8, n, w.stump ? 0.5 : 0.3, w.stump ? 1.1 : 0.8);
    }
    view.bloodOnBlade = Math.max(0, view.bloodOnBlade - dt * 0.025);
  }

  // --------------------------------------------------------- camera
  // mode 'duel': frame both fighters (+ flying limbs) from behind the local player
  updateDuelCamera(dt, me, other, extraPoints, settingsShake = true) {
    const cs = this.camState;
    const A = me.parts.torso.pos, B = other.parts.torso.pos;
    const mid = new THREE.Vector3((A.x + B.x) / 2, 0, (A.z + B.z) / 2);
    const u = new THREE.Vector3(B.x - A.x, 0, B.z - A.z);
    const sep = u.length(); if (sep > 1e-3) u.divideScalar(sep); else u.set(0, 0, 1);
    // pick the side that's closest to where the camera already is
    const p = new THREE.Vector3(-u.z, 0, u.x);
    const curDir = new THREE.Vector3(cs.pos.x - mid.x, 0, cs.pos.z - mid.z).normalize();
    const beta = 0.82; // radians from straight behind the player toward the side
    const dirA = u.clone().multiplyScalar(-Math.cos(beta)).addScaled ? null : null;
    void dirA;
    const d1 = new THREE.Vector3().copy(u).multiplyScalar(-Math.cos(beta)).add(p.clone().multiplyScalar(Math.sin(beta)));
    const d2 = new THREE.Vector3().copy(u).multiplyScalar(-Math.cos(beta)).add(p.clone().multiplyScalar(-Math.sin(beta)));
    const want = (d1.dot(curDir) >= d2.dot(curDir) - 0.25 * cs.side) ? d1 : d2;
    cs.side = want === d1 ? 1 : -1;
    // framing radius: fighters + recently flying parts
    let rad = sep / 2 + 0.9;
    for (const q of extraPoints) {
      const dx = q.x - mid.x, dz = q.z - mid.z, dy = q.y - 1;
      rad = Math.max(rad, Math.sqrt(dx * dx + dz * dz + dy * dy * 0.5) + 0.5);
    }
    rad = Math.min(rad, 7.5);
    const portrait = this.camera.aspect < 1.2;
    const targetDist = Math.max(3.3, rad * (portrait ? 3.2 : 2.25) + 1.0);
    cs.dist += (targetDist - cs.dist) * (1 - Math.exp(-dt * (targetDist > cs.dist ? 4 : 1.5)));
    const height = 1.05 + cs.dist * 0.36;
    const camPos = mid.clone().addScaledVector(want, cs.dist); camPos.y = height;
    const look = mid.clone(); look.y = 0.95;
    const k = 1 - Math.exp(-dt * 3.2);
    cs.pos.lerp(camPos, k); cs.look.lerp(look, 1 - Math.exp(-dt * 5));
    // keep the camera above the platform level when near the edge
    this.camera.position.copy(cs.pos);
    if (settingsShake && cs.shake > 0.001) {
      this.camera.position.x += (Math.random() - 0.5) * cs.shake * 0.12;
      this.camera.position.y += (Math.random() - 0.5) * cs.shake * 0.12;
    }
    cs.shake *= Math.exp(-dt * 6);
    this.camera.lookAt(cs.look);
    this._shadowFollow(mid, rad);
  }
  // camera direction on the ground plane (for camera-relative movement)
  cameraForward() {
    const v = new THREE.Vector3(); this.camera.getWorldDirection(v); v.y = 0;
    if (v.lengthSq() < 1e-6) v.set(0, 0, 1);
    return v.normalize();
  }
  snapCamera() { this.camState.pos.copy(this.camera.position); }

  _shadowFollow(center, rad) {
    const s = Math.max(3.2, rad + 1.2);
    const sc = this.sun.shadow.camera;
    if (Math.abs(sc.right - s) > 0.3) { sc.left = -s; sc.right = s; sc.top = s; sc.bottom = -s; sc.updateProjectionMatrix(); }
    this.sun.target.position.set(center.x, 0.8, center.z);
    this.sun.position.set(center.x, 0.8, center.z).addScaledVector(SUN_DIR, 20);
  }

  // menu: fixed camera near the pedestal, gentle sway
  updateMenuCamera(t, focus) {
    const portrait = this.camera.aspect < 1.2;
    const pos = new THREE.Vector3(focus.x + 1.85 + Math.sin(t * 0.15) * 0.12, focus.y + 1.45, focus.z + 3.35 + Math.cos(t * 0.12) * 0.08);
    this.camera.position.copy(pos);
    const look = new THREE.Vector3(focus.x + (portrait ? 0 : 1.05), focus.y + 1.0, focus.z);
    this.camera.lookAt(look);
    this._shadowFollow(new THREE.Vector3(focus.x, 0, focus.z), 1.5);
  }

  updateClouds(dt) {
    for (const c of this.clouds) {
      c.userData.a += dt * 0.004 * c.userData.speed;
      c.position.x = Math.cos(c.userData.a) * c.userData.d;
      c.position.z = Math.sin(c.userData.a) * c.userData.d;
    }
  }

  render() { this.renderer.render(this.scene, this.camera); }
}

export { THREE };
