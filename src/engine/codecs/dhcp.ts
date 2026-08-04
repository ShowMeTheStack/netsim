// DHCP over BOOTP (RFC 2131) with the common options. Encoder + decoder.
import { ByteReader, ByteWriter, u32ToIp } from '@/shared/bytes';
import { f, type Field, type Layer } from './types';

export const DHCP_DISCOVER = 1, DHCP_OFFER = 2, DHCP_REQUEST = 3, DHCP_DECLINE = 4, DHCP_ACK = 5, DHCP_NAK = 6, DHCP_RELEASE = 7;
export const MAGIC = 0x63825363;
export function msgTypeName(t: number) { return ['', 'DISCOVER', 'OFFER', 'REQUEST', 'DECLINE', 'ACK', 'NAK', 'RELEASE', 'INFORM'][t] ?? `type ${t}`; }
export interface DhcpMessage { op: number; xid: number; secs: number; flags: number; ciaddr: number; yiaddr: number; siaddr: number; giaddr: number; chaddr: Uint8Array; msgType: number; options: DhcpOptions }
export interface DhcpOptions { serverId?: number; requestedIp?: number; leaseTime?: number; subnet?: number; router?: number; dns?: number[]; hostname?: string; paramList?: number[]; message?: string }

export function encodeDhcp(m: DhcpMessage): Uint8Array {
  const w = new ByteWriter(300);
  w.u8(m.op).u8(1).u8(6).u8(0).u32(m.xid >>> 0).u16(m.secs).u16(m.flags).u32(m.ciaddr >>> 0).u32(m.yiaddr >>> 0).u32(m.siaddr >>> 0).u32(m.giaddr >>> 0);
  const chaddr = new Uint8Array(16); chaddr.set(m.chaddr.subarray(0, 16)); w.bytes(chaddr); w.bytes(new Uint8Array(192)); w.u32(MAGIC);
  const o = m.options; w.u8(53).u8(1).u8(m.msgType);
  if (o.serverId !== undefined) w.u8(54).u8(4).u32(o.serverId >>> 0);
  if (o.requestedIp !== undefined) w.u8(50).u8(4).u32(o.requestedIp >>> 0);
  if (o.leaseTime !== undefined) w.u8(51).u8(4).u32(o.leaseTime >>> 0);
  if (o.subnet !== undefined) w.u8(1).u8(4).u32(o.subnet >>> 0);
  if (o.router !== undefined) w.u8(3).u8(4).u32(o.router >>> 0);
  if (o.dns?.length) { w.u8(6).u8(4 * o.dns.length); for (const d of o.dns) w.u32(d >>> 0); }
  if (o.hostname) { w.u8(12).u8(o.hostname.length).ascii(o.hostname); }
  if (o.paramList?.length) { w.u8(55).u8(o.paramList.length); for (const p of o.paramList) w.u8(p); }
  if (o.message) { w.u8(56).u8(o.message.length).ascii(o.message); }
  w.u8(255); return w.toBytes();
}
export function decodeDhcpMessage(b: Uint8Array, start: number, end: number): DhcpMessage {
  const r = new ByteReader(b, start, end);
  const op = r.u8(); r.u8(); r.u8(); r.u8(); const xid = r.u32(); const secs = r.u16(); const flags = r.u16(); const ciaddr = r.u32(), yiaddr = r.u32(), siaddr = r.u32(), giaddr = r.u32(); const chaddr = r.bytes(16); r.bytes(192); r.u32();
  const o: DhcpOptions = {}; let msgType = 0;
  while (r.pos < end) { const code = r.u8(); if (code === 255 || code === 0) { if (code === 0) continue; break; } const len = r.u8();
    if (code === 53) msgType = r.u8(); else if (code === 54) o.serverId = r.u32(); else if (code === 50) o.requestedIp = r.u32(); else if (code === 51) o.leaseTime = r.u32(); else if (code === 1) o.subnet = r.u32(); else if (code === 3) o.router = r.u32();
    else if (code === 6) { o.dns = []; for (let i = 0; i < len; i += 4) o.dns.push(r.u32()); } else if (code === 12) { let s = ''; for (let i = 0; i < len; i++) s += String.fromCharCode(r.u8()); o.hostname = s; }
    else if (code === 55) { o.paramList = []; for (let i = 0; i < len; i++) o.paramList.push(r.u8()); } else if (code === 56) { let s = ''; for (let i = 0; i < len; i++) s += String.fromCharCode(r.u8()); o.message = s; } else r.bytes(len);
  }
  return { op, xid, secs, flags, ciaddr, yiaddr, siaddr, giaddr, chaddr, msgType, options: o };
}
export function decodeDhcpLayer(b: Uint8Array, start: number, end: number): Layer[] {
  const m = decodeDhcpMessage(b, start, end); const s = start;
  const fields: Field[] = [f('type', 'Message type', m.msgType, s, end, `${msgTypeName(m.msgType)} (${m.msgType})`), f('op', 'Op', m.op, s, s + 1, m.op === 1 ? 'BOOTREQUEST' : 'BOOTREPLY'), f('xid', 'Transaction ID', m.xid, s + 4, s + 8, `0x${m.xid.toString(16).padStart(8, '0')}`), f('ciaddr', 'Client IP', u32ToIp(m.ciaddr), s + 12, s + 16), f('yiaddr', 'Your (client) IP', u32ToIp(m.yiaddr), s + 16, s + 20), f('siaddr', 'Server IP', u32ToIp(m.siaddr), s + 20, s + 24)];
  const o = m.options; if (o.serverId !== undefined) fields.push(f('option.server_id', 'DHCP Server Identifier', u32ToIp(o.serverId), s, end)); if (o.requestedIp !== undefined) fields.push(f('option.requested_ip', 'Requested IP Address', u32ToIp(o.requestedIp), s, end)); if (o.leaseTime !== undefined) fields.push(f('option.lease', 'IP Address Lease Time', o.leaseTime, s, end, `${o.leaseTime}s`)); if (o.subnet !== undefined) fields.push(f('option.subnet', 'Subnet Mask', u32ToIp(o.subnet), s, end)); if (o.router !== undefined) fields.push(f('option.router', 'Router', u32ToIp(o.router), s, end)); if (o.dns?.length) fields.push(f('option.dns', 'Domain Name Server', o.dns.map(u32ToIp).join(', '), s, end)); if (o.hostname) fields.push(f('option.hostname', 'Host Name', o.hostname, s, end));
  return [{ proto: 'dhcp', name: 'Dynamic Host Configuration Protocol', start: s, end, summary: `DHCP ${msgTypeName(m.msgType)} - Transaction ID 0x${m.xid.toString(16).padStart(8, '0')}${m.yiaddr ? `, Your IP ${u32ToIp(m.yiaddr)}` : ''}`, warnings: [], fields }];
}
