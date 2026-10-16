// All engine state is plain, structured-cloneable data. No closures, no class instances,
// no live timers. Timers are events in the heap. This is what makes snapshot/restore exact.
import type { Mac } from '@/shared/bytes';
import type { RngState } from './rng';

export type NodeId = number; export type LinkId = number; export type SnifferId = number;
export type NodeType = 'host' | 'router' | 'switch' | 'ap';
export type HostKind = 'laptop' | 'desktop' | 'iot' | 'server' | 'router';

export interface Iface {
  name: string; mac: Mac; ip: number | null; mask: number; up: boolean; mtu: number;
  linkId: LinkId | null; promisc: boolean; wifi?: WifiIface;
  rxPackets: number; txPackets: number; rxBytes: number; txBytes: number; rxDrops: number; txDrops: number;
}
export type RouteKind = 'connected' | 'static' | 'default' | 'rip' | 'ospf' | 'bgp';
export interface WifiIface { ssid: string; channel: number; range: number; associated: NodeId | null; scanning: boolean }
export interface Route { dst: number; mask: number; gw: number | null; iface: string; metric: number; kind: RouteKind }
export interface ArpEntry { mac: Mac; expires: number; static: boolean }
export interface ArpPending { ip: number; frames: { payload: Uint8Array; ifaceIdx: number; ethertype: number }[]; retries: number; started: number }
export type DnsRData2 = { kind: 'a'; ip: number } | { kind: 'ns' | 'cname' | 'ptr'; name: string } | { kind: 'mx'; pref: number; name: string } | { kind: 'txt'; text: string } | { kind: 'soa'; mname: string; rname: string; serial: number; refresh: number; retry: number; expire: number; minimum: number } | { kind: 'raw'; bytes: Uint8Array };
export interface DnsZoneRecord { name: string; type: number; ttl: number; data: DnsRData2 }
export interface DnsZone { origin: string; text: string; records: DnsZoneRecord[] }
export type DnsWaiter =
  | { kind: 'dig'; name: string; type: number; serverIp: string; t0: number }
  | { kind: 'ping'; name: string; opts: { count?: number; interval?: number; size?: number; ttl?: number; df?: boolean } }
  | { kind: 'traceroute'; name: string; opts: { maxHops?: number; probes?: number; icmp?: boolean; timeout?: number } }
  | { kind: 'http'; pid: number; path: string; host: string; port: number };
export interface DnsCacheEntry { records: { name: string; type: number; cls: number; ttl: number; data: DnsRData2 }[]; expires: number }
export interface ReassemblyBuf { src: number; dst: number; id: number; proto: number; frags: { off: number; data: Uint8Array; mf: boolean }[]; totalLen: number | null; started: number; firstHdr: Uint8Array | null; ttl: number }

// ---------- sockets ----------
export type TcpState = 'CLOSED' | 'LISTEN' | 'SYN_SENT' | 'SYN_RCVD' | 'ESTABLISHED' | 'FIN_WAIT_1' | 'FIN_WAIT_2' | 'CLOSE_WAIT' | 'CLOSING' | 'LAST_ACK' | 'TIME_WAIT';
export type CcName = 'tahoe' | 'reno' | 'newreno' | 'cubic';
export interface TcpTracePoint { t: number; cwnd: number; ssthresh: number; rwnd: number; srtt: number; rto: number; inflight: number; ev?: string }
export interface TcpSeqEvent { t: number; kind: 'data' | 'ack' | 'retx' | 'sack'; seq: number; len: number }
export interface UdpSocket { id: number; proto: 'udp'; owner: number; localIp: number | null; localPort: number; remoteIp: number | null; remotePort: number | null; rx: { src: number; sport: number; dport: number; data: Uint8Array; t: number; ttl: number }[]; rxBytes: number; txBytes: number; err: string | null }
export interface TcpSocket {
  id: number; proto: 'tcp'; owner: number; state: TcpState;
  localIp: number | null; localPort: number; remoteIp: number | null; remotePort: number | null;
  listenBacklog: number[] | null;           // for LISTEN sockets: accepted child socket ids not yet taken
  parent: number | null;                     // child of a listener
  // send
  iss: number; sndUna: number; sndNxt: number; sndWnd: number; sndWl1: number; sndWl2: number; maxSndWnd: number;
  sendBuf: Uint8Array; sendBufSeq: number;   // sendBuf[0] corresponds to seq sendBufSeq (== sndUna)
  finQueued: boolean; finSeq: number | null; finAcked: boolean; sndMaxSeq: number;
  // recv
  irs: number; rcvNxt: number; rcvBufCap: number; recvBuf: Uint8Array; ooo: { seq: number; data: Uint8Array }[]; finRcvd: number | null; lastAdvWnd: number;
  // options
  mss: number; peerMss: number; wscale: number; peerWscale: number; sackOk: boolean; peerSackOk: boolean; sacked: [number, number][];
  // rtt / rto
  srtt: number; rttvar: number; rto: number; rtoBackoff: number; rttSeq: number | null; rttStart: number; rtoGen: number; rtoArmed: boolean; rtoDeadline: number;
  // congestion
  cc: CcName; cwnd: number; ssthresh: number; dupAcks: number; recover: number; inRecovery: boolean; highRxt: number;
  cubic: { wMax: number; k: number; epochStart: number; originPoint: number; tcpCwnd: number; ackCnt: number; minRtt: number };
  // misc timers (generation-counted)
  delAckGen: number; delAckPending: boolean; quickAcks: number; persistGen: number; timeWaitGen: number; synRetries: number; keepGen: number;
  nagle: boolean; delayedAck: boolean;
  // stats + trace
  stats: { txSegs: number; rxSegs: number; retx: number; rtoCount: number; fastRetx: number; dupAcksRx: number; txBytes: number; rxBytes: number; appRxBytes: number; oooSegs: number; zeroWnd: number };
  trace: TcpTracePoint[]; seqTrace: TcpSeqEvent[]; log: string[]; createdAt: number; err: string | null;
}
export type Socket = UdpSocket | TcpSocket;

// ---------- processes ----------
export interface PingProc { kind: 'ping'; pid: number; target: number; targetStr: string; count: number; sent: number; received: number; interval: number; timeout: number; outstanding: Record<number, number>; rtts: number[]; done: boolean; ident: number; size: number; ttl: number; df: boolean; errors: number }
export interface TracerouteProc { kind: 'traceroute'; pid: number; target: number; targetStr: string; maxHops: number; probes: number; ttl: number; probe: number; sock: number; basePort: number; sent: Record<number, { t: number; ttl: number }>; hopResults: { ttl: number; from: number | null; rtts: (number | null)[] }[]; done: boolean; timeout: number; icmpMode: boolean; ident: number; reached: boolean; waiting: boolean }
export interface IperfProc { kind: 'iperf'; pid: number; role: 'server' | 'client'; udp: boolean; port: number; sock: number; target: number | null; durationUs: number; bytesTarget: number | null; started: number; lastReport: number; bytes: number; bytesInterval: number; done: boolean; rateBps: number; udpSeq: number; udpLost: number; udpRx: number; udpLastSeq: number; clientSock: number | null; readRateBps: number | null; pendingRead: number; sendBlock: number; finishedAt: number | null; label: string }
export interface NcProc { kind: 'nc'; pid: number; role: 'listen' | 'connect'; udp: boolean; sock: number; port: number; target: number | null; message: string | null; done: boolean; acceptedSock: number | null; keep: boolean }
export interface HttpConn { buf: Uint8Array; keepAlive: boolean; served: number; requests?: string[]; sentAt?: Record<string, number> }
export interface HttpProc { kind: 'http'; pid: number; role: 'server' | 'client'; port: number; sock: number; conns: Record<number, HttpConn>; done: boolean; target: number | null; host: string; path: string; mode: 'persistent' | 'nonpersistent'; pending: string[]; fetched: { path: string; status: number; bytes: number; ms: number; start: number }[]; startedAt: number; pipeline: boolean; method: string }
// A compiled/interpreted user program (e.g. a C socket program). The serializable half lives here;
// its non-cloneable execution context (coroutine / WASM instance) lives in a module-side table
// keyed by `rid`, and is rebuilt by deterministic replay-from-source on restore. `blocked` records
// what the program is currently waiting on, for the runtime inspector.
export interface CProc {
  kind: 'cprog'; pid: number; rid: string; name: string; argv: string[];
  fds: Record<number, number>; nextFd: number;        // fd -> socket id
  blocked: { syscall: string; sock?: number } | null;
  stdout: string[]; done: boolean; exitCode: number | null;
}
export type Proc = PingProc | TracerouteProc | IperfProc | NcProc | HttpProc | CProc;

export interface RipRoute { dst: number; mask: number; gw: number; iface: string; metric: number; learnedFrom: number; timeout: number; gc: number | null; changed: boolean }
export interface RipConfig { enabled: boolean; networks: { net: number; mask: number }[]; updateUs: number; timeoutUs: number; gcUs: number; splitHorizon: boolean; poisonReverse: boolean; routes: RipRoute[]; sock: number | null; gen: number }
export interface OspfNeighbor { routerId: number; ip: number; iface: string; state: 'down' | 'init' | 'two-way' | 'full'; dead: number; lastSeq: number }
export interface OspfLink { linkId: number; linkData: number; type: number; metric: number }
export interface OspfLsaStore { advRouter: number; lsId: number; type: number; seq: number; age: number; links?: OspfLink[]; attached?: number[]; netMask?: number; installedAt: number }
export interface OspfConfig { enabled: boolean; routerId: number; areaId: number; helloUs: number; deadUs: number; ifaceCosts: Record<string, number>; networks: { net: number; mask: number }[]; neighbors: Record<number, OspfNeighbor>; lsdb: Record<string, OspfLsaStore>; seq: number; spf: { dst: number; mask: number; gw: number; iface: string; cost: number }[]; gen: number }
export interface BgpNeighborCfg { peerIp: number; peerAs: number; state: 'idle' | 'connect' | 'opensent' | 'openconfirm' | 'established'; sock: number | null; routerId: number; holdUs: number; keepaliveUs: number; isClient: boolean; up: boolean; rxOpen: boolean; gen: number }
export interface BgpRibEntry { prefix: number; len: number; nextHop: number; asPath: number[]; localPref: number; med: number; origin: number; fromPeer: number; fromAs: number; best: boolean; iBGP: boolean }
export interface BgpConfig { enabled: boolean; as: number; routerId: number; neighbors: BgpNeighborCfg[]; networks: { net: number; mask: number }[]; rib: BgpRibEntry[]; routeReflector: boolean }
export interface RoutingConfig { rip: RipConfig; ospf: OspfConfig; bgp: BgpConfig }
export interface NatEntry { proto: number; insideIp: number; insidePort: number; outsidePort: number; peerIp: number; peerPort: number; expires: number }
export interface PortForward { proto: number; outsidePort: number; insideIp: number; insidePort: number }
export interface NatConfig { enabled: boolean; outsideIface: string; insideIfaces: string[]; table: NatEntry[]; portForwards: PortForward[]; nextPort: number }
export interface HostState {
  id: NodeId; type: 'host' | 'router'; kind: HostKind; name: string; x: number; y: number;
  ifaces: Iface[]; arp: Record<string, ArpEntry>; arpPending: Record<string, ArpPending>;
  routes: Route[]; dns: string[]; hostname: string; forwarding: boolean; hosts: Record<string, number>;
  dhcpServer: import('./apps/dhcp').DhcpServerCfg; dhcpServerSock: number | null; dhcpClient: import('./apps/dhcp').DhcpClient | null;
  dnsSock: number | null; dnsZones: DnsZone[]; dnsRecursion: boolean; dnsRoots: number[]; dnsForwarders: number[]; dnsCache: Record<string, DnsCacheEntry>; resolutions: Record<number, unknown>; nextResolution: number; dnsWaiters: Record<number, DnsWaiter>;
  httpDocroot: Record<string, string>;
  routing: RoutingConfig; bgpListen: number | null; nat: NatConfig;
  procs: Record<number, Proc>; nextPid: number; terminal: string[];
  sockets: Record<number, Socket>; nextSock: number; nextEphemeral: number; tcpHistory: TcpSocket[];
  reasm: Record<string, ReassemblyBuf>; pmtu: Record<string, { mtu: number; expires: number }>;
  arpTimeoutUs: number; arpRetries: number; arpTtlUs: number; reasmTimeoutUs: number;
  tcp: { cc: CcName; initCwndSegs: number; rcvBufCap: number; delayedAck: boolean; delAckUs: number; nagle: boolean; sack: boolean; wscale: boolean; minRtoUs: number; mslUs: number };
  counters: { ipRx: number; ipTx: number; ipFwd: number; icmpRx: number; icmpTx: number; dropNoRoute: number; dropBadChecksum: number; dropNotForMe: number; dropTtl: number; fragsTx: number; fragsRx: number; reasmOk: number; reasmFail: number; udpRx: number; udpTx: number; tcpRx: number; tcpTx: number };
}
export interface SwitchPort { name: string; linkId: LinkId | null; mac: Mac; up: boolean; rxPackets: number; txPackets: number; rxDrops: number; mode: 'access' | 'trunk'; vlan: number; trunkVlans: number[] }
export interface SwitchState {
  id: NodeId; type: 'switch'; name: string; x: number; y: number;
  ports: SwitchPort[]; macTable: Record<string, { port: number; expires: number; vlan: number }>; agingUs: number; vlanEnabled: boolean; script: string | null;
  counters: { learned: number; flooded: number; forwarded: number; filtered: number };
}
export interface ApClient { mac: Mac; node: NodeId; iface: number; assocAt: number }
export interface ApState {
  id: NodeId; type: 'ap'; name: string; x: number; y: number;
  ssid: string; channel: number; range: number; mac: Mac;
  ports: SwitchPort[]; // wired uplink ports (bridge to wired LAN)
  clients: ApClient[]; macTable: Record<string, { port: number; wireless: boolean; node: NodeId; iface: number; expires: number }>;
  beaconUs: number; rtsCts: boolean;
  counters: { beacons: number; assoc: number; txData: number; rxData: number; collisions: number; retries: number; bridged: number };
}
export type NodeState = HostState | SwitchState | ApState;
export function isHost(n: NodeState | undefined): n is HostState { return !!n && (n.type === 'host' || n.type === 'router'); }
export function isAp(n: NodeState | undefined): n is ApState { return !!n && n.type === 'ap'; }

// ---------- links ----------
export interface QueuedFrame { bytes: Uint8Array; frameId: number; enqueuedAt: number; fromNode: NodeId; toNode: NodeId }
export interface LinkDir { queue: QueuedFrame[]; busy: boolean; held: QueuedFrame | null }
export interface LinkEnd { node: NodeId; iface: number }
export interface LinkImpair { dir: 'ab' | 'ba' | 'both'; dropNext: number; filter: string; delayNext: number; delayUs: number; dupNext: number; reorderNext: number; corruptNext: number }
export interface LinkState {
  id: LinkId; a: LinkEnd; b: LinkEnd;
  bandwidthBps: number; bandwidthBpsRev: number; delayUs: number; jitterUs: number; lossPct: number; queueDepth: number; mtu: number;
  ab: LinkDir; ba: LinkDir; // ab = frames from a to b
  impair: LinkImpair;
  stats: { abTx: number; baTx: number; abDrops: number; baDrops: number };
}
export type LinkDirName = 'ab' | 'ba';

export type Milestone = 'tx' | 'rx' | 'drop';
export interface CapturedFrame { n: number; t: number; dir: LinkDirName; bytes: Uint8Array; from: NodeId; to: NodeId; frameId: number; drop?: string }
/** Ground-truth provenance of a transmitted frame (E2): who put it on the wire and under what label.
 *  Recorded only while a tx tag is active (adversary agents set one), so normal traffic stays unlabeled
 *  and defaults to "benign" in the label sidecar. Keyed by frameId. */
export interface FrameOrigin { tag: string; node: NodeId; pid?: number }
export interface SnifferState { id: SnifferId; linkId: LinkId; frames: CapturedFrame[]; nextN: number; captureFilter: string; maxFrames: number; total: number }

export interface Breakpoint { id: number; enabled: boolean; expr: string; milestones: Milestone[]; label?: string }
export interface BreakpointHit { breakpointId: number; milestone: Milestone; linkId: LinkId; frameId: number; nodeId: NodeId; t: number; bytes: Uint8Array; reason?: string }

export type SimEventBody = (
  | { kind: 'linkTxStart'; link: LinkId; dir: LinkDirName }
  | { kind: 'linkDeliver'; link: LinkId; dir: LinkDirName; frameId: number; bytes: Uint8Array; from: NodeId; to: NodeId; txStart: number }
  | { kind: 'timer'; node: NodeId; tag: string; data?: unknown }
  | { kind: 'linkEnqueue'; link: LinkId; dir: LinkDirName; frame: QueuedFrame }
);
export type SimEvent = SimEventBody & { t: number; seq: number };

/** A frame currently propagating on a link; derived for the canvas animation. */
export interface Flight { linkId: LinkId; dir: LinkDirName; frameId: number; start: number; end: number; proto: string; from: NodeId; to: NodeId }

export interface RfTransmission { id: number; node: NodeId; iface: number; channel: number; x: number; y: number; range: number; start: number; end: number; bytes: Uint8Array; kind: 'data' | 'ack' | 'rts' | 'cts' | 'beacon'; dstMac: Mac; srcMac: Mac; collidedAt: NodeId[] }
export interface RfPending { node: NodeId; iface: number; bytes: Uint8Array; dstMac: Mac; kind: 'data' | 'rts' | 'cts' | 'ack' | 'beacon'; retries: number; cw: number; awaitingAck: boolean; seq: number }
export interface WifiCapture { n: number; t: number; bytes: Uint8Array; from: NodeId; kind: string; collision: boolean; rssi: number }
export interface AirMonitor { id: number; channel: number; frames: WifiCapture[]; nextN: number; total: number }
export type ScenarioCheck =
  | { id: string; label: string; kind: 'terminalContains'; node: string; text: string }
  | { id: string; label: string; kind: 'terminalMatches'; node: string; pattern: string }
  | { id: string; label: string; kind: 'hasRoute'; node: string; prefix: string; via?: string }
  | { id: string; label: string; kind: 'routeKind'; node: string; prefix: string; routeKind: string }
  | { id: string; label: string; kind: 'ifaceIp'; node: string; iface: string; ip: string }
  | { id: string; label: string; kind: 'associated'; node: string }
  | { id: string; label: string; kind: 'natActive'; node: string }
  | { id: string; label: string; kind: 'bgpEstablished'; node: string }
  | { id: string; label: string; kind: 'ospfFull'; node: string }
  | { id: string; label: string; kind: 'arpEntry'; node: string; ip: string; mac: string }
  | { id: string; label: string; kind: 'count'; node: string; path: string; min: number }
  | { id: string; label: string; kind: 'tcpStat'; node: string; field: string; min: number }
  | { id: string; label: string; kind: 'macLearned'; node: string; count: number }
  | { id: string; label: string; kind: 'sniffHas'; expr: string };
export interface Scenario { id?: string; title: string; description: string; checks: ScenarioCheck[] }
export interface EngineState {
  version: 1;
  time: number; seq: number; rng: RngState; seed: number;
  events: SimEvent[];
  nodes: Record<NodeId, NodeState>; links: Record<LinkId, LinkState>; sniffers: Record<SnifferId, SnifferState>;
  breakpoints: Breakpoint[]; nextBreakpointId: number;
  nextNodeId: number; nextLinkId: number; nextSnifferId: number; nextFrameId: number;
  lastHit: BreakpointHit | null;
  log: { t: number; text: string }[];
  /** Per-run milestones since last drain (for step-packet + UI). */
  recentMilestones: { milestone: Milestone; linkId: LinkId; frameId: number; t: number; nodeId: NodeId; reason?: string }[];
  rf: { transmissions: RfTransmission[]; nextTxId: number; nextRfSeq: number; monitors: Record<number, AirMonitor>; nextMonitorId: number };
  scenario: Scenario | null;
  lastActivityT: number;
  /** E2 provenance: the active transmission label (adversary agents set/clear it), and the per-frame
   *  ground-truth origin keyed by frameId. Both optional so old sessions still load. */
  txTag?: string | null;
  frameOrigins?: Record<number, FrameOrigin>;
}
