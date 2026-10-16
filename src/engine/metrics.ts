// Research metrics library (E5).
//
// Pure functions that compute standard networking metrics from captured frames and engine state.
// One definition per metric, so every figure number in a paper has a single source. Nothing here
// mutates state or touches a real clock; all times are the engine's integer microseconds.
import { decodeFrame, fieldValue } from './codecs/decode';
import type { CapturedFrame, EngineState, LinkState, TcpSocket, HostState } from './types';
import { isHost } from './types';

export interface FlowKey { src: string; dst: string; proto: string; sport: number; dport: number }
export interface FlowRate { key: string; bytes: number; frames: number; firstT: number; lastT: number; bps: number }

/** Canonical 5-tuple string for a decoded frame, or null if it is not IP/L4. */
export function flowKeyOf(bytes: Uint8Array): FlowKey | null {
  let d: ReturnType<typeof decodeFrame>;
  try { d = decodeFrame(bytes); } catch { return null; }
  if (!d.src || !d.dst) return null;
  const isTcp = d.layers.some(l => l.proto === 'tcp');
  const isUdp = d.layers.some(l => l.proto === 'udp');
  const proto = isTcp ? 'tcp' : isUdp ? 'udp' : d.proto.toLowerCase();
  const sport = Number(fieldValue(d, `${proto}.srcport`) ?? -1);
  const dport = Number(fieldValue(d, `${proto}.dstport`) ?? -1);
  return { src: d.src, dst: d.dst, proto, sport, dport };
}
export function flowKeyStr(k: FlowKey): string { return `${k.proto} ${k.src}:${k.sport} -> ${k.dst}:${k.dport}`; }

/** Aggregate per-flow byte counts and bit-rate over the time span the frames cover. */
export function flowRates(frames: CapturedFrame[]): FlowRate[] {
  const acc = new Map<string, FlowRate>();
  for (const f of frames) {
    if (f.drop) continue;                 // only frames that made it onto the wire
    const k = flowKeyOf(f.bytes); if (!k) continue;
    const key = flowKeyStr(k);
    let r = acc.get(key);
    if (!r) { r = { key, bytes: 0, frames: 0, firstT: f.t, lastT: f.t, bps: 0 }; acc.set(key, r); }
    r.bytes += f.bytes.length; r.frames++;
    if (f.t < r.firstT) r.firstT = f.t; if (f.t > r.lastT) r.lastT = f.t;
  }
  for (const r of acc.values()) { const durUs = Math.max(1, r.lastT - r.firstT); r.bps = (r.bytes * 8 * 1e6) / durUs; }
  return [...acc.values()];
}

/** Aggregate throughput (bits/s) over all non-dropped frames in a capture window. */
export function throughputBps(frames: CapturedFrame[]): number {
  let bytes = 0, firstT = Infinity, lastT = -Infinity;
  for (const f of frames) { if (f.drop) continue; bytes += f.bytes.length; if (f.t < firstT) firstT = f.t; if (f.t > lastT) lastT = f.t; }
  if (!Number.isFinite(firstT) || lastT <= firstT) return 0;
  return (bytes * 8 * 1e6) / (lastT - firstT);
}

/** Jain's fairness index over a set of non-negative rates: (sum x)^2 / (n * sum x^2). 1 is perfectly fair. */
export function jainFairness(rates: number[]): number {
  const xs = rates.filter(x => x > 0);
  if (xs.length === 0) return 0;
  let s = 0, s2 = 0; for (const x of xs) { s += x; s2 += x * x; }
  return (s * s) / (xs.length * s2);
}

/** Loss rate on a link direction from the engine's own link counters. */
export function lossFromLink(link: LinkState): { ab: number; ba: number } {
  const ab = link.stats.abTx + link.stats.abDrops, ba = link.stats.baTx + link.stats.baDrops;
  return { ab: ab > 0 ? link.stats.abDrops / ab : 0, ba: ba > 0 ? link.stats.baDrops / ba : 0 };
}

/** Loss rate observed on a capture: dropped frames over total frames seen. */
export function lossFromFrames(frames: CapturedFrame[]): number {
  if (frames.length === 0) return 0;
  let drops = 0; for (const f of frames) if (f.drop) drops++;
  return drops / frames.length;
}

/** Smoothed RTT (seconds) from a TCP socket's RTO estimator state. */
export function rttSecOf(so: TcpSocket): number { return so.srtt / 1e6; }

/** Collect TCP socket summaries across hosts for RTT / retransmission reporting. */
export interface TcpSummary { node: number; sock: number; srttUs: number; retx: number; rtoCount: number; fastRetx: number; txBytes: number; rxBytes: number; cwnd: number }
export function tcpSummaries(st: EngineState): TcpSummary[] {
  const out: TcpSummary[] = [];
  for (const n of Object.values(st.nodes)) {
    if (!isHost(n)) continue;
    const socks: TcpSocket[] = [...Object.values((n as HostState).sockets).filter((s): s is TcpSocket => s.proto === 'tcp'), ...(n as HostState).tcpHistory];
    for (const so of socks) out.push({ node: n.id, sock: so.id, srttUs: so.srtt, retx: so.stats.retx, rtoCount: so.stats.rtoCount, fastRetx: so.stats.fastRetx, txBytes: so.stats.txBytes, rxBytes: so.stats.rxBytes, cwnd: so.cwnd });
  }
  return out;
}

/** Instantaneous total queue occupancy (frames) summed over both directions of every link. */
export function queueOccupancy(st: EngineState): number {
  let n = 0; for (const l of Object.values(st.links)) n += l.ab.queue.length + l.ba.queue.length; return n;
}
