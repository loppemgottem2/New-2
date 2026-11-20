// =====================================================================
//  AUDIO.JS — all sounds are synthesized with WebAudio (no files).
// =====================================================================
export class Sound {
  constructor() {
    this.ctx = null; this.master = null; this.volume = 0.8; this.noiseBuf = null; this.wind = null;
  }
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4;
    this.master.connect(comp); comp.connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 1.5;
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this._startWind();
  }
  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; }
  _noise(dur, filterType, freq, q = 1, gain = 0.5, attack = 0.005, freqEnd = null) {
    const c = this.ctx; if (!c) return;
    const t = c.currentTime;
    const src = c.createBufferSource(); src.buffer = this.noiseBuf; src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = c.createBiquadFilter(); f.type = filterType; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.05);
  }
  _tone(freq, dur, type = 'sine', gain = 0.3, freqEnd = null, attack = 0.002) {
    const c = this.ctx; if (!c) return;
    const t = c.currentTime;
    const o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + dur + 0.05);
  }
  clash(power = 0.6) {
    if (!this.ctx) return;
    const base = 1300 + Math.random() * 500;
    const parts = [1, 2.13, 3.47, 5.11];
    parts.forEach((m, i) => this._tone(base * m * (0.98 + Math.random() * 0.04), 0.5 + power * 0.7 - i * 0.08, 'sine', 0.13 * power / (1 + i * 0.6)));
    this._noise(0.08, 'highpass', 3000, 0.7, 0.35 * power);
  }
  swish(speed) {
    if (!this.ctx) return;
    const g = Math.min(0.35, 0.05 + speed * 0.02);
    this._noise(0.22, 'bandpass', 500 + speed * 60, 1.6, g, 0.03, 1800 + speed * 80);
  }
  slash(amount = 0.5) {
    if (!this.ctx) return;
    this._noise(0.18, 'bandpass', 900, 0.9, 0.35 + amount * 0.3, 0.004, 300);
    this._tone(140, 0.12, 'sine', 0.25, 70);
  }
  stab() {
    if (!this.ctx) return;
    this._noise(0.25, 'lowpass', 700, 1.2, 0.45, 0.004, 200);
    this._tone(110, 0.2, 'sine', 0.35, 55);
  }
  sever() {
    if (!this.ctx) return;
    this._noise(0.35, 'bandpass', 600, 0.7, 0.6, 0.003, 180);
    this._tone(90, 0.3, 'triangle', 0.35, 45);
    this._noise(0.06, 'highpass', 2500, 0.8, 0.3);
  }
  thud(power = 0.5) {
    if (!this.ctx) return;
    this._tone(80 + Math.random() * 20, 0.18, 'sine', 0.35 * power, 45);
    this._noise(0.08, 'lowpass', 400, 1, 0.25 * power);
  }
  step() { if (this.ctx) this._noise(0.06, 'lowpass', 300 + Math.random() * 200, 1, 0.06); }
  bell(win = true) {
    if (!this.ctx) return;
    const f = win ? 523 : 392;
    [1, 1.5, 2.0, 2.76].forEach((m, i) => this._tone(f * m, 1.6 - i * 0.25, 'sine', 0.12 / (1 + i)));
  }
  gong() { if (this.ctx) { this._tone(110, 2.2, 'sine', 0.3, 104); this._tone(220 * 1.01, 1.6, 'sine', 0.12); this._noise(0.4, 'lowpass', 500, 1, 0.15); } }
  click() { if (this.ctx) this._tone(900, 0.05, 'square', 0.05); }
  death() { if (this.ctx) { this._tone(180, 0.6, 'sawtooth', 0.08, 60); this._noise(0.3, 'lowpass', 300, 1, 0.2); } }
  _startWind() {
    const c = this.ctx;
    const src = c.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 380; f.Q.value = 0.4;
    const g = c.createGain(); g.gain.value = 0.045;
    const lfo = c.createOscillator(); lfo.frequency.value = 0.07;
    const lg = c.createGain(); lg.gain.value = 140; lfo.connect(lg); lg.connect(f.frequency);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(); lfo.start();
    this.wind = g;
  }
}
