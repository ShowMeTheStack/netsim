import { ByteReader, ByteWriter } from '@/shared/bytes';
import { inetChecksum, pseudoHeader } from '@/shared/checksum';
import { f, type Layer } from './types';

export interface UdpPacket { sport: number; dport: number; data: Uint8Array }
export function encodeUdp(p: UdpPacket, srcIp: number, dstIp: number, opts: { corruptChecksum?: boolean } = {}): Uint8Array {
  const len = 8 + p.data.length; const out = new ByteWriter(len).u16(p.sport).u16(p.dport).u16(len).u16(0).bytes(p.data).toBytes();
  let ck = inetChecksum(out, 0, len, pseudoHeader(srcIp, dstIp, 17, len)); if (ck === 0) ck = 0xffff; if (opts.corruptChecksum) ck ^= 0x5555;
  out[6] = ck >> 8; out[7] = ck & 255; return out;
}
export function decodeUdp(b: Uint8Array, start: number, end: number, srcIp: number, dstIp: number): { layer: Layer; pkt: UdpPacket; checksumOk: boolean; payloadStart: number; payloadEnd: number } {
  const r = new ByteReader(b, start, end); const s = start; const warnings: string[] = [];
  const sport = r.u16(), dport = r.u16(), len = r.u16(), ck = r.u16();
  const payloadEnd = Math.min(end, s + len); if (s + len > end) warnings.push('UDP length exceeds packet');
  const checksumOk = ck === 0 || inetChecksum(b, s, payloadEnd, pseudoHeader(srcIp, dstIp, 17, payloadEnd - s)) === 0; if (!checksumOk) warnings.push('Bad UDP checksum');
  const pkt = { sport, dport, data: b.slice(s + 8, payloadEnd) };
  const layer: Layer = { proto: 'udp', name: 'User Datagram Protocol', start: s, end: s + 8, summary: `Src Port: ${sport}, Dst Port: ${dport}, Len: ${len - 8}`, warnings, fields: [
    f('srcport', 'Source Port', sport, s, s + 2), f('dstport', 'Destination Port', dport, s + 2, s + 4), f('port', 'Port (either)', `${sport},${dport}`, s, s + 4), f('length', 'Length', len, s + 4, s + 6),
    f('checksum', 'Checksum', ck, s + 6, s + 8, `0x${ck.toString(16).padStart(4, '0')} [${ck === 0 ? 'not present' : checksumOk ? 'correct' : 'incorrect'}]`), f('checksum_ok', 'Checksum status', checksumOk, s + 6, s + 8), f('len', 'Payload length', payloadEnd - s - 8, s + 8, payloadEnd) ] };
  return { layer, pkt, checksumOk, payloadStart: s + 8, payloadEnd };
}
