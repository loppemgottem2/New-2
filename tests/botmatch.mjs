// Bot vs bot full matches (first to 3) — checks the whole game loop headless.
import { Match } from '../js/match.js';
import { Bot } from '../js/bot.js';
import { makeRng } from '../js/math.js';
import { finite } from './harness.mjs';
export function botMatch(l0, l1, seed = 1, maxSeconds = 400) {
  const rng = makeRng(seed);
  const m = new Match({ names: ['L' + l0, 'L' + l1] });
  m.controllers = [new Bot(l0, rng), new Bot(l1, rng)];
  const dt = 1 / 60;
  const ev = {};
  let frames = 0, falls = [0, 0], was = [false, false], ok = true;
  const t0 = performance.now();
  while (m.state !== 'matchEnd' && frames < maxSeconds * 60) {
    m.step(dt); frames++;
    for (const e of m.combat.events) ev[e.type] = (ev[e.type] || 0) + 1;
    m.combat.events.length = 0;
    m.events.length = 0;
    for (let i = 0; i < 2; i++) { const f = m.fighters[i]; if (f.alive && f.fallen && !was[i]) falls[i]++; was[i] = f.fallen; }
    if (frames % 600 === 0 && !(finite(m.fighters[0]) && finite(m.fighters[1]))) { ok = false; break; }
  }
  const ms = (performance.now() - t0) / frames;
  return { levels: [l0, l1], winner: m.matchWinner >= 0 ? 'L' + [l0, l1][m.matchWinner] : 'none', scores: m.scores, rounds: m.round, secs: +(frames / 60).toFixed(0), falls, ok, msPerFrame: +ms.toFixed(2), ev };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const pairs = process.argv[2] ? [process.argv[2].split(',').map(Number)] : [[10, 1], [8, 3], [5, 5], [1, 10]];
  for (const [a, b] of pairs) for (const seed of [1, 2]) console.log(JSON.stringify(botMatch(a, b, seed)));
}
