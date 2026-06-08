// UDP sockets: bind, send, receive dispatch, ICMP port unreachable for closed ports.
import { encodeUdp, decodeUdp } from '../codecs/udp';
import { IPPROTO_UDP, type Ipv4Packet } from '../codecs/ipv4';
import { hostSendIp, sendIcmpError } from '../devices/host';
import { ICMP_DEST_UNREACH } from '../codecs/icmp';
import { log } from '../core';
import { procNotify } from '../apps/procs';
import { serviceUdpDispatch } from '../apps/services';
import { ephemeralPort } from './tcp';
import type { EngineState, HostState, UdpSocket } from '../types';

export function udpSocket(h: HostState, owner: number, localPort?: number): UdpSocket | string {
  const port = localPort ?? ephemeralPort(h);
  for (const o of Object.values(h.sockets)) if (o.proto === 'udp' && o.localPort === port) return 'Address already in use';
  const id = h.nextSock++; const s: UdpSocket = { id, proto: 'udp', owner, localIp: null, localPort: port, remoteIp: null, remotePort: null, rx: [], rxBytes: 0, txBytes: 0, err: null };
  h.sockets[id] = s; return s;
}
export function udpSend(st: EngineState, h: HostState, s: UdpSocket, dst: number, dport: number, data: Uint8Array, opts: { ttl?: number; df?: boolean; src?: number; egress?: string } = {}) {
  const src0 = opts.src; const r = hostSendIp(st, h, { dst, proto: IPPROTO_UDP, ttl: opts.ttl ?? 64, df: opts.df ?? false, src: src0, egress: opts.egress, payload: new Uint8Array(0), buildPayload: (src) => encodeUdp({ sport: s.localPort, dport, data }, src0 ?? src, dst) });
  if (r.status === 'ok') { s.txBytes += data.length; h.counters.udpTx++; }
  return r;
}
export function udpInput(st: EngineState, h: HostState, ip: Ipv4Packet, bytes: Uint8Array, start: number, end: number, ipHdrStart: number) {
  let d; try { d = decodeUdp(bytes, start, end, ip.src, ip.dst); } catch { return; }
  if (!d.checksumOk) { h.counters.dropBadChecksum++; log(st, `${h.name}: dropped UDP datagram with bad checksum`); return; }
  h.counters.udpRx++;
  const s = Object.values(h.sockets).find(o => o.proto === 'udp' && o.localPort === d.pkt.dport && (o.localIp === null || o.localIp === ip.dst)) as UdpSocket | undefined;
  if (!s) { sendIcmpError(st, h, bytes, ipHdrStart, end, ICMP_DEST_UNREACH, 3); return; }
  s.rx.push({ src: ip.src, sport: d.pkt.sport, dport: d.pkt.dport, data: d.pkt.data, t: st.time, ttl: ip.ttl }); s.rxBytes += d.pkt.data.length; if (s.rx.length > 512) s.rx.splice(0, s.rx.length - 512);
  if (s.owner < 0) { serviceUdpDispatch(st, h, s.id); return; }
  procNotify(st, h, s.owner, { type: 'udpRx', sock: s.id });
}
