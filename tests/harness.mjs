// Shared helpers for headless tests
import { World } from '../js/physics.js';
import { Fighter, LIMB_NAMES, fighterPairFilter } from '../js/fighter.js';
import { CONFIG } from '../js/config.js';
import { V3 } from '../js/math.js';

export function makeWorld() {
  const w = new World({ substeps: CONFIG.PHYSICS.SUBSTEPS, arenaRadius: CONFIG.PHYSICS.WALL_RADIUS });
  w.pairFilter = fighterPairFilter;
  return w;
}
export function stats(f) {
  const t = f.parts.torso;
  return { tilt: +(f.tilt ?? 0).toFixed(3), y: +t.pos.y.toFixed(3), x: +t.pos.x.toFixed(3), z: +t.pos.z.toFixed(3), fallen: f.fallen, steps: f.gait.stepCount };
}
export function finite(f) {
  for (const b of f.bodies) if (!b.pos.isFinite() || !b.q.isFinite()) return false;
  return true;
}
export { Fighter, LIMB_NAMES, CONFIG, V3 };
