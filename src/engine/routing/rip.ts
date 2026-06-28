// RIPv2 distance-vector daemon. Periodic (30s) + triggered updates, split horizon with poison
// reverse, route timeout (180s) and garbage collection (120s). Metric = hop count, infinity = 16.
// This is the readable reference implementation students inspect and tweak (timers/costs/flags).
import { u32ToIp, sameSubnet, IP_BROADCAST } from '@/shared/bytes';
import { encodeRip, decodeRipPacket, RIP_REQUEST, RIP_RESPONSE, RIP_INFINITY, type RipEntry } from '../codecs/rip';
import { IPPROTO_UDP } from '../codecs/ipv4';
import { encodeUdp } from '../codecs/udp';
import { hostSendIp, rebuildConnectedRoutes } from '../devices/host';
import { udpSocket } from '../stack/udp';
import { timer, rand, SEC, log } from '../core';
import type { EngineState, HostState, RipRoute, UdpSocket } from '../types';

const RIP_MCAST = IP_BROADCAST; // simplified: use broadcast rather than 224.0.0.9

export function ripStart(st: EngineState, h: HostState) {
  const cfg = h.routing.rip; if (!cfg.enabled) return;
  if (cfg.sock === null || !h.sockets[cfg.sock]) { const s = udpSocket(h, -4, 520); if (typeof s === 'string') { const ex = Object.values(h.sockets).find(x => x.proto === 'udp' && x.localPort === 520); if (ex) cfg.sock = ex.id; else return; } else { (s as UdpSocket).localIp = null; cfg.sock = s.id; } }
  cfg.gen++; log(st, `${h.name}: RIP enabled on ${cfg.networks.map(n => u32ToIp(n.net)).join(', ') || 'no networks'}`);
  ripRequestAll(st, h); ripSendUpdate(st, h, false);
  timer(st, h.id, cfg.updateUs + rand(st) * SEC, `rip:${cfg.gen}:update`);
}
function ifacesInRip(h: HostState) { return h.ifaces.filter(i => i.ip !== null && i.up && h.routing.rip.networks.some(n => sameSubnet(i.ip!, n.net, n.mask))); }
function ripRequestAll(st: EngineState, h: HostState) { const cfg = h.routing.rip; const req = encodeRip({ command: RIP_REQUEST, version: 2, entries: [{ af: 0, tag: 0, addr: 0, mask: 0, nextHop: 0, metric: RIP_INFINITY }] }); for (const i of ifacesInRip(h)) sendRip(st, h, i.ip!, RIP_MCAST, req); }

function ownRoutes(h: HostState): { dst: number; mask: number; metric: number; gw: number; iface: string }[] {
  const cfg = h.routing.rip; const out: { dst: number; mask: number; metric: number; gw: number; iface: string }[] = [];
  for (const i of ifacesInRip(h)) out.push({ dst: (i.ip! & i.mask) >>> 0, mask: i.mask, metric: 0, gw: 0, iface: i.name });
  for (const r of cfg.routes) if (r.metric < RIP_INFINITY) out.push({ dst: r.dst, mask: r.mask, metric: r.metric, gw: r.gw, iface: r.iface });
  return out;
}
export function ripSendUpdate(st: EngineState, h: HostState, triggeredOnly: boolean) {
  const cfg = h.routing.rip;
  for (const i of ifacesInRip(h)) {
    const entries: RipEntry[] = [];
    for (const r of ownRoutes(h)) {
      if (triggeredOnly) { const rr = cfg.routes.find(x => x.dst === r.dst && x.mask === r.mask); if (r.iface !== '' && r.metric > 0 && !(rr && rr.changed)) continue; }
      let metric = r.metric;
      // split horizon: don't advertise a route back out the interface we learned it on
      if (r.iface === i.name && r.metric > 0) { if (cfg.poisonReverse) metric = RIP_INFINITY; else if (cfg.splitHorizon) continue; }
      entries.push({ af: 2, tag: 0, addr: r.dst, mask: r.mask, nextHop: 0, metric });
    }
    if (entries.length) sendRip(st, h, i.ip!, RIP_MCAST, encodeRip({ command: RIP_RESPONSE, version: 2, entries }));
  }
  if (triggeredOnly) for (const r of cfg.routes) r.changed = false;
}
function sendRip(st: EngineState, h: HostState, src: number, dst: number, payload: Uint8Array) {
  hostSendIp(st, h, { dst, proto: IPPROTO_UDP, ttl: 1, src, egress: h.ifaces.find(i => i.ip === src)?.name, payload: new Uint8Array(0), buildPayload: () => encodeUdp({ sport: 520, dport: 520, data: payload }, src, dst) });
}
export function ripInput(st: EngineState, h: HostState, srcIp: number, data: Uint8Array) {
  const cfg = h.routing.rip; if (!cfg.enabled) return; const pkt = decodeRipPacket(data, 0, data.length);
  const iface = h.ifaces.find(i => i.ip !== null && sameSubnet(i.ip, srcIp, i.mask)); if (!iface) return;
  if (pkt.command === RIP_REQUEST) { ripSendUpdate(st, h, false); return; }
  let changed = false;
  for (const e of pkt.entries) {
    if (e.af !== 2) continue; const metric = Math.min(RIP_INFINITY, e.metric + 1);
    if (h.ifaces.some(i => i.ip !== null && ((i.ip & i.mask) >>> 0) === ((e.addr & e.mask) >>> 0))) continue; // our own connected net
    const existing = cfg.routes.find(r => r.dst === e.addr && r.mask === e.mask);
    if (!existing) {
      if (metric >= RIP_INFINITY) continue;
      cfg.routes.push({ dst: e.addr, mask: e.mask, gw: srcIp, iface: iface.name, metric, learnedFrom: srcIp, timeout: st.time + cfg.timeoutUs, gc: null, changed: true }); changed = true;
      log(st, `${h.name}: RIP learned ${u32ToIp(e.addr)}/${maskLen(e.mask)} via ${u32ToIp(srcIp)} metric ${metric}`);
    } else {
      const better = metric < existing.metric; const fromSame = existing.learnedFrom === srcIp;
      if (better || fromSame) {
        if (fromSame && metric >= RIP_INFINITY && existing.metric < RIP_INFINITY) { existing.metric = RIP_INFINITY; existing.gc = st.time + cfg.gcUs; existing.changed = true; changed = true; log(st, `${h.name}: RIP route ${u32ToIp(e.addr)} became unreachable`); }
        else if (metric < RIP_INFINITY) { existing.metric = metric; existing.gw = srcIp; existing.iface = iface.name; existing.learnedFrom = srcIp; existing.timeout = st.time + cfg.timeoutUs; existing.gc = null; if (better) existing.changed = true; changed = better; }
      }
    }
  }
  installRip(h); if (changed) ripSendUpdate(st, h, true);
}
function installRip(h: HostState) {
  h.routes = h.routes.filter(r => r.kind !== 'rip'); rebuildConnectedRoutes(h);
  for (const r of h.routing.rip.routes) if (r.metric < RIP_INFINITY) h.routes.push({ dst: r.dst, mask: r.mask, gw: r.gw, iface: r.iface, metric: r.metric, kind: 'rip' });
}
export function ripTimer(st: EngineState, h: HostState, gen: number, what: string) {
  const cfg = h.routing.rip; if (!cfg.enabled || cfg.gen !== gen) return;
  if (what === 'update') {
    // expire timed-out routes and collect garbage
    let changed = false; for (const r of cfg.routes) { if (r.gc === null && st.time >= r.timeout) { r.metric = RIP_INFINITY; r.gc = st.time + cfg.gcUs; r.changed = true; changed = true; log(st, `${h.name}: RIP route ${u32ToIp(r.dst)} timed out`); } }
    cfg.routes = cfg.routes.filter(r => r.gc === null || st.time < r.gc);
    installRip(h); ripSendUpdate(st, h, false); if (changed) { /* already advertised via full update */ }
    timer(st, h.id, cfg.updateUs + rand(st) * SEC, `rip:${gen}:update`);
  }
}
function maskLen(m: number) { let n = 0, x = m >>> 0; while (x & 0x80000000) { n++; x = (x << 1) >>> 0; } return n; }
export function isRipSock(h: HostState, sockId: number) { return h.routing.rip.sock === sockId; }
export function ripUdpDispatch(st: EngineState, h: HostState, sockId: number) { const s = h.sockets[sockId]; if (s?.proto !== 'udp') return; for (const dg of s.rx.splice(0)) ripInput(st, h, dg.src, dg.data); }
