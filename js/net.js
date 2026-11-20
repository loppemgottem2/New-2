// =====================================================================
//  NET.JS — 1 v 1 online play with PeerJS (WebRTC, peer to peer).
//
//  * The HOST's phone runs the real physics for both fighters. The
//    guest sends its joysticks ~30x a second and receives snapshots of
//    every body part ~30x a second.
//  * Public "quick match" uses fixed peer ids PREFIX+'pub-1..N': first
//    look for someone waiting in a slot, otherwise wait in a free slot.
//  * Private matches use PREFIX+'priv-'+CODE (5 letters).
//  * ?local=1 swaps in a fake network (BroadcastChannel) so two tabs of
//    one browser can play each other without internet (for testing).
// =====================================================================
import { CONFIG } from './config.js';

export class Emitter {
  constructor() { this._h = {}; }
  on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return this; }
  off(ev, fn) { const a = this._h[ev]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } return this; }
  emit(ev, ...args) { const a = this._h[ev]; if (a) for (const fn of a.slice()) fn(...args); }
}

const params = new URLSearchParams(location.search);
export const LOCAL_MODE = params.has('local');
export const publicId = (slot) => `${CONFIG.NET.PEER_PREFIX}pub-${slot}`;
export const privateId = (code) => `${CONFIG.NET.PEER_PREFIX}priv-${code.toUpperCase()}`;
export function netAvailable() { return LOCAL_MODE || typeof window.Peer === 'function'; }
export function randomCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = ''; for (let i = 0; i < 5; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

function createPeer(id) {
  const Ctor = LOCAL_MODE ? LocalPeer : window.Peer;
  return new Promise((resolve, reject) => {
    if (!Ctor) { reject({ type: 'no-peerjs', message: 'Online play could not load. Check your connection.' }); return; }
    let peer;
    try { peer = id ? new Ctor(id, { debug: 0, config: { iceServers: CONFIG.NET.ICE_SERVERS } }) : new Ctor({ debug: 0, config: { iceServers: CONFIG.NET.ICE_SERVERS } }); }
    catch (e) { reject(e); return; }
    let done = false;
    const timer = setTimeout(() => { if (done) return; done = true; try { peer.destroy(); } catch { /* */ } reject({ type: 'timeout', message: 'Could not reach the matchmaking server.' }); }, 12000);
    peer.on('open', () => { if (done) return; done = true; clearTimeout(timer); resolve(peer); });
    peer.on('error', (err) => { if (done) return; done = true; clearTimeout(timer); try { peer.destroy(); } catch { /* */ } reject(err); });
  });
}

function connectWith(peer, hostId, timeout = CONFIG.NET.CONNECT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    let done = false;
    const conn = peer.connect(hostId, { reliable: true, serialization: 'json' });
    const finish = (err) => {
      if (done) return; done = true; clearTimeout(timer); peer.off?.('error', onErr);
      if (err) { try { conn.close(); } catch { /* */ } reject(err); } else resolve(conn);
    };
    const onErr = (err) => {
      const msg = String(err?.message || '');
      if (err?.type === 'peer-unavailable' && (!msg || msg.includes(hostId))) finish({ type: 'unavailable', message: 'No match found with that code.' });
      else if (err?.type === 'network' || err?.type === 'server-error' || err?.type === 'socket-error') finish({ type: 'network', message: msg });
    };
    const timer = setTimeout(() => finish({ type: 'unavailable', message: 'Nobody answered.' }), timeout);
    peer.on('error', onErr);
    conn.on('open', () => finish(null));
    conn.on('error', () => finish({ type: 'unavailable', message: 'Connection failed.' }));
  });
}

// A single 1v1 link (either side). Emits 'message', 'close'.
export class Link extends Emitter {
  constructor(peer, conn, role) {
    super();
    this.peer = peer; this.conn = conn; this.role = role; this.closed = false; this.last = performance.now();
    this._attach(conn);
    this.timer = setInterval(() => { if (performance.now() - this.last > CONFIG.NET.HOST_TIMEOUT) this._lost('timeout'); }, 1000);
  }
  _attach(conn) {
    conn.on('data', (d) => { this.last = performance.now(); if (d && typeof d === 'object') this.emit('message', d); });
    conn.on('close', () => this._lost('closed'));
    conn.on('error', () => this._lost('error'));
  }
  _lost(why) { if (this.closed) return; this.closed = true; clearInterval(this.timer); this.emit('close', why); try { this.peer.destroy(); } catch { /* */ } }
  send(msg) { if (this.closed || !this.conn.open) return; try { this.conn.send(msg); } catch { /* */ } }
  close() { if (this.closed) return; this.closed = true; clearInterval(this.timer); try { this.send({ t: 'bye' }); } catch { /* */ } setTimeout(() => { try { this.conn.close(); } catch { /* */ } try { this.peer.destroy(); } catch { /* */ } }, 80); }
}

// Wait as host on a given id until one guest joins. Returns {cancel, promise}
export function hostAndWait(peerId, myName, onStatus, isPublic) {
  let cancelled = false, peer = null, probeTimer = null;
  let resolveFn, rejectFn;
  const promise = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
  (async () => {
    try { peer = await createPeer(peerId); } catch (e) { rejectFn(e); return; }
    if (cancelled) { try { peer.destroy(); } catch { /* */ } return; }
    onStatus && onStatus('waiting');
    let taken = false;
    peer.on('connection', (conn) => {
      const setup = () => {
        conn.on('data', (d) => {
          if (!d || typeof d !== 'object') return;
          if (d.t === 'info') { conn.send({ t: 'info', waiting: !taken && !cancelled }); return; }
          if (d.t === 'join') {
            if (taken || cancelled) { conn.send({ t: 'full' }); setTimeout(() => { try { conn.close(); } catch { /* */ } }, 200); return; }
            taken = true;
            clearInterval(probeTimer);
            conn.send({ t: 'accept', name: myName });
            const link = new Link(peer, conn, 'host');
            link.remoteName = String(d.name || 'Player').slice(0, 16);
            resolveFn(link);
          }
        });
      };
      if (conn.open) setup(); else conn.on('open', setup);
    });
    peer.on('disconnected', () => { if (!taken && !cancelled) { try { peer.reconnect(); } catch { /* */ } } });
  })();
  return {
    promise,
    peerRef: () => peer,
    setProbe: (fn) => { probeTimer = setInterval(fn, 6000); },
    cancel: () => { cancelled = true; clearInterval(probeTimer); try { peer && peer.destroy(); } catch { /* */ } rejectFn({ type: 'cancelled' }); },
  };
}

// Join a host id. Resolves with a Link or rejects.
export async function joinHost(hostId, myName) {
  const peer = await createPeer(null);
  let conn;
  try { conn = await connectWith(peer, hostId); } catch (e) { try { peer.destroy(); } catch { /* */ } throw e; }
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { try { peer.destroy(); } catch { /* */ } reject({ type: 'unavailable', message: 'The match did not answer.' }); }, 6000);
    conn.on('data', (d) => {
      if (!d) return;
      if (d.t === 'accept') { clearTimeout(t); const link = new Link(peer, conn, 'guest'); link.remoteName = String(d.name || 'Player').slice(0, 16); resolve(link); }
      if (d.t === 'full') { clearTimeout(t); try { peer.destroy(); } catch { /* */ } reject({ type: 'full', message: 'That match is already full.' }); }
    });
    conn.send({ t: 'join', name: myName });
  });
}

// Is someone waiting in this public slot?
async function probeSlot(peer, slot) {
  try {
    const conn = await connectWith(peer, publicId(slot), 4500);
    const info = await new Promise((res) => {
      const t = setTimeout(() => res(null), 2500);
      conn.on('data', (d) => { if (d && d.t === 'info') { clearTimeout(t); res(d); } });
      conn.send({ t: 'info' });
    });
    try { conn.close(); } catch { /* */ }
    return info && info.waiting;
  } catch { return false; }
}

// Quick match: join a waiting player or wait for one. Returns {promise, cancel}
export function quickMatch(myName, onStatus) {
  let cancelled = false, hosting = null;
  let resolveFn, rejectFn;
  const promise = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
  const N = CONFIG.NET.PUBLIC_SLOTS;
  (async () => {
    onStatus && onStatus('Looking for a public match…');
    let probePeer;
    try { probePeer = await createPeer(null); } catch (e) { rejectFn(e); return; }
    const slots = []; for (let i = 1; i <= N; i++) slots.push(i);
    const results = await Promise.all(slots.map((s) => probeSlot(probePeer, s).then((w) => (w ? s : 0))));
    try { probePeer.destroy(); } catch { /* */ }
    if (cancelled) return;
    for (const s of results.filter(Boolean)) {
      try { const link = await joinHost(publicId(s), myName); if (cancelled) { link.close(); return; } resolveFn(link); return; } catch { /* try next */ }
    }
    // nobody waiting: wait in the first free slot
    for (let s = 1; s <= N && !cancelled; s++) {
      const h = hostAndWait(publicId(s), myName, () => onStatus && onStatus('Waiting for an opponent to join…'), true);
      try {
        hosting = h;
        // while waiting, check lower slots for someone else waiting (so two searchers meet)
        h.setProbe(async () => {
          const p = await createPeer(null).catch(() => null); if (!p) return;
          for (let k = 1; k < s; k++) {
            if (cancelled) break;
            if (await probeSlot(p, k)) {
              try { const link = await joinHost(publicId(k), myName); h.cancel(); resolveFn(link); try { p.destroy(); } catch { /* */ } return; } catch { /* */ }
            }
          }
          try { p.destroy(); } catch { /* */ }
        });
        const link = await h.promise;
        resolveFn(link); return;
      } catch (e) {
        if (e && e.type === 'cancelled') return;
        if (e && e.type === 'unavailable-id') continue; // slot taken (a game is running there)
        rejectFn(e); return;
      }
    }
    if (!cancelled) rejectFn({ type: 'busy', message: 'All public match slots are busy. Try again soon.' });
  })();
  return { promise, cancel: () => { cancelled = true; if (hosting) hosting.cancel(); rejectFn({ type: 'cancelled' }); } };
}

// =====================================================================
//  LocalPeer — PeerJS look-alike over BroadcastChannel (?local=1)
// =====================================================================
class LocalPeer extends Emitter {
  constructor(id) {
    super();
    if (typeof id !== 'string') id = null;
    this.id = id || 'local-' + Math.random().toString(36).slice(2, 10);
    this.bc = new BroadcastChannel('ragdoll-duelists-local');
    this.conns = new Map(); this.open = false; this.nonce = Math.random();
    this.bc.onmessage = (e) => this._msg(e.data);
    this.bc.postMessage({ k: 'claim', id: this.id, nonce: this.nonce });
    this._claim = setTimeout(() => { this.open = true; this.emit('open', this.id); }, 150);
  }
  _msg(m) {
    if (!m) return;
    switch (m.k) {
      case 'claim': if (m.id === this.id && this.open) this.bc.postMessage({ k: 'taken', id: m.id, nonce: m.nonce }); break;
      case 'taken': if (m.nonce === this.nonce && !this.open) { clearTimeout(this._claim); this.emit('error', { type: 'unavailable-id', message: 'ID taken' }); } break;
      case 'req': if (m.to === this.id && this.open) {
        const c = new LocalConn(this, m.from, m.cid); this.conns.set(m.cid, c); this.emit('connection', c);
        this.bc.postMessage({ k: 'ack', to: m.from, cid: m.cid }); setTimeout(() => c._open(), 0);
      } break;
      case 'ack': if (m.to === this.id) this.conns.get(m.cid)?._open(); break;
      case 'data': if (m.to === this.id) { const c = this.conns.get(m.cid); if (c && c.open) c.emit('data', m.d); } break;
      case 'close': if (m.to === this.id) this.conns.get(m.cid)?._closed(); break;
      default: break;
    }
  }
  connect(id) {
    const cid = Math.random().toString(36).slice(2);
    const c = new LocalConn(this, id, cid); this.conns.set(cid, c);
    this.bc.postMessage({ k: 'req', to: id, from: this.id, cid });
    c._timer = setTimeout(() => { if (!c.open) { this.conns.delete(cid); this.emit('error', { type: 'peer-unavailable', message: 'Could not connect to peer ' + id }); } }, 500);
    return c;
  }
  reconnect() {}
  destroy() { for (const c of [...this.conns.values()]) c.close(); try { this.bc.close(); } catch { /* */ } }
}
class LocalConn extends Emitter {
  constructor(peer, remote, cid) { super(); this.peer = peer; this.remote = remote; this.cid = cid; this.open = false; }
  _open() { if (!this.open) { this.open = true; clearTimeout(this._timer); this.emit('open'); } }
  send(d) { if (!this.open) return; try { this.peer.bc.postMessage({ k: 'data', to: this.remote, cid: this.cid, d: JSON.parse(JSON.stringify(d)) }); } catch { /* closed */ } }
  close() { if (this.open) { try { this.peer.bc.postMessage({ k: 'close', to: this.remote, cid: this.cid }); } catch { /* */ } } this._closed(); }
  _closed() { this.peer.conns.delete(this.cid); if (this.open) { this.open = false; this.emit('close'); } }
}
