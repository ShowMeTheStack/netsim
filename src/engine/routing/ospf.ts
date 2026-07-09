// OSPFv2 single-area: Hello adjacency, router-LSA origination, reliable-ish LSA flooding,
// and Dijkstra SPF over the link-state database. Point-to-point links (no DR election needed
// for the common lab topologies). Readable reference implementation.
import { u32ToIp, sameSubnet } from '@/shared/bytes';
import { encodeHello, encodeLsu, decodeOspf, OSPF_HELLO, OSPF_LSU, LSA_ROUTER, type Lsa } from '../codecs/ospf';
import { IPPROTO_OSPF, type Ipv4Packet } from '../codecs/ipv4';
import { hostSendIp, rebuildConnectedRoutes } from '../devices/host';
import { timer, log, SEC } from '../core';
import type { EngineState, HostState, OspfConfig, OspfNeighbor } from '../types';

const ALLSPF = 0xe0000005; // 224.0.0.5

function rid(h: HostState, cfg: OspfConfig) { if (cfg.routerId) return cfg.routerId; const ips = h.ifaces.filter(i => i.ip !== null).map(i => i.ip!); cfg.routerId = ips.length ? Math.max(...ips) : h.id; return cfg.routerId; }
function ospfIfaces(h: HostState) { const cfg = h.routing.ospf; return h.ifaces.filter(i => i.ip !== null && i.up && cfg.networks.some(n => sameSubnet(i.ip!, n.net, n.mask))); }
function cost(cfg: OspfConfig, iface: string) { return cfg.ifaceCosts[iface] ?? 10; }

export function ospfStart(st: EngineState, h: HostState) {
  const cfg = h.routing.ospf; if (!cfg.enabled) return; rid(h, cfg); cfg.gen++;
  log(st, `${h.name}: OSPF router ${u32ToIp(cfg.routerId)} area ${cfg.areaId} on ${ospfIfaces(h).map(i => i.name).join(', ') || 'no interfaces'}`);
  originateLsa(st, h); sendHellos(st, h); timer(st, h.id, cfg.helloUs, `ospf:${cfg.gen}:hello`);
}
function sendHellos(st: EngineState, h: HostState) {
  const cfg = h.routing.ospf;
  for (const i of ospfIfaces(h)) {
    const nbrs = Object.values(cfg.neighbors).filter(n => n.iface === i.name && n.state !== 'down').map(n => n.routerId);
    hostSendIp(st, h, { dst: ALLSPF, proto: IPPROTO_OSPF, ttl: 1, src: i.ip!, egress: i.name, payload: encodeHello({ header: { version: 2, type: OSPF_HELLO, routerId: cfg.routerId, areaId: cfg.areaId }, netMask: i.mask, helloInterval: cfg.helloUs / 1e6, deadInterval: cfg.deadUs / 1e6, dr: 0, bdr: 0, neighbors: nbrs }) });
  }
}
export function ospfInput(st: EngineState, h: HostState, ip: Ipv4Packet, bytes: Uint8Array, start: number, end: number) {
  const cfg = h.routing.ospf; if (!cfg.enabled) return; const d = decodeOspf(bytes, start, end); if (d.header.routerId === cfg.routerId) return;
  const iface = h.ifaces.find(i => i.ip !== null && sameSubnet(i.ip, ip.src, i.mask)); if (!iface) return;
  if (d.hello) {
    let nb = cfg.neighbors[d.header.routerId]; if (!nb) { nb = { routerId: d.header.routerId, ip: ip.src, iface: iface.name, state: 'init', dead: 0, lastSeq: 0 }; cfg.neighbors[d.header.routerId] = nb; log(st, `${h.name}: OSPF neighbor ${u32ToIp(d.header.routerId)} on ${iface.name} (init)`); }
    nb.ip = ip.src; nb.dead = st.time + cfg.deadUs;
    const wasFull = nb.state === 'full';
    if (d.hello.neighbors.includes(cfg.routerId)) { if (nb.state !== 'full') { nb.state = 'full'; log(st, `${h.name}: OSPF adjacency with ${u32ToIp(d.header.routerId)} is FULL`); } } else if (nb.state === 'init') nb.state = 'two-way';
    if (nb.state === 'full' && !wasFull) { originateLsa(st, h); sendHellos(st, h); floodDatabase(st, h, nb); runSpf(st, h); }
    return;
  }
  if (d.lsu) { let changed = false; for (const lsa of d.lsu.lsas) if (installLsa(st, h, lsa)) { changed = true; floodLsa(st, h, lsa, ip.src); } if (changed) runSpf(st, h); }
}
function lsaKey(type: number, lsId: number, adv: number) { return `${type}:${lsId}:${adv}`; }
function originateLsa(st: EngineState, h: HostState) {
  const cfg = h.routing.ospf; const links = [];
  for (const i of ospfIfaces(h)) { const nbrs = Object.values(cfg.neighbors).filter(n => n.iface === i.name && n.state === 'full');
    for (const n of nbrs) links.push({ linkId: n.routerId, linkData: i.ip!, type: 1, metric: cost(cfg, i.name) }); // p2p to neighbor
    links.push({ linkId: (i.ip! & i.mask) >>> 0, linkData: i.mask, type: 3, metric: cost(cfg, i.name) }); // stub net
  }
  const lsa: Lsa = { header: { age: 0, type: LSA_ROUTER, lsId: cfg.routerId, advRouter: cfg.routerId, seq: cfg.seq++ }, links };
  installLsa(st, h, lsa); floodLsa(st, h, lsa, 0); runSpf(st, h);
}
function installLsa(st: EngineState, h: HostState, lsa: Lsa): boolean {
  const cfg = h.routing.ospf; const key = lsaKey(lsa.header.type, lsa.header.lsId, lsa.header.advRouter); const cur = cfg.lsdb[key];
  if (cur && (lsa.header.seq | 0) <= (cur.seq | 0)) return false;
  cfg.lsdb[key] = { advRouter: lsa.header.advRouter, lsId: lsa.header.lsId, type: lsa.header.type, seq: lsa.header.seq, age: lsa.header.age, links: lsa.links, attached: lsa.attachedRouters, netMask: lsa.netMask, installedAt: st.time };
  return true;
}
function floodLsa(st: EngineState, h: HostState, lsa: Lsa, exceptSrc: number) {
  const cfg = h.routing.ospf;
  for (const i of ospfIfaces(h)) for (const n of Object.values(cfg.neighbors)) { if (n.iface !== i.name || n.state !== 'full' || n.ip === exceptSrc) continue; hostSendIp(st, h, { dst: n.ip, proto: IPPROTO_OSPF, ttl: 1, src: i.ip!, egress: i.name, payload: encodeLsu({ header: { version: 2, type: OSPF_LSU, routerId: cfg.routerId, areaId: cfg.areaId }, lsas: [lsa] }) }); }
}
function floodDatabase(st: EngineState, h: HostState, nb: OspfNeighbor) {
  const cfg = h.routing.ospf; const i = h.ifaces.find(x => x.name === nb.iface); if (!i || i.ip === null) return;
  const lsas: Lsa[] = Object.values(cfg.lsdb).map(e => ({ header: { age: 0, type: e.type, lsId: e.lsId, advRouter: e.advRouter, seq: e.seq }, links: e.links, attachedRouters: e.attached, netMask: e.netMask }));
  if (lsas.length) hostSendIp(st, h, { dst: nb.ip, proto: IPPROTO_OSPF, ttl: 1, src: i.ip, egress: i.name, payload: encodeLsu({ header: { version: 2, type: OSPF_LSU, routerId: cfg.routerId, areaId: cfg.areaId }, lsas }) });
}
/** Dijkstra over router-LSAs. Produces routes to stub networks with total path cost. */
function runSpf(st: EngineState, h: HostState) {
  const cfg = h.routing.ospf; const self = cfg.routerId;
  const routers = new Map<number, { links?: { linkId: number; linkData: number; type: number; metric: number }[] }>();
  for (const e of Object.values(cfg.lsdb)) if (e.type === LSA_ROUTER) routers.set(e.advRouter, { links: e.links });
  const dist = new Map<number, number>(); const prevHopIface = new Map<number, { gw: number; iface: string }>(); dist.set(self, 0);
  const visited = new Set<number>();
  for (;;) {
    let u = -1, best = Infinity; for (const [r, d] of dist) if (!visited.has(r) && d < best) { best = d; u = r; }
    if (u === -1) break; visited.add(u); const node = routers.get(u); if (!node?.links) continue;
    for (const lk of node.links) { if (lk.type !== 1) continue; const v = lk.linkId; if (!routers.has(v)) continue; const nd = best + lk.metric;
      if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd);
        // next hop: if u is self, the gw is the neighbor's IP on that link; else inherit u's next hop
        if (u === self) { const nb = Object.values(cfg.neighbors).find(n => n.routerId === v); prevHopIface.set(v, { gw: nb?.ip ?? 0, iface: nb?.iface ?? '' }); }
        else { const p = prevHopIface.get(u); if (p) prevHopIface.set(v, p); }
      }
    }
  }
  // stub networks from every reachable router-LSA
  const spf: OspfConfig['spf'] = [];
  for (const [r, d] of dist) { const node = routers.get(r); if (!node?.links) continue; for (const lk of node.links) if (lk.type === 3) { const net = lk.linkId >>> 0, mask = lk.linkData >>> 0; if (h.ifaces.some(i => i.ip !== null && ((i.ip & i.mask) >>> 0) === net)) continue; const nh = r === self ? { gw: 0, iface: '' } : prevHopIface.get(r); if (!nh || nh.gw === 0) continue; const total = d + lk.metric; const ex = spf.find(x => x.dst === net && x.mask === mask); if (!ex || total < ex.cost) { if (ex) { ex.gw = nh.gw; ex.iface = nh.iface; ex.cost = total; } else spf.push({ dst: net, mask, gw: nh.gw, iface: nh.iface, cost: total }); } } }
  cfg.spf = spf; installOspf(h); void u32ToIp; void st;
}
function installOspf(h: HostState) { h.routes = h.routes.filter(r => r.kind !== 'ospf'); rebuildConnectedRoutes(h); for (const r of h.routing.ospf.spf) h.routes.push({ dst: r.dst, mask: r.mask, gw: r.gw, iface: r.iface, metric: r.cost, kind: 'ospf' }); }
export function ospfTimer(st: EngineState, h: HostState, gen: number, what: string) {
  const cfg = h.routing.ospf; if (!cfg.enabled || cfg.gen !== gen) return;
  if (what === 'hello') { let dead = false; for (const [id, n] of Object.entries(cfg.neighbors)) if (n.dead && st.time >= n.dead) { delete cfg.neighbors[Number(id)]; dead = true; log(st, `${h.name}: OSPF neighbor ${u32ToIp(Number(id))} dead`); } if (dead) { originateLsa(st, h); } sendHellos(st, h); timer(st, h.id, cfg.helloUs, `ospf:${gen}:hello`); }
}
void SEC;
