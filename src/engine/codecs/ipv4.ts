import { ByteReader, ByteWriter, u32ToIp } from '@/shared/bytes';
import { inetChecksum } from '@/shared/checksum';
import { f, type Layer } from './types';

export const IPPROTO_ICMP = 1, IPPROTO_TCP = 6, IPPROTO_UDP = 17, IPPROTO_OSPF = 89;
export interface Ipv4Packet {
  src: number; dst: number; proto: number; ttl: number; id: number;
  df: boolean; mf: boolean; fragOffset: number; // in 8-byte units
  dscp?: number; ecn?: number; payload: Uint8Array;
}
export function ipProtoName(p: number) { switch (p) { case 1: return 'ICMP'; case 6: return 'TCP'; case 17: return 'UDP'; case 89: return 'OSPF'; default: return `proto ${p}`; } }

export function encodeIpv4(p: Ipv4Packet, opts: { corruptChecksum?: boolean } = {}): Uint8Array {
  const total = 20 + p.payload.length;
  const w = new ByteWriter(total);
  w.u8(0x45).u8((((p.dscp ?? 0) & 63) << 2) | ((p.ecn ?? 0) & 3)).u16(total).u16(p.id & 0xffff);
  w.u16(((p.df ? 2 : 0) | (p.mf ? 1 : 0)) << 13 | (p.fragOffset & 0x1fff));
  w.u8(p.ttl & 255).u8(p.proto & 255).u16(0).u32(p.src).u32(p.dst);
  const hdr = w.toBytes(); let ck = inetChecksum(hdr, 0, 20); if (opts.corruptChecksum) ck ^= 0x1234;
  hdr[10] = ck >> 8; hdr[11] = ck & 255;
  const out = new Uint8Array(total); out.set(hdr); out.set(p.payload, 20); return out;
}

export interface Ipv4Decoded { layer: Layer; pkt: Ipv4Packet; payloadStart: number; payloadEnd: number; checksumOk: boolean; ihl: number; totalLength: number }

export function decodeIpv4(b: Uint8Array, start: number, end: number): Ipv4Decoded {
  const r = new ByteReader(b, start, end); const s = start; const warnings: string[] = [];
  const vihl = r.u8(); const version = vihl >> 4; const ihl = (vihl & 15) * 4;
  const tos = r.u8(); const total = r.u16(); const id = r.u16(); const flagsFrag = r.u16(); const ttl = r.u8(); const proto = r.u8(); const ck = r.u16(); const src = r.u32(); const dst = r.u32();
  if (version !== 4) warnings.push(`IP version ${version}, expected 4`);
  const df = !!(flagsFrag & 0x4000), mf = !!(flagsFrag & 0x2000), fragOffset = flagsFrag & 0x1fff;
  const calc = inetChecksum(b, s, s + ihl); const checksumOk = calc === 0;
  if (!checksumOk) warnings.push('Bad IPv4 header checksum');
  const payloadStart = s + ihl; const payloadEnd = Math.min(end, s + total);
  if (s + total > end) warnings.push('IPv4 total length exceeds frame');
  const pkt: Ipv4Packet = { src, dst, proto, ttl, id, df, mf, fragOffset, dscp: tos >> 2, ecn: tos & 3, payload: b.slice(payloadStart, payloadEnd) };
  const fragInfo = (mf || fragOffset) ? ` [Fragment offset ${fragOffset * 8}${mf ? ', more' : ', last'}]` : '';
  const layer: Layer = { proto: 'ipv4', name: 'Internet Protocol Version 4', start: s, end: payloadStart, summary: `Src: ${u32ToIp(src)}, Dst: ${u32ToIp(dst)}${fragInfo}`, warnings, fields: [
    f('version', 'Version', version, s, s + 1), f('hdr_len', 'Header Length', ihl, s, s + 1, `${ihl} bytes (${ihl / 4})`),
    f('dsfield', 'Differentiated Services', tos, s + 1, s + 2, `DSCP ${tos >> 2}, ECN ${tos & 3}`),
    f('len', 'Total Length', total, s + 2, s + 4), f('id', 'Identification', id, s + 4, s + 6, `0x${id.toString(16).padStart(4, '0')} (${id})`),
    f('flags', 'Flags', flagsFrag >> 13, s + 6, s + 8, `${df ? 'DF' : ''}${df && mf ? ',' : ''}${mf ? 'MF' : ''}` || 'none', [
      f('flags.df', "Don't fragment", df, s + 6, s + 7), f('flags.mf', 'More fragments', mf, s + 6, s + 7) ]),
    f('frag_offset', 'Fragment Offset', fragOffset * 8, s + 6, s + 8),
    f('ttl', 'Time to Live', ttl, s + 8, s + 9), f('proto', 'Protocol', proto, s + 9, s + 10, `${ipProtoName(proto)} (${proto})`),
    f('checksum', 'Header Checksum', ck, s + 10, s + 12, `0x${ck.toString(16).padStart(4, '0')} [${checksumOk ? 'correct' : 'incorrect'}]`),
    f('checksum_ok', 'Checksum status', checksumOk, s + 10, s + 12, checksumOk ? 'Good' : 'Bad'),
    f('src', 'Source Address', u32ToIp(src), s + 12, s + 16), f('dst', 'Destination Address', u32ToIp(dst), s + 16, s + 20) ] };
  return { layer, pkt, payloadStart, payloadEnd, checksumOk, ihl, totalLength: total };
}
