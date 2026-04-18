import { ByteReader, ByteWriter, bytesToMac, macToBytes, type Mac } from '@/shared/bytes';
import { crc32 } from '@/shared/checksum';
import { f, type Layer } from './types';

export const ETH_P_IPV4 = 0x0800;
export const ETH_P_ARP = 0x0806;
export const ETH_P_RARP = 0x8035;
export const ETH_P_VLAN = 0x8100;
export const ETH_MIN_FRAME = 64; // including FCS
export const ETH_HDR = 14, ETH_FCS = 4;

export interface EthFrame { dst: Mac; src: Mac; ethertype: number; vlan?: { pcp?: number; vid: number }; payload: Uint8Array }

export function etherTypeName(t: number): string {
  switch (t) { case ETH_P_IPV4: return 'IPv4'; case ETH_P_ARP: return 'ARP'; case ETH_P_RARP: return 'RARP'; case ETH_P_VLAN: return '802.1Q'; default: return '0x' + t.toString(16).padStart(4, '0'); }
}

/** Encode an Ethernet II frame with optional 802.1Q tag, padding and a real FCS. */
export function encodeEthernet(fr: EthFrame, opts: { corruptFcs?: boolean } = {}): Uint8Array {
  const w = new ByteWriter(fr.payload.length + 22);
  w.bytes(macToBytes(fr.dst)).bytes(macToBytes(fr.src));
  if (fr.vlan) { w.u16(ETH_P_VLAN); w.u16((((fr.vlan.pcp ?? 0) & 7) << 13) | (fr.vlan.vid & 0xfff)); }
  w.u16(fr.ethertype).bytes(fr.payload);
  while (w.length < ETH_MIN_FRAME - ETH_FCS) w.u8(0);
  const body = w.toBytes();
  let fcs = crc32(body);
  if (opts.corruptFcs) fcs = (fcs ^ 0xdeadbeef) >>> 0;
  // FCS is transmitted little-endian on the wire.
  const out = new Uint8Array(body.length + 4); out.set(body);
  out[body.length] = fcs & 255; out[body.length + 1] = (fcs >>> 8) & 255; out[body.length + 2] = (fcs >>> 16) & 255; out[body.length + 3] = (fcs >>> 24) & 255;
  return out;
}

export interface EthDecoded { layer: Layer; vlanLayer?: Layer; ethertype: number; payloadStart: number; payloadEnd: number; dst: Mac; src: Mac; vid?: number; fcsOk: boolean }

export function decodeEthernet(b: Uint8Array): EthDecoded {
  const r = new ByteReader(b);
  const dst = bytesToMac(r.bytes(6)); const src = bytesToMac(r.bytes(6));
  let ethertype = r.u16(); const warnings: string[] = [];
  const fields = [f('dst', 'Destination', dst, 0, 6), f('src', 'Source', src, 6, 12)];
  let vlanLayer: Layer | undefined; let vid: number | undefined; let hdrEnd = 14;
  if (ethertype === ETH_P_VLAN) {
    const tci = r.u16(); vid = tci & 0xfff; const pcp = tci >> 13; const inner = r.u16();
    vlanLayer = { proto: 'vlan', name: '802.1Q Virtual LAN', start: 12, end: 18, summary: `VLAN ${vid}, PCP ${pcp}`, warnings: [], fields: [
      f('tpid', 'TPID', ETH_P_VLAN, 12, 14, '0x8100'), f('pcp', 'Priority', pcp, 14, 16), f('vid', 'VLAN ID', vid, 14, 16), f('type', 'Type', inner, 16, 18, etherTypeName(inner)) ] };
    fields.push(f('type', 'Type', ETH_P_VLAN, 12, 14, etherTypeName(ETH_P_VLAN)));
    ethertype = inner; hdrEnd = 18;
  } else fields.push(f('type', 'Type', ethertype, 12, 14, etherTypeName(ethertype)));
  const fcsStart = b.length - 4;
  const fcsWire = (b[fcsStart]! | (b[fcsStart + 1]! << 8) | (b[fcsStart + 2]! << 16) | (b[fcsStart + 3]! << 24)) >>> 0;
  const fcsCalc = crc32(b, 0, fcsStart);
  const fcsOk = fcsWire === fcsCalc;
  fields.push(f('fcs', 'Frame check sequence', '0x' + fcsWire.toString(16).padStart(8, '0'), fcsStart, b.length, fcsOk ? `0x${fcsWire.toString(16).padStart(8, '0')} [correct]` : `0x${fcsWire.toString(16).padStart(8, '0')} [incorrect, should be 0x${fcsCalc.toString(16).padStart(8, '0')}]`));
  fields.push(f('fcs_ok', 'FCS status', fcsOk, fcsStart, b.length, fcsOk ? 'Good' : 'Bad'));
  if (!fcsOk) warnings.push('Bad Ethernet FCS');
  const layer: Layer = { proto: 'eth', name: 'Ethernet II', start: 0, end: hdrEnd, summary: `Src: ${src}, Dst: ${dst}`, fields, warnings };
  return { layer, vlanLayer, ethertype, payloadStart: hdrEnd, payloadEnd: fcsStart, dst, src, vid, fcsOk };
}
