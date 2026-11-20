// =====================================================================
//  MATCH.JS — one duel: the physics world, two fighters, combat and the
//  round rules. Runs the same way in the browser and headless in Node.
//
//  Rules:
//   * both fighters start a round with 100 HP
//   * when one dies the round keeps going while the survivor is still
//     bleeding; if the survivor also dies it is a DRAW (no points)
//   * a survivor who stops bleeding (or clearly can't bleed out) scores
//   * first to 3 round wins takes the match
// =====================================================================
import { World } from './physics.js';
import { Fighter, fighterPairFilter } from './fighter.js';
import { Combat } from './combat.js';
import { CONFIG } from './config.js';

export class Match {
  constructor(o = {}) {
    this.names = o.names || ['You', 'Bot'];
    this.world = new World({ substeps: CONFIG.PHYSICS.SUBSTEPS, arenaRadius: CONFIG.PHYSICS.WALL_RADIUS });
    this.world.pairFilter = fighterPairFilter;
    const d = CONFIG.MATCH.START_DISTANCE / 2;
    this.fighters = [
      new Fighter(this.world, { id: 0, name: this.names[0], x: 0, z: -d, yaw: 0 }),
      new Fighter(this.world, { id: 1, name: this.names[1], x: 0, z: d, yaw: Math.PI }),
    ];
    this.fighters[0].opponent = this.fighters[1];
    this.fighters[1].opponent = this.fighters[0];
    this.combat = new Combat(this.world, this.fighters);
    this.scores = [0, 0];
    this.round = 1;
    this.state = 'intro';
    this.timer = 0;
    this.time = 0;
    this.roundResult = null; // {winner: 0|1|-1(draw)}
    this.matchWinner = -1;
    this.events = [];       // game-level events (round start/end, etc.) for UI/audio/net
    this.controllers = [null, null]; // objects with update(dt, fighter, match) that set fighter.input
    this.frame = 0;
    this._startRound(true);
  }

  _startRound(first) {
    const d = CONFIG.MATCH.START_DISTANCE / 2;
    if (!first) {
      this.combat.reset();
      this.fighters[0].respawn(0, -d, 0);
      this.fighters[1].respawn(0, d, Math.PI);
    }
    this.state = 'intro';
    this.timer = 0;
    this.roundResult = null;
    this.firstDeathTime = -1;
    this.events.push({ type: 'roundStart', round: this.round });
  }

  step(dt) {
    this.time += dt;
    this.timer += dt;
    this.frame++;
    const F = this.fighters;
    // controllers write inputs
    for (let i = 0; i < 2; i++) {
      const c = this.controllers[i];
      if (c && c.update) c.update(dt, F[i], this);
    }
    if (this.state === 'intro' || this.state === 'matchEnd') {
      // no walking before FIGHT!, sword can be waved
      for (const f of F) { f.input.mx = 0; f.input.mz = 0; }
    }
    if (this.state === 'intro' && this.timer > CONFIG.MATCH.ROUND_START_DELAY) {
      this.state = 'fight'; this.timer = 0; this.events.push({ type: 'fight' });
    }
    for (const f of F) f.update(dt);
    this.world.step(dt);
    this.combat.update(dt);
    // keep everything on the platform (falling parts that left it are clamped in by the wall anyway)
    this._rules(dt);
  }

  _rules(dt) {
    const F = this.fighters, M = CONFIG.MATCH;
    const a0 = F[0].alive, a1 = F[1].alive;
    if (this.state === 'fight') {
      if (!a0 || !a1) {
        this.firstDeathTime = this.time;
        if (!a0 && !a1) return this._endRound(-1);
        this.state = 'bleedout'; this.timer = 0;
        this.survivor = a0 ? 0 : 1;
        this.events.push({ type: 'firstDeath', dead: a0 ? 1 : 0 });
      }
    } else if (this.state === 'bleedout') {
      const s = F[this.survivor];
      if (!s.alive) return this._endRound(-1);
      const safe = s.hp - s.bleedPending > 0.5;     // can no longer bleed out
      const stopped = s.bleedRate < 0.25;
      if ((this.timer > 1.2 && (safe || stopped)) ) return this._endRound(this.survivor);
      if (this.timer > M.MAX_POST_DEATH_WAIT) return this._endRound(s.hp > s.bleedPending ? this.survivor : -1);
    } else if (this.state === 'roundEnd') {
      if (this.timer > M.ROUND_END_DELAY) {
        if (this.scores[0] >= M.ROUNDS_TO_WIN || this.scores[1] >= M.ROUNDS_TO_WIN) {
          this.state = 'matchEnd'; this.timer = 0;
          this.matchWinner = this.scores[0] > this.scores[1] ? 0 : 1;
          this.events.push({ type: 'matchEnd', winner: this.matchWinner, scores: this.scores.slice() });
        } else {
          this.round++;
          this._startRound(false);
        }
      }
    }
  }

  _endRound(winner) {
    if (winner >= 0) this.scores[winner]++;
    this.roundResult = { winner };
    this.state = 'roundEnd'; this.timer = 0;
    this.events.push({ type: 'roundEnd', winner, scores: this.scores.slice(), round: this.round });
  }

  rematch() {
    this.scores = [0, 0]; this.round = 1; this.matchWinner = -1;
    this._startRound(false);
  }
}
