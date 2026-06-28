// RIPv2 (RFC 2453) over UDP 520. Request/response with route entries.
import { ByteReader, ByteWriter, u32ToIp } from '@/shared/bytes';
import { f, type Field, type Layer } from './types';

export const RIP_REQUEST = 1, RIP_RESPONSE = 2, RIP_INFINITY = 16;
export interface RipEntry { af: number; tag: number; addr: number; mask: number; nextHop: number; metric: number }
export interface RipPacket { command: number; version: number; entries: RipEntry[] }

export function encodeRip(p: RipPacket): Uint8Array {
  const w = new ByteWriter(4 + p.entries.length * 20); w.u8(p.command).u8(p.version).u16(0);
  for (const e of p.entries) w.u16(e.af).u16(e.tag).u32(e.addr >>> 0).u32(e.mask >>> 0).u32(e.nextHop >>> 0).u32(e.metric >>> 0);
  return w.toBytes();
}
export function decodeRipPacket(b: Uint8Array, start: number, end: number): RipPacket {
  const r = new ByteReader(b, start, end); const command = r.u8(), version = r.u8(); r.u16(); const entries: RipEntry[] = [];
  while (r.remaining >= 20) entries.push({ af: r.u16(), tag: r.u16(), addr: r.u32(), mask: r.u32(), nextHop: r.u32(), metric: r.u32() });
  return { command, version, entries };
}
export function decodeRipLayer(b: Uint8Array, start: number, end: number): Layer[] {
  const p = decodeRipPacket(b, start, end); const s = start;
  const fields: Field[] = [f('command', 'Command', p.command, s, s + 1, p.command === 1 ? 'Request (1)' : 'Response (2)'), f('version', 'Version', p.version, s + 1, s + 2)];
  p.entries.forEach((e, i) => fields.push(f('entry', `Route ${i + 1}`, `${u32ToIp(e.addr)}/${maskLen(e.mask)} metric ${e.metric}`, s + 4 + i * 20, s + 24 + i * 20, `${u32ToIp(e.addr)}/${maskLen(e.mask)}${e.nextHop ? ` via ${u32ToIp(e.nextHop)}` : ''} metric ${e.metric === 16 ? '16 (unreachable)' : e.metric}`)));
  return [{ proto: 'rip', name: 'Routing Information Protocol', start: s, end, summary: `${p.command === 1 ? 'Request' : 'Response'} v${p.version}, ${p.entries.length} route(s)`, warnings: [], fields }];
}
function maskLen(m: number) { let n = 0, x = m >>> 0; while (x & 0x80000000) { n++; x = (x << 1) >>> 0; } return n; }
