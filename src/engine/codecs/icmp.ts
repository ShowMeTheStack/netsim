import { ByteReader, ByteWriter } from '@/shared/bytes';
import { inetChecksum } from '@/shared/checksum';
import { f, type Layer } from './types';
import { u32ToIp } from '@/shared/bytes';

export const ICMP_ECHO_REPLY = 0, ICMP_DEST_UNREACH = 3, ICMP_REDIRECT = 5, ICMP_ECHO = 8, ICMP_TIME_EXCEEDED = 11;
export interface IcmpPacket { type: number; code: number; id?: number; seq?: number; mtu?: number; gateway?: number; data: Uint8Array }

export function icmpTypeName(t: number, c: number): string {
  switch (t) {
    case 0: return 'Echo (ping) reply'; case 8: return 'Echo (ping) request';
    case 3: return 'Destination unreachable (' + (['Net unreachable', 'Host unreachable', 'Protocol unreachable', 'Port unreachable', 'Fragmentation needed', 'Source route failed'][c] ?? `code ${c}`) + ')';
    case 11: return 'Time-to-live exceeded (' + (c === 0 ? 'in transit' : 'fragment reassembly') + ')';
    case 5: return 'Redirect'; default: return `Type ${t} code ${c}`;
  }
}

export function encodeIcmp(p: IcmpPacket, opts: { corruptChecksum?: boolean } = {}): Uint8Array {
  const w = new ByteWriter(8 + p.data.length); w.u8(p.type).u8(p.code).u16(0);
  if (p.type === ICMP_ECHO || p.type === ICMP_ECHO_REPLY) w.u16(p.id ?? 0).u16(p.seq ?? 0);
  else if (p.type === ICMP_DEST_UNREACH && p.code === 4) w.u16(0).u16(p.mtu ?? 0);
  else if (p.type === ICMP_REDIRECT) w.u32(p.gateway ?? 0);
  else w.u32(0);
  w.bytes(p.data); const out = w.toBytes(); let ck = inetChecksum(out); if (opts.corruptChecksum) ck ^= 0x4321; out[2] = ck >> 8; out[3] = ck & 255; return out;
}

export function decodeIcmp(b: Uint8Array, start: number, end: number): { layer: Layer; pkt: IcmpPacket; checksumOk: boolean } {
  const r = new ByteReader(b, start, end); const s = start; const warnings: string[] = [];
  const type = r.u8(), code = r.u8(), ck = r.u16();
  const checksumOk = inetChecksum(b, s, end) === 0; if (!checksumOk) warnings.push('Bad ICMP checksum');
  const fields = [f('type', 'Type', type, s, s + 1, `${type} (${icmpTypeName(type, code).split(' (')[0]})`), f('code', 'Code', code, s + 1, s + 2), f('checksum', 'Checksum', ck, s + 2, s + 4, `0x${ck.toString(16).padStart(4, '0')} [${checksumOk ? 'correct' : 'incorrect'}]`), f('checksum_ok', 'Checksum status', checksumOk, s + 2, s + 4)];
  const pkt: IcmpPacket = { type, code, data: new Uint8Array(0) };
  if (type === ICMP_ECHO || type === ICMP_ECHO_REPLY) { pkt.id = r.u16(); pkt.seq = r.u16(); fields.push(f('ident', 'Identifier', pkt.id, s + 4, s + 6), f('seq', 'Sequence number', pkt.seq, s + 6, s + 8)); }
  else if (type === ICMP_DEST_UNREACH && code === 4) { r.u16(); pkt.mtu = r.u16(); fields.push(f('mtu', 'MTU of next hop', pkt.mtu, s + 6, s + 8)); }
  else if (type === ICMP_REDIRECT) { pkt.gateway = r.u32(); fields.push(f('gateway', 'Gateway address', pkt.gateway, s + 4, s + 8)); }
  else r.u32();
  pkt.data = r.rest();
  if ((type === ICMP_DEST_UNREACH || type === ICMP_TIME_EXCEEDED || type === ICMP_REDIRECT) && pkt.data.length >= 20) {
    // Embedded original IP header + first 8 bytes of its payload.
    const o = s + 8; const ihl = (pkt.data[0]! & 15) * 4; const proto = pkt.data[9]!; const src = ((pkt.data[12]! << 24) | (pkt.data[13]! << 16) | (pkt.data[14]! << 8) | pkt.data[15]!) >>> 0; const dst = ((pkt.data[16]! << 24) | (pkt.data[17]! << 16) | (pkt.data[18]! << 8) | pkt.data[19]!) >>> 0;
    const inner = [f('orig.src', 'Original source', u32ToIp(src), o + 12, o + 16), f('orig.dst', 'Original destination', u32ToIp(dst), o + 16, o + 20), f('orig.proto', 'Original protocol', proto, o + 9, o + 10), f('orig.ttl', 'Original TTL', pkt.data[8]!, o + 8, o + 9), f('orig.id', 'Original identification', (pkt.data[4]! << 8) | pkt.data[5]!, o + 4, o + 6)];
    if (pkt.data.length >= ihl + 8) { const q = ihl; const a = (pkt.data[q]! << 8) | pkt.data[q + 1]!, b2 = (pkt.data[q + 2]! << 8) | pkt.data[q + 3]!;
      if (proto === 17 || proto === 6) inner.push(f('orig.srcport', 'Original source port', a, o + q, o + q + 2), f('orig.dstport', 'Original destination port', b2, o + q + 2, o + q + 4));
      if (proto === 1) inner.push(f('orig.icmp_type', 'Original ICMP type', pkt.data[q]!, o + q, o + q + 1), f('orig.icmp_id', 'Original ICMP id', (pkt.data[q + 4]! << 8) | pkt.data[q + 5]!, o + q + 4, o + q + 6), f('orig.icmp_seq', 'Original ICMP seq', (pkt.data[q + 6]! << 8) | pkt.data[q + 7]!, o + q + 6, o + q + 8)); }
    fields.push(f('orig', 'Original datagram', `${u32ToIp(src)} → ${u32ToIp(dst)}`, o, end, `IPv4 ${u32ToIp(src)} → ${u32ToIp(dst)} proto ${proto}`, inner));
  } else if (pkt.data.length) fields.push(f('data', 'Data', pkt.data.length, s + 8, end, `${pkt.data.length} bytes`));
  const summary = icmpTypeName(type, code) + (pkt.id !== undefined ? `  id=0x${pkt.id.toString(16).padStart(4, '0')}, seq=${pkt.seq}` : '');
  return { layer: { proto: 'icmp', name: 'Internet Control Message Protocol', start: s, end, summary, warnings, fields }, pkt, checksumOk };
}
