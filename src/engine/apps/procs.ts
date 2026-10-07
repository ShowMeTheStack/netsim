// Process framework: sockets and timers notify the owning process; each kind has a handler.
import type { EngineState, HostState, Proc } from '../types';
import { pingNotify, pingTimer, pingKill } from './ping';
import { trNotify, trTimer, trKill } from './traceroute';
import { iperfNotify, iperfTimer, iperfKill } from './iperf';
import { ncNotify, ncTimer, ncKill } from './nc';
import { serviceProcNotify } from './services';
import { httpNotify, httpTimer, httpKill } from './http';
import { cprogNotify, cprogTimer, cprogKill } from './cprog';
import { isClangProc, clangTimer, clangKill, clangNotify } from './clangrun';

export type ProcEvent =
  | { type: 'udpRx'; sock: number } | { type: 'tcpConnected'; sock: number } | { type: 'tcpAccept'; sock: number; newSock: number }
  | { type: 'tcpReadable'; sock: number } | { type: 'tcpWritable'; sock: number } | { type: 'tcpEof'; sock: number } | { type: 'tcpClosed'; sock: number } | { type: 'tcpFinAcked'; sock: number }
  | { type: 'tcpError'; sock: number; err: string } | { type: 'icmpError'; sock?: number; ident?: number; seq?: number; from: number; icmpType: number; code: number; mtu?: number; dst: number; sport?: number; dport?: number; ttlOrig?: number };

export function procNotify(st: EngineState, h: HostState, pid: number, ev: ProcEvent) {
  if (pid < 0) { serviceProcNotify(st, h, ev); return; }
  const p = h.procs[pid]; if (!p) return;
  switch (p.kind) { case 'ping': pingNotify(st, h, p, ev); break; case 'traceroute': trNotify(st, h, p, ev); break; case 'iperf': iperfNotify(st, h, p, ev); break; case 'nc': ncNotify(st, h, p, ev); break; case 'http': httpNotify(st, h, p, ev); break; case 'cprog': (isClangProc(p) ? clangNotify(st, h, p, ev as { type: string; sock?: number }) : cprogNotify(st, h, p, ev)); break; }
}
export function procTimer(st: EngineState, h: HostState, pid: number, what: string, data: unknown) {
  const p = h.procs[pid]; if (!p) return;
  switch (p.kind) { case 'ping': pingTimer(st, h, p, what, data); break; case 'traceroute': trTimer(st, h, p, what, data); break; case 'iperf': iperfTimer(st, h, p, what, data); break; case 'nc': ncTimer(st, h, p, what, data); break; case 'http': httpTimer(); break; case 'cprog': (isClangProc(p) ? clangTimer(st, h, p, what) : cprogTimer(st, h, p, what, data)); break; }
}
export function killProc(st: EngineState, h: HostState, p: Proc) {
  switch (p.kind) { case 'ping': pingKill(st, h, p); break; case 'traceroute': trKill(st, h, p); break; case 'iperf': iperfKill(st, h, p); break; case 'nc': ncKill(st, h, p); break; case 'http': httpKill(st, h, p); break; case 'cprog': (isClangProc(p) ? clangKill(st, h, p) : cprogKill(st, h, p)); break; }
}
/** Deliver an ICMP error to whichever process/socket it concerns. */
export function deliverIcmpError(st: EngineState, h: HostState, ev: Extract<ProcEvent, { type: 'icmpError' }>, innerProto: number) {
  if (innerProto === 1 && ev.ident !== undefined) { for (const p of Object.values(h.procs)) if ((p.kind === 'ping' || p.kind === 'traceroute') && p.ident === ev.ident) procNotify(st, h, p.pid, ev); return; }
  if (innerProto === 17 && ev.sport !== undefined) { for (const s of Object.values(h.sockets)) if (s.proto === 'udp' && s.localPort === ev.sport) { s.err = `${ev.icmpType}/${ev.code}`; procNotify(st, h, s.owner, { ...ev, sock: s.id }); } }
}
