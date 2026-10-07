// The virtual OS command interpreter for hosts and routers. Commands are programs over the host stack.
import { ipToU32, isValidIp, isValidMac, maskToPrefix, parseCidr, u32ToIp } from '@/shared/bytes';
import { resolve } from './apps/dns';
import { startDhcpClient } from './apps/dhcp';
import { startHttpServer, startHttpClient } from './apps/http';
import { DNS_A } from './codecs/dns';
import { term, lookupRoute, rebuildConnectedRoutes, startPing } from './devices/host';
import { setDefaultGateway, addStaticRoute } from './engine';
import { startTraceroute } from './apps/traceroute';
import { startIperfServer, startIperfClient } from './apps/iperf';
import { startNcListen, startNcConnect } from './apps/nc';
import { startProgram, PROGRAM_NAMES } from './apps/cprog';
import { arpSpoof } from './devices/host';
import { killProc } from './apps/procs';
import { tcpStateSummary } from './stack/tcp';
import type { CcName, EngineState, HostState } from './types';

const HELP = [
  'Available commands:',
  '  ping [-c N] [-i SEC] [-s SIZE] [-t TTL] [-M do] IP      ICMP echo (-M do sets DF for PMTU discovery)',
  '  traceroute [-I] [-m MAXHOPS] [-q PROBES] [-w SEC] IP    UDP probes by default, -I for ICMP echo',
  '  iperf -s [-u] [-p PORT] [-R BYTES/S]                     bandwidth server (-R: slow reader for flow-control demos)',
  '  iperf -c IP [-u] [-p PORT] [-t SEC] [-n BYTES] [-b BPS] [-l LEN]   bandwidth client',
  '  nc -l PORT [-u] [-k] | nc IP PORT [-u] MESSAGE...       netcat: listen / send a message',
  '  crun [PROGRAM [ARGS...]]                                run a C socket program (no arg: list programs)',
  '  dig [@server] [TYPE] name | nslookup name                lookup DNS (A/NS/CNAME/MX/TXT/SOA)',
  '  curl [-I] [-0] [--pipeline] [--no-recurse] URL           fetch a page and its embedded resources',
  '  httpd [-p PORT] | dhclient [IF]                          start web server / request a DHCP lease',
  '  netstat | ss                                             list sockets and TCP states',
  '  ps | kill PID                                            list / stop running programs',
  '  arp -a | arp -d IP | arp -s IP MAC                       show / delete / add ARP entries',
  '  ip addr [add IP/PREFIX dev IF | del IF]                  show or set interface addresses',
  '  ip link set IF up|down | ip link set IF mtu N            interface state / MTU',
  '  ip route [add default via GW | add NET/PREFIX via GW | del NET/PREFIX]',
  '  ifconfig | route -n | hostname [NAME] | clear',
  '  sysctl [KEY[=VALUE]]   keys: net.ipv4.ip_forward, net.ipv4.tcp_congestion_control (tahoe|reno|newreno|cubic),',
  '                         net.ipv4.tcp_sack, net.ipv4.tcp_window_scaling, net.ipv4.tcp_initcwnd, net.ipv4.tcp_delack, net.ipv4.tcp_nagle, net.ipv4.tcp_rmem',
];

export function runCommand(st: EngineState, h: HostState, line: string) {
  const raw = line.trim(); term(h, `${h.hostname}$ ${raw}`); if (!raw) return;
  const argv = raw.split(/\s+/); const cmd = argv[0]!.toLowerCase(); const a = argv.slice(1);
  try {
    switch (cmd) {
      case 'help': for (const l of HELP) term(h, l); break;
      case 'clear': h.terminal = []; break;
      case 'hostname': if (a[0]) { h.hostname = a[0]; h.name = a[0]; } else term(h, h.hostname); break;
      case 'ping': cmdPing(st, h, a); break;
      case 'dig': case 'nslookup': case 'host': cmdDig(st, h, a); break;
      case 'curl': case 'wget': cmdCurl(st, h, a); break;
      case 'dhclient': case 'dhcp': cmdDhclient(st, h, a); break;
      case 'httpd': { const port = a[0] === '-p' ? Number(a[1]) : 80; const r = startHttpServer(st, h, port); if (typeof r === 'string') term(h, `httpd: ${r}`); break; }
      case 'arpspoof': { if (!a[0] || !isValidIp(a[0])) { term(h, 'usage: arpspoof <spoofed-ip> [target-ip]  — claim <spoofed-ip> is at our MAC'); break; } arpSpoof(st, h, ipToU32(a[0]), a[1] && isValidIp(a[1]) ? ipToU32(a[1]) : null); term(h, `arpspoof: announcing ${a[0]} is-at ${h.ifaces[0]!.mac}${a[1] ? ` to ${a[1]}` : ' (broadcast)'}`); break; }
      case 'traceroute': case 'tracert': cmdTraceroute(st, h, a); break;
      case 'iperf': case 'iperf3': cmdIperf(st, h, a); break;
      case 'nc': case 'netcat': cmdNc(st, h, a); break;
      case 'crun': cmdCrun(st, h, a); break;
      case 'netstat': case 'ss': cmdNetstat(h); break;
      case 'ps': for (const p of Object.values(h.procs)) term(h, `${String(p.pid).padStart(5)}  ${p.kind}${p.kind === 'ping' || p.kind === 'traceroute' ? ' ' + p.targetStr : p.kind === 'iperf' ? ` -${p.role === 'server' ? 's' : 'c'}${p.udp ? ' -u' : ''} port ${p.port}` : p.kind === 'nc' ? ` ${p.role} ${p.port}` : p.kind === 'cprog' ? ` ${p.name}${p.blocked ? ` [${p.blocked.syscall}]` : ''}` : ''}`); if (!Object.keys(h.procs).length) term(h, '(no processes)'); break;
      case 'kill': { const p = h.procs[Number(a[0])]; if (!p) term(h, `kill: (${a[0]}) - No such process`); else { killProc(st, h, p); term(h, `[${p.pid}] terminated`); } break; }
      case 'arp': cmdArp(st, h, a); break;
      case 'ifconfig': cmdIfconfig(h); break;
      case 'ip': cmdIp(st, h, a); break;
      case 'route': cmdRoute(h); break;
      case 'sysctl': cmdSysctl(h, a); break;
      default: term(h, `${cmd}: command not found`);
    }
  } catch (e) { term(h, `${cmd}: ${(e as Error).message}`); }
}
function needIp(h: HostState, s: string | undefined, what = 'destination'): number | null { if (!s) { term(h, `missing ${what}`); return null; } if (!isValidIp(s)) { term(h, `${s}: Name or service not known`); return null; } return ipToU32(s); }

function cmdPing(st: EngineState, h: HostState, a: string[]) {
  const opts: { count?: number; interval?: number; size?: number; ttl?: number; df?: boolean } = {}; let target: string | undefined;
  for (let i = 0; i < a.length; i++) { const x = a[i]!; if (x === '-c') opts.count = Number(a[++i]); else if (x === '-i') opts.interval = Number(a[++i]) * 1e6; else if (x === '-s') opts.size = Number(a[++i]); else if (x === '-t') opts.ttl = Number(a[++i]); else if (x === '-M') opts.df = a[++i] === 'do'; else if (x === '-D' || x === '-df') opts.df = true; else target = x; }
  if (!target) { term(h, 'usage: ping [-c count] [-i interval] [-s size] [-t ttl] [-M do] destination'); return; }
  if (Object.values(h.procs).some(p => p.kind === 'ping' && !p.done)) { term(h, 'ping: another ping is already running'); return; }
  if (isValidIp(target)) { const dst = ipToU32(target); if (!lookupRoute(h, dst)) { term(h, `ping: connect: Network is unreachable`); return; } startPing(st, h, dst, opts); return; }
  resolve(st, h, target, DNS_A, { kind: 'ping', name: target, opts });
}
function cmdDig(st: EngineState, h: HostState, a: string[]) {
  let type = DNS_A; let name: string | undefined; let server: string | undefined;
  for (const x of a) { if (x.startsWith('@')) server = x.slice(1); else if (/^(A|NS|CNAME|MX|TXT|SOA|PTR|AAAA)$/i.test(x)) type = ({ A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28 } as Record<string, number>)[x.toUpperCase()]!; else name = x; }
  if (!name) { term(h, 'usage: dig [@server] [TYPE] name'); return; }
  if (server && isValidIp(server)) h.dns = [server]; const serverIp = h.dns[0] ?? '(none)';
  resolve(st, h, name, type, { kind: 'dig', name, type, serverIp, t0: st.time });
}
function cmdCurl(st: EngineState, h: HostState, a: string[]) {
  const opts: { method?: string; persistent?: boolean; pipeline?: boolean; recurse?: boolean } = {}; let url: string | undefined;
  for (let i = 0; i < a.length; i++) { const x = a[i]!; if (x === '-X') opts.method = a[++i]; else if (x === '-I') opts.method = 'HEAD'; else if (x === '--http1.0' || x === '-0') opts.persistent = false; else if (x === '--pipeline') opts.pipeline = true; else if (x === '--no-recurse' || x === '-s') opts.recurse = false; else if (!x.startsWith('-')) url = x; }
  if (!url) { term(h, 'usage: curl [-X METHOD] [-I] [-0|--http1.0] [--pipeline] [--no-recurse] URL'); return; }
  const r = startHttpClient(st, h, url, opts); if (typeof r === 'string') term(h, `curl: ${r}`);
}
function cmdDhclient(st: EngineState, h: HostState, a: string[]) { const iface = a.find(x => !x.startsWith('-')) ?? h.ifaces[0]!.name; const e = startDhcpClient(st, h, iface); if (e) term(h, `dhclient: ${e}`); }
function cmdTraceroute(st: EngineState, h: HostState, a: string[]) {
  const opts: { maxHops?: number; probes?: number; icmp?: boolean; timeout?: number } = {}; let target: string | undefined;
  for (let i = 0; i < a.length; i++) { const x = a[i]!; if (x === '-I') opts.icmp = true; else if (x === '-m') opts.maxHops = Number(a[++i]); else if (x === '-q') opts.probes = Number(a[++i]); else if (x === '-w') opts.timeout = Number(a[++i]) * 1e6; else target = x; }
  if (!target) { term(h, 'usage: traceroute [-I] [-m hops] [-q probes] host'); return; }
  if (isValidIp(target)) { const dst = ipToU32(target); if (!lookupRoute(h, dst)) { term(h, `traceroute: Network is unreachable`); return; } const r = startTraceroute(st, h, dst, opts); if (typeof r === 'string') term(h, `traceroute: ${r}`); return; }
  resolve(st, h, target, DNS_A, { kind: 'traceroute', name: target, opts });
}
function cmdIperf(st: EngineState, h: HostState, a: string[]) {
  const o: Record<string, string | boolean> = {}; for (let i = 0; i < a.length; i++) { const x = a[i]!; if (x === '-s' || x === '-u') o[x] = true; else if (x.startsWith('-')) o[x] = a[++i] ?? ''; }
  if (o['-s']) { const r = startIperfServer(st, h, { port: o['-p'] ? Number(o['-p']) : undefined, udp: !!o['-u'], readRate: o['-R'] ? Number(o['-R']) : undefined }); if (typeof r === 'string') term(h, `iperf: ${r}`); return; }
  if (typeof o['-c'] === 'string') { const dst = needIp(h, o['-c']); if (dst === null) return; const r = startIperfClient(st, h, dst, { port: o['-p'] ? Number(o['-p']) : undefined, udp: !!o['-u'], seconds: o['-t'] ? Number(o['-t']) : undefined, bytes: o['-n'] ? Number(o['-n']) : undefined, bps: o['-b'] ? parseRate(String(o['-b'])) : undefined, len: o['-l'] ? Number(o['-l']) : undefined }); if (typeof r === 'string') term(h, `iperf: ${r}`); return; }
  term(h, 'usage: iperf -s [-u] [-p port] [-R bytes/s]  |  iperf -c host [-u] [-p port] [-t sec] [-n bytes] [-b rate] [-l len]');
}
function parseRate(s: string): number { const m = /^([\d.]+)([kKmMgG]?)$/.exec(s); if (!m) return Number(s) || 1e6; const mult = { '': 1, k: 1e3, K: 1e3, m: 1e6, M: 1e6, g: 1e9, G: 1e9 }[m[2]!] ?? 1; return Number(m[1]) * mult; }
function cmdNc(st: EngineState, h: HostState, a: string[]) {
  const udp = a.includes('-u'); const keep = a.includes('-k'); const rest = a.filter(x => x !== '-u' && x !== '-k');
  if (rest[0] === '-l') { const port = Number(rest[1]); if (!port) { term(h, 'usage: nc -l port [-u] [-k]'); return; } const r = startNcListen(st, h, port, udp, keep); if (typeof r === 'string') term(h, `nc: ${r}`); return; }
  const dst = needIp(h, rest[0], 'host'); if (dst === null) return; const port = Number(rest[1]); if (!port) { term(h, 'usage: nc host port [-u] message...'); return; }
  const r = startNcConnect(st, h, dst, port, udp, rest.slice(2).join(' ') || 'hello'); if (typeof r === 'string') term(h, `nc: ${r}`);
}
function cmdCrun(st: EngineState, h: HostState, a: string[]) {
  const name = a[0];
  if (!name) { term(h, 'C socket programs (run with: crun <name> [args...]):'); for (const n of PROGRAM_NAMES) term(h, `  ${n}`); return; }
  const r = startProgram(st, h, name, a.slice(1));
  if (typeof r === 'string') { term(h, `crun: ${r}`); return; }
  term(h, `[${r.pid}] ${name} started — press Play, Step or Turbo to run`);
}
function cmdNetstat(h: HostState) {
  term(h, 'Proto  Local Address          Foreign Address        State         PID');
  const socks = Object.values(h.sockets); if (!socks.length) { term(h, '(no sockets)'); return; }
  for (const s of socks) { if (s.proto === 'udp') term(h, `udp    ${`${s.localIp === null ? '0.0.0.0' : u32ToIp(s.localIp)}:${s.localPort}`.padEnd(23)}${'*:*'.padEnd(23)}${''.padEnd(14)}${s.owner}`); else term(h, `tcp    ${`${s.localIp === null ? '0.0.0.0' : u32ToIp(s.localIp)}:${s.localPort}`.padEnd(23)}${(s.remoteIp === null ? '*:*' : `${u32ToIp(s.remoteIp)}:${s.remotePort}`).padEnd(23)}${s.state.padEnd(14)}${s.owner}  cwnd=${s.cwnd} ssthresh=${s.ssthresh > 1e9 ? 'inf' : s.ssthresh} rto=${(s.rto / 1000).toFixed(0)}ms`); }
}
function cmdArp(st: EngineState, h: HostState, a: string[]) {
  if (a[0] === '-d' && a[1]) { delete h.arp[a[1]]; return; }
  if (a[0] === '-s' && a[1] && a[2]) { if (!isValidIp(a[1]) || !isValidMac(a[2])) throw new Error('bad address'); h.arp[a[1]] = { mac: a[2].toLowerCase(), expires: Number.MAX_SAFE_INTEGER, static: true }; return; }
  const entries = Object.entries(h.arp).filter(([, e]) => e.static || e.expires > st.time);
  if (!entries.length) { term(h, 'arp: no entries'); return; }
  for (const [ip, e] of entries) term(h, `? (${ip}) at ${e.mac} [ether]${e.static ? ' PERM' : ''} on ${h.ifaces[0]!.name}`);
}
function cmdIfconfig(h: HostState) {
  for (const i of h.ifaces) {
    term(h, `${i.name}: flags=${i.up ? 'UP,BROADCAST,RUNNING' : 'DOWN'}  mtu ${i.mtu}`);
    if (i.ip !== null) term(h, `        inet ${u32ToIp(i.ip)}  netmask ${u32ToIp(i.mask)}  broadcast ${u32ToIp(((i.ip & i.mask) | (~i.mask >>> 0)) >>> 0)}`);
    term(h, `        ether ${i.mac}`); term(h, `        RX packets ${i.rxPackets}  bytes ${i.rxBytes}  dropped ${i.rxDrops}`); term(h, `        TX packets ${i.txPackets}  bytes ${i.txBytes}  dropped ${i.txDrops}`);
  }
}
function cmdIp(st: EngineState, h: HostState, a: string[]) {
  void st; const sub = a[0];
  if (sub === 'addr' || sub === 'address' || sub === 'a') {
    if (a[1] === 'add' && a[2] && a[3] === 'dev' && a[4]) { const { ip, mask } = parseCidr(a[2]); const i = h.ifaces.find(x => x.name === a[4]); if (!i) throw new Error(`Cannot find device "${a[4]}"`); i.ip = ip; i.mask = mask; rebuildConnectedRoutes(h); return; }
    if (a[1] === 'del' && a[2]) { const i = h.ifaces.find(x => x.name === a[2]); if (!i) throw new Error(`Cannot find device "${a[2]}"`); i.ip = null; rebuildConnectedRoutes(h); return; }
    h.ifaces.forEach((i, n) => { term(h, `${n + 1}: ${i.name}: <${i.up ? 'UP' : 'DOWN'}> mtu ${i.mtu}`); term(h, `    link/ether ${i.mac}`); if (i.ip !== null) term(h, `    inet ${u32ToIp(i.ip)}/${maskToPrefix(i.mask)} scope global ${i.name}`); }); return;
  }
  if (sub === 'link') {
    if (a[1] === 'set' && a[2]) { const i = h.ifaces.find(x => x.name === a[2]); if (!i) throw new Error(`Cannot find device "${a[2]}"`); if (a[3] === 'up' || a[3] === 'down') { i.up = a[3] === 'up'; rebuildConnectedRoutes(h); return; } if (a[3] === 'mtu' && a[4]) { const m = Number(a[4]); if (m < 68 || m > 9000) throw new Error('invalid mtu'); i.mtu = m; return; } }
    h.ifaces.forEach((i, n) => term(h, `${n + 1}: ${i.name}: <${i.up ? 'UP' : 'DOWN'}> mtu ${i.mtu} link/ether ${i.mac}`)); return;
  }
  if (sub === 'route' || sub === 'r') {
    if (a[1] === 'add' && a[2] === 'default' && a[3] === 'via' && a[4]) { if (!isValidIp(a[4])) throw new Error('bad gateway'); setDefaultGateway(h, ipToU32(a[4])); if (!h.routes.some(r => r.kind === 'default')) throw new Error('Nexthop has invalid gateway (not on a connected subnet)'); return; }
    if (a[1] === 'add' && a[2] && a[3] === 'via' && a[4]) { const { ip, mask } = parseCidr(a[2]); const e = addStaticRoute(h, ip, mask, ipToU32(a[4])); if (e) throw new Error(e); return; }
    if (a[1] === 'del' && a[2]) { if (a[2] === 'default') { setDefaultGateway(h, null); return; } const { ip, mask } = parseCidr(a[2]); h.routes = h.routes.filter(r => !(r.dst === ip && r.mask === mask && r.kind !== 'connected')); return; }
    cmdRoute(h); return;
  }
  term(h, 'usage: ip addr|link|route ...');
}
function cmdRoute(h: HostState) {
  term(h, 'Kernel IP routing table'); term(h, 'Destination     Gateway         Genmask         Flags Metric Iface');
  for (const r of [...h.routes].sort((a, b) => b.mask - a.mask)) term(h, `${u32ToIp(r.dst).padEnd(16)}${(r.gw === null ? '0.0.0.0' : u32ToIp(r.gw)).padEnd(16)}${u32ToIp(r.mask).padEnd(16)}${(r.gw === null ? 'U' : 'UG').padEnd(6)}${String(r.metric).padEnd(7)}${r.iface}`);
}
const SYSCTL: Record<string, { get: (h: HostState) => string; set: (h: HostState, v: string) => void }> = {
  'net.ipv4.ip_forward': { get: h => h.forwarding ? '1' : '0', set: (h, v) => { h.forwarding = v === '1'; } },
  'net.ipv4.tcp_congestion_control': { get: h => h.tcp.cc, set: (h, v) => { if (!['tahoe', 'reno', 'newreno', 'cubic'].includes(v)) throw new Error(`unknown congestion control "${v}"`); h.tcp.cc = v as CcName; } },
  'net.ipv4.tcp_sack': { get: h => h.tcp.sack ? '1' : '0', set: (h, v) => { h.tcp.sack = v === '1'; } },
  'net.ipv4.tcp_window_scaling': { get: h => h.tcp.wscale ? '1' : '0', set: (h, v) => { h.tcp.wscale = v === '1'; } },
  'net.ipv4.tcp_initcwnd': { get: h => String(h.tcp.initCwndSegs), set: (h, v) => { h.tcp.initCwndSegs = Math.max(1, Number(v) || 1); } },
  'net.ipv4.tcp_delack': { get: h => h.tcp.delayedAck ? '1' : '0', set: (h, v) => { h.tcp.delayedAck = v === '1'; } },
  'net.ipv4.tcp_nagle': { get: h => h.tcp.nagle ? '1' : '0', set: (h, v) => { h.tcp.nagle = v === '1'; } },
  'net.ipv4.tcp_rmem': { get: h => String(h.tcp.rcvBufCap), set: (h, v) => { h.tcp.rcvBufCap = Math.max(1024, Number(v) || 65536); } },
};
function cmdSysctl(h: HostState, a: string[]) {
  if (!a[0] || a[0] === '-a') { for (const [k, v] of Object.entries(SYSCTL)) term(h, `${k} = ${v.get(h)}`); return; }
  const [k, v] = a.join(' ').split('='); const key = k!.trim(); const e = SYSCTL[key]; if (!e) throw new Error(`cannot stat ${key}: No such file or directory`);
  if (v === undefined) { term(h, `${key} = ${e.get(h)}`); return; } e.set(h, v.trim()); term(h, `${key} = ${e.get(h)}`);
}
