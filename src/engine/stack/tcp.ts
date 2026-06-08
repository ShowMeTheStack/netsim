// TCP: RFC 793 state machine, RFC 6298 RTO, RFC 5681 fast retransmit/recovery, NewReno (RFC 6582),
// SACK (RFC 2018, simplified scoreboard), CUBIC (RFC 8312), delayed ACK, persist timer, TIME-WAIT.
import { u32ToIp } from '@/shared/bytes';
import { encodeTcp, decodeTcp, TCP_ACK, TCP_SYN, TCP_FIN, TCP_RST, TCP_PSH, flagsStr, type TcpSegment } from '../codecs/tcp';
import { IPPROTO_TCP, type Ipv4Packet } from '../codecs/ipv4';
import { hostSendIp, pathMtu, term } from '../devices/host';
import { timer, rand, SEC, MS, log } from '../core';
import * as cc from './cc';
import { procNotify } from '../apps/procs';
import type { EngineState, HostState, TcpSocket } from '../types';

const MAX_SENDBUF = 512 * 1024;
export const seqLt = (a: number, b: number) => ((a - b) | 0) < 0; export const seqLe = (a: number, b: number) => ((a - b) | 0) <= 0;
const u32 = (x: number) => x >>> 0;

// ---------- socket lifecycle ----------
export function tcpSocket(st: EngineState, h: HostState, owner: number): TcpSocket {
  const id = h.nextSock++; const cfg = h.tcp;
  const s: TcpSocket = { id, proto: 'tcp', owner, state: 'CLOSED', localIp: null, localPort: 0, remoteIp: null, remotePort: null, listenBacklog: null, parent: null,
    iss: 0, sndUna: 0, sndNxt: 0, sndWnd: 0, sndWl1: 0, sndWl2: 0, maxSndWnd: 0, sendBuf: new Uint8Array(0), sendBufSeq: 0, finQueued: false, finSeq: null, finAcked: false, sndMaxSeq: 0,
    irs: 0, rcvNxt: 0, rcvBufCap: cfg.rcvBufCap, recvBuf: new Uint8Array(0), ooo: [], finRcvd: null, lastAdvWnd: 0,
    mss: 1460, peerMss: 536, wscale: 0, peerWscale: 0, sackOk: cfg.sack, peerSackOk: false, sacked: [],
    srtt: 0, rttvar: 0, rto: 1 * SEC, rtoBackoff: 1, rttSeq: null, rttStart: 0, rtoGen: 0, rtoArmed: false, rtoDeadline: 0,
    cc: cfg.cc, cwnd: 0, ssthresh: 0, dupAcks: 0, recover: 0, inRecovery: false, highRxt: 0, cubic: { wMax: 0, k: 0, epochStart: 0, originPoint: 0, tcpCwnd: 0, ackCnt: 0, minRtt: 0 },
    delAckGen: 0, delAckPending: false, quickAcks: 16, persistGen: 0, timeWaitGen: 0, synRetries: 0, keepGen: 0, nagle: cfg.nagle, delayedAck: cfg.delayedAck,
    stats: { txSegs: 0, rxSegs: 0, retx: 0, rtoCount: 0, fastRetx: 0, dupAcksRx: 0, txBytes: 0, rxBytes: 0, appRxBytes: 0, oooSegs: 0, zeroWnd: 0 }, trace: [], seqTrace: [], log: [], createdAt: st.time, err: null };
  if (cfg.wscale) { let sh = 0; while ((s.rcvBufCap >> sh) > 65535 && sh < 14) sh++; s.wscale = sh; }
  h.sockets[id] = s; return s;
}
export function tcpListen(st: EngineState, h: HostState, s: TcpSocket, port: number): string | null {
  for (const o of Object.values(h.sockets)) if (o.proto === 'tcp' && o.state === 'LISTEN' && o.localPort === port) return 'Address already in use';
  s.state = 'LISTEN'; s.localPort = port; s.listenBacklog = []; slog(st, s, `listening on port ${port}`); return null;
}
export function ephemeralPort(h: HostState): number { const p = h.nextEphemeral; h.nextEphemeral = p >= 60999 ? 32768 : p + 1; return p; }
export function tcpConnect(st: EngineState, h: HostState, s: TcpSocket, dst: number, port: number): string | null {
  const r = hostRouteFor(h, dst); if (!r) return 'Network is unreachable';
  s.localIp = r; s.localPort = s.localPort || ephemeralPort(h); s.remoteIp = dst; s.remotePort = port;
  s.iss = Math.floor(rand(st) * 0x7fffffff); s.sndUna = s.iss; s.sndNxt = s.iss + 1; s.sendBufSeq = s.iss + 1; s.recover = s.iss; s.sndMaxSeq = s.iss + 1;
  s.mss = ifaceMssFor(h, dst); cc.ccInit(s, h.tcp.initCwndSegs);
  s.state = 'SYN_SENT'; slog(st, s, `connect ${u32ToIp(dst)}:${port} (ISS=${s.iss})`);
  sendSeg(st, h, s, s.iss, TCP_SYN, new Uint8Array(0), { mss: s.mss, wscale: h.tcp.wscale ? s.wscale : undefined, sackOk: s.sackOk || undefined });
  armRto(st, h, s); trace(st, s, 'SYN');
  return null;
}
export function tcpAccept(h: HostState, ls: TcpSocket): TcpSocket | null { const id = ls.listenBacklog?.shift(); return id === undefined ? null : (h.sockets[id] as TcpSocket) ?? null; }
export function tcpSend(st: EngineState, h: HostState, s: TcpSocket, data: Uint8Array): number {
  if (s.state !== 'ESTABLISHED' && s.state !== 'CLOSE_WAIT') return -1;
  const space = MAX_SENDBUF - s.sendBuf.length; const n = Math.min(space, data.length); if (n <= 0) return 0;
  const nb = new Uint8Array(s.sendBuf.length + n); nb.set(s.sendBuf); nb.set(data.subarray(0, n), s.sendBuf.length); s.sendBuf = nb;
  tcpOutput(st, h, s); return n;
}
export function tcpSendSpace(s: TcpSocket) { return MAX_SENDBUF - s.sendBuf.length; }
export function tcpRecv(st: EngineState, h: HostState, s: TcpSocket, max = Infinity): Uint8Array {
  const n = Math.min(max, s.recvBuf.length); const out = s.recvBuf.slice(0, n); s.recvBuf = s.recvBuf.slice(n); s.stats.appRxBytes += n;
  // Window update: if the window was closed (or grew by >= MSS), tell the peer.
  const wnd = rcvWnd(s); if (n > 0 && (s.lastAdvWnd === 0 || wnd - s.lastAdvWnd >= s.mss) && (s.state === 'ESTABLISHED' || s.state === 'FIN_WAIT_1' || s.state === 'FIN_WAIT_2')) sendAck(st, h, s, 'window update');
  return out;
}
export function tcpClose(st: EngineState, h: HostState, s: TcpSocket) {
  switch (s.state) {
    case 'LISTEN': case 'SYN_SENT': case 'CLOSED': delSock(h, s); return;
    case 'SYN_RCVD': case 'ESTABLISHED': s.state = 'FIN_WAIT_1'; s.finQueued = true; slog(st, s, 'close → FIN_WAIT_1'); tcpOutput(st, h, s); return;
    case 'CLOSE_WAIT': s.state = 'LAST_ACK'; s.finQueued = true; slog(st, s, 'close → LAST_ACK'); tcpOutput(st, h, s); return;
    default: return;
  }
}
export function tcpAbort(st: EngineState, h: HostState, s: TcpSocket) {
  if (s.remoteIp !== null && s.state !== 'LISTEN' && s.state !== 'CLOSED') sendRaw(st, h, s.localIp!, s.remoteIp, s.localPort, s.remotePort!, s.sndNxt, s.rcvNxt, TCP_RST | TCP_ACK, 0, new Uint8Array(0), {});
  slog(st, s, 'abort (RST)'); delSock(h, s);
}
function delSock(h: HostState, s: TcpSocket) {
  delete h.sockets[s.id];
  // Keep finished connections (not listeners / embryonic) so their charts stay inspectable.
  if (s.state !== 'LISTEN' && s.trace.length > 2) { s.state = 'CLOSED'; h.tcpHistory.push(s); if (h.tcpHistory.length > 8) h.tcpHistory.shift(); }
}

// ---------- helpers ----------
function slog(st: EngineState, s: TcpSocket, m: string) { s.log.push(`${(st.time / 1e6).toFixed(6)} ${m}`); if (s.log.length > 1200) s.log.splice(60, 400, '… (older entries trimmed) …'); }
function trace(st: EngineState, s: TcpSocket, ev?: string) {
  s.trace.push({ t: st.time, cwnd: s.cwnd, ssthresh: Math.min(s.ssthresh, 1 << 30), rwnd: s.sndWnd, srtt: s.srtt, rto: s.rto, inflight: Math.max(0, s.sndNxt - s.sndUna), ev });
  if (s.trace.length > 6000) s.trace = s.trace.filter((_, i) => i % 2 === 0 || !!_.ev);
}
function seqEv(s: TcpSocket, t: number, kind: 'data' | 'ack' | 'retx' | 'sack', seq: number, len: number) { s.seqTrace.push({ t, kind, seq, len }); if (s.seqTrace.length > 8000) s.seqTrace = s.seqTrace.filter((_, i) => i % 2 === 0); }
function hostRouteFor(h: HostState, dst: number): number | null { const r = lookupRouteLocal(h, dst); if (!r) return null; const i = h.ifaces.find(x => x.name === r.iface); return i?.ip ?? null; }
function lookupRouteLocal(h: HostState, dst: number) { let best: HostState['routes'][number] | null = null; for (const r of h.routes) { if (((dst & r.mask) >>> 0) !== ((r.dst & r.mask) >>> 0)) continue; if (!best || r.mask > best.mask) best = r; } return best; }
function ifaceMssFor(h: HostState, dst: number): number { const r = lookupRouteLocal(h, dst); const i = r ? h.ifaces.find(x => x.name === r.iface) : h.ifaces[0]; return (i?.mtu ?? 1500) - 40; }
function effMss(h: HostState, s: TcpSocket): number { return Math.max(88, Math.min(s.mss, s.peerMss, pathMtu(h, s.remoteIp!) - 40)); }
function rcvWnd(s: TcpSocket): number { const ooo = s.ooo.reduce((a, x) => a + x.data.length, 0); return Math.max(0, s.rcvBufCap - s.recvBuf.length - ooo); }
function advWnd(s: TcpSocket): number { const w = rcvWnd(s); s.lastAdvWnd = w; return Math.min(65535, w >> s.wscale); }

function sendRaw(st: EngineState, h: HostState, src: number, dst: number, sport: number, dport: number, seq: number, ack: number, flags: number, window: number, data: Uint8Array, options: TcpSegment['options'], df = true) {
  const seg = encodeTcp({ sport, dport, seq: u32(seq), ack: u32(ack), flags, window, options, data }, src, dst);
  h.counters.tcpTx++;
  return hostSendIp(st, h, { src, dst, proto: IPPROTO_TCP, ttl: 64, payload: seg, df });
}
function sendSeg(st: EngineState, h: HostState, s: TcpSocket, seq: number, flags: number, data: Uint8Array, options: TcpSegment['options'] = {}) {
  s.stats.txSegs++; s.stats.txBytes += data.length;
  if ((flags & TCP_ACK) && s.sackOk && s.peerSackOk && s.ooo.length) options = { ...options, sack: sackBlocks(s) };
  if (flags & TCP_ACK) { s.delAckPending = false; }
  const r = sendRaw(st, h, s.localIp!, s.remoteIp!, s.localPort, s.remotePort!, seq, flags & TCP_ACK ? s.rcvNxt : 0, flags, advWnd(s), data, options);
  if (r.status === 'fragneeded') { slog(st, s, `local MTU ${r.mtu} too small, MSS clamped`); }
  return r;
}
function sendAck(st: EngineState, h: HostState, s: TcpSocket, why?: string) { void why; sendSeg(st, h, s, s.sndNxt, TCP_ACK, new Uint8Array(0)); }
function sackBlocks(s: TcpSocket): [number, number][] {
  const blocks = s.ooo.map(x => [x.seq, x.seq + x.data.length] as [number, number]).sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = []; for (const b of blocks) { const l = merged[merged.length - 1]; if (l && b[0] <= l[1]) l[1] = Math.max(l[1], b[1]); else merged.push([b[0], b[1]]); }
  return merged.slice(-3).reverse().slice(0, 4);
}

// ---------- timers ----------
function armRto(st: EngineState, h: HostState, s: TcpSocket) { s.rtoGen++; s.rtoArmed = true; s.rtoDeadline = st.time + s.rto * s.rtoBackoff; timer(st, h.id, s.rto * s.rtoBackoff, `tcp:${s.id}:rto`, s.rtoGen); }
function cancelRto(s: TcpSocket) { s.rtoArmed = false; s.rtoGen++; }
export function tcpTimer(st: EngineState, h: HostState, tag: string, data: unknown) {
  const [, sidS, what] = tag.split(':'); const s = h.sockets[Number(sidS)]; if (!s || s.proto !== 'tcp') return; const gen = data as number;
  switch (what) {
    case 'rto': if (!s.rtoArmed || gen !== s.rtoGen) return; onRto(st, h, s); return;
    case 'dack': if (gen !== s.delAckGen || !s.delAckPending) return; s.delAckPending = false; sendAck(st, h, s, 'delayed'); return;
    case 'persist': if (gen !== s.persistGen) return; onPersist(st, h, s); return;
    case 'tw': if (gen !== s.timeWaitGen) return; slog(st, s, 'TIME_WAIT expired → CLOSED'); delSock(h, s); procNotify(st, h, s.owner, { type: 'tcpClosed', sock: s.id }); return;
  }
}
function onRto(st: EngineState, h: HostState, s: TcpSocket) {
  s.stats.rtoCount++;
  if (s.state === 'SYN_SENT' || s.state === 'SYN_RCVD') {
    if (++s.synRetries > 5) { s.err = s.state === 'SYN_SENT' ? 'Connection timed out' : 'timed out'; slog(st, s, s.err); const owner = s.owner; delSock(h, s); procNotify(st, h, owner, { type: 'tcpError', sock: s.id, err: s.err }); return; }
    s.rtoBackoff *= 2; slog(st, s, `RTO: retransmit ${s.state === 'SYN_SENT' ? 'SYN' : 'SYN-ACK'} (backoff ×${s.rtoBackoff})`);
    if (s.state === 'SYN_SENT') sendSeg(st, h, s, s.iss, TCP_SYN, new Uint8Array(0), { mss: s.mss, wscale: h.tcp.wscale ? s.wscale : undefined, sackOk: s.sackOk || undefined });
    else sendSeg(st, h, s, s.iss, TCP_SYN | TCP_ACK, new Uint8Array(0), { mss: s.mss, wscale: h.tcp.wscale ? s.wscale : undefined, sackOk: s.sackOk || undefined });
    s.stats.retx++; armRto(st, h, s); return;
  }
  if (s.sndUna === s.sndNxt) { s.rtoArmed = false; return; }
  cc.ccOnRto(s); s.rttSeq = null; s.rtoBackoff = Math.min(s.rtoBackoff * 2, 64); s.sacked = [];
  slog(st, s, `RTO expired (rto=${(s.rto * s.rtoBackoff / s.rtoBackoff / 1000).toFixed(0)}ms, backoff ×${s.rtoBackoff}) → ssthresh=${s.ssthresh} cwnd=${s.cwnd}`);
  trace(st, s, 'RTO');
  retransmit(st, h, s, s.sndUna); armRto(st, h, s);
  if (s.rtoBackoff >= 64) { s.err = 'Connection timed out'; const owner = s.owner; slog(st, s, s.err); delSock(h, s); procNotify(st, h, owner, { type: 'tcpError', sock: s.id, err: s.err }); }
}
function onPersist(st: EngineState, h: HostState, s: TcpSocket) {
  if (s.sndWnd > 0 || s.sendBuf.length === s.sndNxt - s.sndUna) return;
  // zero-window probe: one byte beyond the window
  const off = s.sndNxt - s.sendBufSeq; const b = s.sendBuf.subarray(off, off + 1);
  slog(st, s, 'zero window probe'); s.stats.zeroWnd++; sendSeg(st, h, s, s.sndNxt, TCP_ACK, b); trace(st, s, 'ZWP');
  s.persistGen++; timer(st, h.id, Math.min(60 * SEC, s.rto * 2), `tcp:${s.id}:persist`, s.persistGen);
}

// ---------- output ----------
export function tcpOutput(st: EngineState, h: HostState, s: TcpSocket) {
  if (s.state !== 'ESTABLISHED' && s.state !== 'CLOSE_WAIT' && s.state !== 'FIN_WAIT_1' && s.state !== 'LAST_ACK' && s.state !== 'CLOSING') return;
  const mss = effMss(h, s); let sent = 0;
  for (;;) {
    const inflight = s.sndNxt - s.sndUna; const unsent = s.sendBufSeq + s.sendBuf.length - s.sndNxt;
    if (s.sndWnd === 0 && inflight === 0 && unsent > 0) { if (s.persistGen === 0 || true) { s.persistGen++; timer(st, h.id, s.rto, `tcp:${s.id}:persist`, s.persistGen); } break; }
    const usable = Math.min(s.sndWnd, s.cwnd) - inflight;
    if (unsent <= 0) { if (s.finQueued && s.finSeq === null && inflight <= Math.max(0, Math.min(s.sndWnd, s.cwnd))) { s.finSeq = s.sndNxt; sendSeg(st, h, s, s.sndNxt, TCP_FIN | TCP_ACK, new Uint8Array(0)); s.sndNxt++; s.sndMaxSeq = Math.max(s.sndMaxSeq, s.sndNxt); if (!s.rtoArmed) armRto(st, h, s); slog(st, s, `FIN sent seq=${s.finSeq}`); trace(st, s, 'FIN'); } break; }
    const len = Math.min(mss, unsent, usable); if (len <= 0) break;
    if (s.nagle && len < mss && inflight > 0 && unsent < mss) break;
    const off = s.sndNxt - s.sendBufSeq; const data = s.sendBuf.slice(off, off + len); const last = len === unsent;
    sendSeg(st, h, s, s.sndNxt, TCP_ACK | (last ? TCP_PSH : 0), data); seqEv(s, st.time, 'data', s.sndNxt, len);
    if (s.rttSeq === null) { s.rttSeq = s.sndNxt; s.rttStart = st.time; }
    s.sndNxt += len; s.sndMaxSeq = Math.max(s.sndMaxSeq, s.sndNxt); sent++;
    if (!s.rtoArmed) armRto(st, h, s);
  }
  if (sent) trace(st, s);
}
function retransmit(st: EngineState, h: HostState, s: TcpSocket, seq: number) {
  const mss = effMss(h, s);
  if (s.finSeq !== null && seq === s.finSeq) { sendSeg(st, h, s, seq, TCP_FIN | TCP_ACK, new Uint8Array(0)); s.stats.retx++; seqEv(s, st.time, 'retx', seq, 0); return; }
  const off = seq - s.sendBufSeq; if (off < 0 || off >= s.sendBuf.length) return;
  let len = Math.min(mss, s.sendBuf.length - off); if (s.finSeq !== null) len = Math.min(len, s.finSeq - seq);
  const data = s.sendBuf.slice(off, off + len);
  s.stats.retx++; if (s.rttSeq !== null && seqLe(s.rttSeq, seq + len)) s.rttSeq = null; // Karn
  sendSeg(st, h, s, seq, TCP_ACK | TCP_PSH, data); seqEv(s, st.time, 'retx', seq, len); slog(st, s, `retransmit seq=${seq} len=${len}`);
}
function nextSackHole(s: TcpSocket): number | null {
  // first byte >= sndUna (and >= highRxt) not covered by a SACK block, below the highest sacked byte
  if (!s.sacked.length) return null; const top = Math.max(...s.sacked.map(b => b[1])); let p = Math.max(s.sndUna, s.highRxt);
  while (seqLt(p, top)) { const blk = s.sacked.find(b => seqLe(b[0], p) && seqLt(p, b[1])); if (!blk) return p; p = blk[1]; }
  return null;
}

// ---------- input ----------
export function tcpInput(st: EngineState, h: HostState, ip: Ipv4Packet, bytes: Uint8Array, start: number, end: number, ifaceIdx: number) {
  void ifaceIdx; let d; try { d = decodeTcp(bytes, start, end, ip.src, ip.dst); } catch { return; }
  if (!d.checksumOk) { h.counters.dropBadChecksum++; log(st, `${h.name}: dropped TCP segment with bad checksum`); return; }
  h.counters.tcpRx++; const seg = d.seg;
  // find connection: exact 4-tuple first, then listener
  let s: TcpSocket | undefined;
  for (const o of Object.values(h.sockets)) if (o.proto === 'tcp' && o.state !== 'LISTEN' && o.localPort === seg.dport && o.remotePort === seg.sport && o.remoteIp === ip.src && (o.localIp === null || o.localIp === ip.dst)) { s = o; break; }
  if (!s) for (const o of Object.values(h.sockets)) if (o.proto === 'tcp' && o.state === 'LISTEN' && o.localPort === seg.dport && (o.localIp === null || o.localIp === ip.dst)) { s = o; break; }
  if (!s) { if (!(seg.flags & TCP_RST)) { log(st, `${h.name}: TCP ${seg.dport} closed, sending RST`); if (seg.flags & TCP_ACK) sendRaw(st, h, ip.dst, ip.src, seg.dport, seg.sport, seg.ack, 0, TCP_RST, 0, new Uint8Array(0), {}); else sendRaw(st, h, ip.dst, ip.src, seg.dport, seg.sport, 0, seg.seq + seg.data.length + ((seg.flags & TCP_SYN) ? 1 : 0), TCP_RST | TCP_ACK, 0, new Uint8Array(0), {}); } return; }
  s.stats.rxSegs++;
  if (s.state === 'LISTEN') { onListen(st, h, s, ip, seg); return; }
  if (s.state === 'SYN_SENT') { onSynSent(st, h, s, seg); return; }
  // ---- sequence check (RFC 793 acceptability, simplified) ----
  const wnd = rcvWnd(s); const segLen = seg.data.length + ((seg.flags & TCP_SYN) ? 1 : 0) + ((seg.flags & TCP_FIN) ? 1 : 0);
  const segEnd = seg.seq + segLen;
  const acceptable = segLen === 0 ? (wnd === 0 ? seg.seq === s.rcvNxt : seqLe(s.rcvNxt, seg.seq) && seqLt(seg.seq, s.rcvNxt + wnd)) : (seqLt(s.rcvNxt, segEnd) && seqLt(seg.seq, s.rcvNxt + Math.max(wnd, 1)) || seg.seq === s.rcvNxt) || seqLt(seg.seq, s.rcvNxt) && seqLt(s.rcvNxt, segEnd);
  if (!acceptable) { if (!(seg.flags & TCP_RST)) { sendAck(st, h, s); } return; }
  if (seg.flags & TCP_RST) { s.err = 'Connection reset by peer'; slog(st, s, 'RST received → CLOSED'); const owner = s.owner; if (s.state === 'SYN_RCVD' && s.parent !== null) { delSock(h, s); return; } delSock(h, s); procNotify(st, h, owner, { type: 'tcpError', sock: s.id, err: s.err }); return; }
  if (seg.flags & TCP_SYN) { if (s.state === 'SYN_RCVD') { sendSeg(st, h, s, s.iss, TCP_SYN | TCP_ACK, new Uint8Array(0), { mss: s.mss, wscale: h.tcp.wscale ? s.wscale : undefined, sackOk: s.sackOk || undefined }); return; } /* SYN in window: treat as error → RST */ sendRaw(st, h, s.localIp!, s.remoteIp!, s.localPort, s.remotePort!, s.sndNxt, 0, TCP_RST, 0, new Uint8Array(0), {}); s.err = 'Connection reset'; delSock(h, s); procNotify(st, h, s.owner, { type: 'tcpError', sock: s.id, err: s.err }); return; }
  if (!(seg.flags & TCP_ACK)) return;
  // ---- ACK processing ----
  if (s.state === 'SYN_RCVD') {
    if (seg.ack === s.iss + 1) { s.state = 'ESTABLISHED'; s.sndUna = seg.ack; cancelRto(s); s.rtoBackoff = 1; s.sndWnd = seg.window << s.peerWscale; s.sndWl1 = seg.seq; s.sndWl2 = seg.ack; s.maxSndWnd = s.sndWnd; slog(st, s, 'ESTABLISHED (passive)'); trace(st, s, 'EST');
      if (s.parent !== null) { const p = h.sockets[s.parent]; if (p && p.proto === 'tcp' && p.listenBacklog) { p.listenBacklog.push(s.id); procNotify(st, h, p.owner, { type: 'tcpAccept', sock: p.id, newSock: s.id }); } }
    } else { sendRaw(st, h, s.localIp!, s.remoteIp!, s.localPort, s.remotePort!, seg.ack, 0, TCP_RST, 0, new Uint8Array(0), {}); return; }
  }
  onAck(st, h, s, seg);
  if (!h.sockets[s.id]) return;
  // ---- data / FIN ----
  if (seg.data.length || (seg.flags & TCP_FIN)) onData(st, h, s, seg);
  if (h.sockets[s.id]) tcpOutput(st, h, s);
}
function onListen(st: EngineState, h: HostState, ls: TcpSocket, ip: Ipv4Packet, seg: TcpSegment) {
  if (seg.flags & TCP_RST) return;
  if (seg.flags & TCP_ACK) { sendRaw(st, h, ip.dst, ip.src, seg.dport, seg.sport, seg.ack, 0, TCP_RST, 0, new Uint8Array(0), {}); return; }
  if (!(seg.flags & TCP_SYN)) return;
  const c = tcpSocket(st, h, ls.owner); c.parent = ls.id; c.localIp = ip.dst; c.localPort = seg.dport; c.remoteIp = ip.src; c.remotePort = seg.sport;
  c.irs = seg.seq; c.rcvNxt = seg.seq + 1; c.iss = Math.floor(rand(st) * 0x7fffffff); c.sndUna = c.iss; c.sndNxt = c.iss + 1; c.sendBufSeq = c.iss + 1; c.recover = c.iss; c.sndMaxSeq = c.iss + 1;
  c.mss = ifaceMssFor(h, ip.src); c.peerMss = seg.options.mss ?? 536; c.peerWscale = seg.options.wscale ?? 0; if (seg.options.wscale === undefined) c.wscale = 0; c.peerSackOk = !!seg.options.sackOk; c.sackOk = c.sackOk && c.peerSackOk;
  c.sndWnd = seg.window; c.maxSndWnd = c.sndWnd; cc.ccInit(c, h.tcp.initCwndSegs); c.state = 'SYN_RCVD';
  slog(st, c, `SYN from ${u32ToIp(ip.src)}:${seg.sport} (IRS=${seg.seq}), ISS=${c.iss} → SYN_RCVD`);
  sendSeg(st, h, c, c.iss, TCP_SYN | TCP_ACK, new Uint8Array(0), { mss: c.mss, wscale: h.tcp.wscale && seg.options.wscale !== undefined ? c.wscale : undefined, sackOk: c.sackOk || undefined });
  armRto(st, h, c); trace(st, c, 'SYN-ACK');
}
function onSynSent(st: EngineState, h: HostState, s: TcpSocket, seg: TcpSegment) {
  if (seg.flags & TCP_ACK) { if (seg.ack !== s.iss + 1) { if (!(seg.flags & TCP_RST)) sendRaw(st, h, s.localIp!, s.remoteIp!, s.localPort, s.remotePort!, seg.ack, 0, TCP_RST, 0, new Uint8Array(0), {}); return; } }
  if (seg.flags & TCP_RST) { if (seg.flags & TCP_ACK) { s.err = 'Connection refused'; slog(st, s, 'RST → Connection refused'); const owner = s.owner; delSock(h, s); procNotify(st, h, owner, { type: 'tcpError', sock: s.id, err: s.err }); } return; }
  if (!(seg.flags & TCP_SYN)) return;
  s.irs = seg.seq; s.rcvNxt = seg.seq + 1; s.peerMss = seg.options.mss ?? 536; s.peerWscale = seg.options.wscale ?? 0; if (seg.options.wscale === undefined) s.wscale = 0; s.peerSackOk = !!seg.options.sackOk; s.sackOk = s.sackOk && s.peerSackOk;
  if (seg.flags & TCP_ACK) {
    s.sndUna = seg.ack; s.sndWnd = seg.window << s.peerWscale; s.sndWl1 = seg.seq; s.sndWl2 = seg.ack; s.maxSndWnd = s.sndWnd; cancelRto(s); s.rtoBackoff = 1;
    const sample = st.time - s.rttStart; if (s.rttStart) updateRtt(st, h, s, st.time - (s.rtoDeadline - s.rto)); void sample;
    s.state = 'ESTABLISHED'; slog(st, s, `SYN-ACK (IRS=${seg.seq}, MSS=${s.peerMss}, WS=${s.peerWscale}, SACK=${s.peerSackOk}) → ESTABLISHED`); trace(st, s, 'EST');
    sendAck(st, h, s); procNotify(st, h, s.owner, { type: 'tcpConnected', sock: s.id }); tcpOutput(st, h, s);
  } else { s.state = 'SYN_RCVD'; sendSeg(st, h, s, s.iss, TCP_SYN | TCP_ACK, new Uint8Array(0), { mss: s.mss, wscale: h.tcp.wscale ? s.wscale : undefined, sackOk: s.sackOk || undefined }); }
}
function updateRtt(st: EngineState, h: HostState, s: TcpSocket, r: number) {
  if (r < 0) return;
  if (s.srtt === 0) { s.srtt = r; s.rttvar = r / 2; } else { s.rttvar = 0.75 * s.rttvar + 0.25 * Math.abs(s.srtt - r); s.srtt = 0.875 * s.srtt + 0.125 * r; }
  s.rto = Math.min(60 * SEC, Math.max(h.tcp.minRtoUs, s.srtt + Math.max(1 * MS, 4 * s.rttvar)));
  if (s.cubic.minRtt === 0 || r < s.cubic.minRtt) s.cubic.minRtt = r;
  void st;
}
function onAck(st: EngineState, h: HostState, s: TcpSocket, seg: TcpSegment) {
  const ack = seg.ack;
  if (seqLt(s.sndNxt, ack)) { sendAck(st, h, s); return; } // acks something not yet sent
  // SACK scoreboard
  if (seg.options.sack?.length) { for (const b of seg.options.sack) if (seqLe(s.sndUna, b[0]) && seqLe(b[1], s.sndNxt) && !s.sacked.some(x => x[0] === b[0] && x[1] === b[1])) { s.sacked.push([b[0], b[1]]); seqEv(s, st.time, 'sack', b[0], b[1] - b[0]); } }
  if (seqLe(ack, s.sndUna)) {
    // duplicate ACK?
    const isDup = ack === s.sndUna && seg.data.length === 0 && !(seg.flags & (TCP_SYN | TCP_FIN)) && seqLt(s.sndUna, s.sndNxt);
    if (isDup || (seg.options.sack?.length && ack === s.sndUna)) {
      s.dupAcks++; s.stats.dupAcksRx++; seqEv(s, st.time, 'ack', ack, 0);
      if (s.dupAcks === 3 && !s.inRecovery && seqLe(s.recover, ack)) {
        s.stats.fastRetx++; const entered = cc.ccOnFastRetransmit(s, st.time); s.recover = s.sndNxt; s.highRxt = s.sndUna;
        slog(st, s, `3 dup ACKs → fast retransmit seq=${s.sndUna} (${s.cc}: ssthresh=${s.ssthresh} cwnd=${s.cwnd}${entered ? ', fast recovery' : ', slow start'})`); trace(st, s, 'FRX');
        retransmit(st, h, s, s.sndUna); s.highRxt = s.sndUna + effMss(h, s); armRto(st, h, s);
      } else if (s.dupAcks > 3 && s.inRecovery) {
        cc.ccOnDupAckInRecovery(s); trace(st, s);
        if (s.sackOk && s.peerSackOk) { const hole = nextSackHole(s); if (hole !== null && seqLt(hole, s.recover) && (s.sndNxt - s.sndUna) < s.cwnd + effMss(h, s)) { retransmit(st, h, s, hole); s.highRxt = hole + effMss(h, s); } }
        tcpOutput(st, h, s);
      }
    }
    return;
  }
  // ---- new ACK ----
  const acked = ack - s.sndUna; seqEv(s, st.time, 'ack', ack, 0);
  const off = ack - s.sendBufSeq; if (off > 0) { s.sendBuf = s.sendBuf.slice(Math.min(off, s.sendBuf.length)); s.sendBufSeq += Math.min(off, s.sendBufSeq + off - s.sendBufSeq); s.sendBufSeq = ack; }
  s.sndUna = ack; s.sacked = s.sacked.filter(b => seqLt(ack, b[1]));
  if (s.finSeq !== null && seqLt(s.finSeq, ack)) s.finAcked = true;
  if (s.rttSeq !== null && seqLt(s.rttSeq, ack)) { updateRtt(st, h, s, st.time - s.rttStart); s.rttSeq = null; }
  s.rtoBackoff = 1; if (s.sndUna === s.sndNxt) cancelRto(s); else armRto(st, h, s);
  // window update
  if (seqLt(s.sndWl1, seg.seq) || (s.sndWl1 === seg.seq && seqLe(s.sndWl2, ack))) { const w = seg.window << s.peerWscale; if (s.sndWnd === 0 && w > 0) s.persistGen++; s.sndWnd = w; s.sndWl1 = seg.seq; s.sndWl2 = ack; s.maxSndWnd = Math.max(s.maxSndWnd, w); }
  if (s.inRecovery) {
    if (seqLt(ack, s.recover)) { const cont = cc.ccOnPartialAck(s, acked); slog(st, s, `partial ACK ${ack} < recover ${s.recover}${cont ? ' → retransmit next' : ''}`); trace(st, s, 'PACK'); if (cont) { retransmit(st, h, s, s.sndUna); s.highRxt = s.sndUna + effMss(h, s); armRto(st, h, s); } else { s.dupAcks = 0; } }
    else { cc.ccOnFullAck(s); slog(st, s, `recovery complete, cwnd=${s.cwnd}`); trace(st, s, 'REC'); }
  } else { s.dupAcks = 0; cc.ccOnNewAck(s, acked, st.time); trace(st, s); }
  // state transitions driven by our FIN being acked
  if (s.finAcked) {
    if (s.state === 'FIN_WAIT_1') { s.state = 'FIN_WAIT_2'; slog(st, s, 'FIN acked → FIN_WAIT_2'); procNotify(st, h, s.owner, { type: 'tcpFinAcked', sock: s.id }); }
    else if (s.state === 'CLOSING') { enterTimeWait(st, h, s); procNotify(st, h, s.owner, { type: 'tcpFinAcked', sock: s.id }); }
    else if (s.state === 'LAST_ACK') { slog(st, s, 'FIN acked → CLOSED'); const owner = s.owner; delSock(h, s); procNotify(st, h, owner, { type: 'tcpClosed', sock: s.id }); return; }
  }
  if (acked > 0 && (s.state === 'ESTABLISHED' || s.state === 'CLOSE_WAIT')) procNotify(st, h, s.owner, { type: 'tcpWritable', sock: s.id });
}
function enterTimeWait(st: EngineState, h: HostState, s: TcpSocket) { s.state = 'TIME_WAIT'; s.timeWaitGen++; cancelRto(s); slog(st, s, `→ TIME_WAIT (2MSL = ${(2 * h.tcp.mslUs / 1e6).toFixed(0)}s)`); timer(st, h.id, 2 * h.tcp.mslUs, `tcp:${s.id}:tw`, s.timeWaitGen); }
function onData(st: EngineState, h: HostState, s: TcpSocket, seg: TcpSegment) {
  if (s.state === 'CLOSED' || s.state === 'LISTEN' || s.state === 'SYN_SENT') return;
  let seq = seg.seq; let data = seg.data; const fin = !!(seg.flags & TCP_FIN);
  if (s.state === 'TIME_WAIT') { if (fin) { sendAck(st, h, s); s.timeWaitGen++; timer(st, h.id, 2 * h.tcp.mslUs, `tcp:${s.id}:tw`, s.timeWaitGen); } return; }
  // trim old data
  if (seqLt(seq, s.rcvNxt)) { const skip = s.rcvNxt - seq; if (skip >= data.length && !fin) { sendAck(st, h, s); return; } data = data.subarray(Math.min(skip, data.length)); seq = s.rcvNxt; }
  let immediate = false;
  if (seq === s.rcvNxt) {
    if (data.length) { const room = rcvWnd(s); const take = data.subarray(0, Math.min(room, data.length)); if (take.length) { const nb = new Uint8Array(s.recvBuf.length + take.length); nb.set(s.recvBuf); nb.set(take, s.recvBuf.length); s.recvBuf = nb; s.rcvNxt += take.length; s.stats.rxBytes += take.length; } if (take.length < data.length) immediate = true; }
    if (fin && data.length === (s.rcvNxt - seq)) { s.finRcvd = s.rcvNxt; }
    // pull in contiguous out-of-order segments
    let merged = true; while (merged) { merged = false; for (let i = 0; i < s.ooo.length; i++) { const o = s.ooo[i]!; if (seqLe(o.seq, s.rcvNxt) && seqLt(s.rcvNxt, o.seq + o.data.length)) { const part = o.data.subarray(s.rcvNxt - o.seq); const nb = new Uint8Array(s.recvBuf.length + part.length); nb.set(s.recvBuf); nb.set(part, s.recvBuf.length); s.recvBuf = nb; s.rcvNxt += part.length; s.stats.rxBytes += part.length; s.ooo.splice(i, 1); merged = true; immediate = true; break; } else if (seqLe(o.seq + o.data.length, s.rcvNxt)) { s.ooo.splice(i, 1); merged = true; break; } } }
    if (s.finRcvd !== null && s.finRcvd === s.rcvNxt) { s.rcvNxt++; s.finRcvd = -1; onFin(st, h, s); immediate = true; }
    if (data.length) procNotify(st, h, s.owner, { type: 'tcpReadable', sock: s.id });
  } else if (seqLt(s.rcvNxt, seq)) {
    // out of order: buffer within window, send immediate (duplicate) ACK
    if (seqLt(seq, s.rcvNxt + rcvWnd(s)) && data.length && !s.ooo.some(o => o.seq === seq)) { s.ooo.push({ seq, data: data.slice() }); s.stats.oooSegs++; }
    if (fin && data.length) s.finRcvd = seq + data.length;
    immediate = true;
  }
  if (!h.sockets[s.id]) return;
  // ACK policy: immediate for out-of-order / every second full segment / when delayed ACK disabled
  if (immediate || !s.delayedAck || s.delAckPending || s.quickAcks > 0) { if (s.quickAcks > 0) s.quickAcks--; sendAck(st, h, s); s.delAckPending = false; }
  else { s.delAckPending = true; s.delAckGen++; timer(st, h.id, h.tcp.delAckUs, `tcp:${s.id}:dack`, s.delAckGen); }
}
function onFin(st: EngineState, h: HostState, s: TcpSocket) {
  switch (s.state) {
    case 'SYN_RCVD': case 'ESTABLISHED': s.state = 'CLOSE_WAIT'; slog(st, s, 'FIN received → CLOSE_WAIT'); procNotify(st, h, s.owner, { type: 'tcpEof', sock: s.id }); break;
    case 'FIN_WAIT_1': if (s.finAcked) enterTimeWait(st, h, s); else { s.state = 'CLOSING'; slog(st, s, 'FIN received → CLOSING'); } procNotify(st, h, s.owner, { type: 'tcpEof', sock: s.id }); break;
    case 'FIN_WAIT_2': enterTimeWait(st, h, s); procNotify(st, h, s.owner, { type: 'tcpEof', sock: s.id }); break;
    default: break;
  }
}
/** Path MTU changed for this destination: clamp MSS and retransmit what is in flight. */
export function tcpOnPmtu(st: EngineState, h: HostState, dst: number) {
  for (const s of Object.values(h.sockets)) if (s.proto === 'tcp' && s.remoteIp === dst && seqLt(s.sndUna, s.sndNxt)) { slog(st, s, `path MTU now ${pathMtu(h, dst)} → MSS ${effMss(h, s)}, retransmitting`); s.rttSeq = null; retransmit(st, h, s, s.sndUna); }
}
export function tcpOnIcmpUnreach(st: EngineState, h: HostState, dst: number, sport: number, dport: number, why: string) {
  for (const s of Object.values(h.sockets)) if (s.proto === 'tcp' && s.remoteIp === dst && s.localPort === sport && s.remotePort === dport && s.state === 'SYN_SENT') { s.err = why; slog(st, s, `ICMP: ${why}`); const owner = s.owner; delSock(h, s); procNotify(st, h, owner, { type: 'tcpError', sock: s.id, err: why }); }
}
export function tcpStateSummary(s: TcpSocket) { return `${s.state} ${s.localIp === null ? '*' : u32ToIp(s.localIp)}:${s.localPort} ${s.remoteIp === null ? '*:*' : `${u32ToIp(s.remoteIp)}:${s.remotePort}`}`; }
export { flagsStr, term };
