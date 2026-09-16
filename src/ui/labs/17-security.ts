import { E, ip, m, scene, type Lab } from './helpers';
import type { EngineState, ScenarioCheck } from '@/engine/types';
import { SEC } from '@/engine/core';
const MOD = 'Security';
function lan3() { return (st: EngineState) => {
  const sw = E.addSwitch(st, 380, 140, 8, 'Switch1'); const victim = E.addHost(st, 'laptop', 140, 340, 'Victim'); const gw = E.addHost(st, 'router', 380, 340, 'Gateway'); const attacker = E.addHost(st, 'desktop', 620, 340, 'Attacker');
  E.connect(st, victim.id, 0, sw.id, 0); E.connect(st, gw.id, 0, sw.id, 1); E.connect(st, attacker.id, 0, sw.id, 2);
  E.setIfaceIp(st, victim, 'eth0', ip('10.0.0.10'), m(24)); E.setDefaultGateway(victim, ip('10.0.0.1'));
  E.setIfaceIp(st, gw, 'eth0', ip('10.0.0.1'), m(24)); E.setIfaceIp(st, attacker, 'eth0', ip('10.0.0.66'), m(24));
  return { victim, gw, attacker };
}; }
export const SECURITY_LABS: Lab[] = [
  { id: 'sec-arpspoof', module: MOD, name: 'ARP spoofing and man-in-the-middle', difficulty: 'advanced', minutes: 16,
    objectives: ['Poison a victim’s ARP cache', 'Understand why dynamic ARP is trust-on-first-use', 'Name real defences'],
    theory: ['ARP has no authentication: a host believes any reply. An attacker can broadcast a **gratuitous ARP** claiming the **gateway’s** IP is at the attacker’s MAC. The victim caches it and unknowingly sends its gateway-bound traffic to the attacker — a **man-in-the-middle**. Defences include **static ARP**, **Dynamic ARP Inspection**, and switch **port security**.'],
    build: () => scene('sec-arpspoof', 'ARP spoofing and man-in-the-middle', 'Poison the victim’s entry for the gateway.', [{ id: 'poison', label: 'Victim’s gateway entry now points at the attacker', kind: 'arpEntry', node: 'Victim', ip: '10.0.0.1', mac: '02:00:00:04:00:00' }], lan3()),
    checks: [{ id: 'poison', label: 'Victim’s gateway entry now points at the attacker', kind: 'arpEntry', node: 'Victim', ip: '10.0.0.1', mac: '02:00:00:04:00:00' }],
    steps: [
      { title: 'Baseline', do: 'On **Victim** ping the gateway and run `arp -a`, Turbo.', set: ['ping -c 1 10.0.0.1', 'arp -a'], note: 'Record the victim’s real MAC for 10.0.0.1 (the Gateway).' },
      { title: 'Launch the spoof', do: 'On **Attacker** send a gratuitous ARP claiming the gateway’s address, then Turbo.', set: ['arpspoof 10.0.0.1'], observe: 'The forged reply is broadcast to the segment.' },
      { title: 'Confirm the poisoning', do: 'On **Victim** run `arp -a` again.', set: ['arp -a'], observe: 'The gateway 10.0.0.1 now maps to the Attacker’s MAC `02:00:00:04:00:00`.', checkId: 'poison', note: 'Whose MAC does the victim now believe is the gateway? Where will its Internet traffic go?' },
      { title: 'Mitigate', do: 'On the Victim, pin the true mapping with a static ARP entry, then re-spoof and confirm it no longer changes.', set: ['arp -s 10.0.0.1 02:00:00:02:00:00'], note: 'Why does a static entry defeat the spoof? Name one scalable alternative for a real switch.' },
    ],
    questions: [{ q: 'Why is ARP so easy to spoof?', a: 'It is stateless and unauthenticated: hosts accept unsolicited replies and overwrite their cache, trusting whoever answers first. Nothing verifies the claimed IP–MAC binding.' }],
    wrap: 'One forged packet redirects a victim’s traffic — which is why enterprise switches police ARP.' },

  { id: 'sec-sniff-http', module: MOD, name: 'Why plaintext is dangerous', difficulty: 'core', minutes: 14,
    objectives: ['Read an HTTP request off the wire', 'Understand what a sniffer on the path can see', 'Motivate HTTPS'],
    theory: ['HTTP is plaintext. Anyone who can capture the traffic — a compromised switch, a shared medium, or a man-in-the-middle — can read the full request, including any credentials or cookies. This is precisely why the web moved to **HTTPS** (TLS), which encrypts the payload so a sniffer sees only ciphertext.'],
    build: () => scene('sec-sniff-http', 'Why plaintext is dangerous', 'Sniff an HTTP request and read its contents.', [{ id: 'sniff', label: 'An HTTP request was captured in the clear', kind: 'sniffHas', expr: 'http' }, { id: 'ok', label: 'The request reached the server', kind: 'terminalContains', node: 'Client', text: '200 OK' }], (st) => {
      const c = E.addHost(st, 'laptop', 180, 300, 'Client'); const sw = E.addSwitch(st, 380, 180, 8, 'Switch1'); const s = E.addHost(st, 'server', 580, 300, 'WebSrv');
      const l1 = E.connect(st, c.id, 0, sw.id, 0)!; E.connect(st, s.id, 0, sw.id, 1);
      E.setIfaceIp(st, c, 'eth0', ip('10.0.0.2'), m(24)); E.setIfaceIp(st, s, 'eth0', ip('10.0.0.80'), m(24));
      s.httpDocroot = { 'index.html': '<html><body>secret area</body></html>', 'login': 'OK' };
      E.addSniffer(st, l1);
    }),
    checks: [{ id: 'sniff', label: 'An HTTP request was captured in the clear', kind: 'sniffHas', expr: 'http' }, { id: 'ok', label: 'The request reached the server', kind: 'terminalContains', node: 'Client', text: '200 OK' }],
    steps: [
      { title: 'Start the server', do: 'On **WebSrv** run `httpd`.', set: ['httpd'] },
      { title: 'Send a request with data', do: 'On **Client** POST some “credentials” and Turbo.', set: ['curl -X POST --no-recurse http://10.0.0.80/login'], checkId: 'ok' },
      { title: 'Read it off the wire', do: 'In the sniffer, filter `http` and click the request. Expand the HTTP layer and read the hex/ASCII.', set: ['display filter: http'], observe: 'The method, path and headers are fully readable.', checkId: 'sniff', note: 'What could an eavesdropper extract from a real login request here?' },
      { title: 'The fix', do: 'Reason about HTTPS.', note: 'With TLS, what would the sniffer see instead of the request line and headers?' },
    ],
    questions: [{ q: 'A switched network limits who sees a unicast frame. Why is plaintext still risky?', a: 'A switch confines frames only until an attacker becomes man-in-the-middle (e.g. via ARP spoofing) or compromises a device on the path. Encryption protects the data regardless of who captures it.' }],
    wrap: 'If it is not encrypted, assume someone on the path can read it — the whole case for TLS.' },

  { id: 'sec-portscan', module: MOD, name: 'Port scanning and reconnaissance', difficulty: 'core', minutes: 14,
    objectives: ['Distinguish open, closed and filtered ports', 'Understand what a scan reveals to an attacker'],
    theory: ['Before attacking, adversaries **scan** for open services. A TCP connect to an **open** port completes the handshake; a **closed** port replies with **RST** (“refused”); a **filtered** port (firewall drop) gives no reply, so the scanner just times out. The pattern of responses maps a host’s attack surface.'],
    build: () => scene('sec-portscan', 'Port scanning and reconnaissance', 'Probe open vs closed ports and read the responses.', [{ id: 'open', label: 'Found an open port', kind: 'terminalContains', node: 'Attacker', text: 'succeeded' }, { id: 'closed', label: 'Identified a closed port (refused)', kind: 'terminalContains', node: 'Attacker', text: 'refused' }], (st) => {
      const sw = E.addSwitch(st, 380, 160, 8, 'Switch1'); const target = E.addHost(st, 'server', 220, 320, 'Target'); const attacker = E.addHost(st, 'desktop', 560, 320, 'Attacker');
      E.connect(st, target.id, 0, sw.id, 0); E.connect(st, attacker.id, 0, sw.id, 1);
      E.setIfaceIp(st, target, 'eth0', ip('10.0.0.10'), m(24)); E.setIfaceIp(st, attacker, 'eth0', ip('10.0.0.66'), m(24));
      target.httpDocroot = { 'index.html': 'ok' };
      E.addSniffer(st, 1);
    }),
    checks: [{ id: 'open', label: 'Found an open port', kind: 'terminalContains', node: 'Attacker', text: 'succeeded' }, { id: 'closed', label: 'Identified a closed port (refused)', kind: 'terminalContains', node: 'Attacker', text: 'refused' }],
    steps: [
      { title: 'Open a service', do: 'On **Target** start a web server so port 80 is open.', set: ['httpd'] },
      { title: 'Scan an open port', do: 'On **Attacker** connect to port 80 and Turbo.', set: ['nc 10.0.0.10 80'], observe: 'The handshake completes: “succeeded”.', checkId: 'open', note: 'What three TCP segments made the connection succeed?' },
      { title: 'Scan a closed port', do: 'On **Attacker** connect to a port with no listener and Turbo.', set: ['nc 10.0.0.10 9999'], observe: 'The Target replies with a RST: “Connection refused”.', checkId: 'closed', note: 'How does the attacker tell “closed” from “open” from the responses?' },
      { title: 'See it on the wire', do: 'In the sniffer, compare the open-port handshake (SYN, SYN-ACK, ACK) with the closed-port SYN → RST.', note: 'What would a *filtered* (firewalled-drop) port look like to the scanner?' },
    ],
    questions: [{ q: 'How does a scanner distinguish closed from filtered?', a: 'A closed port actively refuses with a TCP RST; a filtered port silently drops the SYN, so the scanner receives nothing and eventually times out — no RST, no handshake.' }],
    wrap: 'Every open port is a door; scanning is how attackers (and defenders) inventory them.' },

  { id: 'sec-dhcp-exhaustion', module: MOD, name: 'DHCP pool exhaustion (concept)', difficulty: 'advanced', minutes: 14,
    objectives: ['See a limited DHCP pool', 'Reason about starvation and rogue-server risks'],
    theory: ['A DHCP pool has a finite set of addresses. An attacker who requests many leases (spoofing MACs) can **exhaust** the pool so legitimate clients get nothing — a denial of service — and may then run a **rogue DHCP server** to hand out a malicious gateway/DNS. Defences include **DHCP snooping** on switches.'],
    build: () => scene('sec-dhcp-exhaustion', 'DHCP pool exhaustion (concept)', 'Watch two clients consume a tiny pool and reason about starvation.', [{ id: 'c1', label: 'Client-1 got a lease', kind: 'terminalContains', node: 'Client-1', text: 'DHCPACK' }, { id: 'c2', label: 'Client-2 got a different lease', kind: 'terminalContains', node: 'Client-2', text: 'DHCPACK' }], (st) => {
      const gw = E.addHost(st, 'router', 200, 160, 'Gateway'); const sw = E.addSwitch(st, 400, 160, 8, 'Switch1');
      const c1 = E.addHost(st, 'laptop', 340, 340, 'Client-1'); const c2 = E.addHost(st, 'laptop', 500, 340, 'Client-2');
      E.connect(st, gw.id, 0, sw.id, 0); E.connect(st, c1.id, 0, sw.id, 1); E.connect(st, c2.id, 0, sw.id, 2);
      E.setIfaceIp(st, gw, 'eth0', ip('10.0.0.1'), m(24));
      gw.dhcpServer = { enabled: true, iface: 'eth0', poolStart: ip('10.0.0.100'), poolEnd: ip('10.0.0.101'), mask: m(24), gateway: ip('10.0.0.1'), dns: [], leaseUs: 3600 * SEC, leases: {} };
    }),
    checks: [{ id: 'c1', label: 'Client-1 got a lease', kind: 'terminalContains', node: 'Client-1', text: 'DHCPACK' }, { id: 'c2', label: 'Client-2 got a different lease', kind: 'terminalContains', node: 'Client-2', text: 'DHCPACK' }],
    steps: [
      { title: 'Note the tiny pool', do: 'Open **Gateway → Services → DHCP server**. The pool holds only two addresses (10.0.0.100–101).', note: 'How many clients can this pool serve?' },
      { title: 'Lease both', do: 'On **Client-1** and **Client-2** run `dhclient`, Turbo.', set: ['Client-1: dhclient', 'Client-2: dhclient'], observe: 'Each gets a distinct address; the pool is now full.', checkId: 'c1', note: 'Record the two leased addresses. Check Gateway → Services for the lease table.' },
      { title: 'Reason about a third client', do: 'A third client (or an attacker spoofing many MACs) would find the pool exhausted.', checkId: 'c2', note: 'What would a legitimate third client experience? How could an attacker weaponise this, and what switch feature defends it?' },
    ],
    questions: [{ q: 'How does exhausting the pool enable a further attack?', a: 'With the real server unable to answer, the attacker’s **rogue DHCP** can respond instead, handing clients a malicious gateway or DNS — a man-in-the-middle. DHCP snooping trusts only authorised server ports.' }],
    wrap: 'A finite pool plus unauthenticated requests is a denial-of-service waiting to happen without snooping.' },

  { id: 'sec-recon-icmp', module: MOD, name: 'Mapping a network with ICMP', difficulty: 'core', minutes: 12,
    objectives: ['Use ping and traceroute for reconnaissance', 'Understand what ICMP reveals and why it is often filtered'],
    theory: ['**ICMP** is invaluable for diagnostics — and for attackers. A **ping sweep** finds live hosts; **traceroute** maps the path and reveals intermediate routers and topology. Because this aids reconnaissance, many networks rate-limit or filter ICMP at the edge.'],
    build: () => scene('sec-recon-icmp', 'Mapping a network with ICMP', 'Discover hosts and map the path with ICMP tools.', [{ id: 'alive', label: 'Found a live host', kind: 'terminalContains', node: 'Attacker', text: 'bytes from 10.0.2.10' }, { id: 'map', label: 'Mapped the path with traceroute', kind: 'terminalContains', node: 'Attacker', text: '10.0.2.10' }], (st) => {
      const attacker = E.addHost(st, 'desktop', 120, 320, 'Attacker'); const r1 = E.addHost(st, 'router', 320, 220, 'R1'); const r2 = E.addHost(st, 'router', 540, 220, 'R2'); const target = E.addHost(st, 'server', 740, 320, 'Target');
      E.connect(st, attacker.id, 0, r1.id, 0); E.connect(st, r1.id, 1, r2.id, 0, { delayUs: 3000 }); E.connect(st, r2.id, 1, target.id, 0);
      E.setIfaceIp(st, attacker, 'eth0', ip('10.0.1.66'), m(24)); E.setDefaultGateway(attacker, ip('10.0.1.1'));
      E.setIfaceIp(st, r1, 'eth0', ip('10.0.1.1'), m(24)); E.setIfaceIp(st, r1, 'eth1', ip('10.0.12.1'), m(24)); E.addStaticRoute(r1, ip('10.0.2.0'), m(24), ip('10.0.12.2'));
      E.setIfaceIp(st, r2, 'eth0', ip('10.0.12.2'), m(24)); E.setIfaceIp(st, r2, 'eth1', ip('10.0.2.1'), m(24)); E.addStaticRoute(r2, ip('10.0.1.0'), m(24), ip('10.0.12.1'));
      E.setIfaceIp(st, target, 'eth0', ip('10.0.2.10'), m(24)); E.setDefaultGateway(target, ip('10.0.2.1'));
    }),
    checks: [{ id: 'alive', label: 'Found a live host', kind: 'terminalContains', node: 'Attacker', text: 'bytes from 10.0.2.10' }, { id: 'map', label: 'Mapped the path with traceroute', kind: 'terminalContains', node: 'Attacker', text: '10.0.2.10' }],
    steps: [
      { title: 'Find a live host', do: 'On **Attacker** ping a suspected host and Turbo.', set: ['ping -c 2 10.0.2.10'], observe: 'Replies confirm the host is alive.', checkId: 'alive' },
      { title: 'Map the path', do: 'Run traceroute to it and Turbo.', set: ['traceroute 10.0.2.10'], observe: 'Every router on the path is revealed.', checkId: 'map', note: 'List the routers discovered. What does an attacker learn about the topology from this?' },
      { title: 'Reason about filtering', do: 'Consider blocking ICMP at R1.', note: 'What would the attacker see if ICMP echo were filtered? What diagnostic ability would defenders lose in exchange?' },
    ],
    questions: [{ q: 'Give one benefit and one risk of allowing ICMP through a network edge.', a: 'Benefit: ping/traceroute make troubleshooting and path-MTU discovery work. Risk: they let outsiders discover live hosts and map internal topology, aiding reconnaissance.' }],
    wrap: 'The same ICMP that helps you debug helps an attacker draw your map — hence the filtering trade-off.' },
];
