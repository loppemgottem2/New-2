// =====================================================================
//  HUD.JS — health bars (with bleeding forecast), score, banners.
// =====================================================================
const $ = (id) => document.getElementById(id);

export class Hud {
  constructor() {
    this.el = $('hud');
    this.bars = [this._bar('p1'), this._bar('p2')];
    this.score = $('score');
    this.roundLabel = $('round-label');
    this.banner = $('banner');
    this.subBanner = $('sub-banner');
    this.vignette = $('vignette');
    this.fps = $('fps');
    this.bannerT = 0;
    this.ghost = [100, 100];
    this.lastHp = [100, 100];
    this.flash = 0;
  }
  _bar(id) {
    const root = $(id);
    return {
      root,
      name: root.querySelector('.hp-name'),
      fill: root.querySelector('.hp-fill'),
      bleed: root.querySelector('.hp-bleed'),
      ghost: root.querySelector('.hp-ghost'),
      num: root.querySelector('.hp-num'),
      drop: root.querySelector('.hp-drop'),
    };
  }
  setNames(a, b) { this.bars[0].name.textContent = a; this.bars[1].name.textContent = b; }
  // fighters: [{hp, bleedPending, bleedRate, alive}], order = screen order (me on the left)
  update(dt, fighters, scores, round) {
    for (let i = 0; i < 2; i++) {
      const f = fighters[i], b = this.bars[i];
      const hp = Math.max(0, f.alive ? f.hp : 0);
      const pend = f.alive ? Math.min(hp, f.bleedPending || 0) : 0;
      if (hp < this.lastHp[i] - 0.5 && i === 0) this.flash = Math.min(1, this.flash + (this.lastHp[i] - hp) / 25);
      this.lastHp[i] = hp;
      this.ghost[i] = Math.max(hp, this.ghost[i] - dt * 22);
      b.fill.style.width = (hp - pend) + '%';
      b.bleed.style.left = (hp - pend) + '%';
      b.bleed.style.width = pend + '%';
      b.ghost.style.width = this.ghost[i] + '%';
      b.num.textContent = Math.ceil(hp);
      const bleeding = f.alive && (f.bleedRate || 0) > 0.25;
      b.root.classList.toggle('bleeding', bleeding);
      b.root.classList.toggle('dead', !f.alive);
      b.drop.textContent = bleeding ? `−${(f.bleedRate).toFixed(1)}/s` : '';
    }
    this.score.textContent = `${scores[0]} – ${scores[1]}`;
    this.roundLabel.textContent = `Round ${round} · first to 3`;
    if (this.bannerT > 0) { this.bannerT -= dt; if (this.bannerT <= 0) { this.banner.classList.remove('show'); this.subBanner.classList.remove('show'); } }
    this.flash = Math.max(0, this.flash - dt * 1.6);
    this.vignette.style.opacity = this.flash.toFixed(3);
  }
  resetBars() { this.ghost = [100, 100]; this.lastHp = [100, 100]; this.flash = 0; }
  show(text, sub = '', time = 1.6, tone = '') {
    this.banner.textContent = text;
    this.banner.className = 'show ' + tone;
    this.subBanner.textContent = sub;
    this.subBanner.classList.toggle('show', !!sub);
    // restart animation
    void this.banner.offsetWidth;
    this.bannerT = time;
  }
  hideBanner() { this.bannerT = 0; this.banner.classList.remove('show'); this.subBanner.classList.remove('show'); }
}
