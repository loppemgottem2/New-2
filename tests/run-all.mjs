// npm test — headless checks of the physics, controller, combat and full matches.
import { runSwing } from './swing.mjs';
import { runWalk } from './walk.mjs';
import { runChaos } from './chaos.mjs';
import { duel, path } from './combat.mjs';
import { botMatch } from './botmatch.mjs';
import { makeWorld, finite, Fighter } from './harness.mjs';

let failed = 0;
function check(name, ok, info) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(info)}`); if (!ok) failed++; }

// 1. stands still for 10 s
{
  const w = makeWorld(); const f = new Fighter(w, {});
  let maxTilt = 0; for (let i = 0; i < 600; i++) { f.update(1 / 60); w.step(1 / 60); maxTilt = Math.max(maxTilt, f.tilt); }
  const drift = Math.hypot(f.parts.torso.pos.x, f.parts.torso.pos.z);
  check('stands balanced', maxTilt < 0.1 && drift < 0.1 && finite(f), { maxTilt: +maxTilt.toFixed(3), drift: +drift.toFixed(3) });
}
// 2. hard random swings without falling
for (const seed of [1, 2]) { const r = runSwing({ seed, seconds: 20 }); check(`swings without falling (seed ${seed})`, r.falls === 0 && r.finite, r); }
// 3. walks in all directions
for (const d of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
  const r = runWalk({ dir: d, face: [0, 50] });
  const moved = Math.hypot(r.x, r.z);
  check(`walks ${JSON.stringify(d)}`, r.falls === 0 && moved > 1.0 && r.finite, { ...r, moved: +moved.toFixed(2) });
}
// 4. chaos: random walking + swinging, falls allowed but must recover
{ const r = runChaos({ seed: 3, seconds: 40 }); check('chaos input stays mostly upright', r.fallTime < 8 && r.finite, r); }
// 5. combat: a rim slash cuts, a thrust stabs
{
  const rim = (t0, a0, a1, dur) => { const p = []; for (let k = 0; k <= 6; k++) { const a = a0 + (a1 - a0) * k / 6; p.push([t0 + dur * k / 6, Math.sin(a) * 0.95, Math.cos(a) * 0.95]); } return p; };
  const slash = path([[0, 0, 0], [0.4, 0.92, 0.3], ...rim(0.8, 1.35, -1.35, 0.22), [1.4, -0.92, 0.3], ...rim(1.7, -1.35, 1.35, 0.22), [2.3, 0, 0]]);
  const r = duel({ script: slash });
  check('slash cuts and damages', (r.ev.slash || 0) > 0 && r.hpB < 100 && r.finite, r);
  const stab = path([[0, 0, 0], [0.5, 0, 0.2], [0.9, 0, 0.2], [1.0, 0, 1], [1.6, 0, 1], [1.9, 0, 0.2], [2.4, 0, 0.2], [2.5, 0.05, 1], [3.5, 0, 1]]);
  const s = duel({ script: stab, dist: 1.35 });
  check('thrust stabs', (s.ev.stab || 0) > 0 && s.hpB < 100 && s.finite, s);
}
// 6. full bot matches finish and the stronger bot wins
{
  const a = botMatch(10, 1, 1), b = botMatch(1, 10, 2);
  check('bot match completes', a.winner !== 'none' && a.ok && b.ok, { a: a.scores, b: b.scores, secs: [a.secs, b.secs] });
  check('level 10 beats level 1', a.winner === 'L10' && b.winner === 'L10', { a: a.winner, b: b.winner });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
