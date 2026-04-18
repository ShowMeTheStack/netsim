import { ByteReader, ByteWriter, bytesToMac, macToBytes, u32ToIp, type Mac } from '@/shared/bytes';
import { f, type Layer } from './types';

export const ARP_REQUEST = 1, ARP_REPLY = 2, RARP_REQUEST = 3, RARP_REPLY = 4;
export interface ArpPacket { oper: number; sha: Mac; spa: number; tha: Mac; tpa: number }

export function encodeArp(p: ArpPacket): Uint8Array {
  return new ByteWriter(28).u16(1).u16(0x0800).u8(6).u8(4).u16(p.oper).bytes(macToBytes(p.sha)).u32(p.spa).bytes(macToBytes(p.tha)).u32(p.tpa).toBytes();
}
export function arpOpName(o: number) { return o === 1 ? 'request' : o === 2 ? 'reply' : o === 3 ? 'RARP request' : o === 4 ? 'RARP reply' : `op ${o}`; }

export function decodeArp(b: Uint8Array, start: number, end: number): { layer: Layer; pkt: ArpPacket } {
  const r = new ByteReader(b, start, end); const s = start;
  const htype = r.u16(), ptype = r.u16(), hlen = r.u8(), plen = r.u8(), oper = r.u16();
  const sha = bytesToMac(r.bytes(6)), spa = r.u32(), tha = bytesToMac(r.bytes(6)), tpa = r.u32();
  const pkt = { oper, sha, spa, tha, tpa };
  const summary = oper === ARP_REQUEST ? `Who has ${u32ToIp(tpa)}? Tell ${u32ToIp(spa)}` : oper === ARP_REPLY ? `${u32ToIp(spa)} is at ${sha}` : oper === RARP_REQUEST ? `Who is ${tha}? Tell ${sha}` : oper === RARP_REPLY ? `${tha} is at ${u32ToIp(tpa)}` : arpOpName(oper);
  const isRarp = oper >= 3;
  const layer: Layer = { proto: isRarp ? 'rarp' : 'arp', name: isRarp ? 'Reverse Address Resolution Protocol' : 'Address Resolution Protocol', start: s, end: s + 28, summary, warnings: [], fields: [
    f('htype', 'Hardware type', htype, s, s + 2, htype === 1 ? 'Ethernet (1)' : String(htype)),
    f('ptype', 'Protocol type', ptype, s + 2, s + 4, ptype === 0x0800 ? 'IPv4 (0x0800)' : '0x' + ptype.toString(16)),
    f('hlen', 'Hardware size', hlen, s + 4, s + 5), f('plen', 'Protocol size', plen, s + 5, s + 6),
    f('opcode', 'Opcode', oper, s + 6, s + 8, `${arpOpName(oper)} (${oper})`),
    f('src_mac', 'Sender MAC address', sha, s + 8, s + 14), f('src_ip', 'Sender IP address', u32ToIp(spa), s + 14, s + 18),
    f('dst_mac', 'Target MAC address', tha, s + 18, s + 24), f('dst_ip', 'Target IP address', u32ToIp(tpa), s + 24, s + 28) ] };
  return { layer, pkt };
}
