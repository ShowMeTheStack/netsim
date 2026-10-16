// Headless command applier (foundation for E1 capsule replay and E4 sweep runner).
//
// `applyCmd` is the single authoritative routing of a `Cmd` onto an `EngineState`, factored out of
// the worker so the exact same state mutations happen in the browser worker, in a headless Node
// replay of a reproducibility capsule, and in a sweep harness. It performs ONLY state mutation and
// returns the side effects (errors, a produced session string, a replacement state, a compile
// result) as data; the caller (worker) decides how to surface them. Run-control (play/turbo/pause/
// step/setSpeed), the clang compile path (async IO), and sniffer capture-reset posting stay with
// the worker, because they are not pure state mutations.
import * as E from './engine';
import { ipToU32 } from '@/shared/bytes';
import { runCommand } from './terminal';
import { prefixToMask, parseCidr } from '@/shared/bytes';
import { isHost, isAp } from './types';
import { serializeSession, parseSession } from '@/session/session';
import { SEC } from './core';
import { compileAndStart } from './apps/cprog';
import type { Cmd } from '@/shared/protocol';
import type { EngineState } from './types';
import type { CDiagnostic } from '@/shared/cprograms';

export interface CmdOutcome {
  error?: string;
  session?: string;                 // exportSession result (JSON)
  newState?: EngineState;           // importSession / newSession / loadScenario
  imported?: { theme?: string };    // after a state replacement that carried UI state
  compile?: { node: number; ok: boolean; diagnostics: CDiagnostic[]; pid?: number };
  captureReset?: boolean;           // caller should flush sniffer captures to the UI
  /** True when applyCmd does not handle this command (run-control / clang / requestState). */
  deferToWorker?: boolean;
}

function parseNets(expr: string): { net: number; mask: number }[] {
  return expr.split(/[,\n]+/).map(x => x.trim()).filter(Boolean).map(x => { const { ip, mask } = parseCidr(x); return { net: (ip & mask) >>> 0, mask }; });
}

/** Apply one command to `st`, mutating it in place (or returning a replacement). Pure w.r.t. IO. */
export function applyCmd(st: EngineState, c: Cmd): CmdOutcome {
  switch (c.type) {
    case 'addNode': { if (c.nodeType === 'host') E.addHost(st, c.kind ?? 'laptop', c.x, c.y, c.name); else if (c.nodeType === 'router') E.addHost(st, 'router', c.x, c.y, c.name); else if (c.nodeType === 'ap') E.addAp(st, c.x, c.y, c.name); else E.addSwitch(st, c.x, c.y, 8, c.name); return {}; }
    case 'removeNode': E.removeNode(st, c.id); return {};
    case 'moveNode': { const n = st.nodes[c.id]; if (n) { n.x = c.x; n.y = c.y; } return {}; }
    case 'renameNode': { const n = st.nodes[c.id]; if (n) { n.name = c.name; if (isHost(n)) n.hostname = c.name; } return {}; }
    case 'connect': return E.connect(st, c.a, c.aIface, c.b, c.bIface) === null ? { error: 'Cannot connect: port in use or invalid' } : {};
    case 'removeLink': E.removeLink(st, c.id); return {};
    case 'setLink': { const l = st.links[c.id]; if (l) Object.assign(l, c.props); return {}; }
    case 'setImpair': { const l = st.links[c.id]; if (l) Object.assign(l.impair, c.impair); return {}; }
    case 'setHostTcp': { const n = st.nodes[c.node]; if (isHost(n)) Object.assign(n.tcp, c.tcp); return {}; }
    case 'setForwarding': { const n = st.nodes[c.node]; if (isHost(n)) n.forwarding = c.on; return {}; }
    case 'addRoute': { const n = st.nodes[c.node]; if (isHost(n)) { try { const { ip, mask } = parseCidr(c.cidr); const e = E.addStaticRoute(n, ip, mask, ipToU32(c.gw)); if (e) return { error: e }; } catch (e) { return { error: (e as Error).message }; } } return {}; }
    case 'delRoute': { const n = st.nodes[c.node]; if (isHost(n)) { const r = n.routes[c.index]; if (r && r.kind !== 'connected') n.routes.splice(c.index, 1); } return {}; }
    case 'setIface': { const n = st.nodes[c.node]; if (isHost(n)) { E.setIfaceIp(st, n, c.iface, c.ip === null ? null : ipToU32(c.ip), prefixToMask(c.prefix)); const i = n.ifaces.find(x => x.name === c.iface); if (i) { if (c.up !== undefined) i.up = c.up; if (c.mtu !== undefined) i.mtu = c.mtu; } } return {}; }
    case 'setGateway': { const n = st.nodes[c.node]; if (isHost(n)) E.setDefaultGateway(n, c.gw === null ? null : ipToU32(c.gw)); return {}; }
    case 'runCmd': { const n = st.nodes[c.node]; if (isHost(n)) runCommand(st, n, c.line); return {}; }
    case 'addSniffer': E.addSniffer(st, c.link); return {};
    case 'removeSniffer': delete st.sniffers[c.id]; return { captureReset: true };
    case 'clearCapture': { const s = st.sniffers[c.id]; if (s) { s.frames = []; s.nextN = 1; s.total = 0; } return { captureReset: true }; }
    case 'setCaptureFilter': { const s = st.sniffers[c.id]; if (s) s.captureFilter = c.expr; return {}; }
    case 'addBreakpoint': E.addBreakpoint(st, c.expr, c.milestones, c.label); return {};
    case 'removeBreakpoint': st.breakpoints = st.breakpoints.filter(b => b.id !== c.id); return {};
    case 'toggleBreakpoint': { const b = st.breakpoints.find(x => x.id === c.id); if (b) b.enabled = c.enabled; return {}; }
    case 'exportSession': return { session: serializeSession(st, { theme: c.theme }) };
    case 'importSession': { try { const f = parseSession(c.json); const ns = f.state; E.ensureServices(ns); return { newState: ns, imported: { theme: f.ui?.theme }, captureReset: true }; } catch (e) { return { error: (e as Error).message }; } }
    case 'newSession': return { newState: E.createState(c.seed ?? 1) };
    case 'loadScenario': { try { const f = parseSession(c.json); const ns = f.state; E.ensureServices(ns); return { newState: ns, imported: { theme: f.ui?.theme }, captureReset: true }; } catch (e) { return { error: (e as Error).message }; } }
    case 'setDhcpServer': { const n = st.nodes[c.node]; if (isHost(n)) { const g = c.cfg; try { n.dhcpServer = { ...n.dhcpServer, enabled: g.enabled, iface: g.iface, poolStart: g.poolStart ? ipToU32(g.poolStart) : 0, poolEnd: g.poolEnd ? ipToU32(g.poolEnd) : 0, mask: prefixToMask(g.prefix), gateway: g.gateway ? ipToU32(g.gateway) : 0, dns: g.dns.split(/[,\s]+/).filter(Boolean).map(ipToU32) }; if (n.dhcpServerSock && (!g.enabled)) { delete n.sockets[n.dhcpServerSock]; n.dhcpServerSock = null; } E.ensureServices(st); } catch (e) { return { error: (e as Error).message }; } } return {}; }
    case 'setDnsConfig': { const n = st.nodes[c.node]; if (isHost(n)) { try { n.dnsRecursion = c.recursion; n.dnsRoots = c.roots.split(/[,\s]+/).filter(Boolean).map(ipToU32); n.dnsForwarders = c.forwarders.split(/[,\s]+/).filter(Boolean).map(ipToU32); E.ensureServices(st); } catch (e) { return { error: (e as Error).message }; } } return {}; }
    case 'setDnsZone': { const n = st.nodes[c.node]; if (isHost(n)) { E.setDnsZone(n, c.origin, c.text); E.ensureServices(st); } return {}; }
    case 'delDnsZone': { const n = st.nodes[c.node]; if (isHost(n)) n.dnsZones = n.dnsZones.filter(z => z.origin !== c.origin); return {}; }
    case 'setHttpDocroot': { const n = st.nodes[c.node]; if (isHost(n)) n.httpDocroot = c.files; return {}; }
    case 'setHosts': { const n = st.nodes[c.node]; if (isHost(n)) { n.hosts = {}; for (const line of c.text.split('\n')) { const p2 = line.trim().split(/\s+/); if (p2.length >= 2 && !line.startsWith('#')) { try { const addr = ipToU32(p2[0]!); for (const nm of p2.slice(1)) n.hosts[nm] = addr; } catch { /* skip */ } } } } return {}; }
    case 'setResolv': { const n = st.nodes[c.node]; if (isHost(n)) n.dns = c.dns.split(/[,\s]+/).filter(Boolean); return {}; }
    case 'setRip': { const n = st.nodes[c.node]; if (isHost(n)) { n.routing.rip.enabled = c.enabled; n.routing.rip.networks = parseNets(c.networks); if (!c.enabled && n.routing.rip.sock) { delete n.sockets[n.routing.rip.sock]; n.routing.rip.sock = null; n.routes = n.routes.filter(r => r.kind !== 'rip'); } E.ensureServices(st); } return {}; }
    case 'setOspf': { const n = st.nodes[c.node]; if (isHost(n)) { n.routing.ospf.enabled = c.enabled; n.routing.ospf.networks = parseNets(c.networks); n.routing.ospf.ifaceCosts = c.costs; if (!c.enabled) { n.routing.ospf.neighbors = {}; n.routing.ospf.lsdb = {}; n.routes = n.routes.filter(r => r.kind !== 'ospf'); } n.routing.ospf.gen++; E.ensureServices(st); } return {}; }
    case 'setBgp': { const n = st.nodes[c.node]; if (isHost(n)) { const b = n.routing.bgp; b.enabled = c.enabled; b.as = c.as; b.routerId = c.routerId ? ipToU32(c.routerId) : 0; b.networks = parseNets(c.networks); b.routeReflector = c.routeReflector; if (!c.enabled) { b.rib = []; for (const nb of b.neighbors) { nb.state = 'idle'; nb.sock = null; } n.routes = n.routes.filter(r => r.kind !== 'bgp'); } E.ensureServices(st); } return {}; }
    case 'addBgpNeighbor': { const n = st.nodes[c.node]; if (isHost(n)) { n.routing.bgp.neighbors.push({ peerIp: ipToU32(c.peerIp), peerAs: c.peerAs, state: 'idle', sock: null, routerId: 0, holdUs: 90 * SEC, keepaliveUs: 30 * SEC, isClient: false, up: false, rxOpen: false, gen: 0 }); E.ensureServices(st); } return {}; }
    case 'delBgpNeighbor': { const n = st.nodes[c.node]; if (isHost(n)) n.routing.bgp.neighbors = n.routing.bgp.neighbors.filter(nb => nb.peerIp !== ipToU32(c.peerIp)); return {}; }
    case 'setNat': { const n = st.nodes[c.node]; if (isHost(n)) { n.nat.enabled = c.enabled; n.nat.outsideIface = c.outsideIface; n.nat.insideIfaces = c.insideIfaces; if (!c.enabled) n.nat.table = []; } return {}; }
    case 'addPortForward': { const n = st.nodes[c.node]; if (isHost(n)) n.nat.portForwards.push({ proto: c.proto, outsidePort: c.outsidePort, insideIp: ipToU32(c.insideIp), insidePort: c.insidePort }); return {}; }
    case 'delPortForward': { const n = st.nodes[c.node]; if (isHost(n)) n.nat.portForwards.splice(c.index, 1); return {}; }
    case 'setSwitchVlan': { const n = st.nodes[c.node]; if (n?.type === 'switch') { n.vlanEnabled = c.enabled; c.ports.forEach((pc, i) => { const p2 = n.ports[i]; if (p2) { p2.mode = pc.mode; p2.vlan = pc.vlan; p2.trunkVlans = pc.trunkVlans; } }); n.macTable = {}; } return {}; }
    case 'setSwitchScript': { const n = st.nodes[c.node]; if (n?.type === 'switch') { n.script = c.script; n.macTable = {}; } return {}; }
    case 'setWireless': { const n = st.nodes[c.node]; if (isHost(n)) { if (c.on) E.setWireless(n, c.iface, { ssid: c.ssid, channel: c.channel, range: c.range }); else E.clearWireless(n, c.iface); } return {}; }
    case 'setAp': { const n = st.nodes[c.node]; if (isAp(n)) { n.ssid = c.ssid; n.channel = c.channel; n.range = c.range; n.rtsCts = c.rtsCts; n.clients = []; for (const nn of Object.values(st.nodes)) if (isHost(nn)) for (const i of nn.ifaces) if (i.wifi && i.wifi.associated === n.id) i.wifi.associated = null; } return {}; }
    case 'addAirMonitor': E.addAirMonitor(st, c.channel); return {};
    case 'removeAirMonitor': delete st.rf.monitors[c.id]; return {};
    case 'compileRun': {
      const n = st.nodes[c.node]; if (!isHost(n)) return {};
      if (c.backend === 'clang') return { deferToWorker: true };   // async IO path: worker only
      const r = compileAndStart(st, n, c.source, c.name, c.argv, c.backend);
      return 'diagnostics' in r ? { compile: { node: c.node, ok: false, diagnostics: r.diagnostics } } : { compile: { node: c.node, ok: true, pid: r.pid, diagnostics: [] } };
    }
    // run-control, restart bookkeeping, clang compile, capsule IO, and requestState are the worker's job
    case 'play': case 'turbo': case 'pause': case 'stepEvent': case 'stepPacket':
    case 'stepSyscall': case 'setSpeed': case 'restart': case 'requestState':
    case 'exportCapsule': case 'replayCapsule': case 'exportPcap':
      return { deferToWorker: true };
  }
}
