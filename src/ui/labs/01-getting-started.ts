import { E, ip, m, scene, type Lab } from './helpers';
import type { ScenarioCheck } from '@/engine/types';
const MOD = 'Getting Started';
const CHK_PING: ScenarioCheck[] = [{ id: 'ping', label: 'PC-A pinged PC-B successfully', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 192.168.1.20' }];
const CHK_SNIFF_ICMP: ScenarioCheck[] = [{ id: 'snifficmp', label: 'An ICMP echo request was captured', kind: 'sniffHas', expr: 'icmp.type == 8' }];

function twoHostLan(withSniffer = false) {
  return (st: import('@/engine/types').EngineState) => {
    const a = E.addHost(st, 'laptop', 140, 300, 'PC-A'); const sw = E.addSwitch(st, 340, 200, 8, 'Switch1'); const b = E.addHost(st, 'desktop', 540, 300, 'PC-B');
    const l1 = E.connect(st, a.id, 0, sw.id, 0)!; E.connect(st, b.id, 0, sw.id, 1);
    E.setIfaceIp(st, a, 'eth0', ip('192.168.1.10'), m(24)); E.setIfaceIp(st, b, 'eth0', ip('192.168.1.20'), m(24));
    if (withSniffer) E.addSniffer(st, l1);
  };
}

export const GETTING_STARTED: Lab[] = [
  {
    id: 'gs-first-ping', module: MOD, name: 'The workspace and your first ping', difficulty: 'intro', minutes: 10,
    objectives: ['Recognise the canvas, palette, node popup and terminal', 'Send ICMP echo requests with `ping` and read the results', 'Understand round-trip time (RTT)'],
    theory: [
      'A **network** is just devices that can exchange messages. In this simulator you build one on the canvas: drag devices from the left palette, wire them with the Connect tool, and double-click any device to open its configuration popup.',
      'The **terminal** inside a host is a tiny virtual operating system. The `ping` command sends **ICMP echo request** packets and measures how long each **echo reply** takes to come back. That time is the **round-trip time (RTT)**.',
      'This lab is pre-built: PC-A (`192.168.1.10`) and PC-B (`192.168.1.20`) are already wired to a switch and addressed, both in the `/24` network `192.168.1.0`.',
    ],
    build: () => scene('gs-first-ping', 'The workspace and your first ping', 'Ping PC-B from PC-A and read the round-trip times.', CHK_PING, twoHostLan()),
    checks: CHK_PING,
    steps: [
      { title: 'Open PC-A', do: 'With the Select tool active, double-click **PC-A** to open its popup, then click the **Terminal** tab.', observe: 'The prompt shows the host name.' },
      { title: 'Ping PC-B', do: 'In the terminal, run the ping command. The simulation is paused, so press **Turbo** in the top bar to run it to completion (or step with **⏭ Packet** to watch each frame).', set: ['ping -c 4 192.168.1.20'], note: 'Write down the RTT of the first reply and of the later replies.' },
      { title: 'Read the result', do: 'Read the summary line.', observe: 'It reports how many packets were transmitted and received and the packet loss.', note: 'Why is the first ping usually slower than the rest? (Hint: something has to happen before PC-A can send the very first packet.)', checkId: 'ping' },
    ],
    questions: [
      { q: 'Why was the first RTT larger than the others?', a: 'Before PC-A can send the ICMP request it must learn PC-B’s MAC address using ARP, which adds one extra round trip. Later pings reuse the cached MAC, so they are faster.' },
      { q: 'Both hosts are in `192.168.1.0/24`. What does the `/24` mean?', a: 'The first 24 bits (`192.168.1`) are the network part; the last 8 bits identify the host. Both addresses share the network part, so they are on the same subnet and can talk directly.' },
    ],
    wrap: 'You built intuition for the core loop: configure, run, observe. Everything else in these labs is this same loop applied to deeper ideas.',
  },
  {
    id: 'gs-sniffer', module: MOD, name: 'Reading packets with the sniffer', difficulty: 'intro', minutes: 12,
    objectives: ['Attach a sniffer to a link', 'Read the packet list and the layered decode', 'See ARP resolve a MAC address before ICMP flows'],
    theory: [
      'A **sniffer** (like Wireshark) records every frame crossing a link. Each captured frame is decoded into its **layers**: Ethernet, then IPv4, then ICMP, each nested inside the previous. This is **encapsulation**.',
      'Before two hosts exchange IP packets, the sender must map the destination **IP address** to a **MAC address** using **ARP** (Address Resolution Protocol). You will see the ARP request and reply come first, then the ICMP echo exchange.',
    ],
    build: () => scene('gs-sniffer', 'Reading packets with the sniffer', 'Sniff the PC-A link, ping PC-B, and read the ARP and ICMP frames.', [...CHK_PING, CHK_SNIFF_ICMP[0]!], twoHostLan(true)),
    checks: [...CHK_PING, CHK_SNIFF_ICMP[0]!],
    steps: [
      { title: 'Find the sniffer', do: 'A sniffer is already attached to PC-A’s link (the 🔍 badge on the wire). Its packet list is on the right.' },
      { title: 'Generate traffic', do: 'Open PC-A’s terminal, ping PC-B once, and run Turbo.', set: ['ping -c 1 192.168.1.20'] },
      { title: 'Read the capture', do: 'Look at the packet list. The first two frames are **ARP**, then two **ICMP** frames follow.', observe: 'The ARP request asks “Who has 192.168.1.20?” and the reply says “...is at” a MAC address.', note: 'Record the destination MAC of the ARP request. What is special about it?', checkId: 'snifficmp' },
      { title: 'Inspect the layers', do: 'Click the ICMP request row. The detail pane shows Ethernet ▸ IPv4 ▸ ICMP nested. Expand each and hover a field to highlight its bytes in the hex dump.', note: 'What is the IPv4 TTL value on the echo request?' },
    ],
    questions: [
      { q: 'What destination MAC does an ARP request use, and why?', a: 'The broadcast MAC `ff:ff:ff:ff:ff:ff`, because the sender does not yet know the target’s MAC, so it must ask everyone on the segment.' },
      { q: 'What does "encapsulation" mean here?', a: 'Each layer wraps the one above it: ICMP data is placed inside an IPv4 packet, which is placed inside an Ethernet frame. Each layer adds its own header.' },
    ],
    wrap: 'The sniffer plus the layered decode is your microscope for every later lab.',
  },
  {
    id: 'gs-filters', module: MOD, name: 'Display and capture filters', difficulty: 'intro', minutes: 10,
    objectives: ['Write display filters to focus on specific packets', 'Understand the filter grammar shared across the tool'],
    theory: [
      'A busy capture is hard to read. A **display filter** hides everything that does not match an expression, e.g. `icmp` or `arp.opcode == 2` or `ipv4.addr == 192.168.1.0/24`. The same grammar drives capture filters and breakpoints.',
      'Filters combine with `and`, `or`, `not`, comparisons (`==`, `!=`, `<`, `>`), and CIDR matches on addresses.',
    ],
    build: () => scene('gs-filters', 'Display and capture filters', 'Ping, then use display filters to isolate ARP replies and ICMP.', CHK_PING, twoHostLan(true)),
    checks: CHK_PING,
    steps: [
      { title: 'Capture some traffic', do: 'Ping PC-B four times from PC-A and Turbo.', set: ['ping -c 4 192.168.1.20'], checkId: 'ping' },
      { title: 'Filter to ICMP only', do: 'Type a filter into the display-filter box above the packet list.', set: ['icmp'], observe: 'The ARP frames disappear; the count shows shown/total.', note: 'How many ICMP frames remain?' },
      { title: 'Filter to just ARP replies', do: 'Change the filter.', set: ['arp.opcode == 2'], observe: 'Only the “is at” replies remain.' },
      { title: 'Combine conditions', do: 'Try a compound filter and a CIDR match.', set: ['icmp and ipv4.ttl == 64', 'ipv4.addr == 192.168.1.0/24'], note: 'Write one filter that shows only echo requests (hint: `icmp.type == 8`).' },
    ],
    questions: [
      { q: 'What does `ipv4.addr == 192.168.1.0/24` match?', a: 'Any packet whose source or destination IP falls inside the `192.168.1.0/24` subnet.' },
    ],
    wrap: 'Filters turn a firehose of packets into exactly the story you want to tell.',
  },
  {
    id: 'gs-stepping', module: MOD, name: 'Stepping, breakpoints and turbo', difficulty: 'intro', minutes: 12,
    objectives: ['Control simulated time: step, play, turbo', 'Set a breakpoint that pauses on a condition'],
    theory: [
      'The engine runs in **simulated time**, independent of your wall clock. **Step Event** advances one internal event; **Step Packet** advances to the next packet milestone; **Play** runs at a chosen speed; **Turbo** runs as fast as possible until things go quiet.',
      'A **breakpoint** pauses the simulation when a packet matches a condition, using the same filter grammar. It is the network equivalent of a debugger breakpoint.',
    ],
    build: () => scene('gs-stepping', 'Stepping, breakpoints and turbo', 'Set a breakpoint on the ARP reply, then step through a ping.', CHK_PING, twoHostLan(true)),
    checks: CHK_PING,
    steps: [
      { title: 'Add a breakpoint', do: 'Open the **Breakpoints** tab at the bottom. Add a breakpoint with the condition below, on the **tx** milestone (or click the “ARP reply” quick button).', set: ['arp.opcode == 2'] },
      { title: 'Start a ping and Play', do: 'Ping PC-B once, then press **Play**. The simulation pauses when the ARP reply is transmitted.', set: ['ping -c 1 192.168.1.20'], observe: 'The breakpoint banner shows which frame hit.', note: 'At what simulated time did the ARP reply appear?' },
      { title: 'Step to the end', do: 'Disable the breakpoint, then press **Step Packet** a few times to watch each frame, and finally **Turbo** to finish.', checkId: 'ping' },
      { title: 'Restart', do: 'Press **Restart**. Time returns to zero and captures clear, but your topology and addresses stay.', observe: 'This lets you re-run an experiment deterministically.' },
    ],
    questions: [
      { q: 'Why is deterministic replay useful?', a: 'The same topology, seed and inputs always produce the same run, so you (and classmates) can reproduce and compare an experiment exactly.' },
    ],
    wrap: 'You can now freeze time on any condition and inspect the network at that instant — essential for the debugging-heavy labs later.',
  },
];

