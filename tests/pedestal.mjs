// Menu hero on its pedestal: random swings on every tap must not knock him off / over.
import { World } from '../js/physics.js';
import { Fighter, fighterPairFilter, SWORD_GUARD } from '../js/fighter.js';
import { CONFIG } from '../js/config.js';
import { makeRng } from '../js/math.js';
export function runPedestal(seed = 1, taps = 80) {
  const rng = makeRng(seed);
  const w = new World({ substeps: CONFIG.PHYSICS.SUBSTEPS, arenaRadius: CONFIG.PHYSICS.MENU_PEDESTAL_RADIUS - 0.1 });
  w.pairFilter = fighterPairFilter;
  const f = new Fighter(w, { x: 0, z: 0, yaw: 0.5, pedestal: true });
  let falls = 0, was = false, maxR = 0, swingT = 0;
  for (let i = 0; i < taps * 30; i++) {
    if (i % 30 === 0) { const a = rng() * Math.PI * 2, r = 0.65 + rng() * 0.35; f.input.sx = Math.sin(a) * r; f.input.sy = Math.cos(a) * r; swingT = 0.32 + rng() * 0.15; }
    if (swingT > 0) { swingT -= 1 / 60; if (swingT <= 0) { f.input.sx = SWORD_GUARD.x; f.input.sy = SWORD_GUARD.y; } }
    f.update(1 / 60); w.step(1 / 60);
    if (f.fallen && !was) falls++; was = f.fallen;
    for (const s of ['R', 'L']) { const p = f.parts['foot' + s].pos; maxR = Math.max(maxR, Math.hypot(p.x, p.z)); }
  }
  return { falls, maxFootRadius: +maxR.toFixed(2), steps: f.gait.stepCount };
}
if (import.meta.url === `file://${process.argv[1]}`) for (const s of [1, 2, 3]) console.log(JSON.stringify(runPedestal(s)));
