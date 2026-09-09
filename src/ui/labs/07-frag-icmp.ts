import { E, ip, m, scene, type Lab } from './helpers';
import type { ScenarioCheck } from '@/engine/types';
const MOD = 'Fragmentation & ICMP';
function routed(midMtu?: number) { return (st: import('@/engine/types').EngineState) => {
  const a = E.addHost(st, 'laptop', 120, 320, 'PC-A'); const r1 = E.addHost(st, 'router', 320, 220, 'R1'); const r2 = E.addHost(st, 'router', 540, 220, 'R2'); const b = E.addHost(st, 'server', 740, 320, 'Server');
  const l1 = E.connect(st, a.id, 0, r1.id, 0, { delayUs: 2000 })!; const l2 = E.connect(st, r1.id, 1, r2.id, 0, { delayUs: 2000, mtu: midMtu })!; const l3 = E.connect(st, r2.id, 1, b.id, 0, { delayUs: 2000 })!;
  E.setIfaceIp(st, a, 'eth0', ip('10.0.1.10'), m(24)); E.setDefaultGateway(a, ip('10.0.1.1'));
  E.setIfaceIp(st, r1, 'eth0', ip('10.0.1.1'), m(24)); E.setIfaceIp(st, r1, 'eth1', ip('10.0.12.1'), m(24)); E.addStaticRoute(r1, ip('10.0.2.0'), m(24), ip('10.0.12.2'));
  E.setIfaceIp(st, r2, 'eth0', ip('10.0.12.2'), m(24)); E.setIfaceIp(st, r2, 'eth1', ip('10.0.2.1'), m(24)); E.addStaticRoute(r2, ip('10.0.1.0'), m(24), ip('10.0.12.1'));
  E.setIfaceIp(st, b, 'eth0', ip('10.0.2.10'), m(24)); E.setDefaultGateway(b, ip('10.0.2.1'));
  if (midMtu) { r1.ifaces[1]!.mtu = midMtu; r2.ifaces[0]!.mtu = midMtu; }
  E.addSniffer(st, l2); return { l1, l2, l3 };
}; }
export const FRAG_ICMP: Lab[] = [
  { id: 'frag-basic', module: MOD, name: 'IP fragmentation and reassembly', difficulty: 'core', minutes: 15,
    objectives: ['See a large packet split to fit a small-MTU link', 'Understand the MF flag and fragment offset', 'Confirm the destination reassembles'],
    theory: ['Every link has a **Maximum Transmission Unit (MTU)**. If an IP packet is larger than the next link’s MTU (and the **Don’t Fragment** bit is clear), the router **fragments** it into pieces. Each fragment carries the same IP ID, a **fragment offset**, and the **More Fragments (MF)** flag (set on all but the last). The destination **reassembles** them.',
      'Here the middle link has a 600-byte MTU. A 1400-byte ping must be fragmented to cross it.'],
    build: () => scene('frag-basic', 'IP fragmentation and reassembly', 'Send an oversized ping across a 600-byte-MTU link.', [{ id: 'ping', label: 'The large ping succeeded (reassembled)', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.2.10' }, { id: 'frag', label: 'The server reassembled fragments', kind: 'count', node: 'Server', path: 'counters.reasmOk', min: 1 }], routed(600)),
    checks: [{ id: 'ping', label: 'The large ping succeeded (reassembled)', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.2.10' }, { id: 'frag', label: 'The server reassembled fragments', kind: 'count', node: 'Server', path: 'counters.reasmOk', min: 1 }],
    steps: [
      { title: 'Send a big ping', do: 'From PC-A send a 1400-byte ping to the server and Turbo.', set: ['ping -c 1 -s 1400 10.0.2.10'], checkId: 'ping' },
      { title: 'See the fragments', do: 'On the middle-link sniffer, look at the IPv4 frames.', observe: 'Several fragments share one IP Identification; all but the last have the **More fragments** flag set, with increasing fragment offsets.', note: 'How many fragments did one 1400-byte packet become on a 600-byte link? Record their offsets.' },
      { title: 'Confirm reassembly', do: 'Open **Server → Stats** and find the reassembly counter.', observe: 'The server rebuilt the original packet before handing it to ICMP.', checkId: 'frag' },
    ],
    questions: [{ q: 'Where does reassembly happen — at each router or only at the destination?', a: 'Only at the final destination. Routers may fragment further but never reassemble; that would require buffering all fragments at every hop.' }],
    wrap: 'One oversized packet, several fragments on the wire, one packet delivered — the MF flag and offset make it reversible.' },

  { id: 'frag-pmtud', module: MOD, name: 'Path MTU discovery', difficulty: 'advanced', minutes: 15,
    objectives: ['Set the Don’t Fragment bit', 'Trigger an ICMP “fragmentation needed” error', 'Watch the host learn the path MTU'],
    theory: ['Fragmentation is costly, so modern hosts avoid it with **Path MTU Discovery**: they set the **Don’t Fragment (DF)** bit. If a packet is too big for a link, the router cannot fragment it — instead it drops it and returns an **ICMP “fragmentation needed”** error reporting the link’s MTU. The sender caches that path MTU and sends smaller packets.'],
    build: () => scene('frag-pmtud', 'Path MTU discovery', 'Send a DF ping too big for the path and read the ICMP error.', [{ id: 'needed', label: 'PC-A received an ICMP “frag needed” error', kind: 'terminalContains', node: 'PC-A', text: 'Frag needed' }, { id: 'pmtu', label: 'PC-A learned the path MTU (600)', kind: 'count', node: 'PC-A', path: 'counters.icmpRx', min: 1 }], routed(600)),
    checks: [{ id: 'needed', label: 'PC-A received an ICMP “frag needed” error', kind: 'terminalContains', node: 'PC-A', text: 'Frag needed' }, { id: 'pmtu', label: 'PC-A learned the path MTU (600)', kind: 'count', node: 'PC-A', path: 'counters.icmpRx', min: 1 }],
    steps: [
      { title: 'Send a DF ping', do: 'From PC-A send a big ping with Don’t Fragment set and Turbo.', set: ['ping -c 1 -M do -s 1400 10.0.2.10'], observe: 'The router at the 600-MTU link returns an ICMP error instead of forwarding.', checkId: 'needed' },
      { title: 'Read the MTU', do: 'Read the error line in PC-A’s terminal.', observe: 'It reports the next-hop MTU (600).', note: 'What MTU did the router report? Which router sent the error?', checkId: 'pmtu' },
      { title: 'Send within the PMTU', do: 'Now send a ping small enough to fit and Turbo.', set: ['ping -c 1 -M do -s 500 10.0.2.10'], observe: 'It succeeds without fragmentation.', note: 'Why does PMTUD avoid the cost of fragmentation entirely?' },
    ],
    questions: [{ q: 'What does the router do with a too-big DF packet, and how does the sender find out the MTU?', a: 'It drops the packet and sends back an ICMP “fragmentation needed” message carrying the next-hop MTU. The sender caches that value as the path MTU and shrinks its packets.' }],
    wrap: 'DF + the ICMP feedback loop lets endpoints size packets perfectly without any router ever fragmenting.' },

  { id: 'icmp-traceroute', module: MOD, name: 'TTL and how traceroute works', difficulty: 'core', minutes: 14,
    objectives: ['Understand the TTL field and “TTL exceeded”', 'See how traceroute maps a path hop by hop'],
    theory: ['Every IP packet has a **Time To Live (TTL)** that each router decrements. At zero, the router drops the packet and returns an **ICMP Time Exceeded** message. **traceroute** exploits this: it sends packets with TTL 1, 2, 3… Each elicits a “TTL exceeded” from the next router along the path, revealing every hop.'],
    build: () => scene('icmp-traceroute', 'TTL and how traceroute works', 'Trace the path across two routers and watch TTL at work.', [{ id: 'trace', label: 'traceroute reached the server', kind: 'terminalContains', node: 'PC-A', text: '10.0.2.10' }, { id: 'ttl', label: 'A small-TTL ping triggered “Time to live exceeded”', kind: 'terminalContains', node: 'PC-A', text: 'Time to live exceeded' }], routed()),
    checks: [{ id: 'trace', label: 'traceroute reached the server', kind: 'terminalContains', node: 'PC-A', text: '10.0.2.10' }, { id: 'ttl', label: 'A small-TTL ping triggered “Time to live exceeded”', kind: 'terminalContains', node: 'PC-A', text: 'Time to live exceeded' }],
    steps: [
      { title: 'Force a TTL expiry', do: 'From PC-A ping the server with TTL 1 and Turbo.', set: ['ping -c 1 -t 1 10.0.2.10'], observe: 'The first router replies “Time to live exceeded” because the TTL hit zero there.', note: 'Which router answered, and why that one?', checkId: 'ttl' },
      { title: 'Run traceroute', do: 'Now trace the whole path and Turbo.', set: ['traceroute 10.0.2.10'], observe: 'Each hop appears in order: R1, R2, then the server.', note: 'Record the three hop addresses. How does traceroute learn each one?', checkId: 'trace' },
    ],
    questions: [{ q: 'How does incrementing TTL reveal the path?', a: 'A packet with TTL n dies at the n-th router, which identifies itself via an ICMP Time Exceeded message. Sending TTL 1, 2, 3… makes each successive router reveal itself, mapping the path hop by hop.' }],
    wrap: 'TTL is a loop-prevention safety valve that traceroute cleverly repurposes into a mapping tool.' },
];
