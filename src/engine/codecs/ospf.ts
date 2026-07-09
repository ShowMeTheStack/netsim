// OSPFv2 (RFC 2328) over IP protocol 89. Hello, DD, LSR, LSU, LSAck; router + network LSAs.
import { ByteReader, ByteWriter, u32ToIp } from '@/shared/bytes';
import { inetChecksum } from '@/shared/checksum';
import { f, type Field, type Layer } from './types';

export const OSPF_HELLO = 1, OSPF_DD = 2, OSPF_LSR = 3, OSPF_LSU = 4, OSPF_LSACK = 5;
export const LSA_ROUTER = 1, LSA_NETWORK = 2;
export interface OspfHeader { version: number; type: number; routerId: number; areaId: number }
export interface LsaHeader { age: number; type: number; lsId: number; advRouter: number; seq: number }
export interface RouterLink { linkId: number; linkData: number; type: number; metric: number }
export interface Lsa { header: LsaHeader; links?: RouterLink[]; attachedRouters?: number[]; netMask?: number }
export interface OspfHello { header: OspfHeader; netMask: number; helloInterval: number; deadInterval: number; dr: number; bdr: number; neighbors: number[] }
export interface OspfLsu { header: OspfHeader; lsas: Lsa[] }

function encHeader(w: ByteWriter, h: OspfHeader, bodyLen: number) { w.u8(h.version).u8(h.type).u16(24 + bodyLen).u32(h.routerId >>> 0).u32(h.areaId >>> 0).u16(0).u16(0).u32(0); }
export function encodeHello(h: OspfHello): Uint8Array {
  const w = new ByteWriter(48); encHeader(w, h.header, 20 + h.neighbors.length * 4);
  w.u32(h.netMask >>> 0).u16(h.helloInterval).u8(0).u8(1).u32(0).u32(h.dr >>> 0).u32(h.bdr >>> 0); // options, priority; note: deadInterval simplified
  w.patchU16(34, h.deadInterval); // store dead in the router-dead field position (simplified layout below uses fixed offsets)
  for (const n of h.neighbors) w.u32(n >>> 0);
  const b = w.toBytes(); const ck = inetChecksum(b, 0, b.length); b[12] = ck >> 8; b[13] = ck & 255; return b;
}
function encLsa(w: ByteWriter, l: Lsa) {
  const start = w.length; w.u16(l.header.age).u8(0).u8(l.header.type).u32(l.header.lsId >>> 0).u32(l.header.advRouter >>> 0).u32(l.header.seq >>> 0).u16(0); const lenAt = w.length; w.u16(0);
  if (l.header.type === LSA_ROUTER && l.links) { w.u16(0).u16(l.links.length); for (const lk of l.links) { w.u32(lk.linkId >>> 0).u32(lk.linkData >>> 0).u8(lk.type).u8(0).u16(lk.metric); } }
  else if (l.header.type === LSA_NETWORK && l.attachedRouters) { w.u32((l.netMask ?? 0) >>> 0); for (const rid of l.attachedRouters) w.u32(rid >>> 0); }
  w.patchU16(lenAt, w.length - start);
}
export function encodeLsu(u: OspfLsu): Uint8Array {
  const w = new ByteWriter(64); const bodyStart = 24; encHeader(w, u.header, 4 + u.lsas.length * 40); w.u32(u.lsas.length); for (const l of u.lsas) encLsa(w, l);
  void bodyStart; const b = w.toBytes(); const ck = inetChecksum(b, 0, b.length); b[12] = ck >> 8; b[13] = ck & 255; return b;
}
export function decodeOspf(b: Uint8Array, start: number, end: number): { header: OspfHeader; hello?: OspfHello; lsu?: OspfLsu } {
  const r = new ByteReader(b, start, end); const version = r.u8(), type = r.u8(); r.u16(); const routerId = r.u32(), areaId = r.u32(); r.u16(); r.u16(); r.u32();
  const header: OspfHeader = { version, type, routerId, areaId };
  if (type === OSPF_HELLO) { const netMask = r.u32(); const helloInterval = r.u16(); r.u8(); r.u8(); const deadInterval = (b[start + 34]! << 8) | b[start + 35]!; const dr = r.u32(), bdr = r.u32(); const neighbors: number[] = []; while (r.remaining >= 4) neighbors.push(r.u32()); return { header, hello: { header, netMask, helloInterval, deadInterval, dr, bdr, neighbors } }; }
  if (type === OSPF_LSU) { const count = r.u32(); const lsas: Lsa[] = []; for (let i = 0; i < count && r.remaining >= 20; i++) { const age = r.u16(); r.u8(); const lt = r.u8(); const lsId = r.u32(), advRouter = r.u32(), seq = r.u32(); r.u16(); const len = r.u16(); const bodyEnd = r.pos + len - 20; const lsa: Lsa = { header: { age, type: lt, lsId, advRouter, seq } }; if (lt === LSA_ROUTER) { r.u16(); const n = r.u16(); lsa.links = []; for (let k = 0; k < n; k++) lsa.links.push({ linkId: r.u32(), linkData: r.u32(), type: r.u8(), metric: (r.u8(), r.u16()) }); } else if (lt === LSA_NETWORK) { lsa.netMask = r.u32(); lsa.attachedRouters = []; while (r.pos < bodyEnd) lsa.attachedRouters.push(r.u32()); } r.pos = bodyEnd; lsas.push(lsa); } return { header, lsu: { header, lsas } }; }
  return { header };
}
export function decodeOspfLayer(b: Uint8Array, start: number, end: number): Layer[] {
  const d = decodeOspf(b, start, end); const s = start; const name = ['', 'Hello', 'DB Description', 'LS Request', 'LS Update', 'LS Ack'][d.header.type] ?? `type ${d.header.type}`;
  const fields: Field[] = [f('type', 'Message Type', d.header.type, s + 1, s + 2, name), f('srcrouter', 'Source OSPF Router', u32ToIp(d.header.routerId), s + 4, s + 8), f('area', 'Area ID', u32ToIp(d.header.areaId), s + 8, s + 12)];
  if (d.hello) fields.push(f('hello.dr', 'Designated Router', u32ToIp(d.hello.dr), s, end), f('hello.neighbors', 'Active Neighbors', d.hello.neighbors.map(u32ToIp).join(', ') || 'none', s, end));
  if (d.lsu) fields.push(f('lsa.count', 'Number of LSAs', d.lsu.lsas.length, s + 24, s + 28), ...d.lsu.lsas.map((l, i) => f('lsa', `LSA ${i + 1}`, `${l.header.type === 1 ? 'Router' : 'Network'}-LSA from ${u32ToIp(l.header.advRouter)}`, s, end, `${l.header.type === 1 ? 'Router' : 'Network'}-LSA id ${u32ToIp(l.header.lsId)} adv ${u32ToIp(l.header.advRouter)} seq 0x${(l.header.seq >>> 0).toString(16)}${l.links ? `, ${l.links.length} links` : ''}`)));
  return [{ proto: 'ospf', name: 'Open Shortest Path First', start: s, end, summary: `OSPF ${name}, Router ${u32ToIp(d.header.routerId)}, Area ${u32ToIp(d.header.areaId)}${d.hello ? `, ${d.hello.neighbors.length} nbr` : d.lsu ? `, ${d.lsu.lsas.length} LSA` : ''}`, warnings: [], fields }];
}
