// DNS wire format (RFC 1035) with name compression. Encoder + tolerant decoder.
import { ByteReader, ByteWriter, u32ToIp, ipToU32 } from '@/shared/bytes';
import { f, type Field, type Layer } from './types';

export const DNS_A = 1, DNS_NS = 2, DNS_CNAME = 5, DNS_SOA = 6, DNS_PTR = 12, DNS_MX = 15, DNS_TXT = 16, DNS_AAAA = 28;
export const RCODE_NOERROR = 0, RCODE_FORMERR = 1, RCODE_SERVFAIL = 2, RCODE_NXDOMAIN = 3, RCODE_REFUSED = 5;
export const CLASS_IN = 1;
export function typeName(t: number) { return ({ 1: 'A', 2: 'NS', 5: 'CNAME', 6: 'SOA', 12: 'PTR', 15: 'MX', 16: 'TXT', 28: 'AAAA' } as Record<number, string>)[t] ?? `TYPE${t}`; }
export function rcodeName(r: number) { return ['NOERROR', 'FORMERR', 'SERVFAIL', 'NXDOMAIN', 'NOTIMP', 'REFUSED'][r] ?? `RCODE${r}`; }

export interface DnsQuestion { name: string; type: number; cls: number }
export interface DnsRecord { name: string; type: number; cls: number; ttl: number; data: DnsRData }
export type DnsRData = { kind: 'a'; ip: number } | { kind: 'ns' | 'cname' | 'ptr'; name: string } | { kind: 'mx'; pref: number; name: string } | { kind: 'txt'; text: string } | { kind: 'soa'; mname: string; rname: string; serial: number; refresh: number; retry: number; expire: number; minimum: number } | { kind: 'raw'; bytes: Uint8Array };
export interface DnsMessage { id: number; qr: boolean; opcode: number; aa: boolean; tc: boolean; rd: boolean; ra: boolean; rcode: number; questions: DnsQuestion[]; answers: DnsRecord[]; authority: DnsRecord[]; additional: DnsRecord[] }

export function newQuery(id: number, name: string, type = DNS_A, rd = true): DnsMessage { return { id, qr: false, opcode: 0, aa: false, tc: false, rd, ra: false, rcode: 0, questions: [{ name, type, cls: CLASS_IN }], answers: [], authority: [], additional: [] }; }

function writeName(w: ByteWriter, name: string, table: Map<string, number>, base: number) {
  let n = name.replace(/\.$/, '');
  for (;;) {
    if (n === '') { w.u8(0); return; }
    const at = table.get(n); if (at !== undefined) { w.u16(0xc000 | at); return; }
    table.set(n, base + w.length);
    const dot = n.indexOf('.'); const label = dot < 0 ? n : n.slice(0, dot);
    w.u8(label.length); w.ascii(label); n = dot < 0 ? '' : n.slice(dot + 1);
  }
}
function readName(r: ByteReader): string {
  const labels: string[] = []; let jumped = false; let safety = 0;
  let p = r.pos;
  for (;;) {
    if (safety++ > 128) break; const len = r.buf[p]!;
    if (len === undefined) break;
    if ((len & 0xc0) === 0xc0) { const ptr = ((len & 0x3f) << 8) | r.buf[p + 1]!; if (!jumped) r.pos = p + 2; jumped = true; p = ptr; continue; }
    if (len === 0) { if (!jumped) r.pos = p + 1; break; }
    p++; let s = ''; for (let i = 0; i < len; i++) s += String.fromCharCode(r.buf[p + i]!); labels.push(s); p += len; if (!jumped) r.pos = p;
  }
  return labels.join('.');
}
export function encodeDns(m: DnsMessage): Uint8Array {
  const w = new ByteWriter(64); const table = new Map<string, number>();
  const flags = (m.qr ? 0x8000 : 0) | (m.opcode << 11) | (m.aa ? 0x400 : 0) | (m.tc ? 0x200 : 0) | (m.rd ? 0x100 : 0) | (m.ra ? 0x80 : 0) | (m.rcode & 15);
  w.u16(m.id).u16(flags).u16(m.questions.length).u16(m.answers.length).u16(m.authority.length).u16(m.additional.length);
  for (const q of m.questions) { writeName(w, q.name, table, 0); w.u16(q.type).u16(q.cls); }
  const rr = (rec: DnsRecord) => {
    writeName(w, rec.name, table, 0); w.u16(rec.type).u16(rec.cls).u32(rec.ttl >>> 0);
    const lenAt = w.length; w.u16(0); const dataStart = w.length; const d = rec.data;
    if (d.kind === 'a') w.u32(d.ip >>> 0); else if (d.kind === 'ns' || d.kind === 'cname' || d.kind === 'ptr') writeName(w, d.name, table, 0);
    else if (d.kind === 'mx') { w.u16(d.pref); writeName(w, d.name, table, 0); } else if (d.kind === 'txt') { w.u8(d.text.length); w.ascii(d.text); }
    else if (d.kind === 'soa') { writeName(w, d.mname, table, 0); writeName(w, d.rname, table, 0); w.u32(d.serial >>> 0).u32(d.refresh).u32(d.retry).u32(d.expire).u32(d.minimum); }
    else if (d.kind === 'raw') w.bytes(d.bytes);
    w.patchU16(lenAt, w.length - dataStart);
  };
  for (const a of m.answers) rr(a); for (const a of m.authority) rr(a); for (const a of m.additional) rr(a);
  return w.toBytes();
}
export function decodeDnsMessage(b: Uint8Array, start = 0, end = b.length): DnsMessage {
  const r = new ByteReader(b, start, end);
  const id = r.u16(), flags = r.u16(), qd = r.u16(), an = r.u16(), ns = r.u16(), ar = r.u16();
  const m: DnsMessage = { id, qr: !!(flags & 0x8000), opcode: (flags >> 11) & 15, aa: !!(flags & 0x400), tc: !!(flags & 0x200), rd: !!(flags & 0x100), ra: !!(flags & 0x80), rcode: flags & 15, questions: [], answers: [], authority: [], additional: [] };
  for (let i = 0; i < qd; i++) { const name = readName(r); const type = r.u16(), cls = r.u16(); m.questions.push({ name, type, cls }); }
  const readRR = (): DnsRecord => { const name = readName(r); const type = r.u16(), cls = r.u16(), ttl = r.u32(), rdlen = r.u16(); const dataEnd = r.pos + rdlen; let data: DnsRData;
    if (type === DNS_A && rdlen === 4) data = { kind: 'a', ip: r.u32() }; else if (type === DNS_NS) data = { kind: 'ns', name: readName(r) }; else if (type === DNS_CNAME) data = { kind: 'cname', name: readName(r) }; else if (type === DNS_PTR) data = { kind: 'ptr', name: readName(r) };
    else if (type === DNS_MX) { const pref = r.u16(); data = { kind: 'mx', pref, name: readName(r) }; } else if (type === DNS_TXT) { const l = r.u8(); let s = ''; for (let i = 0; i < l; i++) s += String.fromCharCode(r.u8()); data = { kind: 'txt', text: s }; }
    else if (type === DNS_SOA) { const mname = readName(r), rname = readName(r); data = { kind: 'soa', mname, rname, serial: r.u32(), refresh: r.u32(), retry: r.u32(), expire: r.u32(), minimum: r.u32() }; }
    else data = { kind: 'raw', bytes: b.slice(r.pos, dataEnd) };
    r.pos = dataEnd; return { name, type, cls, ttl, data }; };
  for (let i = 0; i < an; i++) m.answers.push(readRR()); for (let i = 0; i < ns; i++) m.authority.push(readRR()); for (let i = 0; i < ar; i++) m.additional.push(readRR());
  return m;
}
export function rdataStr(d: DnsRData): string { switch (d.kind) { case 'a': return u32ToIp(d.ip); case 'ns': case 'cname': case 'ptr': return d.name; case 'mx': return `${d.pref} ${d.name}`; case 'txt': return `"${d.text}"`; case 'soa': return `${d.mname} ${d.rname} ${d.serial}`; case 'raw': return `(${d.bytes.length} bytes)`; } }
export function decodeDnsLayer(b: Uint8Array, start: number, end: number, isTcp: boolean): Layer[] {
  let s = start; if (isTcp) s += 2; // TCP DNS has a 2-byte length prefix
  const m = decodeDnsMessage(b, s, end);
  const q = m.questions[0]; const kind = m.qr ? 'response' : 'query';
  const summary = m.qr ? `Standard query response 0x${m.id.toString(16).padStart(4, '0')} ${rcodeName(m.rcode)}${m.aa ? ' AA' : ''}${q ? ` ${typeName(q.type)} ${q.name}` : ''}${m.answers.map(a => ` ${typeName(a.type)} ${rdataStr(a.data)}`).join('')}` : `Standard query 0x${m.id.toString(16).padStart(4, '0')}${q ? ` ${typeName(q.type)} ${q.name}` : ''}`;
  const secFields = (name: string, recs: DnsRecord[]): Field[] => recs.map(rr => f(name, `${rr.name || '<root>'}`, `${typeName(rr.type)} ${rdataStr(rr.data)}`, s, end, `${rr.name || '<root>'}: type ${typeName(rr.type)}, class IN, ttl ${rr.ttl}, ${rdataStr(rr.data)}`));
  return [{ proto: 'dns', name: 'Domain Name System (' + kind + ')', start: s, end, summary, warnings: m.tc ? ['Truncated (TC) — retry over TCP'] : [], fields: [
    f('id', 'Transaction ID', m.id, s, s + 2, `0x${m.id.toString(16).padStart(4, '0')}`),
    f('flags.response', 'Response', m.qr, s + 2, s + 3), f('flags.opcode', 'Opcode', m.opcode, s + 2, s + 3), f('flags.authoritative', 'Authoritative', m.aa, s + 2, s + 3), f('flags.truncated', 'Truncated', m.tc, s + 2, s + 3), f('flags.recdesired', 'Recursion desired', m.rd, s + 2, s + 3), f('flags.recavail', 'Recursion available', m.ra, s + 3, s + 4), f('flags.rcode', 'Reply code', m.rcode, s + 3, s + 4, rcodeName(m.rcode)),
    f('count.queries', 'Questions', m.questions.length, s + 4, s + 6), f('count.answers', 'Answer RRs', m.answers.length, s + 6, s + 8), f('count.auth_rr', 'Authority RRs', m.authority.length, s + 8, s + 10), f('count.add_rr', 'Additional RRs', m.additional.length, s + 10, s + 12),
    ...m.questions.map(qq => f('qry.name', 'Query', qq.name, s, end, `${qq.name}: type ${typeName(qq.type)}, class IN`)),
    ...secFields('resp.name', m.answers), ...secFields('auth', m.authority), ...secFields('add', m.additional),
  ] }];
}
export { ipToU32 };
