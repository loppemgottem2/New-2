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
import { SWORD_GEO, SWORD_GUARD } from './fighter.js';
import { CONFIG } from './config.js';

const TAU = Math.PI * 2;

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
    if (!f.alive) { inp.mx = inp.mz = 0; inp.sx = SWORD_GUARD.x; inp.sy = SWORD_GUARD.y; return; }
    const seen = this._perceive(f, o);
    const me = f.parts.torso.pos;
    const toO = new V3(seen.pos.x - me.x, 0, seen.pos.z - me.z);
    const dist = toO.len();
    const fwd = dist > 1e-4 ? toO.clone().scale(1 / dist) : new V3(0, 0, 1);
    const right = new V3(-fwd.z, 0, fwd.x);
    const fighting = match.state === 'fight' || match.state === 'intro';
    const oppThreat = seen.alive && seen.armed;

    // ---------------- footwork
    const reach = 1.38 + 0.1 * this.k;          // torso distance at which swings land
    let want = 0;                               // + toward, - away
    const hurt = f.hp < 45 || f.bleedRate > 3;
    if (!seen.alive || match.state === 'bleedout') {
      want = dist > 2.6 ? 0.4 : dist < 2.0 ? -0.6 : 0; // keep away from danger while bleeding out
    } else if (this.plan) {
      want = dist > reach - 0.05 ? 1 : dist < reach - 0.4 ? -0.5 : 0.2;
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
    let sx = SWORD_GUARD.x, sy = SWORD_GUARD.y;
    // threat detection -> block
    if (oppThreat && fighting && !this.plan) {
      const rel = new V3().subVectors(seen.tip, me);
      const closing = -seen.tipVel.dot(rel) / Math.max(0.2, rel.len());
      const tipSpeed = seen.tipVel.len();
      if (rel.len() < 1.6 && tipSpeed > 3.2 && closing > 1.0 && this.blockT <= 0) {
        if (this.rng() < this.blockChance) {
          const side = rel.dot(right), up = rel.y - me.y;
          const sgn = side >= 0 ? 1 : -1;
          // put the blade in the way of the incoming one
          if (up > 0.35) this.block = { x: sgn * 0.92, y: 0.38, t: 0.35 };               // high: blade across above
          else if (up < -0.35) this.block = { x: sgn * 0.55, y: -0.65, t: 0.35 };        // low: point down to that side
          else this.block = { x: clamp(side * 1.6, -0.8, 0.8), y: 0.62, t: 0.35 };        // middle: lean it toward the side
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
    } else if (fighting && match.state === 'fight' && seen.alive && f.swordHeld && !f.fallen && this.cool <= 0 && dist < reach + 0.3 - 0.15 * this.k) {
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
    // where is the opponent's blade? a raised guard covers the head and chest,
    // a lowered one leaves the top open. Good bots attack where the blade isn't.
    const guardHigh = seen.tip.y > seen.pos.y + 0.25;
    const kinds = ['slashRL', 'slashLR', 'chop', 'diagR', 'diagL', 'low', 'stab', 'stab'];
    let kind = kinds[Math.floor(rnd() * kinds.length)];
    if (rnd() < k * 0.85) {
      const pool = guardHigh ? ['low', 'waistRL', 'waistLR', 'stabLow', 'diagR', 'diagL'] : ['chop', 'diagR', 'diagL', 'stab', 'stabHead', 'slashRL', 'slashLR'];
      kind = pool[Math.floor(rnd() * pool.length)];
    }
    // stick paths in the half-dome map (see fighter.js): x = right, y = up, middle = at the opponent
    const G = [SWORD_GUARD.x, SWORD_GUARD.y];
    const path = (wp) => { const pts = [[0, G[0], G[1]]]; let t = 0; for (const [dt, x, y] of wp) { t += dt; pts.push([t, x, y]); } return pts; };
    const slash = (dir, y) => path([[wind, dir * 0.95, y + 0.15], [0.08, dir * 0.95, y + 0.12], [strike, -dir * 0.95, y]]);
    const stab = (aimY) => path([[wind * 0.8, 0, aimY + 0.4], [wind * 0.2, 0, aimY + 0.28], [strike * 0.45, 0, aimY], [0.35, 0, aimY]]);
    let pts;
    switch (kind) {
      case 'slashRL': pts = slash(1, 0.1); break;
      case 'slashLR': pts = slash(-1, 0.1); break;
      case 'waistRL': pts = slash(1, -0.18); break;
      case 'waistLR': pts = slash(-1, -0.18); break;
      case 'chop': pts = path([[wind, 0.04, 0.99], [0.1, 0.04, 0.99], [strike, 0, -0.55]]); break;
      case 'diagR': pts = path([[wind, 0.72, 0.68], [0.08, 0.72, 0.68], [strike, -0.6, -0.6]]); break;
      case 'diagL': pts = path([[wind, -0.72, 0.68], [0.08, -0.72, 0.68], [strike, 0.6, -0.6]]); break;
      case 'low': { const sg = rnd() < 0.5 ? 1 : -1; pts = slash(sg, -0.48); break; }
      case 'stabLow': pts = stab(-0.16); break;
      case 'stabHead': pts = stab(0.14); break;
      default: pts = stab(0.0); // stab at the chest
    }
    pts.push([pts[pts.length - 1][0] + 0.25, G[0], G[1]]);
    this.plan = { kind, pts, t: 0 };
  }
}
