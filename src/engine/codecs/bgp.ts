// BGP-4 (RFC 4271) over TCP 179. OPEN, UPDATE, KEEPALIVE, NOTIFICATION.
import { ByteReader, ByteWriter, u32ToIp } from '@/shared/bytes';
import { f, type Field, type Layer } from './types';

export const BGP_OPEN = 1, BGP_UPDATE = 2, BGP_NOTIFICATION = 3, BGP_KEEPALIVE = 4;
export const ORIGIN_IGP = 0, ORIGIN_EGP = 1, ORIGIN_INCOMPLETE = 2;
export interface BgpRoute { prefix: number; len: number }
export interface BgpPathAttrs { origin: number; asPath: number[]; nextHop: number; localPref?: number; med?: number }
export interface BgpUpdate { withdrawn: BgpRoute[]; attrs?: BgpPathAttrs; nlri: BgpRoute[] }
export interface BgpOpen { version: number; as: number; holdTime: number; bgpId: number }
export type BgpMessage = { type: 1; open: BgpOpen } | { type: 2; update: BgpUpdate } | { type: 3; code: number; sub: number } | { type: 4 };

const MARKER = new Uint8Array(16).fill(0xff);
function frame(w: ByteWriter, type: number, body: Uint8Array) { w.bytes(MARKER).u16(19 + body.length).u8(type).bytes(body); }
function encPrefix(w: ByteWriter, r: BgpRoute) { w.u8(r.len); const bytes = Math.ceil(r.len / 8); for (let i = 0; i < bytes; i++) w.u8((r.prefix >>> (24 - i * 8)) & 0xff); }
export function encodeBgp(m: BgpMessage): Uint8Array {
  const w = new ByteWriter(64);
  if (m.type === BGP_OPEN) { const bw = new ByteWriter(16); bw.u8(m.open.version).u16(m.open.as).u16(m.open.holdTime).u32(m.open.bgpId >>> 0).u8(0); frame(w, 1, bw.toBytes()); }
  else if (m.type === BGP_KEEPALIVE) frame(w, 4, new Uint8Array(0));
  else if (m.type === BGP_NOTIFICATION) { const bw = new ByteWriter(2); bw.u8(m.code).u8(m.sub); frame(w, 3, bw.toBytes()); }
  else { const bw = new ByteWriter(32); const wr = new ByteWriter(16); for (const r of m.update.withdrawn) encPrefix(wr, r); const wb = wr.toBytes(); bw.u16(wb.length).bytes(wb);
    const ab = new ByteWriter(32); if (m.update.attrs) { const a = m.update.attrs; ab.u8(0x40).u8(1).u8(1).u8(a.origin); const pw = new ByteWriter(8); pw.u8(2).u8(a.asPath.length); for (const as of a.asPath) pw.u16(as); const pb = pw.toBytes(); ab.u8(0x40).u8(2).u8(pb.length).bytes(pb); ab.u8(0x40).u8(3).u8(4).u32(a.nextHop >>> 0); if (a.localPref !== undefined) { ab.u8(0x40).u8(5).u8(4).u32(a.localPref >>> 0); } if (a.med !== undefined) { ab.u8(0x80).u8(4).u8(4).u32(a.med >>> 0); } }
    const abb = ab.toBytes(); bw.u16(abb.length).bytes(abb); for (const r of m.update.nlri) encPrefix(bw, r); frame(w, 2, bw.toBytes()); }
  return w.toBytes();
}
function decPrefix(r: ByteReader): BgpRoute { const len = r.u8(); const bytes = Math.ceil(len / 8); let prefix = 0; for (let i = 0; i < bytes; i++) prefix |= r.u8() << (24 - i * 8); return { prefix: prefix >>> 0, len }; }
export function decodeBgpMessages(b: Uint8Array, start: number, end: number): { msgs: BgpMessage[]; consumed: number } {
  const msgs: BgpMessage[] = []; let p = start;
  while (end - p >= 19) { const len = (b[p + 16]! << 8) | b[p + 17]!; const type = b[p + 18]!; if (len < 19 || p + len > end) break; const r = new ByteReader(b, p + 19, p + len);
    if (type === BGP_OPEN) { const version = r.u8(), as = r.u16(), holdTime = r.u16(), bgpId = r.u32(); msgs.push({ type: 1, open: { version, as, holdTime, bgpId } }); }
    else if (type === BGP_KEEPALIVE) msgs.push({ type: 4 });
    else if (type === BGP_NOTIFICATION) msgs.push({ type: 3, code: r.u8(), sub: r.u8() });
    else if (type === BGP_UPDATE) { const wlen = r.u16(); const wEnd = r.pos + wlen; const withdrawn: BgpRoute[] = []; while (r.pos < wEnd) withdrawn.push(decPrefix(r)); const alen = r.u16(); const aEnd = r.pos + alen; let attrs: BgpPathAttrs | undefined;
      if (alen > 0) { attrs = { origin: 0, asPath: [], nextHop: 0 }; while (r.pos < aEnd) { const flags = r.u8(); const tc = r.u8(); const al = (flags & 0x10) ? r.u16() : r.u8(); const aStart = r.pos; if (tc === 1) attrs.origin = r.u8(); else if (tc === 2) { r.u8(); const n = r.u8(); for (let i = 0; i < n; i++) attrs.asPath.push(r.u16()); } else if (tc === 3) attrs.nextHop = r.u32(); else if (tc === 5) attrs.localPref = r.u32(); else if (tc === 4) attrs.med = r.u32(); r.pos = aStart + al; } }
      const nlri: BgpRoute[] = []; while (r.pos < p + len) nlri.push(decPrefix(r)); msgs.push({ type: 2, update: { withdrawn, attrs, nlri } }); }
    p += len;
  }
  return { msgs, consumed: p - start };
}
export function decodeBgpLayer(b: Uint8Array, start: number, end: number): Layer[] {
  const { msgs } = decodeBgpMessages(b, start, end); if (!msgs.length) return [{ proto: 'data', name: 'TCP segment data', start, end, summary: `${end - start} bytes`, warnings: [], fields: [] }];
  const names = ['', 'OPEN', 'UPDATE', 'NOTIFICATION', 'KEEPALIVE'];
  const fields: Field[] = []; for (const m of msgs) { if (m.type === 1) fields.push(f('open.as', 'OPEN — My AS', m.open.as, start, end, `AS${m.open.as}, hold ${m.open.holdTime}s, id ${u32ToIp(m.open.bgpId)}`)); else if (m.type === 4) fields.push(f('keepalive', 'KEEPALIVE', 1, start, end)); else if (m.type === 3) fields.push(f('notification', 'NOTIFICATION', m.code, start, end, `code ${m.code}/${m.sub}`)); else { const a = m.update.attrs; fields.push(f('update', 'UPDATE', m.update.nlri.length, start, end, `${m.update.nlri.map(r => `${u32ToIp(r.prefix)}/${r.len}`).join(', ') || '(no NLRI)'}${a ? ` AS_PATH [${a.asPath.join(' ')}] next-hop ${u32ToIp(a.nextHop)}${a.localPref !== undefined ? ` localpref ${a.localPref}` : ''}` : ''}${m.update.withdrawn.length ? ` withdraw ${m.update.withdrawn.map(r => `${u32ToIp(r.prefix)}/${r.len}`).join(', ')}` : ''}`)); } }
  return [{ proto: 'bgp', name: 'Border Gateway Protocol', start, end, summary: msgs.map(m => names[m.type]).join(', ') + (msgs.length === 1 && msgs[0]!.type === 2 ? `: ${msgs[0]!.update.nlri.map(r => u32ToIp(r.prefix) + '/' + r.len).join(',') || 'withdraw'}` : ''), warnings: [], fields }];
}
