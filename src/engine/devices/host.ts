// Host / router virtual OS: NICs, ARP, IPv4 (fragmentation, reassembly, forwarding), ICMP, sockets, processes.
import { BROADCAST_MAC, IP_BROADCAST, broadcastOf, u32ToIp, type Mac } from '@/shared/bytes';
import { decodeEthernet, encodeEthernet, ETH_P_ARP, ETH_P_IPV4 } from '../codecs/ethernet';
import { ARP_REPLY, ARP_REQUEST, decodeArp, encodeArp } from '../codecs/arp';
import { decodeIpv4, encodeIpv4, IPPROTO_ICMP, IPPROTO_TCP, IPPROTO_UDP, type Ipv4Packet } from '../codecs/ipv4';
import { decodeIcmp, encodeIcmp, ICMP_DEST_UNREACH, ICMP_ECHO, ICMP_ECHO_REPLY, ICMP_TIME_EXCEEDED } from '../codecs/icmp';
import { nicTx } from '../link';
import { log, timer, rand } from '../core';
import type { EngineState, HostState, Iface, Route, SimEvent } from '../types';
import { pingReply, pingArpFailed } from '../apps/ping';
import { trEchoReply } from '../apps/traceroute';
import { procTimer, deliverIcmpError, killProc } from '../apps/procs';
import { udpInput } from '../stack/udp';
import { serviceTimer } from '../apps/services';
import { rfSend } from '../wireless/medium';
import { tcpInput, tcpTimer, tcpOnPmtu, tcpOnIcmpUnreach } from '../stack/tcp';
import { ospfInput } from '../routing/ospf';
import { natForward, natExpire } from '../stack/nat';

export function term(h: HostState, line: string) { h.terminal.push(line); if (h.terminal.length > 1000) h.terminal.splice(0, h.terminal.length - 1000); }

// ---------- routing ----------
export function rebuildConnectedRoutes(h: HostState) {
  h.routes = h.routes.filter(r => r.kind !== 'connected');
  for (const i of h.ifaces) if (i.ip !== null && i.up) h.routes.push({ dst: (i.ip & i.mask) >>> 0, mask: i.mask, gw: null, iface: i.name, metric: 0, kind: 'connected' });
}
export function lookupRoute(h: HostState, dst: number): Route | null {
  let best: Route | null = null;
  for (const r of h.routes) {
    if (((dst & r.mask) >>> 0) !== ((r.dst & r.mask) >>> 0)) continue;
    const iface = h.ifaces.find(i => i.name === r.iface); if (!iface || !iface.up) continue;
    if (!best || r.mask > best.mask || (r.mask === best.mask && r.metric < best.metric)) best = r;
  }
  return best;
}
export function ifaceByName(h: HostState, name: string): { iface: Iface; idx: number } | null { const idx = h.ifaces.findIndex(i => i.name === name); return idx < 0 ? null : { iface: h.ifaces[idx]!, idx }; }
export function ownsIp(h: HostState, ip: number) { return h.ifaces.some(i => i.ip === ip); }
export function pathMtu(h: HostState, dst: number): number {
  const r = lookupRoute(h, dst); const i = r ? h.ifaces.find(x => x.name === r.iface) : undefined; let mtu = i?.mtu ?? 1500;
  const c = h.pmtu[u32ToIp(dst)]; if (c && c.mtu < mtu) mtu = c.mtu; return mtu;
}

// ---------- L2 send ----------
export function hostSendFrame(st: EngineState, h: HostState, ifaceIdx: number, dst: Mac, ethertype: number, payload: Uint8Array) {
  const iface = h.ifaces[ifaceIdx]!; if (!iface.up) { iface.txDrops++; return; }
  const bytes = encodeEthernet({ dst, src: iface.mac, ethertype, payload });
  iface.txPackets++; iface.txBytes += bytes.length;
  if (iface.wifi) { if (iface.wifi.associated === null) { iface.txDrops++; return; } if (!rfSend(st, h.id, ifaceIdx, bytes)) iface.txDrops++; return; }
  if (!nicTx(st, h.id, ifaceIdx, bytes)) iface.txDrops++;
}

// ---------- ARP ----------
export function arpLookup(h: HostState, ip: number, now: number): Mac | null { const e = h.arp[u32ToIp(ip)]; if (!e) return null; if (!e.static && e.expires <= now) { delete h.arp[u32ToIp(ip)]; return null; } return e.mac; }
export function arpRequest(st: EngineState, h: HostState, ifaceIdx: number, targetIp: number) {
  const iface = h.ifaces[ifaceIdx]!;
  hostSendFrame(st, h, ifaceIdx, BROADCAST_MAC, ETH_P_ARP, encodeArp({ oper: ARP_REQUEST, sha: iface.mac, spa: iface.ip ?? 0, tha: '00:00:00:00:00:00', tpa: targetIp }));
}
function arpResolveAndSend(st: EngineState, h: HostState, ifaceIdx: number, nextHop: number, ethertype: number, payload: Uint8Array) {
  const key = u32ToIp(nextHop); const mac = arpLookup(h, nextHop, st.time);
  if (mac) { hostSendFrame(st, h, ifaceIdx, mac, ethertype, payload); return; }
  const pend = h.arpPending[key];
  if (pend) { if (pend.frames.length < 32) pend.frames.push({ payload, ifaceIdx, ethertype }); return; }
  h.arpPending[key] = { ip: nextHop, frames: [{ payload, ifaceIdx, ethertype }], retries: 0, started: st.time };
  arpRequest(st, h, ifaceIdx, nextHop); timer(st, h.id, h.arpTimeoutUs, `arp:${key}`);
}
function onArpTimer(st: EngineState, h: HostState, key: string) {
  const pend = h.arpPending[key]; if (!pend) return;
  if (arpLookup(h, pend.ip, st.time)) { delete h.arpPending[key]; return; }
  if (pend.retries < h.arpRetries) { pend.retries++; arpRequest(st, h, pend.frames[0]?.ifaceIdx ?? 0, pend.ip); timer(st, h.id, h.arpTimeoutUs, `arp:${key}`); return; }
  log(st, `${h.name}: ARP for ${key} failed after ${pend.retries + 1} attempts, ${pend.frames.length} packet(s) dropped`);
  delete h.arpPending[key];
  const srcIp = h.ifaces[pend.frames[0]?.ifaceIdx ?? 0]!.ip ?? 0;
  for (const fr of pend.frames) {
    if (fr.ethertype !== ETH_P_IPV4) continue;
    let ip; try { ip = decodeIpv4(fr.payload, 0, fr.payload.length); } catch { continue; }
    if (ownsIp(h, ip.pkt.src)) { for (const p of Object.values(h.procs)) if (p.kind === 'ping' && !p.done && p.target === ip.pkt.dst) pingArpFailed(h, p, srcIp); }
    else sendIcmpError(st, h, fr.payload, 0, fr.payload.length, ICMP_DEST_UNREACH, 1); // router: host unreachable
  }
}
function onArpRx(st: EngineState, h: HostState, ifaceIdx: number, bytes: Uint8Array, start: number, end: number) {
  const iface = h.ifaces[ifaceIdx]!; const { pkt } = decodeArp(bytes, start, end);
  const forUs = iface.ip !== null && pkt.tpa === iface.ip; const spaKey = u32ToIp(pkt.spa);
  const gratuitous = pkt.spa === pkt.tpa; const existing = h.arp[spaKey];
  if (existing && existing.static) { /* static entries are immutable — this is exactly what defeats ARP spoofing */ }
  else if (forUs || existing || gratuitous) { h.arp[spaKey] = { mac: pkt.sha, expires: st.time + h.arpTtlUs, static: false }; flushPending(st, h, spaKey); }
  if (pkt.oper === ARP_REQUEST && forUs) hostSendFrame(st, h, ifaceIdx, pkt.sha, ETH_P_ARP, encodeArp({ oper: ARP_REPLY, sha: iface.mac, spa: iface.ip!, tha: pkt.sha, tpa: pkt.spa }));
}
function flushPending(st: EngineState, h: HostState, key: string) {
  const pend = h.arpPending[key]; if (!pend) return; delete h.arpPending[key];
  const mac = arpLookup(h, pend.ip, st.time); if (!mac) return;
  for (const fr of pend.frames) hostSendFrame(st, h, fr.ifaceIdx, mac, fr.ethertype, fr.payload);
}

// ---------- IPv4 send ----------
export type SendResult = { status: 'ok' } | { status: 'noroute' } | { status: 'fragneeded'; mtu: number };
export interface SendReq { dst: number; proto: number; ttl: number; payload: Uint8Array; src?: number; df?: boolean; buildPayload?: (src: number) => Uint8Array; tos?: number; egress?: string }
export function hostSendIp(st: EngineState, h: HostState, req: SendReq): SendResult {
  const isMcast = (req.dst >>> 28) === 0xe; // 224.0.0.0/4
  // Limited broadcast (255.255.255.255) or link-local multicast (224.0.0.x): send out the chosen interface, no route needed. Used by DHCP/OSPF.
  if (req.dst === IP_BROADCAST || isMcast) {
    const ifr = req.egress ? ifaceByName(h, req.egress) : null; const iface = (ifr ?? { iface: h.ifaces.find(i => i.up) })?.iface; const idx = iface ? h.ifaces.indexOf(iface) : -1;
    if (!iface || idx < 0) { h.counters.dropNoRoute++; return { status: 'noroute' }; }
    const src = req.src ?? iface.ip ?? 0; const payload = req.buildPayload ? req.buildPayload(src) : req.payload;
    const pkt: Ipv4Packet = { src, dst: IP_BROADCAST, proto: req.proto, ttl: req.ttl, id: Math.floor(rand(st) * 65536), df: false, mf: false, fragOffset: 0, payload };
    h.counters.ipTx++; hostSendFrame(st, h, idx, BROADCAST_MAC, ETH_P_IPV4, encodeIpv4(pkt)); return { status: 'ok' };
  }
  const r = lookupRoute(h, req.dst);
  if (!r) { h.counters.dropNoRoute++; log(st, `${h.name}: no route to ${u32ToIp(req.dst)}`); return { status: 'noroute' }; }
  const ifr = ifaceByName(h, r.iface)!; const iface = ifr.iface;
  const src = req.src ?? iface.ip ?? 0; const payload = req.buildPayload ? req.buildPayload(src) : req.payload;
  const pkt: Ipv4Packet = { src, dst: req.dst, proto: req.proto, ttl: req.ttl, id: Math.floor(rand(st) * 65536), df: req.df ?? false, mf: false, fragOffset: 0, dscp: (req.tos ?? 0) >> 2, ecn: (req.tos ?? 0) & 3, payload };
  const mtu = Math.min(iface.mtu, h.pmtu[u32ToIp(req.dst)]?.mtu ?? Infinity);
  if (20 + payload.length > mtu && pkt.df) return { status: 'fragneeded', mtu };
  h.counters.ipTx++;
  const isBcast = req.dst === IP_BROADCAST || (iface.ip !== null && req.dst === broadcastOf(iface.ip, iface.mask));
  const nextHop = r.gw ?? req.dst;
  for (const frag of fragment(h, pkt, mtu)) { if (isBcast) hostSendFrame(st, h, ifr.idx, BROADCAST_MAC, ETH_P_IPV4, frag); else arpResolveAndSend(st, h, ifr.idx, nextHop, ETH_P_IPV4, frag); }
  return { status: 'ok' };
}
/** Split an IPv4 packet into fragments that fit `mtu` (encoded bytes). */
export function fragment(h: HostState, pkt: Ipv4Packet, mtu: number): Uint8Array[] {
  if (20 + pkt.payload.length <= mtu) return [encodeIpv4(pkt)];
  const chunk = Math.floor((mtu - 20) / 8) * 8; const out: Uint8Array[] = []; const base = pkt.fragOffset * 8;
  for (let off = 0; off < pkt.payload.length; off += chunk) {
    const last = off + chunk >= pkt.payload.length;
    out.push(encodeIpv4({ ...pkt, payload: pkt.payload.subarray(off, off + chunk), fragOffset: (base + off) / 8, mf: !last || pkt.mf })); h.counters.fragsTx++;
  }
  return out;
}

// ---------- ICMP errors ----------
export function sendIcmpError(st: EngineState, h: HostState, bytes: Uint8Array, ipStart: number, ipEnd: number, type: number, code: number, mtu?: number) {
  let ip; try { ip = decodeIpv4(bytes, ipStart, ipEnd); } catch { return; }
  if (ip.pkt.fragOffset !== 0) return; if (ip.pkt.dst === IP_BROADCAST) return;
  if (ip.pkt.proto === IPPROTO_ICMP) { const t = bytes[ip.payloadStart]; if (t !== ICMP_ECHO && t !== ICMP_ECHO_REPLY) return; } // never answer an ICMP error with an error
  const inner = bytes.slice(ipStart, Math.min(ipEnd, ip.payloadStart + 8));
  h.counters.icmpTx++;
  hostSendIp(st, h, { dst: ip.pkt.src, proto: IPPROTO_ICMP, ttl: 64, payload: encodeIcmp({ type, code, mtu, data: inner }) });
}

// ---------- receive ----------
export function hostRx(st: EngineState, h: HostState, ifaceIdx: number, bytes: Uint8Array) {
  const iface = h.ifaces[ifaceIdx]; if (!iface || !iface.up) return;
  iface.rxPackets++; iface.rxBytes += bytes.length;
  let e; try { e = decodeEthernet(bytes); } catch { iface.rxDrops++; return; }
  if (!e.fcsOk) { iface.rxDrops++; h.counters.dropBadChecksum++; log(st, `${h.name}: dropped frame with bad FCS`); return; }
  if (e.dst !== iface.mac && e.dst !== BROADCAST_MAC && !iface.promisc) { h.counters.dropNotForMe++; return; }
  if (e.ethertype === ETH_P_ARP) { onArpRx(st, h, ifaceIdx, bytes, e.payloadStart, e.payloadEnd); return; }
  if (e.ethertype === ETH_P_IPV4) { onIpRx(st, h, ifaceIdx, bytes, e.payloadStart, e.payloadEnd); return; }
}
function onIpRx(st: EngineState, h: HostState, ifaceIdx: number, bytes: Uint8Array, start: number, end: number) {
  const iface = h.ifaces[ifaceIdx]!;
  let ip; try { ip = decodeIpv4(bytes, start, end); } catch { iface.rxDrops++; return; }
  if (!ip.checksumOk) { h.counters.dropBadChecksum++; log(st, `${h.name}: dropped IPv4 packet with bad header checksum`); return; }
  h.counters.ipRx++; const end2 = ip.payloadEnd;
  const isMcast = (ip.pkt.dst >>> 28) === 0xe;
  // NAT reverse: a datagram arriving on the outside interface, addressed to our outside IP, that
  // matches a translation or port-forward is rewritten and forwarded to the inside host.
  if (h.nat.enabled && iface.name === h.nat.outsideIface && ownsIp(h, ip.pkt.dst)) {
    const translated = natForward(st, h, bytes, start, end2, iface.name, h.nat.outsideIface);
    if (translated && translated !== bytes) { const d2 = decodeIpv4(translated, 0, translated.length); ipForward(st, h, d2.pkt, translated, 0, translated.length, iface.name); return; }
  }
  const forMe = ownsIp(h, ip.pkt.dst) || ip.pkt.dst === IP_BROADCAST || isMcast || (iface.ip !== null && ip.pkt.dst === broadcastOf(iface.ip, iface.mask));
  if (!forMe) { if (h.forwarding) ipForward(st, h, ip.pkt, bytes, start, end2, iface.name); else h.counters.dropNotForMe++; return; }
  if (ip.pkt.mf || ip.pkt.fragOffset) { reassemble(st, h, ip.pkt, bytes, start, end2, ifaceIdx); return; }
  deliverLocal(st, h, ip.pkt, bytes, start, ip.payloadStart, end2, ifaceIdx);
}
function deliverLocal(st: EngineState, h: HostState, pkt: Ipv4Packet, bytes: Uint8Array, ipStart: number, payloadStart: number, end: number, ifaceIdx: number) {
  switch (pkt.proto) {
    case IPPROTO_ICMP: onIcmpRx(st, h, pkt, bytes, payloadStart, end); break;
    case IPPROTO_UDP: udpInput(st, h, pkt, bytes, payloadStart, end, ipStart); break;
    case IPPROTO_TCP: tcpInput(st, h, pkt, bytes, payloadStart, end, ifaceIdx); break;
    case 89: ospfInput(st, h, pkt, bytes, payloadStart, end); break;
    default: sendIcmpError(st, h, bytes, ipStart, end, ICMP_DEST_UNREACH, 2);
  }
}
function ipForward(st: EngineState, h: HostState, pkt: Ipv4Packet, bytes: Uint8Array, start: number, end: number, inIface = '') {
  if (pkt.ttl <= 1) { h.counters.dropTtl++; log(st, `${h.name}: TTL exceeded for ${u32ToIp(pkt.src)} → ${u32ToIp(pkt.dst)}`); sendIcmpError(st, h, bytes, start, end, ICMP_TIME_EXCEEDED, 0); return; }
  const r = lookupRoute(h, pkt.dst);
  if (!r) { h.counters.dropNoRoute++; log(st, `${h.name}: no route to ${u32ToIp(pkt.dst)}, sending net unreachable`); sendIcmpError(st, h, bytes, start, end, ICMP_DEST_UNREACH, 0); return; }
  const ifr = ifaceByName(h, r.iface)!;
  // Source NAT on egress out the outside interface.
  if (h.nat.enabled && r.iface === h.nat.outsideIface && inIface && h.nat.insideIfaces.includes(inIface)) {
    const translated = natForward(st, h, bytes, start, end, inIface, r.iface);
    if (translated === null) { h.counters.dropNotForMe++; return; }
    if (translated !== bytes) { const d2 = decodeIpv4(translated, 0, translated.length); pkt = d2.pkt; bytes = translated; start = 0; end = translated.length; }
  }
  const out: Ipv4Packet = { ...pkt, ttl: pkt.ttl - 1 };
  if (20 + out.payload.length > ifr.iface.mtu) {
    if (out.df) { log(st, `${h.name}: packet ${20 + out.payload.length} B > MTU ${ifr.iface.mtu} on ${ifr.iface.name} with DF set → frag needed`); sendIcmpError(st, h, bytes, start, end, ICMP_DEST_UNREACH, 4, ifr.iface.mtu); return; }
    log(st, `${h.name}: fragmenting ${20 + out.payload.length} B packet for MTU ${ifr.iface.mtu}`);
  }
  h.counters.ipFwd++;
  const nextHop = r.gw ?? pkt.dst;
  for (const frag of fragment(h, out, ifr.iface.mtu)) arpResolveAndSend(st, h, ifr.idx, nextHop, ETH_P_IPV4, frag);
}
function reassemble(st: EngineState, h: HostState, pkt: Ipv4Packet, bytes: Uint8Array, start: number, end: number, ifaceIdx: number) {
  h.counters.fragsRx++; const key = `${pkt.src}-${pkt.dst}-${pkt.id}-${pkt.proto}`;
  let rb = h.reasm[key];
  if (!rb) { rb = { src: pkt.src, dst: pkt.dst, id: pkt.id, proto: pkt.proto, frags: [], totalLen: null, started: st.time, firstHdr: null, ttl: pkt.ttl }; h.reasm[key] = rb; timer(st, h.id, h.reasmTimeoutUs, `reasm:${key}`); }
  const off = pkt.fragOffset * 8; rb.frags.push({ off, data: pkt.payload.slice(), mf: pkt.mf });
  if (off === 0) rb.firstHdr = bytes.slice(start, start + 20); if (!pkt.mf) rb.totalLen = off + pkt.payload.length;
  if (rb.totalLen === null || rb.firstHdr === null) return;
  // check coverage
  const sorted = [...rb.frags].sort((a, b) => a.off - b.off); let need = 0;
  for (const f of sorted) { if (f.off > need) return; need = Math.max(need, f.off + f.data.length); }
  if (need < rb.totalLen) return;
  const payload = new Uint8Array(rb.totalLen); for (const f of sorted) payload.set(f.data.subarray(0, Math.min(f.data.length, rb.totalLen - f.off)), f.off);
  delete h.reasm[key]; h.counters.reasmOk++; log(st, `${h.name}: reassembled ${rb.frags.length} fragments (${rb.totalLen} bytes) id=0x${pkt.id.toString(16)}`);
  const full: Ipv4Packet = { ...pkt, mf: false, fragOffset: 0, payload };
  const whole = encodeIpv4(full);
  deliverLocal(st, h, full, whole, 0, 20, whole.length, ifaceIdx);
}
function onReasmTimer(st: EngineState, h: HostState, key: string) {
  const rb = h.reasm[key]; if (!rb) return; delete h.reasm[key]; h.counters.reasmFail++;
  log(st, `${h.name}: reassembly timeout for id=0x${rb.id.toString(16)} (${rb.frags.length} fragments)`);
  if (rb.firstHdr) { const first = rb.frags.find(f => f.off === 0)!; const orig = new Uint8Array(20 + first.data.length); orig.set(rb.firstHdr); orig.set(first.data, 20); sendIcmpError(st, h, orig, 0, orig.length, ICMP_TIME_EXCEEDED, 1); }
}
function onIcmpRx(st: EngineState, h: HostState, ip: Ipv4Packet, bytes: Uint8Array, start: number, end: number) {
  let ic; try { ic = decodeIcmp(bytes, start, end); } catch { return; }
  if (!ic.checksumOk) { h.counters.dropBadChecksum++; return; }
  h.counters.icmpRx++; const p = ic.pkt;
  if (p.type === ICMP_ECHO) { h.counters.icmpTx++; hostSendIp(st, h, { dst: ip.src, proto: IPPROTO_ICMP, ttl: 64, payload: encodeIcmp({ type: ICMP_ECHO_REPLY, code: 0, id: p.id, seq: p.seq, data: p.data }) }); return; }
  if (p.type === ICMP_ECHO_REPLY) { for (const pr of Object.values(h.procs)) { if (pr.kind === 'ping' && pr.ident === p.id) pingReply(st, h, pr, p.seq ?? 0, ip.ttl, end - start, ip.src); else if (pr.kind === 'traceroute' && pr.icmpMode && pr.ident === p.id) trEchoReply(st, h, pr, p.seq ?? 0, ip.src); } return; }
  if (p.type === ICMP_DEST_UNREACH || p.type === ICMP_TIME_EXCEEDED) {
    if (p.data.length < 28) return; const d = p.data; const ihl = (d[0]! & 15) * 4; const proto = d[9]!; const src = ((d[12]! << 24) | (d[13]! << 16) | (d[14]! << 8) | d[15]!) >>> 0; const dst = ((d[16]! << 24) | (d[17]! << 16) | (d[18]! << 8) | d[19]!) >>> 0;
    if (!ownsIp(h, src)) return; const q = ihl; const w0 = (d[q]! << 8) | d[q + 1]!, w1 = (d[q + 2]! << 8) | d[q + 3]!;
    if (p.type === ICMP_DEST_UNREACH && p.code === 4) { let mtu = p.mtu ?? 0; if (!mtu) { const cur = pathMtu(h, dst); mtu = [1500, 1492, 1006, 576, 296, 68].find(m => m < cur) ?? 68; } h.pmtu[u32ToIp(dst)] = { mtu, expires: st.time + 600e6 }; log(st, `${h.name}: path MTU to ${u32ToIp(dst)} is now ${mtu}`); if (proto === IPPROTO_TCP) tcpOnPmtu(st, h, dst); }
    if (proto === IPPROTO_TCP && p.type === ICMP_DEST_UNREACH && (p.code === 0 || p.code === 1 || p.code === 3)) tcpOnIcmpUnreach(st, h, dst, w0, w1, ['Network is unreachable', 'No route to host', '', 'Connection refused'][p.code]!);
    const ev = { type: 'icmpError' as const, from: ip.src, icmpType: p.type, code: p.code, mtu: p.mtu, dst, sport: proto === IPPROTO_UDP || proto === IPPROTO_TCP ? w0 : undefined, dport: proto === IPPROTO_UDP || proto === IPPROTO_TCP ? w1 : undefined, ident: proto === IPPROTO_ICMP ? ((d[q + 4]! << 8) | d[q + 5]!) : undefined, seq: proto === IPPROTO_ICMP ? ((d[q + 6]! << 8) | d[q + 7]!) : undefined };
    deliverIcmpError(st, h, ev, proto);
  }
}

// ---------- processes / timers ----------
export function hostKillProcs(st: EngineState, h: HostState) { for (const p of Object.values(h.procs)) killProc(st, h, p); }
export function hostTimer(st: EngineState, h: HostState, ev: Extract<SimEvent, { kind: 'timer' }>) {
  const tag = ev.tag;
  if (tag.startsWith('arp:')) { onArpTimer(st, h, tag.slice(4)); return; }
  if (tag.startsWith('reasm:')) { onReasmTimer(st, h, tag.slice(6)); return; }
  if (tag.startsWith('tcp:')) { tcpTimer(st, h, tag, ev.data); return; }
  if (tag.startsWith('proc:')) { const [, pidS, what] = tag.split(':'); procTimer(st, h, Number(pidS), what!, ev.data); return; }
  if (tag.startsWith('dhcp:') || tag.startsWith('dns:') || tag.startsWith('rip:') || tag.startsWith('ospf:') || tag.startsWith('bgp:')) { serviceTimer(st, h, tag, ev.data); return; }
}
export function setDefaultGatewayLocal(h: HostState, gw: number | null) { h.routes = h.routes.filter(r => r.kind !== 'default'); if (gw !== null) { const via = h.ifaces.find(i => i.ip !== null && ((i.ip & i.mask) >>> 0) === ((gw & i.mask) >>> 0)); if (via) h.routes.push({ dst: 0, mask: 0, gw, iface: via.name, metric: 1, kind: 'default' }); } }
export function arpSpoof(st: EngineState, h: HostState, spoofedIp: number, targetIp: number | null) {
  // Gratuitous/unsolicited ARP reply claiming spoofedIp is at our MAC — poisons the target's cache.
  const iface = h.ifaces[0]!; if (iface.ip === null) return;
  const reply = encodeArp({ oper: ARP_REPLY, sha: iface.mac, spa: spoofedIp, tha: targetIp === null ? iface.mac : arpLookup(h, targetIp, st.time) ?? 'ff:ff:ff:ff:ff:ff', tpa: targetIp ?? spoofedIp });
  hostSendFrame(st, h, 0, targetIp === null ? BROADCAST_MAC : (arpLookup(h, targetIp, st.time) ?? BROADCAST_MAC), ETH_P_ARP, reply);
}
export { startPing } from '../apps/ping';
