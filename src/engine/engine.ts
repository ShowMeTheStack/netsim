// Engine orchestration: state creation, topology edits, event dispatch, playback, snapshots.
import { heapPop, heapPeek, heapRemoveWhere } from './heap';
import { seedRng } from './rng';
import { onLinkTxStart, onLinkDeliver, onLinkEnqueue } from './link';
import { hostRx, hostTimer, rebuildConnectedRoutes, hostKillProcs } from './devices/host';
import { switchRx, switchExpireMacs } from './devices/switch';
import { SEC, MS, log } from './core';
import { prefixToMask, ipToU32, u32ToIp } from '@/shared/bytes';
import { defaultDhcpServer, startDhcpServer } from './apps/dhcp';
import { ensureDnsSock, parseZone } from './apps/dns';
import './apps/resolve-actions';
import { ripStart } from './routing/rip';
import { ospfStart } from './routing/ospf';
import { bgpStart } from './routing/bgp';
import { apStart, onRfTxEnd, onWifiAckTx, onWifiCts, wifiTimer, apWiredRx } from './wireless/medium';
import { decodeFrame, decodeFrame as decodeFrameFn } from './codecs/decode';
import { compileFilter as compileFilterFn, evalFilter as evalFilterFn } from '@/filters/filter';
import { isHost, isAp, type EngineState, type HostState, type SwitchState, type NodeState, type NodeId, type LinkId, type HostKind, type Iface, type BreakpointHit, type Flight, type Milestone, type SnifferId, type LinkState } from './types';

export function createState(seed = 1): EngineState {
  return { version: 1, time: 0, seq: 0, rng: seedRng(seed), seed, events: [], nodes: {}, links: {}, sniffers: {}, breakpoints: [], nextBreakpointId: 1, nextNodeId: 1, nextLinkId: 1, nextSnifferId: 1, nextFrameId: 1, lastHit: null, log: [], recentMilestones: [], rf: { transmissions: [], nextTxId: 1, nextRfSeq: 1, monitors: {}, nextMonitorId: 1 }, scenario: null, lastActivityT: 0 };
}
export function makeMac(nodeId: number, idx: number) { return `02:00:${((nodeId >> 8) & 255).toString(16).padStart(2, '0')}:${(nodeId & 255).toString(16).padStart(2, '0')}:00:${(idx & 255).toString(16).padStart(2, '0')}`; }
function makeIface(nodeId: number, idx: number, name: string): Iface { return { name, mac: makeMac(nodeId, idx), ip: null, mask: prefixToMask(24), up: true, mtu: 1500, linkId: null, promisc: false, rxPackets: 0, txPackets: 0, rxBytes: 0, txBytes: 0, rxDrops: 0, txDrops: 0 }; }
export const defaultRouting = (): import('./types').RoutingConfig => ({
  rip: { enabled: false, networks: [], updateUs: 30 * SEC, timeoutUs: 180 * SEC, gcUs: 120 * SEC, splitHorizon: true, poisonReverse: true, routes: [], sock: null, gen: 0 },
  ospf: { enabled: false, routerId: 0, areaId: 0, helloUs: 10 * SEC, deadUs: 40 * SEC, ifaceCosts: {}, networks: [], neighbors: {}, lsdb: {}, seq: 0x80000001, spf: [], gen: 0 },
  bgp: { enabled: false, as: 0, routerId: 0, neighbors: [], networks: [], rib: [], routeReflector: false },
});
export const DEFAULT_ROOTS = () => [ipToU32('198.41.0.4')];
export const DEFAULT_DOCROOT = () => ({ 'index.html': '<html>\n<head><title>NetSim server</title><link rel="stylesheet" href="/style.css"></head>\n<body>\n<h1>It works!</h1>\n<img src="/logo.png">\n<script src="/app.js"></script>\n</body>\n</html>\n', 'style.css': 'body { font-family: sans-serif; }\n', 'app.js': 'console.log("hello from NetSim");\n', 'logo.png': 'PNGDATA-placeholder-bytes-representing-an-image-of-modest-size-'.repeat(4) });
export const zeroCounters = () => ({ ipRx: 0, ipTx: 0, ipFwd: 0, icmpRx: 0, icmpTx: 0, dropNoRoute: 0, dropBadChecksum: 0, dropNotForMe: 0, dropTtl: 0, fragsTx: 0, fragsRx: 0, reasmOk: 0, reasmFail: 0, udpRx: 0, udpTx: 0, tcpRx: 0, tcpTx: 0 });

export function addHost(st: EngineState, kind: HostKind, x: number, y: number, name?: string): HostState {
  const id = st.nextNodeId++; const nm = name ?? `${kind}${id}`; const router = kind === 'router';
  const h: HostState = { id, type: router ? 'router' : 'host', kind, name: nm, hostname: nm, x, y, ifaces: [makeIface(id, 0, 'eth0')], arp: {}, arpPending: {}, routes: [], dns: [], forwarding: router, hosts: {}, dhcpServer: defaultDhcpServer(), dhcpServerSock: null, dhcpClient: null, dnsSock: null, dnsZones: [], dnsRecursion: false, dnsRoots: DEFAULT_ROOTS(), dnsForwarders: [], dnsCache: {}, resolutions: {}, nextResolution: 1, dnsWaiters: {}, httpDocroot: kind === 'server' ? DEFAULT_DOCROOT() : {}, routing: defaultRouting(), bgpListen: null, nat: { enabled: false, outsideIface: '', insideIfaces: [], table: [], portForwards: [], nextPort: 40000 }, procs: {}, nextPid: 100, terminal: [`NetSim virtual OS — ${nm}`, `Type 'help' for commands.`],
    sockets: {}, nextSock: 1, nextEphemeral: 32768 + (id * 97) % 1000, tcpHistory: [], reasm: {}, pmtu: {}, arpTimeoutUs: 1 * SEC, arpRetries: 2, arpTtlUs: 60 * SEC, reasmTimeoutUs: 30 * SEC,
    tcp: { cc: 'reno', initCwndSegs: 1, rcvBufCap: 262144, delayedAck: true, delAckUs: 40 * MS, nagle: false, sack: true, wscale: true, minRtoUs: 200 * MS, mslUs: 30 * SEC }, counters: zeroCounters() };
  const n = router ? 4 : kind === 'server' ? 2 : 1; for (let i = 1; i < n; i++) h.ifaces.push(makeIface(id, i, `eth${i}`));
  st.nodes[id] = h; return h;
}
export function addSwitch(st: EngineState, x: number, y: number, ports = 8, name?: string): SwitchState {
  const id = st.nextNodeId++; const nm = name ?? `switch${id}`;
  const sw: SwitchState = { id, type: 'switch', name: nm, x, y, ports: [], macTable: {}, agingUs: 300 * SEC, vlanEnabled: false, script: null, counters: { learned: 0, flooded: 0, forwarded: 0, filtered: 0 } };
  for (let i = 0; i < ports; i++) sw.ports.push({ name: `Fa0/${i + 1}`, linkId: null, mac: makeMac(id, i), up: true, rxPackets: 0, txPackets: 0, rxDrops: 0, mode: 'access', vlan: 1, trunkVlans: [] });
  st.nodes[id] = sw; return sw;
}
export function addAp(st: EngineState, x: number, y: number, name?: string): import('./types').ApState {
  const id = st.nextNodeId++; const nm = name ?? `ap${id}`;
  const ap: import('./types').ApState = { id, type: 'ap', name: nm, x, y, ssid: 'netsim', channel: 6, range: 200, mac: makeMac(id, 0), ports: [], clients: [], macTable: {}, beaconUs: 1000 * MS, rtsCts: false, counters: { beacons: 0, assoc: 0, txData: 0, rxData: 0, collisions: 0, retries: 0, bridged: 0 } };
  for (let i = 0; i < 4; i++) ap.ports.push({ name: `Gi0/${i + 1}`, linkId: null, mac: makeMac(id, i + 1), up: true, rxPackets: 0, txPackets: 0, rxDrops: 0, mode: 'access', vlan: 1, trunkVlans: [] });
  st.nodes[id] = ap; return ap;
}
export function nodePorts(n: NodeState): { name: string; linkId: LinkId | null }[] { return isHost(n) ? n.ifaces : n.ports; }
export function freePort(n: NodeState): number { return nodePorts(n).findIndex(p => p.linkId === null); }

export function removeNode(st: EngineState, id: NodeId) {
  const n = st.nodes[id]; if (!n) return;
  for (const l of Object.values(st.links)) if (l.a.node === id || l.b.node === id) removeLink(st, l.id);
  if (isHost(n)) hostKillProcs(st, n);
  heapRemoveWhere(st.events, e => e.kind === 'timer' && e.node === id);
  delete st.nodes[id];
}
export type LinkProps = Partial<Pick<LinkState, 'bandwidthBps' | 'bandwidthBpsRev' | 'delayUs' | 'jitterUs' | 'lossPct' | 'queueDepth' | 'mtu'>>;
export function connect(st: EngineState, a: NodeId, aIface: number, b: NodeId, bIface: number, props: LinkProps = {}): LinkId | null {
  const na = st.nodes[a], nb = st.nodes[b]; if (!na || !nb || a === b) return null;
  const pa = nodePorts(na)[aIface], pb = nodePorts(nb)[bIface]; if (!pa || !pb || pa.linkId !== null || pb.linkId !== null) return null;
  const id = st.nextLinkId++;
  st.links[id] = { id, a: { node: a, iface: aIface }, b: { node: b, iface: bIface }, bandwidthBps: props.bandwidthBps ?? 100e6, bandwidthBpsRev: props.bandwidthBpsRev ?? props.bandwidthBps ?? 100e6, delayUs: props.delayUs ?? 1 * MS, jitterUs: props.jitterUs ?? 0, lossPct: props.lossPct ?? 0, queueDepth: props.queueDepth ?? 200, mtu: props.mtu ?? 1500,
    ab: { queue: [], busy: false, held: null }, ba: { queue: [], busy: false, held: null }, impair: { dir: 'both', dropNext: 0, filter: '', delayNext: 0, delayUs: 500 * MS, dupNext: 0, reorderNext: 0, corruptNext: 0 }, stats: { abTx: 0, baTx: 0, abDrops: 0, baDrops: 0 } };
  pa.linkId = id; pb.linkId = id;
  return id;
}
export function removeLink(st: EngineState, id: LinkId) {
  const l = st.links[id]; if (!l) return;
  for (const end of [l.a, l.b]) { const n = st.nodes[end.node]; if (n) { const p = nodePorts(n)[end.iface]; if (p) p.linkId = null; } }
  heapRemoveWhere(st.events, e => (e.kind === 'linkDeliver' || e.kind === 'linkTxStart' || e.kind === 'linkEnqueue') && e.link === id);
  for (const s of Object.values(st.sniffers)) if (s.linkId === id) delete st.sniffers[s.id];
  delete st.links[id];
}
export function addSniffer(st: EngineState, linkId: LinkId): SnifferId | null {
  if (!st.links[linkId]) return null; for (const s of Object.values(st.sniffers)) if (s.linkId === linkId) return s.id;
  const id = st.nextSnifferId++; st.sniffers[id] = { id, linkId, frames: [], nextN: 1, captureFilter: '', maxFrames: 5000, total: 0 }; return id;
}
export function addBreakpoint(st: EngineState, expr: string, milestones: Milestone[] = ['tx', 'rx', 'drop'], label?: string) { const id = st.nextBreakpointId++; st.breakpoints.push({ id, enabled: true, expr, milestones, label }); return id; }

export function setWireless(h: HostState, ifaceName: string, cfg: { ssid?: string; channel?: number; range?: number } = {}) {
  const i = h.ifaces.find(x => x.name === ifaceName); if (!i) return;
  i.wifi = { ssid: cfg.ssid ?? '', channel: cfg.channel ?? 6, range: cfg.range ?? 200, associated: null, scanning: true }; i.linkId = null;
}
export function clearWireless(h: HostState, ifaceName: string) { const i = h.ifaces.find(x => x.name === ifaceName); if (i) delete i.wifi; }
export function addAirMonitor(st: EngineState, channel: number): number { const id = st.rf.nextMonitorId++; st.rf.monitors[id] = { id, channel, frames: [], nextN: 1, total: 0 }; return id; }
export function setIfaceIp(st: EngineState, h: HostState, ifaceName: string, ip: number | null, mask: number) {
  void st; const i = h.ifaces.find(x => x.name === ifaceName); if (!i) return; i.ip = ip; i.mask = mask; rebuildConnectedRoutes(h);
}
export function setDefaultGateway(h: HostState, gw: number | null) {
  h.routes = h.routes.filter(r => r.kind !== 'default');
  if (gw !== null) { const via = h.ifaces.find(i => i.ip !== null && ((i.ip & i.mask) >>> 0) === ((gw & i.mask) >>> 0)); if (via) h.routes.push({ dst: 0, mask: 0, gw, iface: via.name, metric: 1, kind: 'default' }); }
}
export function setDnsZone(h: HostState, origin: string, text: string) { const { records } = parseZone(origin, text); const z = h.dnsZones.find(z => z.origin === origin); if (z) { z.text = text; z.records = records; } else h.dnsZones.push({ origin: origin.replace(/\.$/, ''), text, records }); }
export function addStaticRoute(h: HostState, dst: number, mask: number, gw: number): string | null {
  const via = h.ifaces.find(i => i.ip !== null && ((i.ip & i.mask) >>> 0) === ((gw & i.mask) >>> 0)); if (!via) return 'Nexthop has invalid gateway (not on a connected subnet)';
  h.routes = h.routes.filter(r => !(r.dst === dst && r.mask === mask && r.kind === 'static')); h.routes.push({ dst, mask, gw, iface: via.name, metric: 1, kind: 'static' }); return null;
}

// ---------- dispatch ----------
function dispatch(st: EngineState, ev: import('./types').SimEvent) {
  switch (ev.kind) {
    case 'linkTxStart': onLinkTxStart(st, ev); break;
    case 'linkEnqueue': onLinkEnqueue(st, ev); break;
    case 'linkDeliver': { const r = onLinkDeliver(st, ev); if (!r) break; const n = st.nodes[r.node]; if (!n) break; if (isHost(n)) hostRx(st, n, r.iface, ev.bytes); else if (n.type === 'switch') switchRx(st, n, r.iface, ev.bytes); else if (isAp(n)) apWiredRx(st, n, r.iface, ev.bytes); break; }
    case 'timer': {
      const tag = ev.tag;
      if (tag.startsWith('wifiend:')) { onRfTxEnd(st, Number(tag.slice(8)), ev.data as number); break; }
      if (tag.startsWith('wifiacktx:')) { onWifiAckTx(st, ev.node, Number(tag.slice(10)), ev.data as { toMac: string; ackBytes: Uint8Array; channel: number; range: number }); break; }
      if (tag.startsWith('wificts:')) { onWifiCts(st, ev.node, ev.data as { toMac: string; dataLen: number; channel: number }); break; }
      if (tag.startsWith('wifiack:')) break; // SIFS marker only
      if (tag.startsWith('wifi:')) { wifiTimer(st, ev.node, tag, ev.data); break; }
      const n = st.nodes[ev.node]; if (!n) break; if (isHost(n)) hostTimer(st, n, ev); break;
    }
  }
}

export interface RunResult { events: number; hit: BreakpointHit | null; idle: boolean; stoppedOnPacket: boolean }
export function advance(st: EngineState, untilT: number, maxEvents: number, stopOnPacket = false, quiescentGapUs = Infinity): RunResult {
  let n = 0; st.recentMilestones = []; st.lastHit = null;
  while (n < maxEvents) {
    const next = heapPeek(st.events);
    if (!next) return { events: n, hit: null, idle: true, stoppedOnPacket: false };                 // queue empty: stay at current time
    if (next.t > untilT) { if (Number.isFinite(untilT) && untilT > st.time) st.time = untilT; return { events: n, hit: null, idle: false, stoppedOnPacket: false }; }  // time-bounded: advance the clock to the boundary
    // Quiescence: stop before crossing a long idle gap (periodic timers like DHCP renew / TIME_WAIT),
    // but only once some work has been done and the gap is measured from the last activity.
    if (n > 0 && next.t - Math.max(st.lastActivityT, 0) > quiescentGapUs) return { events: n, hit: null, idle: false, stoppedOnPacket: false };
    heapPop(st.events); st.time = next.t; dispatch(st, next); n++;
    if (st.lastHit) return { events: n, hit: st.lastHit, idle: false, stoppedOnPacket: false };
    if (stopOnPacket && st.recentMilestones.length) return { events: n, hit: null, idle: false, stoppedOnPacket: true };
  }
  return { events: n, hit: null, idle: false, stoppedOnPacket: false };
}
export function stepEvent(st: EngineState) { return advance(st, Infinity, 1); }
export function stepPacket(st: EngineState) { return advance(st, Infinity, 1_000_000, true); }
/** Time of the next pending event, or null if the queue is empty. */
export function nextEventTime(st: EngineState): number | null { const e = heapPeek(st.events); return e ? e.t : null; }
export function housekeeping(st: EngineState) { for (const n of Object.values(st.nodes)) if (n.type === 'switch') switchExpireMacs(n, st.time); }

/** Frames currently in flight, derived from pending deliver events (for canvas animation). */
export function flights(st: EngineState): Flight[] {
  const out: Flight[] = [];
  for (const e of st.events) if (e.kind === 'linkDeliver') { let proto = 'ETH'; try { proto = decodeFrame(e.bytes).proto; } catch { /* ignore */ } out.push({ linkId: e.link, dir: e.dir, frameId: e.frameId, start: e.txStart, end: e.t, proto, from: e.from, to: e.to }); }
  return out;
}
export function evalCheck(st: EngineState, c: import('./types').ScenarioCheck): boolean {
  if (c.kind === 'sniffHas') { const ast = compileFilterFn(c.expr); if (ast instanceof Error) return false; for (const sn of Object.values(st.sniffers)) for (const fr of sn.frames) { try { if (evalFilterFn(ast, decodeFrameFn(fr.bytes))) return true; } catch { /* */ } } for (const mon of Object.values(st.rf.monitors)) for (const fr of mon.frames) { try { if (evalFilterFn(ast, decodeFrameFn(fr.bytes))) return true; } catch { /* */ } } return false; }
  const byName = (nm: string) => Object.values(st.nodes).find(n => n.name === nm);
  const n = byName(c.node); if (!n) return false;
  switch (c.kind) {
    case 'terminalContains': return isHost(n) && n.terminal.join('\n').includes(c.text);
    case 'hasRoute': { if (!isHost(n)) return false; const [ipS, preS] = c.prefix.split('/'); try { const ip = ipToU32(ipS!); const mask = prefixToMask(Number(preS ?? 32)); return n.routes.some(r => r.mask === mask && ((r.dst & mask) >>> 0) === ((ip & mask) >>> 0) && r.kind !== 'connected'); } catch { return false; } }
    case 'associated': return isHost(n) && n.ifaces.some(i => i.wifi && i.wifi.associated !== null);
    case 'natActive': return isHost(n) && n.nat.enabled && n.nat.table.length > 0;
    case 'bgpEstablished': return isHost(n) && n.routing.bgp.neighbors.some(nb => nb.state === 'established');
    case 'ospfFull': return isHost(n) && Object.values(n.routing.ospf.neighbors).some(x => x.state === 'full');
    case 'arpEntry': { if (!isHost(n)) return false; const e = n.arp[c.ip]; return !!e && e.mac === c.mac.toLowerCase(); }
    case 'terminalMatches': return isHost(n) && new RegExp(c.pattern).test(n.terminal.join('\n'));
    case 'ifaceIp': { if (!isHost(n)) return false; const i = n.ifaces.find(x => x.name === c.iface); return !!i && i.ip !== null && u32ToIp(i.ip) === c.ip; }
    case 'routeKind': { if (!isHost(n)) return false; const [ipS, preS] = c.prefix.split('/'); try { const ip = ipToU32(ipS!); const mask = prefixToMask(Number(preS ?? 32)); return n.routes.some(r => r.kind === c.routeKind && r.mask === mask && ((r.dst & mask) >>> 0) === ((ip & mask) >>> 0)); } catch { return false; } }
    case 'macLearned': return n.type === 'switch' && Object.keys(n.macTable).length >= c.count;
    case 'count': { const v = dotGet(n as unknown as Record<string, unknown>, c.path); return typeof v === 'number' ? v >= c.min : Array.isArray(v) ? v.length >= c.min : false; }
    case 'tcpStat': { if (!isHost(n)) return false; const socks = [...Object.values(n.sockets), ...n.tcpHistory]; let m = 0; for (const so of socks) if (so.proto === 'tcp') { const v = (so.stats as unknown as Record<string, number>)[c.field] ?? 0; if (v > m) m = v; } return m >= c.min; }
  }
}
function dotGet(o: Record<string, unknown>, path: string): unknown { let cur: unknown = o; for (const k of path.split('.')) { if (cur && typeof cur === 'object') cur = (cur as Record<string, unknown>)[k]; else return undefined; } return cur; }
export function snapshot(st: EngineState): EngineState { return structuredClone(st); }
export function restore(snap: EngineState): EngineState { return structuredClone(snap); }
export { log };

/** Start/refresh DHCP and DNS server sockets based on each host's config. Idempotent. */
export function resetRoutingDynamic(n: HostState) {
  n.routing.rip.routes = []; n.routing.rip.sock = null;
  n.routing.ospf.neighbors = {}; n.routing.ospf.lsdb = {}; n.routing.ospf.spf = []; n.routing.ospf.seq = 0x80000001;
  for (const nb of n.routing.bgp.neighbors) { nb.state = 'idle'; nb.sock = null; nb.up = false; nb.rxOpen = false; } n.bgpListen = null;
  n.routing.bgp.rib = [];
  n.routes = n.routes.filter(r => r.kind === 'connected' || r.kind === 'static' || r.kind === 'default'); n.nat.table = []; n.nat.nextPort = 40000;
}
export function ensureServices(st: EngineState) {
  for (const n of Object.values(st.nodes)) { if (!isHost(n)) continue;
    if (n.dhcpServer.enabled && !n.dhcpServerSock) startDhcpServer(st, n);
    if (!n.dhcpServer.enabled && n.dhcpServerSock) { delete n.sockets[n.dhcpServerSock]; n.dhcpServerSock = null; }
    if ((n.dnsZones.length || n.dnsRecursion) && n.dnsSock === null) ensureDnsSock(st, n);
    if (n.routing.rip.enabled && (n.routing.rip.sock === null || !n.sockets[n.routing.rip.sock])) ripStart(st, n);
    if (n.routing.ospf.enabled) ospfStart(st, n);
    if (n.routing.bgp.enabled) bgpStart(st, n);
  }
  for (const n of Object.values(st.nodes)) if (isAp(n)) apStart(st, n);
}

/** Cold boot: keep topology and config, clear all dynamic state and return to t=0. */
export function coldRestart(st: EngineState) {
  st.time = 0; st.seq = 0; st.rng = seedRng(st.seed); st.events = []; st.lastHit = null; st.log = []; st.recentMilestones = []; st.nextFrameId = 1; st.lastActivityT = 0;
  for (const n of Object.values(st.nodes)) {
    if (isHost(n)) { n.arp = Object.fromEntries(Object.entries(n.arp).filter(([, e]) => e.static)); n.arpPending = {}; n.procs = {}; n.sockets = {}; n.tcpHistory = []; n.reasm = {}; n.dnsSock = null; n.dhcpServerSock = null; n.dhcpClient = null; n.dnsCache = {}; n.resolutions = {}; n.dnsWaiters = {}; resetRoutingDynamic(n); n.dhcpServer = { ...n.dhcpServer, leases: {} }; n.pmtu = {}; n.terminal = [`NetSim virtual OS — ${n.name}`, `Type 'help' for commands.`]; for (const i of n.ifaces) { i.rxPackets = i.txPackets = i.rxBytes = i.txBytes = i.rxDrops = i.txDrops = 0; } n.counters = zeroCounters(); }
    else if (n.type === 'switch') { n.macTable = {}; n.counters = { learned: 0, flooded: 0, forwarded: 0, filtered: 0 }; for (const p of n.ports) { p.rxPackets = p.txPackets = p.rxDrops = 0; } }
  }
  for (const l of Object.values(st.links)) { l.ab = { queue: [], busy: false, held: null }; l.ba = { queue: [], busy: false, held: null }; l.stats = { abTx: 0, baTx: 0, abDrops: 0, baDrops: 0 }; }
  for (const s of Object.values(st.sniffers)) { s.frames = []; s.nextN = 1; s.total = 0; }
  st.rf = { transmissions: [], nextTxId: 1, nextRfSeq: 1, monitors: st.rf.monitors, nextMonitorId: st.rf.nextMonitorId };
  for (const m of Object.values(st.rf.monitors)) { m.frames = []; m.nextN = 1; m.total = 0; }
  for (const n of Object.values(st.nodes)) if (isAp(n)) { n.clients = []; n.macTable = {}; n.counters = { beacons: 0, assoc: 0, txData: 0, rxData: 0, collisions: 0, retries: 0, bridged: 0 }; } else if (isHost(n)) { for (const i of n.ifaces) if (i.wifi) i.wifi.associated = null; }
}
