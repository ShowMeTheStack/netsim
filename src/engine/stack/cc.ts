// Pluggable congestion controllers: Tahoe, Reno, NewReno, CUBIC. Pure functions over the TCB.
// All window values are in bytes; `s.mss` is the effective sender MSS.
import type { TcpSocket } from '../types';

const CUBIC_C = 0.4, CUBIC_BETA = 0.7;
function flight(s: TcpSocket) { return Math.max(0, s.sndNxt - s.sndUna); }
export function ccInit(s: TcpSocket, initSegs: number) {
  s.cwnd = initSegs * s.mss; s.ssthresh = 0x7fffffff; s.dupAcks = 0; s.inRecovery = false; s.recover = s.iss;
  s.cubic = { wMax: 0, k: 0, epochStart: 0, originPoint: 0, tcpCwnd: 0, ackCnt: 0, minRtt: 0 };
}
/** ACK advanced snd_una while not in loss recovery. `prevFlight` is the bytes outstanding
 *  just before this ACK (sndNxt - oldSndUna), used for congestion-window validation. */
export function ccOnNewAck(s: TcpSocket, acked: number, now: number, prevFlight: number) {
  // RFC 5681 §3.1 / RFC 7661: do not grow cwnd when the flow is not cwnd-limited (it is
  // application- or receive-window-limited). Without this, cwnd runs away on a clean or
  // receive-window-bounded path while nothing is ever in flight to justify it.
  if (prevFlight + s.mss <= s.cwnd) return;
  if (s.cwnd < s.ssthresh) { s.cwnd += Math.min(acked, s.mss); return; } // slow start (RFC 5681: at most SMSS per ACK)
  if (s.cc === 'cubic') { cubicUpdate(s, now); return; }
  // congestion avoidance: +MSS per RTT (byte-counting approximation)
  s.cwnd += Math.max(1, Math.floor((s.mss * s.mss) / s.cwnd));
}
/** Third duplicate ACK: returns true if the variant enters fast recovery. */
export function ccOnFastRetransmit(s: TcpSocket, now: number): boolean {
  const fl = flight(s);
  switch (s.cc) {
    case 'tahoe': s.ssthresh = Math.max(Math.floor(fl / 2), 2 * s.mss); s.cwnd = s.mss; s.inRecovery = false; return false;
    case 'reno': case 'newreno': s.ssthresh = Math.max(Math.floor(fl / 2), 2 * s.mss); s.cwnd = s.ssthresh + 3 * s.mss; s.inRecovery = true; return true;
    case 'cubic': {
      const c = s.cubic; c.epochStart = 0;
      c.wMax = s.cwnd < c.wMax ? s.cwnd * (1 + CUBIC_BETA) / 2 : s.cwnd; // fast convergence
      s.ssthresh = Math.max(Math.floor(s.cwnd * CUBIC_BETA), 2 * s.mss); s.cwnd = s.ssthresh; s.inRecovery = true; void now; return true;
    }
  }
}
/** Additional duplicate ACK while in fast recovery (Reno-family window inflation). */
export function ccOnDupAckInRecovery(s: TcpSocket) { if (s.cc === 'reno' || s.cc === 'newreno') s.cwnd += s.mss; }
/** ACK that advances snd_una but does not cover `recover` (NewReno/CUBIC partial ACK). Returns true if recovery continues. */
export function ccOnPartialAck(s: TcpSocket, acked: number): boolean {
  // Classic Reno leaves recovery on the first new ACK. With SACK negotiated, recovery is SACK-driven (RFC 6675 style) and continues.
  if (s.cc === 'reno' && !(s.sackOk && s.peerSackOk)) { s.cwnd = s.ssthresh; s.inRecovery = false; return false; }
  // NewReno / CUBIC: deflate by acked, add back one MSS if a full segment was acked, stay in recovery
  s.cwnd = Math.max(s.mss, s.cwnd - acked + (acked >= s.mss ? s.mss : 0)); return true;
}
/** ACK covering `recover`: leave fast recovery. */
export function ccOnFullAck(s: TcpSocket) {
  if (s.cc === 'newreno' || s.cc === 'cubic') s.cwnd = Math.min(s.ssthresh, Math.max(flight(s), s.mss) + s.mss); else s.cwnd = s.ssthresh;
  s.inRecovery = false; s.dupAcks = 0;
}
/** Retransmission timeout: back to slow start (all variants). */
export function ccOnRto(s: TcpSocket) {
  s.ssthresh = Math.max(Math.floor(flight(s) / 2), 2 * s.mss); s.cwnd = s.mss; s.inRecovery = false; s.dupAcks = 0;
  if (s.cc === 'cubic') { s.cubic.epochStart = 0; s.cubic.wMax = Math.max(s.cubic.wMax, s.cwnd); }
}
function cubicUpdate(s: TcpSocket, now: number) {
  const c = s.cubic; const mss = s.mss; const rttS = (s.srtt || 100_000) / 1e6;
  if (c.epochStart === 0) {
    c.epochStart = now; c.ackCnt = 0;
    if (s.cwnd < c.wMax) { c.k = Math.cbrt((c.wMax - s.cwnd) / mss / CUBIC_C); c.originPoint = c.wMax; } else { c.k = 0; c.originPoint = s.cwnd; }
    c.tcpCwnd = s.cwnd;
  }
  const t = (now - c.epochStart) / 1e6 + rttS;
  const target = c.originPoint + CUBIC_C * Math.pow(t - c.k, 3) * mss;   // W_cubic(t+RTT) in bytes
  // TCP-friendly estimate (RFC 8312 §4.2)
  c.tcpCwnd += (3 * (1 - CUBIC_BETA) / (1 + CUBIC_BETA)) * (mss * mss / s.cwnd);
  const goal = Math.max(target, c.tcpCwnd);
  if (goal > s.cwnd) s.cwnd += Math.max(1, Math.floor(((goal - s.cwnd) / s.cwnd) * mss)); else s.cwnd += Math.max(1, Math.floor(0.01 * mss * mss / s.cwnd));
}
