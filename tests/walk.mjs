// Walk in a direction with the move stick and check the fighter gets there upright.
import { makeWorld, stats, finite, Fighter, V3 } from './harness.mjs';
export function runWalk({ dir = [0, 1], seconds = 3.5, log = false, face = null } = {}) {
  const w = makeWorld();
  const f = new Fighter(w, { x: 0, z: 0, yaw: 0 });
  if (face) { // a dummy opponent to face
    f.opponent = { parts: { torso: { pos: new V3(face[0], 1, face[1]) } } };
  }
  const dt = 1 / 60;
  let falls = 0, was = false, firstFall = -1;
  for (let i = 0; i < seconds * 60; i++) {
    f.input.mx = i > 30 ? dir[0] : 0; f.input.mz = i > 30 ? dir[1] : 0;
    f.update(dt); w.step(dt);
    if (f.fallen && !was) { falls++; if (firstFall < 0) firstFall = +(i * dt).toFixed(2); }
    was = f.fallen;
    if (log && i % 15 === 0) console.log((i * dt).toFixed(2), JSON.stringify(stats(f)), 'v', f.comVel.x.toFixed(2), f.comVel.z.toFixed(2), 'swing', f.gait.swing);
  }
  const t = f.parts.torso.pos;
  return { falls, firstFall, x: +t.x.toFixed(2), z: +t.z.toFixed(2), steps: f.gait.stepCount, finite: finite(f) };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv[2] === 'log') console.log(runWalk({ dir: [0, 1], log: true }));
  else for (const d of [[0, 1], [0, -1], [1, 0], [-1, 0], [0.7, 0.7]]) console.log('dir', d, JSON.stringify(runWalk({ dir: d })), 'facing+z', JSON.stringify(runWalk({ dir: d, face: [0, 50] })));
}
