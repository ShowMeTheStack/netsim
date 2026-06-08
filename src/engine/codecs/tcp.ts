import { ByteReader, ByteWriter } from '@/shared/bytes';
import { inetChecksum, pseudoHeader } from '@/shared/checksum';
import { f, type Field, type Layer } from './types';

export const TCP_FIN = 1, TCP_SYN = 2, TCP_RST = 4, TCP_PSH = 8, TCP_ACK = 16, TCP_URG = 32, TCP_ECE = 64, TCP_CWR = 128;
export interface TcpOptions { mss?: number; wscale?: number; sackOk?: boolean; sack?: [number, number][]; ts?: { val: number; ecr: number } }
export interface TcpSegment { sport: number; dport: number; seq: number; ack: number; flags: number; window: number; urgent?: number; options: TcpOptions; data: Uint8Array }

export function flagsStr(fl: number): string {
  const n: string[] = []; if (fl & TCP_FIN) n.push('FIN'); if (fl & TCP_SYN) n.push('SYN'); if (fl & TCP_RST) n.push('RST'); if (fl & TCP_PSH) n.push('PSH'); if (fl & TCP_ACK) n.push('ACK'); if (fl & TCP_URG) n.push('URG'); if (fl & TCP_ECE) n.push('ECE'); if (fl & TCP_CWR) n.push('CWR'); return n.join(', ') || 'none';
}
function encodeOptions(o: TcpOptions): Uint8Array {
  const w = new ByteWriter(40);
  if (o.mss !== undefined) w.u8(2).u8(4).u16(o.mss);
  if (o.wscale !== undefined) w.u8(1).u8(3).u8(3).u8(o.wscale);
  if (o.sackOk) w.u8(1).u8(1).u8(4).u8(2);
  if (o.ts) w.u8(1).u8(1).u8(8).u8(10).u32(o.ts.val).u32(o.ts.ecr);
  if (o.sack && o.sack.length) { const blocks = o.sack.slice(0, 4); w.u8(1).u8(1).u8(5).u8(2 + blocks.length * 8); for (const [a, b] of blocks) w.u32(a >>> 0).u32(b >>> 0); }
  while (w.length % 4) w.u8(0);
  return w.toBytes();
}
export function encodeTcp(sg: TcpSegment, srcIp: number, dstIp: number, opts: { corruptChecksum?: boolean } = {}): Uint8Array {
  const optBytes = encodeOptions(sg.options); const hdrLen = 20 + optBytes.length; const len = hdrLen + sg.data.length;
  const out = new ByteWriter(len).u16(sg.sport).u16(sg.dport).u32(sg.seq >>> 0).u32(sg.ack >>> 0).u8((hdrLen / 4) << 4).u8(sg.flags & 0xff).u16(sg.window).u16(0).u16(sg.urgent ?? 0).bytes(optBytes).bytes(sg.data).toBytes();
  let ck = inetChecksum(out, 0, len, pseudoHeader(srcIp, dstIp, 6, len)); if (opts.corruptChecksum) ck ^= 0x2222; out[16] = ck >> 8; out[17] = ck & 255; return out;
}
export function decodeTcp(b: Uint8Array, start: number, end: number, srcIp: number, dstIp: number): { layer: Layer; seg: TcpSegment; checksumOk: boolean; payloadStart: number } {
  const r = new ByteReader(b, start, end); const s = start; const warnings: string[] = [];
  const sport = r.u16(), dport = r.u16(), seq = r.u32(), ack = r.u32(), off = r.u8(), flags = r.u8(), window = r.u16(), ck = r.u16(), urgent = r.u16();
  const hdrLen = (off >> 4) * 4; if (hdrLen < 20 || s + hdrLen > end) warnings.push('Bad TCP header length');
  const options: TcpOptions = {}; const optFields: Field[] = [];
  let p = s + 20; const optEnd = Math.min(s + hdrLen, end);
  while (p < optEnd) {
    const k = b[p]!; if (k === 0) { optFields.push(f('options.eol', 'End of Option List', 0, p, p + 1)); break; } if (k === 1) { optFields.push(f('options.nop', 'No-Operation', 1, p, p + 1)); p++; continue; }
    const l = b[p + 1] ?? 0; if (l < 2 || p + l > optEnd) { warnings.push('Malformed TCP option'); break; }
    if (k === 2 && l === 4) { options.mss = (b[p + 2]! << 8) | b[p + 3]!; optFields.push(f('options.mss', 'Maximum segment size', options.mss, p, p + l, `${options.mss} bytes`)); }
    else if (k === 3 && l === 3) { options.wscale = b[p + 2]!; optFields.push(f('options.wscale', 'Window scale', options.wscale, p, p + l, `${options.wscale} (multiply by ${1 << options.wscale})`)); }
    else if (k === 4 && l === 2) { options.sackOk = true; optFields.push(f('options.sack_perm', 'SACK permitted', true, p, p + l)); }
    else if (k === 5) { const blocks: [number, number][] = []; for (let q = p + 2; q + 8 <= p + l; q += 8) blocks.push([((b[q]! << 24) | (b[q + 1]! << 16) | (b[q + 2]! << 8) | b[q + 3]!) >>> 0, ((b[q + 4]! << 24) | (b[q + 5]! << 16) | (b[q + 6]! << 8) | b[q + 7]!) >>> 0]); options.sack = blocks; optFields.push(f('options.sack', 'SACK', blocks.map(x => `${x[0]}-${x[1]}`).join(' '), p, p + l, blocks.map(x => `[${x[0]}, ${x[1]})`).join(' '))); }
    else if (k === 8 && l === 10) { const rr = new ByteReader(b, p + 2, p + 10); options.ts = { val: rr.u32(), ecr: rr.u32() }; optFields.push(f('options.timestamp', 'Timestamps', `${options.ts.val}/${options.ts.ecr}`, p, p + l, `TSval ${options.ts.val}, TSecr ${options.ts.ecr}`)); }
    else optFields.push(f('options.unknown', `Option ${k}`, k, p, p + l));
    p += l;
  }
  const payloadStart = s + hdrLen; const dataLen = Math.max(0, end - payloadStart);
  const checksumOk = inetChecksum(b, s, end, pseudoHeader(srcIp, dstIp, 6, end - s)) === 0; if (!checksumOk) warnings.push('Bad TCP checksum');
  const seg: TcpSegment = { sport, dport, seq, ack, flags, window, urgent, options, data: b.slice(payloadStart, end) };
  const fl = flagsStr(flags);
  const summary = `${sport} → ${dport} [${fl}] Seq=${seq}${flags & TCP_ACK ? ` Ack=${ack}` : ''} Win=${window} Len=${dataLen}${options.mss ? ` MSS=${options.mss}` : ''}${options.wscale !== undefined ? ` WS=${1 << options.wscale}` : ''}${options.sackOk ? ' SACK_PERM' : ''}${options.sack?.length ? ` SLE/SRE=${options.sack.map(x => `${x[0]}-${x[1]}`).join(',')}` : ''}`;
  const layer: Layer = { proto: 'tcp', name: 'Transmission Control Protocol', start: s, end: payloadStart, summary, warnings, fields: [
    f('srcport', 'Source Port', sport, s, s + 2), f('dstport', 'Destination Port', dport, s + 2, s + 4), f('port', 'Port (either)', `${sport},${dport}`, s, s + 4),
    f('seq', 'Sequence Number', seq, s + 4, s + 8), f('ack', 'Acknowledgment Number', ack, s + 8, s + 12),
    f('hdr_len', 'Header Length', hdrLen, s + 12, s + 13, `${hdrLen} bytes (${hdrLen / 4})`),
    f('flags', 'Flags', flags, s + 13, s + 14, `0x${flags.toString(16).padStart(3, '0')} (${fl})`, [
      f('flags.cwr', 'Congestion Window Reduced', !!(flags & TCP_CWR), s + 13, s + 14), f('flags.ece', 'ECN-Echo', !!(flags & TCP_ECE), s + 13, s + 14), f('flags.urg', 'Urgent', !!(flags & TCP_URG), s + 13, s + 14),
      f('flags.ack', 'Acknowledgment', !!(flags & TCP_ACK), s + 13, s + 14), f('flags.push', 'Push', !!(flags & TCP_PSH), s + 13, s + 14), f('flags.reset', 'Reset', !!(flags & TCP_RST), s + 13, s + 14),
      f('flags.syn', 'Syn', !!(flags & TCP_SYN), s + 13, s + 14), f('flags.fin', 'Fin', !!(flags & TCP_FIN), s + 13, s + 14) ]),
    f('window_size_value', 'Window', window, s + 14, s + 16), f('checksum', 'Checksum', ck, s + 16, s + 18, `0x${ck.toString(16).padStart(4, '0')} [${checksumOk ? 'correct' : 'incorrect'}]`), f('checksum_ok', 'Checksum status', checksumOk, s + 16, s + 18),
    f('urgent_pointer', 'Urgent Pointer', urgent, s + 18, s + 20), ...(optFields.length ? [f('options', 'Options', hdrLen - 20, s + 20, payloadStart, `${hdrLen - 20} bytes`, optFields)] : []),
    f('len', 'TCP Segment Len', dataLen, payloadStart, end) ] };
  return { layer, seg, checksumOk, payloadStart };
}
