import { makeWorld, stats, finite, Fighter } from './harness.mjs';
const w = makeWorld();
const f = new Fighter(w, { x: 0, z: 0, yaw: 0 });
const dt = 1/60;
let maxTilt = 0;
const t0 = performance.now();
for (let i = 0; i < 600; i++) {
  f.update(dt); w.step(dt);
  maxTilt = Math.max(maxTilt, f.tilt || 0);
  if (i % 60 === 0) console.log(i/60, JSON.stringify(stats(f)), 'feet', f.parts.footR.grounded, f.parts.footL.grounded, 'sword', f.sword.pos.y.toFixed(2));
}
console.log('final', stats(f), 'maxTilt', maxTilt.toFixed(3), 'finite', finite(f), 'ms/frame', ((performance.now()-t0)/600).toFixed(2));
