// Source NAT / PAT on a router: rewrite inside source IP:port to the outside interface address
// and a unique port on egress; reverse on ingress. Static port-forwards expose inside servers.
// TCP, UDP and ICMP-echo (id used as the port) are translated, with checksums recomputed.
import { u32ToIp, IP_BROADCAST } from '@/shared/bytes';
import { decodeIpv4, encodeIpv4, IPPROTO_TCP, IPPROTO_UDP, IPPROTO_ICMP, type Ipv4Packet } from '../codecs/ipv4';
import { inetChecksum, pseudoHeader } from '@/shared/checksum';
import { log, SEC } from '../core';
import type { EngineState, HostState } from '../types';

function outsideIp(h: HostState): number | null { const i = h.ifaces.find(x => x.name === h.nat.outsideIface); return i?.ip ?? null; }
function l4ports(bytes: Uint8Array, off: number, proto: number): { sport: number; dport: number } | null {
  if (proto === IPPROTO_TCP || proto === IPPROTO_UDP) return { sport: (bytes[off]! << 8) | bytes[off + 1]!, dport: (bytes[off + 2]! << 8) | bytes[off + 3]! };
  if (proto === IPPROTO_ICMP && (bytes[off] === 8 || bytes[off] === 0)) { const id = (bytes[off + 4]! << 8) | bytes[off + 5]!; return { sport: id, dport: id }; }
  return null;
}
/** Rewrite one L4 identifier and fix checksums in place. Returns a new packet buffer. */
function rewrite(pkt: Ipv4Packet, opts: { newSrc?: number; newDst?: number; newSport?: number; newDport?: number }): Uint8Array {
  const payload = pkt.payload.slice(); const proto = pkt.proto; const src = opts.newSrc ?? pkt.src; const dst = opts.newDst ?? pkt.dst;
  if (proto === IPPROTO_TCP || proto === IPPROTO_UDP) {
    if (opts.newSport !== undefined) { payload[0] = opts.newSport >> 8; payload[1] = opts.newSport & 255; }
    if (opts.newDport !== undefined) { payload[2] = opts.newDport >> 8; payload[3] = opts.newDport & 255; }
    const ckOff = proto === IPPROTO_TCP ? 16 : 6; payload[ckOff] = 0; payload[ckOff + 1] = 0;
    let ck = inetChecksum(payload, 0, payload.length, pseudoHeader(src, dst, proto, payload.length)); if (proto === IPPROTO_UDP && ck === 0) ck = 0xffff; payload[ckOff] = ck >> 8; payload[ckOff + 1] = ck & 255;
  } else if (proto === IPPROTO_ICMP) { if (opts.newSport !== undefined) { payload[4] = opts.newSport >> 8; payload[5] = opts.newSport & 255; } payload[2] = 0; payload[3] = 0; const ck = inetChecksum(payload, 0, payload.length); payload[2] = ck >> 8; payload[3] = ck & 255; }
  return encodeIpv4({ ...pkt, src, dst, payload });
}
/** Called on forward. Returns possibly-rewritten packet bytes, or null to drop. `inbound` = arrived on the outside interface. */
export function natForward(st: EngineState, h: HostState, bytes: Uint8Array, ipStart: number, ipEnd: number, inIface: string, outIface: string): Uint8Array | null {
  const nat = h.nat; if (!nat.enabled) return bytes;
  const oip = outsideIp(h); if (oip === null) return bytes;
  const dec = decodeIpv4(bytes, ipStart, ipEnd); const pkt = dec.pkt; const ports = l4ports(bytes, dec.payloadStart, pkt.proto); if (!ports) return bytes;
  const goingOut = outIface === nat.outsideIface && nat.insideIfaces.includes(inIface);
  const comingIn = inIface === nat.outsideIface;
  if (goingOut) {
    // Return traffic of a port-forwarded connection: keep the well-known outside port as the source.
    const pf = nat.portForwards.find(x => x.proto === pkt.proto && x.insideIp === pkt.src && x.insidePort === ports.sport);
    if (pf) return rewrite({ ...pkt, payload: bytes.subarray(dec.payloadStart, ipEnd) }, { newSrc: oip, newSport: pf.outsidePort });
    let e = nat.table.find(x => x.proto === pkt.proto && x.insideIp === pkt.src && x.insidePort === ports.sport && x.peerIp === pkt.dst);
    if (!e) { e = { proto: pkt.proto, insideIp: pkt.src, insidePort: ports.sport, outsidePort: nat.nextPort++, peerIp: pkt.dst, peerPort: ports.dport, expires: st.time + 120 * SEC }; if (nat.nextPort > 65000) nat.nextPort = 40000; nat.table.push(e); log(st, `${h.name}: NAT ${u32ToIp(pkt.src)}:${ports.sport} → ${u32ToIp(oip)}:${e.outsidePort} (to ${u32ToIp(pkt.dst)})`); }
    e.expires = st.time + 120 * SEC;
    return rewrite({ ...pkt, payload: bytes.subarray(dec.payloadStart, ipEnd) }, { newSrc: oip, newSport: e.outsidePort });
  }
  if (comingIn && (pkt.dst === oip)) {
    // static port forward first
    const pf = nat.portForwards.find(x => x.proto === pkt.proto && x.outsidePort === ports.dport);
    if (pf) return rewrite({ ...pkt, payload: bytes.subarray(dec.payloadStart, ipEnd) }, { newDst: pf.insideIp, newDport: pf.insidePort });
    const e = nat.table.find(x => x.proto === pkt.proto && x.outsidePort === ports.dport && (x.peerIp === pkt.src || pkt.proto === IPPROTO_ICMP));
    if (!e) return null; e.expires = st.time + 120 * SEC;
    if (pkt.proto === IPPROTO_ICMP) return rewrite({ ...pkt, payload: bytes.subarray(dec.payloadStart, ipEnd) }, { newDst: e.insideIp, newSport: e.insidePort });
    return rewrite({ ...pkt, payload: bytes.subarray(dec.payloadStart, ipEnd) }, { newDst: e.insideIp, newDport: e.insidePort });
  }
  return bytes;
}
export function natExpire(h: HostState, now: number) { h.nat.table = h.nat.table.filter(e => e.expires > now); }
void IP_BROADCAST;
