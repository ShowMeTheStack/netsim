// DHCP client and server over UDP 67/68. DORA handshake with lease management.
import { bytesToMac, macToBytes, u32ToIp, IP_BROADCAST, broadcastOf } from '@/shared/bytes';
import { encodeDhcp, decodeDhcpMessage, DHCP_DISCOVER, DHCP_OFFER, DHCP_REQUEST, DHCP_ACK, DHCP_NAK, DHCP_RELEASE, msgTypeName } from '../codecs/dhcp';
import { rebuildConnectedRoutes, setDefaultGatewayLocal, term } from '../devices/host';
import { udpSocket, udpSend } from '../stack/udp';
import { timer, log, SEC, rand } from '../core';
import type { EngineState, HostState, UdpSocket } from '../types';

// ---------------- server ----------------
export interface DhcpServerCfg { enabled: boolean; iface: string; poolStart: number; poolEnd: number; mask: number; gateway: number; dns: number[]; leaseUs: number; leases: Record<string, { ip: number; expires: number; mac: string }> }
export function defaultDhcpServer(): DhcpServerCfg { return { enabled: false, iface: 'eth0', poolStart: 0, poolEnd: 0, mask: 0, gateway: 0, dns: [], leaseUs: 3600 * SEC, leases: {} }; }
export function startDhcpServer(st: EngineState, h: HostState) {
  const cfg = h.dhcpServer; if (!cfg.enabled) return;
  const existing = Object.values(h.sockets).find(s => s.proto === 'udp' && s.localPort === 67); if (existing) return;
  const s = udpSocket(h, -1, 67); if (typeof s === 'string') { log(st, `${h.name}: DHCP server cannot bind: ${s}`); return; }
  (s as UdpSocket).localIp = null; h.dhcpServerSock = s.id;
  log(st, `${h.name}: DHCP server started on ${cfg.iface}, pool ${u32ToIp(cfg.poolStart)}–${u32ToIp(cfg.poolEnd)}`);
}
function poolPick(cfg: DhcpServerCfg, mac: string): number | null {
  for (const [m, l] of Object.entries(cfg.leases)) if (m === mac) return l.ip;
  const taken = new Set(Object.values(cfg.leases).map(l => l.ip));
  for (let ip = cfg.poolStart; ip <= cfg.poolEnd; ip++) if (!taken.has(ip)) return ip;
  return null;
}
export function dhcpServerRx(st: EngineState, h: HostState, ifaceIdx: number, srcMac: string, data: Uint8Array) {
  const cfg = h.dhcpServer; if (!cfg.enabled) return; void srcMac;
  const m = decodeDhcpMessage(data, 0, data.length); const mac = bytesToMac(m.chaddr.subarray(0, 6)); const iface = h.ifaces[ifaceIdx]!; if (iface.ip === null) return;
  const send = (yiaddr: number, type: number) => {
    const reply = encodeDhcp({ op: 2, xid: m.xid, secs: 0, flags: m.flags, ciaddr: 0, yiaddr, siaddr: iface.ip!, giaddr: m.giaddr, chaddr: m.chaddr.subarray(0, 6), msgType: type, options: { serverId: iface.ip!, leaseTime: Math.floor(cfg.leaseUs / 1e6), subnet: cfg.mask, router: cfg.gateway || undefined, dns: cfg.dns.length ? cfg.dns : undefined } });
    const sock = h.sockets[h.dhcpServerSock!]; if (sock?.proto === 'udp') udpSend(st, h, sock, IP_BROADCAST, 68, reply, { src: iface.ip!, egress: cfg.iface });
  };
  if (m.msgType === DHCP_DISCOVER) { const ip = poolPick(cfg, mac); if (ip === null) { log(st, `${h.name}: DHCP pool exhausted`); return; } log(st, `${h.name}: DHCP DISCOVER from ${mac} → OFFER ${u32ToIp(ip)}`); send(ip, DHCP_OFFER); }
  else if (m.msgType === DHCP_REQUEST) {
    const req = m.options.requestedIp ?? m.ciaddr; if (m.options.serverId !== undefined && m.options.serverId !== iface.ip) return;
    if (req < cfg.poolStart || req > cfg.poolEnd) { send(0, DHCP_NAK); return; }
    cfg.leases[mac] = { ip: req, expires: st.time + cfg.leaseUs, mac }; log(st, `${h.name}: DHCP REQUEST ${u32ToIp(req)} from ${mac} → ACK`); send(req, DHCP_ACK);
  } else if (m.msgType === DHCP_RELEASE) { delete cfg.leases[mac]; log(st, `${h.name}: DHCP RELEASE from ${mac}`); }
}

// ---------------- client ----------------
export interface DhcpClient { iface: string; state: 'init' | 'selecting' | 'requesting' | 'bound'; xid: number; offeredIp: number; serverId: number; sock: number; gen: number; leaseUs: number; boundAt: number }
export function startDhcpClient(st: EngineState, h: HostState, ifaceName: string): string | null {
  const ifaceIdx = h.ifaces.findIndex(i => i.name === ifaceName); if (ifaceIdx < 0) return `no such interface ${ifaceName}`;
  const iface = h.ifaces[ifaceIdx]!; iface.ip = null; rebuildConnectedRoutes(h);
  const s = udpSocket(h, -2, 68); if (typeof s === 'string') { const ex = Object.values(h.sockets).find(x => x.proto === 'udp' && x.localPort === 68); if (ex) delete h.sockets[ex.id]; const s2 = udpSocket(h, -2, 68); if (typeof s2 === 'string') return s2; (s2 as UdpSocket).localIp = null; return doDiscover(st, h, ifaceName, s2.id); }
  (s as UdpSocket).localIp = null; return doDiscover(st, h, ifaceName, s.id);
}
function doDiscover(st: EngineState, h: HostState, ifaceName: string, sockId: number): null {
  const xid = Math.floor(rand(st) * 0xffffffff); const c: DhcpClient = { iface: ifaceName, state: 'selecting', xid, offeredIp: 0, serverId: 0, sock: sockId, gen: (h.dhcpClient?.gen ?? 0) + 1, leaseUs: 0, boundAt: 0 }; h.dhcpClient = c;
  const iface = h.ifaces.find(i => i.name === ifaceName)!;
  term(h, `${ifaceName}: sending DHCPDISCOVER`); log(st, `${h.name}: DHCPDISCOVER on ${ifaceName}`);
  const sock = h.sockets[sockId]; if (sock?.proto === 'udp') udpSend(st, h, sock, IP_BROADCAST, 67, encodeDhcp({ op: 1, xid, secs: 0, flags: 0x8000, ciaddr: 0, yiaddr: 0, siaddr: 0, giaddr: 0, chaddr: macToBytes(iface.mac), msgType: DHCP_DISCOVER, options: { paramList: [1, 3, 6, 51], hostname: h.hostname } }), { src: 0, egress: ifaceName });
  timer(st, h.id, 4 * SEC, `dhcp:${c.gen}:timeout`); return null;
}
export function dhcpClientRx(st: EngineState, h: HostState, data: Uint8Array) {
  const c = h.dhcpClient; if (!c) return; const m = decodeDhcpMessage(data, 0, data.length); if (m.xid !== c.xid) return;
  const iface = h.ifaces.find(i => i.name === c.iface)!;
  if (m.msgType === DHCP_OFFER && c.state === 'selecting') {
    c.offeredIp = m.yiaddr; c.serverId = m.options.serverId ?? m.siaddr; c.state = 'requesting';
    term(h, `${c.iface}: DHCPOFFER of ${u32ToIp(m.yiaddr)} from ${u32ToIp(c.serverId)}`); log(st, `${h.name}: DHCPOFFER ${u32ToIp(m.yiaddr)} → DHCPREQUEST`);
    const sock = h.sockets[c.sock]; if (sock?.proto === 'udp') udpSend(st, h, sock, IP_BROADCAST, 67, encodeDhcp({ op: 1, xid: c.xid, secs: 0, flags: 0x8000, ciaddr: 0, yiaddr: 0, siaddr: 0, giaddr: 0, chaddr: macToBytes(iface.mac), msgType: DHCP_REQUEST, options: { requestedIp: m.yiaddr, serverId: c.serverId, paramList: [1, 3, 6, 51], hostname: h.hostname } }), { src: 0, egress: c.iface });
  } else if (m.msgType === DHCP_ACK && c.state === 'requesting') {
    iface.ip = m.yiaddr; if (m.options.subnet) iface.mask = m.options.subnet; rebuildConnectedRoutes(h);
    if (m.options.router) setDefaultGatewayLocal(h, m.options.router);
    if (m.options.dns?.length) h.dns = m.options.dns.map(u32ToIp);
    c.state = 'bound'; c.leaseUs = (m.options.leaseTime ?? 3600) * SEC; c.boundAt = st.time;
    term(h, `${c.iface}: DHCPACK — bound to ${u32ToIp(m.yiaddr)}/${maskPrefix(iface.mask)}, lease ${m.options.leaseTime ?? 3600}s${m.options.router ? `, gw ${u32ToIp(m.options.router)}` : ''}${m.options.dns?.length ? `, dns ${m.options.dns.map(u32ToIp).join(',')}` : ''}`);
    log(st, `${h.name}: DHCPACK bound ${u32ToIp(m.yiaddr)}`);
    timer(st, h.id, c.leaseUs / 2, `dhcp:${c.gen}:renew`);
  } else if (m.msgType === DHCP_NAK) { term(h, `${c.iface}: DHCPNAK — restarting`); c.state = 'init'; doDiscover(st, h, c.iface, c.sock); }
}
function maskPrefix(m: number) { let n = 0, x = m >>> 0; while (x & 0x80000000) { n++; x = (x << 1) >>> 0; } return n; }
export function dhcpTimer(st: EngineState, h: HostState, gen: number, what: string) {
  const c = h.dhcpClient; if (!c || c.gen !== gen) return;
  if (what === 'timeout' && c.state !== 'bound') { term(h, `${c.iface}: no DHCPOFFER received, retrying`); doDiscover(st, h, c.iface, c.sock); }
  else if (what === 'renew' && c.state === 'bound') { term(h, `${c.iface}: renewing lease`); doDiscover(st, h, c.iface, c.sock); }
}
export function isDhcpSock(h: HostState, sockId: number) { return h.dhcpServerSock === sockId || h.dhcpClient?.sock === sockId; }
export function dhcpUdpDispatch(st: EngineState, h: HostState, sockId: number) {
  const sock = h.sockets[sockId]; if (sock?.proto !== 'udp') return;
  for (const dg of sock.rx.splice(0)) { if (dg.dport === 67 || sockId === h.dhcpServerSock) { const ifaceIdx = h.ifaces.findIndex(i => i.name === h.dhcpServer.iface); dhcpServerRx(st, h, ifaceIdx < 0 ? 0 : ifaceIdx, '', dg.data); } else dhcpClientRx(st, h, dg.data); }
}
void broadcastOf; void DHCP_NAK;
