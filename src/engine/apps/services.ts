// Routes UDP delivered to service sockets (owner < 0) to DHCP / DNS handlers.
import type { EngineState, HostState } from '../types';
import { isDhcpSock, dhcpUdpDispatch, dhcpTimer } from './dhcp';
import { isDnsSock, dnsServerRx, dnsTimer } from './dns';
import { isRipSock, ripUdpDispatch, ripTimer } from '../routing/rip';
import { ospfTimer } from '../routing/ospf';
import { bgpTimer, bgpNotify, isBgpSock } from '../routing/bgp';
import type { ProcEvent } from './procs';

export function serviceUdpDispatch(st: EngineState, h: HostState, sockId: number) {
  if (isDhcpSock(h, sockId)) { dhcpUdpDispatch(st, h, sockId); return; }
  if (isDnsSock(h, sockId)) { dnsServerRx(st, h); return; }
  if (isRipSock(h, sockId)) { ripUdpDispatch(st, h, sockId); return; }
}
export function serviceProcNotify(st: EngineState, h: HostState, ev: ProcEvent) {
  const sock = 'sock' in ev ? (ev as { sock: number }).sock : undefined; const newSock = 'newSock' in ev ? (ev as { newSock: number }).newSock : undefined;
  if (sock !== undefined && (isBgpSock(h, sock) || (newSock !== undefined && isBgpSock(h, newSock)))) bgpNotify(st, h, ev as { type: string; sock: number; newSock?: number; err?: string });
}
export function serviceTimer(st: EngineState, h: HostState, tag: string, data: unknown) {
  const [, a, b] = tag.split(':'); void data;
  if (tag.startsWith('dhcp:')) { dhcpTimer(st, h, Number(a), b!); return true; }
  if (tag.startsWith('dns:')) { dnsTimer(st, h, Number(a)); return true; }
  if (tag.startsWith('rip:')) { ripTimer(st, h, Number(a), b!); return true; }
  if (tag.startsWith('ospf:')) { ospfTimer(st, h, Number(a), b!); return true; }
  if (tag.startsWith('bgp:')) { bgpTimer(st, h, Number(a), tag.split(':').slice(2).join(':')); return true; }
  return false;
}
