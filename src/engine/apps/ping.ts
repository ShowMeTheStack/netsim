import { u32ToIp } from '@/shared/bytes';
import { encodeIcmp, ICMP_ECHO, icmpTypeName } from '../codecs/icmp';
import { IPPROTO_ICMP } from '../codecs/ipv4';
import { hostSendIp, term } from '../devices/host';
import { timer, SEC } from '../core';
import type { ProcEvent } from './procs';
import type { EngineState, HostState, PingProc } from '../types';

export function startPing(st: EngineState, h: HostState, target: number, opts: { count?: number; interval?: number; size?: number; ttl?: number; timeout?: number; df?: boolean } = {}): PingProc {
  const pid = h.nextPid++;
  const p: PingProc = { kind: 'ping', pid, target, targetStr: u32ToIp(target), count: opts.count ?? 4, sent: 0, received: 0, interval: opts.interval ?? 1 * SEC, timeout: opts.timeout ?? 3.5 * SEC, outstanding: {}, rtts: [], done: false, ident: pid & 0xffff, size: opts.size ?? 56, ttl: opts.ttl ?? 64, df: opts.df ?? false, errors: 0 };
  h.procs[pid] = p;
  term(h, `PING ${p.targetStr} (${p.targetStr}) ${p.size}(${p.size + 28}) bytes of data.`);
  pingSend(st, h, p); return p;
}
function pingSend(st: EngineState, h: HostState, p: PingProc) {
  if (p.done) return;
  const seq = ++p.sent; const data = new Uint8Array(p.size); for (let i = 0; i < data.length; i++) data[i] = (i + 8) & 0xff;
  const r = hostSendIp(st, h, { dst: p.target, proto: IPPROTO_ICMP, ttl: p.ttl, df: p.df, payload: encodeIcmp({ type: ICMP_ECHO, code: 0, id: p.ident, seq, data }) });
  if (r.status === 'noroute') term(h, `ping: connect: Network is unreachable`);
  else if (r.status === 'fragneeded') { term(h, `ping: local error: message too long, mtu=${r.mtu}`); p.errors++; }
  else { h.counters.icmpTx++; p.outstanding[seq] = st.time; timer(st, h.id, p.timeout, `proc:${p.pid}:timeout`, seq); }
  if (p.sent < p.count) timer(st, h.id, p.interval, `proc:${p.pid}:send`); else timer(st, h.id, p.timeout + 1, `proc:${p.pid}:finish`);
}
export function pingReply(st: EngineState, h: HostState, p: PingProc, seq: number, ttl: number, len: number, from: number) {
  const sent = p.outstanding[seq]; if (sent === undefined) return; delete p.outstanding[seq];
  const rtt = (st.time - sent) / 1000; p.rtts.push(rtt); p.received++;
  term(h, `${len} bytes from ${u32ToIp(from)}: icmp_seq=${seq} ttl=${ttl} time=${rtt.toFixed(3)} ms`);
}
export function pingNotify(st: EngineState, h: HostState, p: PingProc, ev: ProcEvent) {
  if (ev.type !== 'icmpError') return; const seq = ev.seq ?? 0; if (p.outstanding[seq] === undefined) return; delete p.outstanding[seq]; p.errors++;
  const what = ev.icmpType === 11 ? 'Time to live exceeded' : ev.icmpType === 3 && ev.code === 4 ? `Frag needed and DF set (mtu = ${ev.mtu})` : ev.icmpType === 3 ? ['Destination Net Unreachable', 'Destination Host Unreachable', 'Destination Protocol Unreachable', 'Destination Port Unreachable'][ev.code] ?? icmpTypeName(ev.icmpType, ev.code) : icmpTypeName(ev.icmpType, ev.code);
  term(h, `From ${u32ToIp(ev.from)} icmp_seq=${seq} ${what}`); void st;
}
export function pingTimer(st: EngineState, h: HostState, p: PingProc, what: string, data: unknown) {
  if (what === 'send') pingSend(st, h, p);
  else if (what === 'timeout') { const seq = data as number; if (p.outstanding[seq] !== undefined) { delete p.outstanding[seq]; term(h, `Request timeout for icmp_seq ${seq}`); } }
  else if (what === 'finish') pingFinish(st, h, p);
}
export function pingArpFailed(h: HostState, p: PingProc, fromIp: number) { for (const k of Object.keys(p.outstanding).map(Number).sort((a, b) => a - b)) { delete p.outstanding[k]; p.errors++; term(h, `From ${u32ToIp(fromIp)} icmp_seq=${k} Destination Host Unreachable`); } }
function pingFinish(st: EngineState, h: HostState, p: PingProc) {
  if (p.done) return; p.done = true; void st;
  const loss = p.sent ? Math.round(((p.sent - p.received) / p.sent) * 100) : 0;
  term(h, ``); term(h, `--- ${p.targetStr} ping statistics ---`);
  term(h, `${p.sent} packets transmitted, ${p.received} received, ${p.errors ? `+${p.errors} errors, ` : ''}${loss}% packet loss`);
  if (p.rtts.length) { const min = Math.min(...p.rtts), max = Math.max(...p.rtts), avg = p.rtts.reduce((a, b) => a + b, 0) / p.rtts.length; term(h, `rtt min/avg/max = ${min.toFixed(3)}/${avg.toFixed(3)}/${max.toFixed(3)} ms`); }
  delete h.procs[p.pid];
}
export function pingKill(st: EngineState, h: HostState, p: PingProc) { pingFinish(st, h, p); }
