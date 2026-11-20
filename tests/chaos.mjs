// Random walking + random sword swinging at the same time.
import { makeWorld, stats, finite, Fighter, V3 } from './harness.mjs';
import { makeRng } from '../js/math.js';
export function runChaos({ seconds = 60, seed = 1 } = {}) {
  const rng = makeRng(seed);
  const w = makeWorld();
  const f = new Fighter(w, { x: 0, z: 0, yaw: 0 });
  const dummy = { parts: { torso: { pos: new V3(0, 1, 3) } } };
  f.opponent = dummy;
  const dt = 1 / 60;
  let falls = 0, was = false, nextMove = 0, nextSword = 0, fallTime = 0;
  for (let i = 0; i < seconds * 60; i++) {
    const t = i * dt;
    if (t >= nextMove) {
      const a = rng() * Math.PI * 2, r = rng() < 0.3 ? 0 : 0.5 + rng() * 0.5;
      f.input.mx = Math.sin(a) * r; f.input.mz = Math.cos(a) * r; nextMove = t + 0.4 + rng() * 1.2;
    }
    if (t >= nextSword) {
      const a = rng() * Math.PI * 2, r = rng() < 0.2 ? 0 : 0.6 + rng() * 0.4;
      f.input.sx = Math.sin(a) * r; f.input.sy = Math.cos(a) * r; nextSword = t + 0.2 + rng() * 0.6;
    }
    // keep the dummy opponent 2.5 m in front-ish, wandering
    dummy.parts.torso.pos.set(Math.sin(t * 0.3) * 3, 1, Math.cos(t * 0.3) * 3);
    // keep the fighter inside the arena: steer back toward center if near edge
    const tp = f.parts.torso.pos; const rr = Math.hypot(tp.x, tp.z);
    if (rr > 4) { f.input.mx = -tp.x / rr; f.input.mz = -tp.z / rr; }
    f.update(dt); w.step(dt);
    if (f.fallen && !was) falls++;
    if (f.fallen) fallTime += dt;
    was = f.fallen;
  }
  return { falls, fallTime: +fallTime.toFixed(1), finite: finite(f), steps: f.gait.stepCount };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  for (const seed of [1, 2, 3, 4]) console.log('seed', seed, JSON.stringify(runChaos({ seed })));
}
