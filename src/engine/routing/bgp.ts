// BGP-4: eBGP + iBGP sessions over TCP 179. OPEN/KEEPALIVE/UPDATE, best-path selection
// (local-pref, AS-path length, origin, MED), and iBGP with optional route-reflector behavior.
// Readable reference implementation.
import { u32ToIp, sameSubnet } from '@/shared/bytes';
import { encodeBgp, decodeBgpMessages, BGP_OPEN, BGP_UPDATE, BGP_KEEPALIVE, type BgpMessage, type BgpRoute } from '../codecs/bgp';
import { tcpSocket, tcpConnect, tcpListen, tcpAccept, tcpSend, tcpRecv, tcpClose } from '../stack/tcp';
import { rebuildConnectedRoutes, lookupRoute } from '../devices/host';
import { timer, log, SEC } from '../core';
import type { EngineState, HostState, BgpConfig, BgpNeighborCfg, BgpRibEntry, TcpSocket } from '../types';

export function bgpStart(st: EngineState, h: HostState) {
  const cfg = h.routing.bgp; if (!cfg.enabled) return; if (!cfg.routerId) cfg.routerId = Math.max(...h.ifaces.filter(i => i.ip !== null).map(i => i.ip!), h.id);
  // passive listener
  if (!Object.values(h.sockets).some(s => s.proto === 'tcp' && s.state === 'LISTEN' && s.localPort === 179)) { const ls = tcpSocket(st, h, -5); tcpListen(st, h, ls, 179); h.bgpListen = ls.id; }
  log(st, `${h.name}: BGP AS${cfg.as} router-id ${u32ToIp(cfg.routerId)}${cfg.routeReflector ? ' (route reflector)' : ''}`);
  for (const nb of cfg.neighbors) { nb.gen = (nb.gen ?? 0) + 1; if (nb.state === 'idle' && bestSrc(h, nb) > nb.peerIp) bgpConnect(st, h, nb); }
}
function bgpConnect(st: EngineState, h: HostState, nb: BgpNeighborCfg) {
  const cfg = h.routing.bgp; const s = tcpSocket(st, h, -5); nb.sock = s.id; nb.state = 'connect'; nb.isClient = true;
  const e = tcpConnect(st, h, s, nb.peerIp, 179); if (e) { nb.state = 'idle'; nb.sock = null; timer(st, h.id, 5 * SEC, `bgp:${cfg.as}:retry:${nb.peerIp}`); }
}
function findNb(cfg: BgpConfig, pred: (n: BgpNeighborCfg) => boolean) { return cfg.neighbors.find(pred); }
function sendOpen(st: EngineState, h: HostState, s: TcpSocket) { const cfg = h.routing.bgp; tcpSend(st, h, s, encodeBgp({ type: BGP_OPEN, open: { version: 4, as: cfg.as, holdTime: 90, bgpId: cfg.routerId } })); }
function sendKeepalive(st: EngineState, h: HostState, s: TcpSocket) { tcpSend(st, h, s, encodeBgp({ type: BGP_KEEPALIVE })); }

export function bgpNotify(st: EngineState, h: HostState, ev: { type: string; sock: number; newSock?: number; err?: string }) {
  const cfg = h.routing.bgp; if (!cfg.enabled) return;
  if (ev.type === 'tcpAccept' && ev.sock === h.bgpListen) { const ls = h.sockets[h.bgpListen!]; if (ls?.proto !== 'tcp') return; const c = tcpAccept(h, ls); if (!c) return; let nb = findNb(cfg, n => n.peerIp === c.remoteIp); if (!nb) { tcpClose(st, h, c); return; } nb.sock = c.id; nb.isClient = false; nb.state = 'opensent'; sendOpen(st, h, c); return; }
  const nb = findNb(cfg, n => n.sock === ev.sock); if (!nb) return;
  const s = h.sockets[nb.sock!]; if (s?.proto !== 'tcp') return;
  if (ev.type === 'tcpConnected') { nb.state = 'opensent'; sendOpen(st, h, s); }
  else if (ev.type === 'tcpReadable') bgpRead(st, h, nb, s);
  else if (ev.type === 'tcpEof' || ev.type === 'tcpClosed' || ev.type === 'tcpError') { if (nb.state !== 'idle') log(st, `${h.name}: BGP session with ${u32ToIp(nb.peerIp)} down`); nb.state = 'idle'; nb.up = false; nb.sock = null; nb.rxOpen = false; withdrawFrom(st, h, nb.peerIp); timer(st, h.id, 5 * SEC, `bgp:${cfg.as}:retry:${nb.peerIp}`); }
}
function bgpRead(st: EngineState, h: HostState, nb: BgpNeighborCfg, s: TcpSocket) {
  const buf = (nb as BgpNeighborCfg & { buf?: Uint8Array }); const d = tcpRecv(st, h, s); const cur = buf.buf ?? new Uint8Array(0); const all = new Uint8Array(cur.length + d.length); all.set(cur); all.set(d, cur.length);
  const { msgs, consumed } = decodeBgpMessages(all, 0, all.length); buf.buf = all.slice(consumed);
  for (const m of msgs) handleMsg(st, h, nb, s, m);
}
function handleMsg(st: EngineState, h: HostState, nb: BgpNeighborCfg, s: TcpSocket, m: BgpMessage) {
  const cfg = h.routing.bgp;
  if (m.type === BGP_OPEN) { nb.peerAs = m.open.as; nb.routerId = m.open.bgpId; nb.rxOpen = true; sendKeepalive(st, h, s); nb.state = 'openconfirm'; }
  else if (m.type === BGP_KEEPALIVE) { if (nb.state === 'openconfirm' || nb.state === 'opensent') { nb.state = 'established'; nb.up = true; log(st, `${h.name}: BGP session with ${u32ToIp(nb.peerIp)} (AS${nb.peerAs}) ESTABLISHED`); advertiseAll(st, h, nb); } timer(st, h.id, 30 * SEC, `bgp:${cfg.as}:ka:${nb.peerIp}`); }
  else if (m.type === BGP_UPDATE) { onUpdate(st, h, nb, m.update); }
}
function onUpdate(st: EngineState, h: HostState, nb: BgpNeighborCfg, u: { withdrawn: BgpRoute[]; attrs?: { origin: number; asPath: number[]; nextHop: number; localPref?: number; med?: number }; nlri: BgpRoute[] }) {
  const cfg = h.routing.bgp; const iBGP = nb.peerAs === cfg.as;
  for (const w of u.withdrawn) cfg.rib = cfg.rib.filter(r => !(r.prefix === w.prefix && r.len === w.len && r.fromPeer === nb.peerIp));
  if (u.attrs && u.nlri.length) {
    if (u.attrs.asPath.includes(cfg.as)) { /* loop prevention (eBGP) */ } else {
      for (const n of u.nlri) { cfg.rib = cfg.rib.filter(r => !(r.prefix === n.prefix && r.len === n.len && r.fromPeer === nb.peerIp));
        cfg.rib.push({ prefix: n.prefix, len: n.len, nextHop: iBGP ? u.attrs!.nextHop : nb.peerIp, asPath: u.attrs!.asPath, localPref: u.attrs!.localPref ?? 100, med: u.attrs!.med ?? 0, origin: u.attrs!.origin, fromPeer: nb.peerIp, fromAs: nb.peerAs, best: false, iBGP });
        log(st, `${h.name}: BGP UPDATE ${u32ToIp(n.prefix)}/${n.len} AS_PATH [${u.attrs!.asPath.join(' ')}] from ${u32ToIp(nb.peerIp)}`);
      }
    }
  }
  selectBest(st, h); propagate(st, h, nb, u, iBGP);
}
function selectBest(st: EngineState, h: HostState) {
  const cfg = h.routing.bgp; const byPrefix = new Map<string, BgpRibEntry[]>();
  for (const r of cfg.rib) { r.best = false; const k = `${r.prefix}/${r.len}`; (byPrefix.get(k) ?? byPrefix.set(k, []).get(k)!).push(r); }
  for (const [, group] of byPrefix) { group.sort((a, b) => b.localPref - a.localPref || a.asPath.length - b.asPath.length || a.origin - b.origin || a.med - b.med || a.fromPeer - b.fromPeer); const best = group[0]; if (best) best.best = true; }
  installBgp(st, h);
}
function installBgp(st: EngineState, h: HostState) {
  h.routes = h.routes.filter(r => r.kind !== 'bgp'); rebuildConnectedRoutes(h);
  for (const r of h.routing.bgp.rib) { if (!r.best) continue; const nh = r.nextHop; const rt = lookupRoute(h, nh); const iface = rt ? rt.iface : h.ifaces.find(i => i.ip !== null && sameSubnet(i.ip, nh, i.mask))?.name; if (!iface) continue; const mask = (0xffffffff << (32 - r.len)) >>> 0; h.routes.push({ dst: (r.prefix & mask) >>> 0, mask, gw: nh, iface, metric: r.asPath.length, kind: 'bgp' }); }
  void st;
}
function localRoutes(h: HostState): BgpRoute[] { return h.routing.bgp.networks.map(n => ({ prefix: n.net >>> 0, len: maskLen(n.mask) })); }
function advertiseAll(st: EngineState, h: HostState, nb: BgpNeighborCfg) {
  const cfg = h.routing.bgp; const s = h.sockets[nb.sock!]; if (s?.proto !== 'tcp') return; const iBGP = nb.peerAs === cfg.as;
  // originated networks
  for (const r of localRoutes(h)) tcpSend(st, h, s, encodeBgp({ type: BGP_UPDATE, update: { withdrawn: [], attrs: { origin: 0, asPath: iBGP ? [] : [cfg.as], nextHop: bestSrc(h, nb), localPref: 100 }, nlri: [r] } }));
  // best learned routes (respect iBGP split-horizon unless route reflector)
  for (const r of cfg.rib) { if (!r.best) continue; if (iBGP && r.iBGP && !cfg.routeReflector) continue; if (r.fromPeer === nb.peerIp) continue;
    tcpSend(st, h, s, encodeBgp({ type: BGP_UPDATE, update: { withdrawn: [], attrs: { origin: r.origin, asPath: iBGP ? r.asPath : [cfg.as, ...r.asPath], nextHop: iBGP ? r.nextHop : bestSrc(h, nb), localPref: iBGP ? r.localPref : 100 }, nlri: [{ prefix: r.prefix, len: r.len }] } })); }
}
function propagate(st: EngineState, h: HostState, from: BgpNeighborCfg, u: { attrs?: { origin: number; asPath: number[]; nextHop: number; localPref?: number }; nlri: BgpRoute[]; withdrawn: BgpRoute[] }, fromIBGP: boolean) {
  const cfg = h.routing.bgp;
  for (const nb of cfg.neighbors) { if (nb.state !== 'established' || nb.peerIp === from.peerIp) continue; const s = h.sockets[nb.sock!]; if (s?.proto !== 'tcp') continue; const toIBGP = nb.peerAs === cfg.as;
    if (fromIBGP && toIBGP && !cfg.routeReflector) continue; // iBGP split horizon
    for (const n of u.nlri) { const r = cfg.rib.find(x => x.prefix === n.prefix && x.len === n.len && x.best); if (!r || r.fromPeer !== from.peerIp) continue;
      tcpSend(st, h, s, encodeBgp({ type: BGP_UPDATE, update: { withdrawn: [], attrs: { origin: r.origin, asPath: toIBGP ? r.asPath : [cfg.as, ...r.asPath], nextHop: toIBGP ? (fromIBGP ? r.nextHop : r.nextHop) : bestSrc(h, nb), localPref: toIBGP ? r.localPref : 100 }, nlri: [n] } })); }
    for (const w of u.withdrawn) tcpSend(st, h, s, encodeBgp({ type: BGP_UPDATE, update: { withdrawn: [w], nlri: [] } }));
  }
}
function withdrawFrom(st: EngineState, h: HostState, peerIp: number) { const cfg = h.routing.bgp; const lost = cfg.rib.filter(r => r.fromPeer === peerIp); cfg.rib = cfg.rib.filter(r => r.fromPeer !== peerIp); if (lost.length) { selectBest(st, h); } }
function bestSrc(h: HostState, nb: BgpNeighborCfg): number { const i = h.ifaces.find(x => x.ip !== null && sameSubnet(x.ip, nb.peerIp, x.mask)); return i?.ip ?? h.routing.bgp.routerId; }
export function bgpTimer(st: EngineState, h: HostState, as: number, tag: string) {
  const cfg = h.routing.bgp; if (!cfg.enabled || cfg.as !== as) return; const [, peerS] = tag.split(':'); const peer = Number(peerS);
  if (tag.startsWith('retry:')) { const nb = cfg.neighbors.find(n => n.peerIp === peer); if (nb && nb.state === 'idle' && bestSrc(h, nb) > nb.peerIp) bgpConnect(st, h, nb); }
  else if (tag.startsWith('ka:')) { const nb = cfg.neighbors.find(n => n.peerIp === peer); if (nb && nb.state === 'established' && nb.sock !== null) { const s = h.sockets[nb.sock]; if (s?.proto === 'tcp') { sendKeepalive(st, h, s); timer(st, h.id, 30 * SEC, `bgp:${as}:ka:${peer}`); } } }
}
function maskLen(m: number) { let n = 0, x = m >>> 0; while (x & 0x80000000) { n++; x = (x << 1) >>> 0; } return n; }
export function isBgpSock(h: HostState, sockId: number) { return h.bgpListen === sockId || h.routing.bgp.neighbors.some(n => n.sock === sockId); }
