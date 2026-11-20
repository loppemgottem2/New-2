// Scripted attacks between two fighters: cuts, stabs, severing, bleeding, death.
import { makeWorld, finite, Fighter, V3 } from './harness.mjs';
import { Combat } from '../js/combat.js';
export function duel({ dist = 1.5, script, seconds = 4, victimStick = [1, -0.3], log = false, victimDropSword = false }) {
  const w = makeWorld();
  const A = new Fighter(w, { x: 0, z: -dist / 2, yaw: 0, name: 'A' });
  const B = new Fighter(w, { x: 0, z: dist / 2, yaw: Math.PI, name: 'B' });
  A.opponent = B; B.opponent = A;
  const cm = new Combat(w, [A, B]);
  if (victimDropSword) B.dropSword();
  const dt = 1 / 60;
  const ev = {};
  for (let i = 0; i < seconds * 60; i++) {
    const t = i * dt;
    const s = script(t);
    A.input.sx = s[0]; A.input.sy = s[1];
    if (s[2] !== undefined) { A.input.mx = s[2]; A.input.mz = s[3]; }
    B.input.sx = victimStick[0]; B.input.sy = victimStick[1];
    A.update(dt); B.update(dt); w.step(dt); cm.update(dt);
    for (const e of cm.events) { ev[e.type] = (ev[e.type] || 0) + 1; if (log && e.type !== 'cutting') console.log(t.toFixed(2), JSON.stringify(e)); }
    cm.events.length = 0;
  }
  const limbs = Object.entries(B.limbHp).filter(([, v]) => v < 100).map(([k, v]) => `${k}:${v.toFixed(0)}`).join(' ');
  return { ev, hpB: +B.hp.toFixed(1), aliveB: B.alive, bleed: +B.bleedRate.toFixed(2), detached: Object.keys(B.detached).filter((k) => B.detached[k]), limbs, finite: finite(A) && finite(B), aFallen: A.fallen };
}
// helper: piecewise linear stick path [[t, sx, sy], ...]
export function path(points) {
  return (t) => {
    if (t <= points[0][0]) return [points[0][1], points[0][2]];
    for (let i = 1; i < points.length; i++) {
      if (t <= points[i][0]) {
        const [t0, x0, y0] = points[i - 1], [t1, x1, y1] = points[i];
        const k = (t - t0) / (t1 - t0);
        return [x0 + (x1 - x0) * k, y0 + (y1 - y0) * k];
      }
    }
    const l = points[points.length - 1]; return [l[1], l[2]];
  };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const log = process.argv[2] === 'log';
  // horizontal slash: swipe the sword stick across the middle (right -> left, then back)
  const slash = path([[0, 0, 0.86], [0.4, 0.95, 0.3], [0.8, 0.95, 0.3], [0.98, -0.95, 0.12], [1.4, -0.95, 0.3], [1.7, -0.95, 0.3], [1.88, 0.95, 0.12], [2.3, 0, 0.86]]);
  console.log('slash vs open guard', JSON.stringify(duel({ script: slash, log })));
  // overhead chop: wind up back, chop forward/down
  const chop = path([[0, 0, 0.86], [0.5, 0.04, 0.99], [0.9, 0.04, 0.99], [1.08, 0, -0.55], [1.5, 0, -0.55], [1.8, 0.04, 0.99], [2.2, 0.04, 0.99], [2.38, 0, -0.55], [3, 0, 0.86]]);
  console.log('chop', JSON.stringify(duel({ script: chop, log })));
  // stab: pull back then thrust forward
  const stab = path([[0, 0, 0.86], [0.5, 0, 0.3], [0.9, 0, 0.3], [1.0, 0, 0.0], [1.6, 0, 0.0], [1.9, 0, 0.3], [2.4, 0, 0.3], [2.5, 0, 0.02], [3.5, 0, 0.02]]);
  console.log('stab', JSON.stringify(duel({ script: stab, log, dist: 1.7 })));
  console.log('slash vs guard', JSON.stringify(duel({ script: slash, victimStick: [0, 0] })));
}
