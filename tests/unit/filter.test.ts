import { describe, it, expect } from 'vitest';
import { parseFilter, evalFilter, compileFilter } from '@/filters/filter';
import { encodeEthernet, ETH_P_ARP, ETH_P_IPV4 } from '@/engine/codecs/ethernet';
import { encodeArp, ARP_REQUEST } from '@/engine/codecs/arp';
import { encodeIpv4, IPPROTO_ICMP } from '@/engine/codecs/ipv4';
import { encodeIcmp, ICMP_ECHO } from '@/engine/codecs/icmp';
import { decodeFrame } from '@/engine/codecs/decode';
import { ipToU32 } from '@/shared/bytes';

const icmpFrame = decodeFrame(encodeEthernet({ dst: '02:00:00:02:00:00', src: '02:00:00:01:00:00', ethertype: ETH_P_IPV4, payload: encodeIpv4({ src: ipToU32('10.0.0.1'), dst: ipToU32('10.0.0.2'), proto: IPPROTO_ICMP, ttl: 64, id: 1, df: false, mf: false, fragOffset: 0, payload: encodeIcmp({ type: ICMP_ECHO, code: 0, id: 1, seq: 1, data: new Uint8Array(56) }) }) }));
const arpFrame = decodeFrame(encodeEthernet({ dst: 'ff:ff:ff:ff:ff:ff', src: '02:00:00:01:00:00', ethertype: ETH_P_ARP, payload: encodeArp({ oper: ARP_REQUEST, sha: '02:00:00:01:00:00', spa: ipToU32('10.0.0.1'), tha: '00:00:00:00:00:00', tpa: ipToU32('10.0.0.2') }) }));
const m = (expr: string, d = icmpFrame) => evalFilter(parseFilter(expr), d);

describe('filter language', () => {
  it('protocol presence', () => { expect(m('icmp')).toBe(true); expect(m('arp')).toBe(false); expect(m('arp', arpFrame)).toBe(true); expect(m('eth')).toBe(true); });
  it('comparisons', () => { expect(m('ipv4.ttl == 64')).toBe(true); expect(m('ipv4.ttl > 100')).toBe(false); expect(m('ipv4.ttl <= 64')).toBe(true); expect(m('icmp.type == 8')).toBe(true); expect(m('icmp.type eq 8')).toBe(true); });
  it('addresses and cidr', () => { expect(m('ipv4.dst == 10.0.0.2')).toBe(true); expect(m('ipv4.addr == 10.0.0.1')).toBe(true); expect(m('ipv4.addr == 10.0.0.0/24')).toBe(true); expect(m('ipv4.addr == 192.168.0.0/16')).toBe(false); expect(m('eth.src == 02:00:00:01:00:00')).toBe(true); expect(m('eth.dst == ff:ff:ff:ff:ff:ff', arpFrame)).toBe(true); });
  it('boolean logic', () => { expect(m('icmp and ipv4.ttl == 64')).toBe(true); expect(m('arp or icmp')).toBe(true); expect(m('not arp')).toBe(true); expect(m('!(icmp && ipv4.ttl == 64)')).toBe(false); expect(m('(arp or icmp) and frame.len > 50')).toBe(true); });
  it('in / contains / booleans', () => { expect(m('icmp.type in {0 8}')).toBe(true); expect(m('arp.opcode in {1 2}', arpFrame)).toBe(true); expect(m('eth.fcs_ok == true')).toBe(true); expect(m('ipv4.flags.df == 1')).toBe(false); expect(m('arp.src_ip contains 10.0', arpFrame)).toBe(true); });
  it('empty filter matches everything; bad filter compiles to Error', () => { expect(evalFilter(parseFilter('   '), icmpFrame)).toBe(true); expect(compileFilter('ipv4.ttl ==')).toBeInstanceOf(Error); expect(compileFilter('(icmp')).toBeInstanceOf(Error); });
});
