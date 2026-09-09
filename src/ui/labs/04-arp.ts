import { E, ip, m, scene, type Lab } from './helpers';
import type { ScenarioCheck } from '@/engine/types';
const MOD = 'ARP';
function lan(sniff = true) { return (st: import('@/engine/types').EngineState) => { const a = E.addHost(st, 'laptop', 160, 300, 'PC-A'); const sw = E.addSwitch(st, 360, 180, 8, 'Switch1'); const b = E.addHost(st, 'desktop', 560, 300, 'PC-B'); const l1 = E.connect(st, a.id, 0, sw.id, 0)!; E.connect(st, b.id, 0, sw.id, 1); E.setIfaceIp(st, a, 'eth0', ip('10.0.0.1'), m(24)); E.setIfaceIp(st, b, 'eth0', ip('10.0.0.2'), m(24)); if (sniff) E.addSniffer(st, l1); }; }
const arpB: ScenarioCheck = { id: 'arp', label: 'PC-A learned PC-B’s MAC', kind: 'arpEntry', node: 'PC-A', ip: '10.0.0.2', mac: '02:00:00:03:00:00' };
export const ARP_LABS: Lab[] = [
  { id: 'arp-resolve', module: MOD, name: 'ARP: from IP to MAC', difficulty: 'intro', minutes: 12,
    objectives: ['Trace the ARP request/reply exchange', 'Understand why ARP is needed at all', 'Read the ARP cache'],
    theory: ['IP packets travel inside Ethernet frames, and Ethernet delivers by **MAC address**, not IP. So before sending to `10.0.0.2`, PC-A must find that host’s MAC. It **broadcasts** an ARP request “Who has 10.0.0.2? Tell 10.0.0.1”; PC-B replies with its MAC; PC-A caches the mapping and sends the IP packet.',
      'ARP works only within one broadcast domain (one subnet). To reach another subnet a host ARPs for its **default gateway**, not the far host.'],
    build: () => scene('arp-resolve', 'ARP: from IP to MAC', 'Watch ARP resolve PC-B’s MAC, then inspect the cache.', [arpB], lan()),
    checks: [arpB],
    steps: [
      { title: 'Empty cache', do: 'Open **PC-A → ARP**. It is empty before any traffic.', note: 'Record the empty starting state.' },
      { title: 'Trigger ARP', do: 'Ping PC-B once and Turbo.', set: ['ping -c 1 10.0.0.2'] },
      { title: 'Read request and reply', do: 'In the sniffer, click the first ARP frame (the request) and the second (the reply).', observe: 'Request is broadcast; reply is unicast back to PC-A.', note: 'Copy the exact summary text of the request and the reply.' },
      { title: 'Read the cache', do: 'Re-open PC-A → ARP.', observe: 'It now maps 10.0.0.2 to a MAC with a TTL.', checkId: 'arp' },
    ],
    questions: [{ q: 'Why must the ARP request be a broadcast?', a: 'The sender does not know the target’s MAC yet, so it cannot address the request to it. Broadcasting asks every host on the segment; only the owner of that IP answers.' }],
    wrap: 'ARP is the glue between the IP world (addresses) and the Ethernet world (MACs).' },

  { id: 'arp-cache', module: MOD, name: 'The ARP cache and its lifetime', difficulty: 'core', minutes: 12,
    objectives: ['Manage the ARP cache: view, static entries, deletion', 'Understand cache TTL and re-resolution'],
    theory: ['Caching avoids an ARP exchange before every packet. Entries have a **TTL**; when they expire the next packet re-resolves. You can also add **static** entries (permanent) and delete entries by hand — useful for testing and, as you will see in the security module, relevant to spoofing.'],
    build: () => scene('arp-cache', 'The ARP cache and its lifetime', 'Populate, inspect, pin and clear the ARP cache.', [arpB], lan(false)),
    checks: [arpB],
    steps: [
      { title: 'Populate', do: 'From PC-A, ping PC-B and Turbo, then run `arp -a` in PC-A’s terminal.', set: ['ping -c 1 10.0.0.2', 'arp -a'], observe: 'One dynamic entry with a TTL.', checkId: 'arp' },
      { title: 'Add a static entry', do: 'Pin a fake mapping and list again.', set: ['arp -s 10.0.0.9 aa:bb:cc:dd:ee:ff', 'arp -a'], observe: 'The static entry is marked PERM and never expires.', note: 'How does a static entry differ from a learned one?' },
      { title: 'Delete and re-resolve', do: 'Delete PC-B’s entry, then ping it again and **Turbo**.', set: ['arp -d 10.0.0.2', 'ping -c 1 10.0.0.2'], observe: 'A fresh ARP exchange happens before the ping.', note: 'Why did deleting the entry force another ARP?' },
    ],
    questions: [{ q: 'What is the risk of a host blindly trusting ARP replies?', a: 'Anyone on the segment can claim any IP, overwriting the cache (ARP spoofing). Static entries or Dynamic ARP Inspection mitigate this — explored in the Security module.' }],
    wrap: 'You now control the cache directly, which sets up the ARP-spoofing lab later.' },

  { id: 'arp-router', module: MOD, name: 'ARP across a router', difficulty: 'core', minutes: 14,
    objectives: ['See that ARP is per-segment', 'Understand why the destination MAC changes at each hop while the IP stays'],
    theory: ['A router separates two subnets, so ARP does **not** cross it. To reach a host on the far side, PC-A ARPs for its **gateway** (the router), and the router ARPs for the final host on the other segment. The **IP addresses stay the same end-to-end**, but the **MAC addresses are rewritten at every hop**.'],
    build: () => scene('arp-router', 'ARP across a router', 'Compare the MACs and IPs on each side of a router.', [{ id: 'ping', label: 'PC-A reached the server across the router', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.2.10' }, { id: 'arpgw', label: 'PC-A resolved its gateway’s MAC', kind: 'arpEntry', node: 'PC-A', ip: '10.0.1.1', mac: '02:00:00:02:00:00' }], (st) => {
      const a = E.addHost(st, 'laptop', 140, 300, 'PC-A'); const r = E.addHost(st, 'router', 360, 200, 'R1'); const s = E.addHost(st, 'server', 580, 300, 'Server');
      const l1 = E.connect(st, a.id, 0, r.id, 0)!; const l2 = E.connect(st, r.id, 1, s.id, 0)!;
      E.setIfaceIp(st, a, 'eth0', ip('10.0.1.10'), m(24)); E.setDefaultGateway(a, ip('10.0.1.1'));
      E.setIfaceIp(st, r, 'eth0', ip('10.0.1.1'), m(24)); E.setIfaceIp(st, r, 'eth1', ip('10.0.2.1'), m(24));
      E.setIfaceIp(st, s, 'eth0', ip('10.0.2.10'), m(24)); E.setDefaultGateway(s, ip('10.0.2.1'));
      E.addSniffer(st, l1); E.addSniffer(st, l2);
    }),
    checks: [{ id: 'ping', label: 'PC-A reached the server across the router', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.2.10' }, { id: 'arpgw', label: 'PC-A resolved its gateway’s MAC', kind: 'arpEntry', node: 'PC-A', ip: '10.0.1.1', mac: '02:00:00:02:00:00' }],
    steps: [
      { title: 'Ping across', do: 'From PC-A ping the server (10.0.2.10) and Turbo.', set: ['ping -c 2 10.0.2.10'], checkId: 'ping' },
      { title: 'Whom did PC-A ARP for?', do: 'Run `arp -a` on PC-A.', set: ['arp -a'], observe: 'PC-A resolved the **gateway** 10.0.1.1, not the server 10.0.2.10.', checkId: 'arpgw' },
      { title: 'Compare both links', do: 'On the left-link sniffer inspect an ICMP echo; do the same on the right-link sniffer.', observe: 'IPv4 source/destination are identical on both links; the Ethernet MACs differ.', note: 'Record the source and destination MACs on each link. Which stays the same across the router — the IP or the MAC?' },
    ],
    questions: [{ q: 'The IP addresses are unchanged but the MACs change at the router. Why?', a: 'IP addressing is end-to-end; Ethernet is hop-by-hop. Each link is its own Layer-2 segment, so every hop rewrites the frame’s source/destination MAC while the IP packet inside is preserved (only its TTL decrements).' }],
    wrap: 'IP is the constant; MACs are local currency, minted fresh on every hop.' },
];
