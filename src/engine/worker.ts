// Engine worker: owns the EngineState, runs playback, answers UI commands.
/// <reference lib="webworker" />
import * as E from './engine';
import { ipToU32, u32ToIp } from '@/shared/bytes';
import { runCommand } from './terminal';
import { prefixToMask, parseCidr } from '@/shared/bytes';
import { isHost, isAp } from './types';
import { serializeSession, parseSession } from '@/session/session';
import { DEFAULT_SWITCH_SCRIPT } from './devices/switch-script';
void DEFAULT_SWITCH_SCRIPT;
import { SEC } from './core';
import { compileAndStart } from './apps/cprog';
import { startClangProgram, registerClangProgram } from './apps/clangrun';
import type { Cmd, Msg, RunMode, UiState } from '@/shared/protocol';
import type { EngineState, SnifferId } from './types';

let st: EngineState = E.createState(1);
let mode: RunMode = 'paused'; let speed = 1; let lastWall = 0; let tickHandle: ReturnType<typeof setInterval> | null = null; let turboDeadline = 0;
const sent: Record<SnifferId, number> = {}; // last capture n sent per sniffer
let stateDirty = true; let lastPost = 0;

const post = (m: Msg) => (self as unknown as Worker).postMessage(m);

function view(): UiState {
  const sniffers: UiState['sniffers'] = {}; for (const s of Object.values(st.sniffers)) sniffers[s.id] = { id: s.id, linkId: s.linkId, total: s.total, captureFilter: s.captureFilter };
  return { time: st.time, seq: st.seq, seed: st.seed, mode, speed, queued: st.events.length, nextEventUs: E.nextEventTime(st), nodes: st.nodes, links: st.links, sniffers, breakpoints: st.breakpoints, lastHit: st.lastHit, flights: E.flights(st), log: st.log.slice(-200), rf: { transmissions: st.rf.transmissions, monitors: rfMonitors() }, scenario: st.scenario ? { id: st.scenario.id, title: st.scenario.title, description: st.scenario.description, results: st.scenario.checks.map(c => ({ id: c.id, label: c.label, pass: E.evalCheck(st, c) })) } : null };
}
function rfMonitors() { const out: Record<number, { id: number; channel: number; total: number; frames: import('./types').WifiCapture[] }> = {}; for (const m of Object.values(st.rf.monitors)) out[m.id] = { id: m.id, channel: m.channel, total: m.total, frames: m.frames.slice(-300) }; return out;
}
function postState(force = false) {
  const now = performance.now(); if (!force && now - lastPost < 33) { stateDirty = true; return; }
  lastPost = now; stateDirty = false; post({ type: 'state', st: view() }); postCaptures();
}
function postCaptures() {
  for (const s of Object.values(st.sniffers)) {
    const from = sent[s.id] ?? 0; const fresh = s.frames.filter(f => f.n > from);
    if (fresh.length) { post({ type: 'capture', snifferId: s.id, frames: fresh }); sent[s.id] = fresh[fresh.length - 1]!.n; }
    else if (from > 0 && s.nextN === 1) { sent[s.id] = 0; post({ type: 'capture', snifferId: s.id, frames: [], reset: true }); }
  }
  for (const id of Object.keys(sent)) if (!st.sniffers[Number(id)]) delete sent[Number(id)];
}
function setMode(m: RunMode) {
  mode = m; if (tickHandle) { clearInterval(tickHandle); tickHandle = null; }
  if (m === 'play') { lastWall = performance.now(); tickHandle = setInterval(tickPlay, 16); }
  else if (m === 'turbo') { turboDeadline = st.time + TURBO_MAX_ADVANCE; tickHandle = setInterval(tickTurbo, 0); }
  postState(true);
}
function afterRun(r: E.RunResult) {
  E.housekeeping(st);
  if (r.hit) { setMode('paused'); return; }
  if (mode === 'turbo' && r.idle) setMode('paused');
}
function tickPlay() {
  const now = performance.now(); const dt = Math.min(250, now - lastWall); lastWall = now;
  const r = E.advance(st, st.time + dt * 1000 * speed, 50_000); afterRun(r); postState();
}
// Turbo runs as fast as possible but pauses at a quiescent point: when the next pending event
// is more than TURBO_QUIESCENT_US of simulated idle away (e.g. a periodic DHCP-renew / TIME_WAIT
// timer), so a periodic protocol does not make turbo spin forever. Closely spaced activity
// (ping intervals, retransmits) keeps it running.
const TURBO_QUIESCENT_US = 60_000_000;   // stop at long idle gaps (e.g. DHCP renew at 1800s)
const TURBO_MAX_ADVANCE = 300_000_000;   // and never advance more than 300s of sim time per run,
                                         // so periodic protocols (OSPF hello 10s, RIP 30s) still terminate a turbo run
function tickTurbo() {
  const r = E.advance(st, turboDeadline, 200_000, false, TURBO_QUIESCENT_US); afterRun(r); postState();
  if (mode !== 'turbo') return;
  const nt = E.nextEventTime(st);
  if (nt === null || nt - Math.max(st.lastActivityT, 0) > TURBO_QUIESCENT_US || st.time >= turboDeadline) setMode('paused');
}

function handle(c: Cmd) {
  switch (c.type) {
    case 'addNode': { if (c.nodeType === 'host') E.addHost(st, c.kind ?? 'laptop', c.x, c.y, c.name); else if (c.nodeType === 'router') E.addHost(st, 'router', c.x, c.y, c.name); else if (c.nodeType === 'ap') E.addAp(st, c.x, c.y, c.name); else E.addSwitch(st, c.x, c.y, 8, c.name); break; }
    case 'removeNode': E.removeNode(st, c.id); break;
    case 'moveNode': { const n = st.nodes[c.id]; if (n) { n.x = c.x; n.y = c.y; } break; }
    case 'renameNode': { const n = st.nodes[c.id]; if (n) { n.name = c.name; if (isHost(n)) n.hostname = c.name; } break; }
    case 'connect': { if (E.connect(st, c.a, c.aIface, c.b, c.bIface) === null) post({ type: 'error', message: 'Cannot connect: port in use or invalid' }); break; }
    case 'removeLink': E.removeLink(st, c.id); break;
    case 'setLink': { const l = st.links[c.id]; if (l) Object.assign(l, c.props); break; }
    case 'setImpair': { const l = st.links[c.id]; if (l) Object.assign(l.impair, c.impair); break; }
    case 'setHostTcp': { const n = st.nodes[c.node]; if (isHost(n)) Object.assign(n.tcp, c.tcp); break; }
    case 'setForwarding': { const n = st.nodes[c.node]; if (isHost(n)) n.forwarding = c.on; break; }
    case 'addRoute': { const n = st.nodes[c.node]; if (isHost(n)) { try { const { ip, mask } = parseCidr(c.cidr); const e = E.addStaticRoute(n, ip, mask, ipToU32(c.gw)); if (e) post({ type: 'error', message: e }); } catch (e) { post({ type: 'error', message: (e as Error).message }); } } break; }
    case 'delRoute': { const n = st.nodes[c.node]; if (isHost(n)) { const r = n.routes[c.index]; if (r && r.kind !== 'connected') n.routes.splice(c.index, 1); } break; }
    case 'setIface': { const n = st.nodes[c.node]; if (isHost(n)) { E.setIfaceIp(st, n, c.iface, c.ip === null ? null : ipToU32(c.ip), prefixToMask(c.prefix)); const i = n.ifaces.find(x => x.name === c.iface); if (i) { if (c.up !== undefined) i.up = c.up; if (c.mtu !== undefined) i.mtu = c.mtu; } } break; }
    case 'setGateway': { const n = st.nodes[c.node]; if (isHost(n)) E.setDefaultGateway(n, c.gw === null ? null : ipToU32(c.gw)); break; }
    case 'runCmd': { const n = st.nodes[c.node]; if (isHost(n)) runCommand(st, n, c.line); break; }
    case 'addSniffer': E.addSniffer(st, c.link); break;
    case 'removeSniffer': delete st.sniffers[c.id]; delete sent[c.id]; post({ type: 'capture', snifferId: c.id, frames: [], reset: true }); break;
    case 'clearCapture': { const s = st.sniffers[c.id]; if (s) { s.frames = []; s.nextN = 1; s.total = 0; sent[c.id] = 0; post({ type: 'capture', snifferId: c.id, frames: [], reset: true }); } break; }
    case 'setCaptureFilter': { const s = st.sniffers[c.id]; if (s) s.captureFilter = c.expr; break; }
    case 'addBreakpoint': E.addBreakpoint(st, c.expr, c.milestones, c.label); break;
    case 'removeBreakpoint': st.breakpoints = st.breakpoints.filter(b => b.id !== c.id); break;
    case 'toggleBreakpoint': { const b = st.breakpoints.find(x => x.id === c.id); if (b) b.enabled = c.enabled; break; }
    case 'play': st.lastHit = null; setMode('play'); return;
    case 'turbo': st.lastHit = null; setMode('turbo'); return;
    case 'pause': setMode('paused'); return;
    case 'stepEvent': setMode('paused'); afterRun(E.stepEvent(st)); break;
    case 'stepPacket': setMode('paused'); afterRun(E.stepPacket(st)); break;
    case 'stepSyscall': setMode('paused'); afterRun(E.stepSyscall(st)); break;
    case 'setSpeed': speed = c.speed; break;
    case 'restart': setMode('paused'); E.coldRestart(st); for (const k of Object.keys(sent)) sent[Number(k)] = 0; for (const s of Object.values(st.sniffers)) post({ type: 'capture', snifferId: s.id, frames: [], reset: true }); break;
    case 'exportSession': post({ type: 'session', json: serializeSession(st, { theme: c.theme }) }); return;
    case 'importSession': { try { const f = parseSession(c.json); setMode('paused'); st = f.state; E.ensureServices(st); for (const k of Object.keys(sent)) delete sent[Number(k)]; for (const s of Object.values(st.sniffers)) { post({ type: 'capture', snifferId: s.id, frames: [], reset: true }); } post({ type: 'imported', theme: f.ui?.theme }); } catch (e) { post({ type: 'error', message: (e as Error).message }); } break; }
    case 'newSession': setMode('paused'); st = E.createState(c.seed ?? 1); for (const k of Object.keys(sent)) delete sent[Number(k)]; break;
    case 'setDhcpServer': { const n = st.nodes[c.node]; if (isHost(n)) { const g = c.cfg; try { n.dhcpServer = { ...n.dhcpServer, enabled: g.enabled, iface: g.iface, poolStart: g.poolStart ? ipToU32(g.poolStart) : 0, poolEnd: g.poolEnd ? ipToU32(g.poolEnd) : 0, mask: prefixToMask(g.prefix), gateway: g.gateway ? ipToU32(g.gateway) : 0, dns: g.dns.split(/[,\s]+/).filter(Boolean).map(ipToU32) }; if (n.dhcpServerSock && (!g.enabled)) { delete n.sockets[n.dhcpServerSock]; n.dhcpServerSock = null; } E.ensureServices(st); } catch (e) { post({ type: 'error', message: (e as Error).message }); } } break; }
    case 'setDnsConfig': { const n = st.nodes[c.node]; if (isHost(n)) { try { n.dnsRecursion = c.recursion; n.dnsRoots = c.roots.split(/[,\s]+/).filter(Boolean).map(ipToU32); n.dnsForwarders = c.forwarders.split(/[,\s]+/).filter(Boolean).map(ipToU32); E.ensureServices(st); } catch (e) { post({ type: 'error', message: (e as Error).message }); } } break; }
    case 'setDnsZone': { const n = st.nodes[c.node]; if (isHost(n)) { E.setDnsZone(n, c.origin, c.text); E.ensureServices(st); } break; }
    case 'delDnsZone': { const n = st.nodes[c.node]; if (isHost(n)) n.dnsZones = n.dnsZones.filter(z => z.origin !== c.origin); break; }
    case 'setHttpDocroot': { const n = st.nodes[c.node]; if (isHost(n)) n.httpDocroot = c.files; break; }
    case 'setHosts': { const n = st.nodes[c.node]; if (isHost(n)) { n.hosts = {}; for (const line of c.text.split('\n')) { const p2 = line.trim().split(/\s+/); if (p2.length >= 2 && !line.startsWith('#')) { try { const addr = ipToU32(p2[0]!); for (const nm of p2.slice(1)) n.hosts[nm] = addr; } catch { /* skip */ } } } } break; }
    case 'setResolv': { const n = st.nodes[c.node]; if (isHost(n)) n.dns = c.dns.split(/[,\s]+/).filter(Boolean); break; }
    case 'setRip': { const n = st.nodes[c.node]; if (isHost(n)) { n.routing.rip.enabled = c.enabled; n.routing.rip.networks = parseNets(c.networks); if (!c.enabled && n.routing.rip.sock) { delete n.sockets[n.routing.rip.sock]; n.routing.rip.sock = null; n.routes = n.routes.filter(r => r.kind !== 'rip'); } E.ensureServices(st); } break; }
    case 'setOspf': { const n = st.nodes[c.node]; if (isHost(n)) { n.routing.ospf.enabled = c.enabled; n.routing.ospf.networks = parseNets(c.networks); n.routing.ospf.ifaceCosts = c.costs; if (!c.enabled) { n.routing.ospf.neighbors = {}; n.routing.ospf.lsdb = {}; n.routes = n.routes.filter(r => r.kind !== 'ospf'); } n.routing.ospf.gen++; E.ensureServices(st); } break; }
    case 'setBgp': { const n = st.nodes[c.node]; if (isHost(n)) { const b = n.routing.bgp; b.enabled = c.enabled; b.as = c.as; b.routerId = c.routerId ? ipToU32(c.routerId) : 0; b.networks = parseNets(c.networks); b.routeReflector = c.routeReflector; if (!c.enabled) { b.rib = []; for (const nb of b.neighbors) { nb.state = 'idle'; nb.sock = null; } n.routes = n.routes.filter(r => r.kind !== 'bgp'); } E.ensureServices(st); } break; }
    case 'addBgpNeighbor': { const n = st.nodes[c.node]; if (isHost(n)) { n.routing.bgp.neighbors.push({ peerIp: ipToU32(c.peerIp), peerAs: c.peerAs, state: 'idle', sock: null, routerId: 0, holdUs: 90 * SEC, keepaliveUs: 30 * SEC, isClient: false, up: false, rxOpen: false, gen: 0 }); E.ensureServices(st); } break; }
    case 'delBgpNeighbor': { const n = st.nodes[c.node]; if (isHost(n)) n.routing.bgp.neighbors = n.routing.bgp.neighbors.filter(nb => nb.peerIp !== ipToU32(c.peerIp)); break; }
    case 'setNat': { const n = st.nodes[c.node]; if (isHost(n)) { n.nat.enabled = c.enabled; n.nat.outsideIface = c.outsideIface; n.nat.insideIfaces = c.insideIfaces; if (!c.enabled) n.nat.table = []; } break; }
    case 'addPortForward': { const n = st.nodes[c.node]; if (isHost(n)) n.nat.portForwards.push({ proto: c.proto, outsidePort: c.outsidePort, insideIp: ipToU32(c.insideIp), insidePort: c.insidePort }); break; }
    case 'delPortForward': { const n = st.nodes[c.node]; if (isHost(n)) n.nat.portForwards.splice(c.index, 1); break; }
    case 'setSwitchVlan': { const n = st.nodes[c.node]; if (n?.type === 'switch') { n.vlanEnabled = c.enabled; c.ports.forEach((pc, i) => { const p2 = n.ports[i]; if (p2) { p2.mode = pc.mode; p2.vlan = pc.vlan; p2.trunkVlans = pc.trunkVlans; } }); n.macTable = {}; } break; }
    case 'setSwitchScript': { const n = st.nodes[c.node]; if (n?.type === 'switch') { n.script = c.script; n.macTable = {}; } break; }
    case 'setWireless': { const n = st.nodes[c.node]; if (isHost(n)) { if (c.on) E.setWireless(n, c.iface, { ssid: c.ssid, channel: c.channel, range: c.range }); else E.clearWireless(n, c.iface); } break; }
    case 'setAp': { const n = st.nodes[c.node]; if (isAp(n)) { n.ssid = c.ssid; n.channel = c.channel; n.range = c.range; n.rtsCts = c.rtsCts; n.clients = []; for (const nn of Object.values(st.nodes)) if (isHost(nn)) for (const i of nn.ifaces) if (i.wifi && i.wifi.associated === n.id) i.wifi.associated = null; } break; }
    case 'addAirMonitor': E.addAirMonitor(st, c.channel); break;
    case 'removeAirMonitor': delete st.rf.monitors[c.id]; break;
    case 'loadScenario': { try { const f = parseSession(c.json); setMode('paused'); st = f.state; E.ensureServices(st); for (const k of Object.keys(sent)) delete sent[Number(k)]; post({ type: 'imported', theme: f.ui?.theme }); } catch (e) { post({ type: 'error', message: (e as Error).message }); } break; }
    case 'compileRun': {
      const n = st.nodes[c.node]; if (!isHost(n)) break;
      if (c.backend === 'clang') { void compileRunClang(c.node, c.name, c.source, c.argv); break; }
      const r = compileAndStart(st, n, c.source, c.name, c.argv, c.backend);
      if ('diagnostics' in r) post({ type: 'compile', node: c.node, ok: false, diagnostics: r.diagnostics }); else post({ type: 'compile', node: c.node, ok: true, pid: r.pid, diagnostics: [] });
      break;
    }
    case 'requestState': break;
  }
  postState(true);
}
// Compile real C with the in-browser clang toolchain (lazy-loaded; assets fetched same-origin from
// /csys/ = the opt-in C download) and run it. Async and fire-and-forth; results come back as a
// 'compile' message. The heavy modules (clang ~31MB, binaryen) load only when C is actually used.
async function compileRunClang(node: number, name: string, source: string, argv: string[]) {
  const n = st.nodes[node]; if (!isHost(n)) return;
  const err = (message: string) => post({ type: 'compile', node, ok: false, diagnostics: [{ line: 1, col: 1, message, severity: 'error' }] });
  try {
    const { clangCompile, finalizeWasm } = await import('./cc/clang');
    // binaryen is served from /csys/ (part of the opt-in C download) and loaded at runtime so Vite
    // never bundles its multi-MB minified source (which crashes the bundler's token scanner). The
    // specifier is computed so the bundler cannot try to resolve it at build time.
    const binaryenUrl = '/csys/' + 'binaryen.mjs';
    const bmod = await import(/* @vite-ignore */ binaryenUrl);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const binaryen = (bmod as { default: any }).default;
    const r = await clangCompile(source, {
      readBuffer: async (f: string) => { const res = await fetch(`/csys/${f}`); if (!res.ok) throw new Error(`fetch /csys/${f}: ${res.status}`); return new Uint8Array(await res.arrayBuffer()); },
      asyncify: (wasm: Uint8Array) => finalizeWasm(binaryen, wasm),
    });
    if (!r.ok) { post({ type: 'compile', node, ok: false, diagnostics: r.diagnostics }); return; }
    registerClangProgram(name, r.wasm);   // make it exec()-able by name
    const p = startClangProgram(st, n, r.wasm, name, argv);
    if (typeof p === 'string') { err(p); return; }
    post({ type: 'compile', node, ok: true, pid: p.pid, diagnostics: [] }); postState(true);
  } catch (e) { err(`C toolchain failed to load: ${(e as Error).message}`); }
}
function parseNets(expr: string): { net: number; mask: number }[] { return expr.split(/[,\n]+/).map(x => x.trim()).filter(Boolean).map(x => { const { ip, mask } = parseCidr(x); return { net: (ip & mask) >>> 0, mask }; }); }
self.onmessage = (ev: MessageEvent<Cmd>) => { try { handle(ev.data); } catch (e) { post({ type: 'error', message: (e as Error).message }); postState(true); } };
setInterval(() => { if (stateDirty) postState(true); }, 50);
post({ type: 'ready' }); postState(true);
