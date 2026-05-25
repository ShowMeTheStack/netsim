// Walks a raw frame's bytes and produces the layer tree. Tolerant: never throws.
import { u32ToIp } from '@/shared/bytes';
import { decodeEthernet, ETH_P_ARP, ETH_P_IPV4, ETH_P_RARP } from './ethernet';
import { decodeArp } from './arp';
import { decodeIpv4, IPPROTO_ICMP, ipProtoName } from './ipv4';
import { decodeIcmp } from './icmp';
import { decodeUdp } from './udp';
import { decodeTcp } from './tcp';
import { f, type DecodedFrame, type Layer } from './types';
import { decodeDnsLayer } from './dns';
import { decodeDhcpLayer } from './dhcp';
import { decodeHttpLayer } from '../apps/http';
import { decodeRipLayer } from './rip';
import { decodeOspfLayer } from './ospf';
import { decodeBgpLayer } from './bgp';

type ExtraDecoder = (b: Uint8Array, start: number, end: number, ctx: { ip: { src: number; dst: number; proto: number } }) => Layer[] | undefined;
/** Application-layer decoders keyed by transport port (DNS, HTTP... registered in later phases). */
const appDecoders: { match: (proto: 'udp' | 'tcp', sport: number, dport: number) => boolean; decode: (b: Uint8Array, start: number, end: number, ctx: { proto: 'udp' | 'tcp'; sport: number; dport: number }) => Layer[] | undefined }[] = [];
export function registerAppDecoder(match: (proto: 'udp' | 'tcp', sport: number, dport: number) => boolean, decode: (b: Uint8Array, start: number, end: number, ctx: { proto: 'udp' | 'tcp'; sport: number; dport: number }) => Layer[] | undefined) { appDecoders.push({ match, decode }); }
function appLayers(b: Uint8Array, start: number, end: number, proto: 'udp' | 'tcp', sport: number, dport: number): Layer[] {
  if (end <= start) return [];
  for (const d of appDecoders) if (d.match(proto, sport, dport)) { try { const ls = d.decode(b, start, end, { proto, sport, dport }); if (ls) return ls; } catch { /* fall through to raw data */ } }
  return [{ proto: 'data', name: 'Data', start, end, summary: `${end - start} bytes`, warnings: [], fields: [f('len', 'Length', end - start, start, end)] }];
}
const l4: Record<number, ExtraDecoder> = {
  17: (b, s, e, ctx) => { const u = decodeUdp(b, s, e, ctx.ip.src, ctx.ip.dst); return [u.layer, ...appLayers(b, u.payloadStart, u.payloadEnd, 'udp', u.pkt.sport, u.pkt.dport)]; },
  6: (b, s, e, ctx) => { const t = decodeTcp(b, s, e, ctx.ip.src, ctx.ip.dst); return [t.layer, ...appLayers(b, t.payloadStart, e, 'tcp', t.seg.sport, t.seg.dport)]; },
  89: (b, s, e) => decodeOspfLayer(b, s, e),
};

registerAppDecoder((p, sp, dp) => sp === 53 || dp === 53, (b, s, e, ctx) => decodeDnsLayer(b, s, e, ctx.proto === 'tcp'));
registerAppDecoder((p, sp, dp) => p === 'udp' && (sp === 67 || dp === 67 || sp === 68 || dp === 68), (b, s, e) => decodeDhcpLayer(b, s, e));
registerAppDecoder((p, sp, dp) => p === 'tcp' && (sp === 80 || dp === 80 || sp === 8080 || dp === 8080), (b, s, e) => decodeHttpLayer(b, s, e));
registerAppDecoder((p, sp, dp) => p === 'udp' && (sp === 520 || dp === 520), (b, s, e) => decodeRipLayer(b, s, e));
registerAppDecoder((p, sp, dp) => p === 'tcp' && (sp === 179 || dp === 179), (b, s, e) => decodeBgpLayer(b, s, e));

export function decodeFrame(b: Uint8Array): DecodedFrame {
  const layers: Layer[] = []; const warnings: string[] = [];
  const out: DecodedFrame = { length: b.length, layers, proto: 'ETH', src: '', dst: '', info: '', warnings };
  const push = (l: Layer) => { layers.push(l); warnings.push(...l.warnings); out.proto = l.proto.toUpperCase(); out.info = l.summary; };
  try {
    const e = decodeEthernet(b); push(e.layer); if (e.vlanLayer) push(e.vlanLayer);
    out.src = e.src; out.dst = e.dst;
    if (e.ethertype === ETH_P_ARP || e.ethertype === ETH_P_RARP) { const a = decodeArp(b, e.payloadStart, e.payloadEnd); push(a.layer); }
    else if (e.ethertype === ETH_P_IPV4) {
      const ip = decodeIpv4(b, e.payloadStart, e.payloadEnd); push(ip.layer);
      out.src = u32ToIp(ip.pkt.src); out.dst = u32ToIp(ip.pkt.dst);
      if (ip.pkt.mf || ip.pkt.fragOffset) {
        // Only the first fragment carries the L4 header; show fragment data for the rest.
        if (ip.pkt.fragOffset) { push({ proto: 'data', name: 'Fragmented IP data', start: ip.payloadStart, end: ip.payloadEnd, summary: `Fragment data (${ip.payloadEnd - ip.payloadStart} bytes)`, warnings: [], fields: [] }); out.proto = 'IPv4'; out.info = ip.layer.summary; return out; }
      }
      if (ip.pkt.proto === IPPROTO_ICMP) { const ic = decodeIcmp(b, ip.payloadStart, ip.payloadEnd); push(ic.layer); }
      else if (l4[ip.pkt.proto]) { for (const l of l4[ip.pkt.proto]!(b, ip.payloadStart, ip.payloadEnd, { ip: ip.pkt }) ?? []) { if (l.proto === 'data') layers.push(l); else push(l); } }
      else push({ proto: 'data', name: ipProtoName(ip.pkt.proto), start: ip.payloadStart, end: ip.payloadEnd, summary: `${ipProtoName(ip.pkt.proto)} payload (${ip.payloadEnd - ip.payloadStart} bytes)`, warnings: [], fields: [] });
      if (ip.pkt.mf) out.info += ' [more fragments]';
    } else push({ proto: 'data', name: 'Data', start: e.payloadStart, end: e.payloadEnd, summary: `${e.payloadEnd - e.payloadStart} bytes`, warnings: [], fields: [f('len', 'Length', e.payloadEnd - e.payloadStart, e.payloadStart, e.payloadEnd)] });
  } catch (err) {
    warnings.push(`Malformed: ${(err as Error).message}`);
    layers.push({ proto: 'malformed', name: 'Malformed packet', start: 0, end: b.length, summary: (err as Error).message, warnings: [], fields: [] });
  }
  return out;
}

/** Resolve a filter key like "ipv4.dst" or "frame.len" against a decoded frame. */
export function fieldValue(d: DecodedFrame, key: string): unknown {
  const dot = key.indexOf('.');
  if (dot < 0) return d.layers.some(l => l.proto === key) ? true : undefined; // protocol presence
  const proto = key.slice(0, dot), fkey = key.slice(dot + 1);
  if (proto === 'frame') { if (fkey === 'len') return d.length; if (fkey === 'proto') return d.proto; return undefined; }
  for (const l of d.layers) if (l.proto === proto) {
    const stack = [...l.fields]; while (stack.length) { const x = stack.shift()!; if (x.key === fkey) return x.value; if (x.children) stack.push(...x.children); }
    if (fkey === 'addr' && proto === 'ipv4') return [fieldValue(d, 'ipv4.src'), fieldValue(d, 'ipv4.dst')];
    if (fkey === 'addr' && proto === 'eth') return [fieldValue(d, 'eth.src'), fieldValue(d, 'eth.dst')];
  }
  return undefined;
}
