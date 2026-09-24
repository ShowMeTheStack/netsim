import { describe, it, expect } from 'vitest';
import { crc32, inetChecksum } from '@/shared/checksum';
import { fromHex, hex, ipToU32, u32ToIp, prefixToMask, maskToPrefix } from '@/shared/bytes';
import { encodeEthernet, decodeEthernet, ETH_P_ARP, ETH_P_IPV4 } from '@/engine/codecs/ethernet';
import { encodeArp, decodeArp, ARP_REQUEST } from '@/engine/codecs/arp';
import { encodeIpv4, decodeIpv4, IPPROTO_ICMP } from '@/engine/codecs/ipv4';
import { encodeIcmp, decodeIcmp, ICMP_ECHO } from '@/engine/codecs/icmp';
import { decodeFrame, fieldValue } from '@/engine/codecs/decode';

describe('checksums', () => {
  it('crc32 of "123456789" is 0xCBF43926', () => { expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926); });
  it('inet checksum matches RFC 1071 example', () => {
    // Classic example: 0x0001 0xf203 0xf4f5 0xf6f7 -> checksum 0x220d
    expect(inetChecksum(fromHex('0001f203f4f5f6f7'))).toBe(0x220d);
  });
  it('IPv4 header checksum from a known packet verifies to zero', () => {
    // Known-good header (Wikipedia example): 4500 0073 0000 4000 4011 b861 c0a8 0001 c0a8 00c7
    const h = fromHex('450000730000400040 11b861c0a80001c0a800c7');
    expect(inetChecksum(h)).toBe(0);
  });
});

describe('address helpers', () => {
  it('round-trips ipv4', () => { expect(u32ToIp(ipToU32('192.168.1.200'))).toBe('192.168.1.200'); expect(ipToU32('255.255.255.255')).toBe(0xffffffff); });
  it('prefix<->mask', () => { expect(prefixToMask(24)).toBe(0xffffff00); expect(maskToPrefix(0xffffff00)).toBe(24); expect(prefixToMask(0)).toBe(0); expect(maskToPrefix(0xffffffff)).toBe(32); });
});

describe('ethernet', () => {
  it('pads to 64 bytes and produces a valid FCS', () => {
    const fr = encodeEthernet({ dst: 'ff:ff:ff:ff:ff:ff', src: '02:00:00:01:00:00', ethertype: ETH_P_ARP, payload: new Uint8Array(28) });
    expect(fr.length).toBe(64);
    const d = decodeEthernet(fr); expect(d.fcsOk).toBe(true); expect(d.ethertype).toBe(ETH_P_ARP); expect(d.dst).toBe('ff:ff:ff:ff:ff:ff'); expect(d.payloadEnd).toBe(60);
  });
  it('detects a corrupted FCS', () => {
    const fr = encodeEthernet({ dst: 'ff:ff:ff:ff:ff:ff', src: '02:00:00:01:00:00', ethertype: ETH_P_ARP, payload: new Uint8Array(28) }, { corruptFcs: true });
    expect(decodeEthernet(fr).fcsOk).toBe(false);
  });
  it('encodes and decodes an 802.1Q tag', () => {
    const fr = encodeEthernet({ dst: '02:00:00:02:00:00', src: '02:00:00:01:00:00', ethertype: ETH_P_IPV4, vlan: { vid: 42, pcp: 3 }, payload: new Uint8Array(50) });
    const d = decodeEthernet(fr); expect(d.vid).toBe(42); expect(d.ethertype).toBe(ETH_P_IPV4); expect(d.payloadStart).toBe(18); expect(d.fcsOk).toBe(true);
  });
});

describe('arp', () => {
  it('round-trips', () => {
    const p = { oper: ARP_REQUEST, sha: '02:00:00:01:00:00', spa: ipToU32('10.0.0.1'), tha: '00:00:00:00:00:00', tpa: ipToU32('10.0.0.2') };
    const b = encodeArp(p); expect(b.length).toBe(28);
    const d = decodeArp(b, 0, b.length); expect(d.pkt).toEqual(p); expect(d.layer.summary).toBe('Who has 10.0.0.2? Tell 10.0.0.1');
  });
});

describe('ipv4 + icmp', () => {
  it('round-trips with valid checksums', () => {
    const icmp = encodeIcmp({ type: ICMP_ECHO, code: 0, id: 0x1234, seq: 7, data: new Uint8Array([1, 2, 3, 4]) });
    const ip = encodeIpv4({ src: ipToU32('10.0.0.1'), dst: ipToU32('10.0.0.2'), proto: IPPROTO_ICMP, ttl: 64, id: 99, df: true, mf: false, fragOffset: 0, payload: icmp });
    const d = decodeIpv4(ip, 0, ip.length); expect(d.checksumOk).toBe(true); expect(d.pkt.df).toBe(true); expect(d.pkt.ttl).toBe(64); expect(d.pkt.id).toBe(99); expect(u32ToIp(d.pkt.dst)).toBe('10.0.0.2');
    const ic = decodeIcmp(ip, d.payloadStart, d.payloadEnd); expect(ic.checksumOk).toBe(true); expect(ic.pkt.id).toBe(0x1234); expect(ic.pkt.seq).toBe(7); expect(hex(ic.pkt.data)).toBe('01020304');
  });
  it('flags bad checksums', () => {
    const icmp = encodeIcmp({ type: ICMP_ECHO, code: 0, id: 1, seq: 1, data: new Uint8Array(8) }, { corruptChecksum: true });
    const ip = encodeIpv4({ src: 1, dst: 2, proto: IPPROTO_ICMP, ttl: 1, id: 1, df: false, mf: false, fragOffset: 0, payload: icmp }, { corruptChecksum: true });
    const d = decodeIpv4(ip, 0, ip.length); expect(d.checksumOk).toBe(false);
    expect(decodeIcmp(ip, d.payloadStart, d.payloadEnd).checksumOk).toBe(false);
  });
});

describe('decodeFrame + fieldValue', () => {
  it('builds a full layer tree for ICMP echo and resolves filter keys', () => {
    const icmp = encodeIcmp({ type: ICMP_ECHO, code: 0, id: 5, seq: 2, data: new Uint8Array(56) });
    const ip = encodeIpv4({ src: ipToU32('10.0.0.1'), dst: ipToU32('10.0.0.2'), proto: IPPROTO_ICMP, ttl: 64, id: 1, df: false, mf: false, fragOffset: 0, payload: icmp });
    const fr = encodeEthernet({ dst: '02:00:00:02:00:00', src: '02:00:00:01:00:00', ethertype: ETH_P_IPV4, payload: ip });
    const d = decodeFrame(fr);
    expect(d.layers.map(l => l.proto)).toEqual(['eth', 'ipv4', 'icmp']);
    expect(d.proto).toBe('ICMP'); expect(d.src).toBe('10.0.0.1'); expect(d.dst).toBe('10.0.0.2'); expect(d.warnings).toEqual([]);
    expect(fieldValue(d, 'ipv4.ttl')).toBe(64); expect(fieldValue(d, 'icmp.type')).toBe(8); expect(fieldValue(d, 'eth.src')).toBe('02:00:00:01:00:00'); expect(fieldValue(d, 'icmp')).toBe(true); expect(fieldValue(d, 'arp')).toBeUndefined(); expect(fieldValue(d, 'frame.len')).toBe(fr.length);
    // every field's byte range lies within its layer and the frame
    for (const l of d.layers) for (const f of l.fields) { expect(f.start).toBeGreaterThanOrEqual(0); expect(f.end).toBeLessThanOrEqual(fr.length); }
  });
  it('never throws on garbage', () => { const d = decodeFrame(new Uint8Array(5)); expect(d.layers[0]!.proto).toBe('malformed'); });
});
