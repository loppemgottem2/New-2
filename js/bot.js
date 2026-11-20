// =====================================================================
//  BOT.JS — computer opponents, level 1 (clumsy) .. 10 (deadly).
//
//  Bots play by the same rules as people: every frame they only set the
//  two joysticks (move + sword). They see the world with a reaction
//  delay, plan swings as paths of the sword stick, try to block incoming
//  blades, and manage distance. Higher levels react faster, swing faster
//  (which matters: slow edges don't cut), aim better, block more and
//  keep better distance.
// =====================================================================
import { V3, clamp, lerp, wrapAngle } from './math.js';
import { SWORD_GEO } from './fighter.js';
import { CONFIG } from './config.js';

const TAU = Math.PI * 2;

function rimPath(t0, a0, a1, r, dur, n = 6) {
  const pts = [];
  for (let k = 0; k <= n; k++) {
    const a = a0 + (a1 - a0) * (k / n);
    pts.push([t0 + dur * (k / n), Math.sin(a) * r, Math.cos(a) * r]);
  }
  return pts;
}

export class Bot {
  constructor(level = 5, rng = Math.random) {
    this.rng = rng;
    this.setLevel(level);
    this.plan = null;
    this.cool = 0.6 + rng() * 0.6;
    this.history = [];
    this.moveDir = 0; this.strafe = 0; this.strafeT = 0;
    this.blockT = 0; this.block = null;
    this.stick = { x: 0, y: 0 };
    this.time = 0;
    this.noise = { x: 0, y: 0, t: 0 };
  }

  setLevel(level) {
    this.level = clamp(Math.round(level), 1, 10);
    const k = (this.level - 1) / 9, B = CONFIG.BOT;
    const L = (arr) => lerp(arr[0], arr[1], k);
    this.reaction = L(B.REACTION);
    this.aimNoise = L(B.AIM_NOISE);
    this.blockChance = L(B.BLOCK_CHANCE);
    this.aggression = L(B.AGGRESSION);
    this.swingSpeed = L(B.SWING_SPEED);
    this.spacing = L(B.SPACING);
    this.k = k;
  }

  // what the bot "sees": the state some reaction time ago
  _perceive(f, o) {
    const tip = o.sword.localToWorld(new V3(0, SWORD_GEO.tipY, 0), new V3());
    const tipVel = o.sword.pointVelocity(tip, new V3());
    this.history.push({ t: this.time, pos: o.parts.torso.pos.clone(), vel: o.comVel.clone(), tip, tipVel, alive: o.alive, armed: o.swordHeld });
    while (this.history.length > 2 && this.history[1].t <= this.time - this.reaction) this.history.shift();
    return this.history[0];
  }

  update(dt, f, match) {
    this.time += dt;
    const o = f.opponent;
    const inp = f.input;
    if (!f.alive) { inp.mx = inp.mz = inp.sx = inp.sy = 0; return; }
    const seen = this._perceive(f, o);
    const me = f.parts.torso.pos;
    const toO = new V3(seen.pos.x - me.x, 0, seen.pos.z - me.z);
    const dist = toO.len();
    const fwd = dist > 1e-4 ? toO.clone().scale(1 / dist) : new V3(0, 0, 1);
    const right = new V3(-fwd.z, 0, fwd.x);
    const fighting = match.state === 'fight' || match.state === 'intro';
    const oppThreat = seen.alive && seen.armed;

    // ---------------- footwork
    const reach = 1.55 + 0.1 * this.k;          // distance at which swings land
    let want = 0;                               // + toward, - away
    const hurt = f.hp < 45 || f.bleedRate > 3;
    if (!seen.alive || match.state === 'bleedout') {
      want = dist > 2.6 ? 0.4 : dist < 2.0 ? -0.6 : 0; // keep away from danger while bleeding out
    } else if (this.plan) {
      want = dist > reach - 0.1 ? 1 : dist < reach - 0.45 ? -0.5 : 0.15;
    } else if (this.cool > 0.25 && this.spacing > 0.5 && oppThreat) {
      // stay just outside the opponent's reach while recovering
      const safe = 2.05 + (hurt ? 0.4 : 0);
      want = dist < safe ? -0.9 * this.spacing : dist > safe + 0.5 ? 0.6 : 0;
    } else {
      want = dist > reach + 0.15 ? 1 : dist < reach - 0.5 ? -0.6 : 0.1;
    }
    // circling
    this.strafeT -= dt;
    if (this.strafeT <= 0) { this.strafe = (this.rng() < 0.5 ? -1 : 1) * (this.rng() < 0.3 + 0.4 * this.k ? 0.7 : 0); this.strafeT = 0.8 + this.rng() * 1.6; }
    const mv = new V3().addScaled(fwd, want).addScaled(right, this.strafe * (dist < 2.6 ? 1 : 0.3));
    // stay away from the edge
    const rr = Math.hypot(me.x, me.z);
    if (rr > CONFIG.PHYSICS.WALL_RADIUS - 1.6) { mv.x -= (me.x / rr) * 1.2; mv.z -= (me.z / rr) * 1.2; }
    if (f.fallen || match.state === 'intro') mv.set(0, 0, 0);
    const ml = mv.len(); if (ml > 1) mv.scale(1 / ml);
    inp.mx = mv.x; inp.mz = mv.z;

    // ---------------- sword
    this.cool -= dt;
    let sx = 0, sy = 0.08;
    // threat detection -> block
    if (oppThreat && fighting && !this.plan) {
      const rel = new V3().subVectors(seen.tip, me);
      const closing = -seen.tipVel.dot(rel) / Math.max(0.2, rel.len());
      const tipSpeed = seen.tipVel.len();
      if (rel.len() < 1.6 && tipSpeed > 3.2 && closing > 1.0 && this.blockT <= 0) {
        if (this.rng() < this.blockChance) {
          const side = rel.dot(right), up = rel.y - 0.25;
          // put the blade in the way: lean it toward the incoming side / up
          this.block = { x: clamp(side * 1.2, -0.65, 0.65), y: up > 0.25 ? 0.42 : 0.12, t: 0.35 };
        }
        this.blockT = 0.5;
      }
    }
    this.blockT -= dt;
    if (this.block) {
      sx = this.block.x; sy = this.block.y;
      this.block.t -= dt;
      if (this.block.t <= 0) this.block = null;
    } else if (this.plan) {
      this.plan.t += dt * this.swingSpeedNow;
      const p = this.plan.pts;
      let k = 0; while (k < p.length - 1 && p[k + 1][0] < this.plan.t) k++;
      if (k >= p.length - 1) { sx = p[p.length - 1][1]; sy = p[p.length - 1][2]; this.plan = null; this.cool = lerp(1.3, 0.45, this.aggression) + this.rng() * 0.5; }
      else {
        const a = p[k], b = p[k + 1], u = clamp((this.plan.t - a[0]) / Math.max(1e-4, b[0] - a[0]), 0, 1);
        sx = a[1] + (b[1] - a[1]) * u; sy = a[2] + (b[2] - a[2]) * u;
      }
    } else if (fighting && match.state === 'fight' && seen.alive && f.swordHeld && !f.fallen && this.cool <= 0 && dist < reach + 0.55) {
      this._choosePlan(f, seen, dist);
    }
    // aim noise (slowly varying)
    this.noise.t -= dt;
    if (this.noise.t <= 0) { this.noise.x = (this.rng() - 0.5) * this.aimNoise; this.noise.y = (this.rng() - 0.5) * this.aimNoise; this.noise.t = 0.3 + this.rng() * 0.4; }
    sx += this.noise.x; sy += this.noise.y;
    const r = Math.hypot(sx, sy); if (r > 1) { sx /= r; sy /= r; }
    inp.sx = sx; inp.sy = sy;
  }

  _choosePlan(f, seen, dist) {
    const rnd = this.rng;
    const k = this.k;
    // swing speed: low levels are slow (slow edges often fail to cut)
    this.swingSpeedNow = lerp(0.55, 1.15, this.swingSpeed) * (0.85 + rnd() * 0.3);
    const strike = lerp(0.42, 0.17, k);    // seconds for the cutting part of the swing
    const wind = lerp(0.55, 0.22, k);
    const kinds = ['slashRL', 'slashLR', 'chop', 'diagR', 'diagL', 'stab', 'stab'];
    // good bots favour what works: stabs and chops when close, wide slashes otherwise
    let kind = kinds[Math.floor(rnd() * kinds.length)];
    if (k > 0.5 && rnd() < k * 0.6) kind = dist < 1.45 ? (rnd() < 0.55 ? 'stab' : 'chop') : (rnd() < 0.5 ? 'slashRL' : 'slashLR');
    let pts;
    switch (kind) {
      case 'slashRL': pts = [[0, 0, 0.1], [wind, 0.9, 0.4], [wind + 0.08, 0.95, 0.3], ...rimPath(wind + 0.1, 1.5, -1.5, 0.98, strike)]; break;
      case 'slashLR': pts = [[0, 0, 0.1], [wind, -0.9, 0.4], [wind + 0.08, -0.95, 0.3], ...rimPath(wind + 0.1, -1.5, 1.5, 0.98, strike)]; break;
      case 'chop': pts = [[0, 0, 0.1], [wind, 0.05, -0.95], [wind + 0.1, 0.05, -0.95], [wind + 0.1 + strike * 0.6, 0.02, 0.62], [wind + 0.1 + strike, 0, 1]]; break;
      case 'diagR': pts = [[0, 0, 0.1], [wind, 0.7, -0.65], [wind + 0.08, 0.7, -0.65], [wind + 0.08 + strike, -0.75, 0.62]]; break;
      case 'diagL': pts = [[0, 0, 0.1], [wind, -0.7, -0.65], [wind + 0.08, -0.7, -0.65], [wind + 0.08 + strike, 0.75, 0.62]]; break;
      default: // stab: chamber up, then thrust straight at the chest and hold a moment
        pts = [[0, 0, 0.1], [wind * 0.8, 0, 0.25], [wind, 0, 0.3], [wind + strike * 0.45, 0, 1], [wind + strike * 0.45 + 0.35, 0, 1]];
    }
    pts.push([pts[pts.length - 1][0] + 0.25, 0, 0.1]);
    this.plan = { kind, pts, t: 0 };
  }
}
