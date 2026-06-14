// traceroute: UDP probes (default) to increasing TTLs, or ICMP echo with -I.
import { u32ToIp } from '@/shared/bytes';
import { encodeIcmp, ICMP_ECHO } from '../codecs/icmp';
import { IPPROTO_ICMP } from '../codecs/ipv4';
import { hostSendIp, term } from '../devices/host';
import { udpSocket, udpSend } from '../stack/udp';
import { timer, SEC } from '../core';
import type { ProcEvent } from './procs';
import type { EngineState, HostState, TracerouteProc } from '../types';

export function startTraceroute(st: EngineState, h: HostState, target: number, opts: { maxHops?: number; probes?: number; icmp?: boolean; timeout?: number } = {}): TracerouteProc | string {
  const pid = h.nextPid++;
  const p: TracerouteProc = { kind: 'traceroute', pid, target, targetStr: u32ToIp(target), maxHops: opts.maxHops ?? 30, probes: opts.probes ?? 3, ttl: 1, probe: 0, sock: -1, basePort: 33434, sent: {}, hopResults: [], done: false, timeout: opts.timeout ?? 1 * SEC, icmpMode: !!opts.icmp, ident: pid & 0xffff, reached: false, waiting: false };
  if (!p.icmpMode) { const s = udpSocket(h, pid); if (typeof s === 'string') return s; p.sock = s.id; }
  h.procs[pid] = p;
  term(h, `traceroute to ${p.targetStr} (${p.targetStr}), ${p.maxHops} hops max, ${p.icmpMode ? '64' : '60'} byte packets`);
  sendProbe(st, h, p); return p;
}
function seqOf(p: TracerouteProc) { return (p.ttl - 1) * p.probes + p.probe; }
function sendProbe(st: EngineState, h: HostState, p: TracerouteProc) {
  if (p.done) return; p.probe++; const seq = seqOf(p);
  if (p.probe === 1) p.hopResults.push({ ttl: p.ttl, from: null, rtts: [] });
  let r;
  if (p.icmpMode) r = hostSendIp(st, h, { dst: p.target, proto: IPPROTO_ICMP, ttl: p.ttl, payload: encodeIcmp({ type: ICMP_ECHO, code: 0, id: p.ident, seq, data: new Uint8Array(36) }) });
  else { const s = h.sockets[p.sock]; if (!s || s.proto !== 'udp') return finish(st, h, p); r = udpSend(st, h, s, p.target, p.basePort + seq, new Uint8Array(32), { ttl: p.ttl }); }
  if (r.status !== 'ok') { term(h, `traceroute: ${r.status === 'noroute' ? 'Network is unreachable' : 'send failed'}`); return finish(st, h, p); }
  p.sent[seq] = { t: st.time, ttl: p.ttl }; p.waiting = true;
  timer(st, h.id, p.timeout, `proc:${p.pid}:timeout`, seq);
}
function record(st: EngineState, h: HostState, p: TracerouteProc, seq: number, from: number | null, reached: boolean) {
  const s = p.sent[seq]; if (!s) return; delete p.sent[seq]; p.waiting = false;
  const hop = p.hopResults[p.hopResults.length - 1]!; hop.rtts.push(from === null ? null : (st.time - s.t) / 1000); if (from !== null) hop.from = from;
  if (reached) p.reached = true;
  if (p.probe >= p.probes) { printHop(h, hop); if (p.reached || p.ttl >= p.maxHops) return finish(st, h, p); p.ttl++; p.probe = 0; }
  sendProbe(st, h, p);
}
function printHop(h: HostState, hop: { ttl: number; from: number | null; rtts: (number | null)[] }) {
  term(h, `${String(hop.ttl).padStart(2)}  ${hop.from === null ? '*' : u32ToIp(hop.from).padEnd(15)}  ${hop.rtts.map(r => r === null ? '*' : `${r.toFixed(3)} ms`).join('  ')}`);
}
export function trNotify(st: EngineState, h: HostState, p: TracerouteProc, ev: ProcEvent) {
  if (ev.type !== 'icmpError') return;
  let seq: number | undefined;
  if (p.icmpMode) seq = ev.seq; else if (ev.dport !== undefined) seq = ev.dport - p.basePort;
  if (seq === undefined || !p.sent[seq]) return;
  const reached = ev.icmpType === 3; // port unreachable (or any unreachable) from the destination ends the trace
  record(st, h, p, seq, ev.from, reached && ev.from === p.target);
  if (reached && ev.from !== p.target && ev.code !== 3) { term(h, `  !${['N', 'H', 'P', 'P', 'F'][ev.code] ?? ev.code}`); }
}
export function trEchoReply(st: EngineState, h: HostState, p: TracerouteProc, seq: number, from: number) { if (p.sent[seq]) record(st, h, p, seq, from, true); }
export function trTimer(st: EngineState, h: HostState, p: TracerouteProc, what: string, data: unknown) { if (what === 'timeout') { const seq = data as number; if (p.sent[seq]) record(st, h, p, seq, null, false); } }
function finish(st: EngineState, h: HostState, p: TracerouteProc) { void st; if (p.done) return; p.done = true; if (p.sock >= 0) delete h.sockets[p.sock]; delete h.procs[p.pid]; }
export function trKill(st: EngineState, h: HostState, p: TracerouteProc) { finish(st, h, p); }
