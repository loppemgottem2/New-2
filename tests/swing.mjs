// Random hard sword swings while standing: the fighter should stay on his feet.
import { makeWorld, stats, finite, Fighter, V3 } from './harness.mjs';
import { makeRng } from '../js/math.js';
import { SWORD_GEO } from '../js/fighter.js';
export function runSwing({ seconds = 30, seed = 1, assist = true, log = false } = {}) {
  const rng = makeRng(seed);
  const w = makeWorld();
  const f = new Fighter(w, { x: 0, z: 0, yaw: 0 });
  if (!assist) f._torsoAssist = () => {};
  const dt = 1 / 60;
  let firstFall = -1, falls = 0, wasFallen = false, maxTip = 0, next = 0, maxTilt = 0;
  const tip = new V3(), tipPrev = new V3();
  f.sword.localToWorld(new V3(0, SWORD_GEO.tipY, 0), tipPrev);
  for (let i = 0; i < seconds * 60; i++) {
    const t = i * dt;
    if (t >= next) {
      const a = rng() * Math.PI * 2, r = rng() < 0.2 ? 0 : 0.6 + rng() * 0.4;
      f.input.sx = Math.sin(a) * r; f.input.sy = Math.cos(a) * r;
      next = t + 0.25 + rng() * 0.6;
    }
    f.update(dt); w.step(dt);
    f.sword.localToWorld(new V3(0, SWORD_GEO.tipY, 0), tip);
    maxTip = Math.max(maxTip, tip.distTo(tipPrev) / dt); tipPrev.copy(tip);
    if (f.fallen && !wasFallen) { falls++; if (firstFall < 0) firstFall = +t.toFixed(2); }
    wasFallen = f.fallen;
    maxTilt = Math.max(maxTilt, f.tilt);
    if (log && i % 120 === 0) console.log(t.toFixed(1), JSON.stringify(stats(f)));
  }
  return { firstFall, falls, maxTip: +maxTip.toFixed(1), maxTilt: +maxTilt.toFixed(2), finite: finite(f), steps: f.gait.stepCount, drift: +Math.hypot(f.parts.torso.pos.x, f.parts.torso.pos.z).toFixed(2) };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  for (const seed of [1, 2, 3]) console.log('seed', seed, JSON.stringify(runSwing({ seed })));
  console.log('no assist', JSON.stringify(runSwing({ seed: 1, assist: false })));
}
