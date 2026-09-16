import { E, ip, m, scene, type Lab } from './helpers';
import type { EngineState, ScenarioCheck } from '@/engine/types';
import { SEC } from '@/engine/core';
const MOD = 'Capstones';
export const CAPSTONE_LABS: Lab[] = [
  { id: 'cap-enterprise', module: MOD, name: 'Build a small enterprise network', difficulty: 'advanced', minutes: 30,
    objectives: ['Integrate DHCP, DNS, HTTP and routing', 'Bring up a client with zero manual host config', 'Browse an internal site by name'],
    theory: ['Real networks combine everything you have learned. Here a **gateway/router** runs **DHCP** for the user LAN; a **server** provides **DNS** and **HTTP**. Your goal: enable the services so a freshly booted **Client** gets its address automatically, resolves an internal name, and fetches the intranet page — all without hand-configuring the client.'],
    build: () => scene('cap-enterprise', 'Build a small enterprise network', 'Enable DHCP + DNS + HTTP so the client works end to end by name.', [{ id: 'dhcp', label: 'Client obtained an address via DHCP', kind: 'terminalContains', node: 'Client', text: 'DHCPACK' }, { id: 'dns', label: 'Client resolved intranet.corp', kind: 'terminalContains', node: 'Client', text: '10.0.0.80' }, { id: 'http', label: 'Client fetched the intranet page', kind: 'terminalContains', node: 'Client', text: '200 OK' }], (st) => {
      const gw = E.addHost(st, 'router', 240, 140, 'Gateway'); const sw = E.addSwitch(st, 440, 160, 8, 'CoreSwitch');
      const client = E.addHost(st, 'laptop', 260, 360, 'Client'); const dns = E.addHost(st, 'server', 460, 360, 'Server'); const web = dns;
      E.connect(st, gw.id, 0, sw.id, 0); E.connect(st, client.id, 0, sw.id, 1); E.connect(st, dns.id, 0, sw.id, 2);
      E.setIfaceIp(st, gw, 'eth0', ip('10.0.0.1'), m(24));
      E.setIfaceIp(st, dns, 'eth0', ip('10.0.0.80'), m(24)); E.setDefaultGateway(dns, ip('10.0.0.1'));
      gw.dhcpServer = { enabled: false, iface: 'eth0', poolStart: ip('10.0.0.100'), poolEnd: ip('10.0.0.150'), mask: m(24), gateway: ip('10.0.0.1'), dns: [ip('10.0.0.80')], leaseUs: 3600 * SEC, leases: {} };
      E.setDnsZone(dns, 'corp', '$TTL 300\nintranet IN A 10.0.0.80\n@ IN A 10.0.0.80\n');
      web.httpDocroot = { 'index.html': '<html><body><h1>Welcome to the intranet</h1></body></html>' };
    }),
    checks: [{ id: 'dhcp', label: 'Client obtained an address via DHCP', kind: 'terminalContains', node: 'Client', text: 'DHCPACK' }, { id: 'dns', label: 'Client resolved intranet.corp', kind: 'terminalContains', node: 'Client', text: '10.0.0.80' }, { id: 'http', label: 'Client fetched the intranet page', kind: 'terminalContains', node: 'Client', text: '200 OK' }],
    steps: [
      { title: 'Enable DHCP', do: 'Open **Gateway → Services → DHCP server**, tick Enabled (pool, gateway and DNS are pre-filled), Apply.', set: ['Enabled = on'] },
      { title: 'Confirm DNS + web', do: 'Open **Server → Services**: the DNS zone `corp` maps `intranet.corp → 10.0.0.80`. Start the web server.', set: ['httpd'] },
      { title: 'Boot the client', do: 'On **Client** get a lease, then Turbo.', set: ['dhclient'], observe: 'It receives address, gateway and DNS automatically.', checkId: 'dhcp', note: 'Record the client’s leased address, gateway and DNS.' },
      { title: 'Resolve by name', do: 'On **Client** look up the intranet name and **Turbo**.', set: ['dig intranet.corp'], observe: 'It resolves to 10.0.0.80 via the server’s zone.', checkId: 'dns' },
      { title: 'Browse the intranet', do: 'On **Client** fetch the site by name and Turbo.', set: ['curl http://intranet.corp/'], observe: 'A 200 OK and the welcome page.', checkId: 'http', note: 'Trace the full journey of that one command: DHCP already done, then DNS, then TCP handshake, then HTTP.' },
    ],
    questions: [{ q: 'List, in order, every protocol the client used from power-on to viewing the page.', a: 'ARP (for DHCP/gateway), DHCP (address+DNS+gateway), DNS (name→IP), ARP again (for the server or gateway MAC), TCP (handshake), and HTTP (GET/200). ICMP may also appear for diagnostics.' }],
    wrap: 'You wired the whole stack together: one `curl intranet.corp` quietly used half a dozen protocols you now understand.' },

  { id: 'cap-troubleshoot', module: MOD, name: 'Troubleshoot a broken network', difficulty: 'advanced', minutes: 24,
    objectives: ['Diagnose a connectivity failure methodically', 'Use ping, traceroute and routing tables', 'Apply the minimal fix'],
    theory: ['This network is **broken on purpose**. PC-A cannot reach the Server across two routers. Diagnose it like a pro: work up the layers, use `ping` to nearby then far devices, `traceroute` to find where packets die, and `route -n` to inspect tables. Then apply the smallest fix and verify.'],
    build: () => scene('cap-troubleshoot', 'Troubleshoot a broken network', 'Find why PC-A cannot reach the Server, and fix it.', [{ id: 'fixed', label: 'PC-A can now reach the Server', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.2.10' }], (st) => {
      const a = E.addHost(st, 'laptop', 120, 320, 'PC-A'); const r1 = E.addHost(st, 'router', 320, 220, 'R1'); const r2 = E.addHost(st, 'router', 540, 220, 'R2'); const b = E.addHost(st, 'server', 740, 320, 'Server');
      E.connect(st, a.id, 0, r1.id, 0); E.connect(st, r1.id, 1, r2.id, 0); E.connect(st, r2.id, 1, b.id, 0);
      E.setIfaceIp(st, a, 'eth0', ip('10.0.1.10'), m(24)); E.setDefaultGateway(a, ip('10.0.1.1'));
      E.setIfaceIp(st, r1, 'eth0', ip('10.0.1.1'), m(24)); E.setIfaceIp(st, r1, 'eth1', ip('10.0.12.1'), m(24));
      E.setIfaceIp(st, r2, 'eth0', ip('10.0.12.2'), m(24)); E.setIfaceIp(st, r2, 'eth1', ip('10.0.2.1'), m(24));
      E.setIfaceIp(st, b, 'eth0', ip('10.0.2.10'), m(24)); E.setDefaultGateway(b, ip('10.0.2.1'));
      // The FAULT: R1 knows how to reach 10.0.2.0, but R2 is missing the RETURN route to 10.0.1.0.
      E.addStaticRoute(r1, ip('10.0.2.0'), m(24), ip('10.0.12.2'));
      // (R2 has no route back to 10.0.1.0 — this is what the student must find and add.)
    }),
    checks: [{ id: 'fixed', label: 'PC-A can now reach the Server', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.2.10' }],
    steps: [
      { title: 'Reproduce the fault', do: 'On **PC-A** ping the Server and Turbo. It fails.', set: ['ping -c 2 10.0.2.10'], note: 'Does it fail with “unreachable” (no route locally) or timeouts (packets lost en route)? What does that tell you?' },
      { title: 'Localise it', do: 'From PC-A run traceroute and **Turbo**; from R1’s terminal ping the Server too.', set: ['PC-A: traceroute 10.0.2.10', 'R1: ping -c 1 10.0.2.10'], observe: 'Requests get far but replies do not return — a classic one-way routing hole.', note: 'At which hop does traceroute stall? Which direction is broken?' },
      { title: 'Inspect the tables', do: 'Run `route -n` on R1 and on R2.', set: ['R1: route -n', 'R2: route -n'], observe: 'R1 has a route to 10.0.2.0, but R2 has **no** route back to 10.0.1.0.', note: 'Write down exactly which route is missing and on which router.' },
      { title: 'Apply the fix', do: 'On **R2 → Routes** add the missing return route to PC-A’s network via R1, then re-test from PC-A with a ping and **Turbo**.', set: ['R2: 10.0.1.0/24 via 10.0.12.1', 'PC-A: ping -c 3 10.0.2.10'], checkId: 'fixed' },
    ],
    questions: [{ q: 'The forward path worked but pings failed. Why does that point straight at a missing *return* route?', a: 'Requests reaching the Server prove the forward path is fine. If replies never come back, the break is on the return path — here R2 had no route to PC-A’s subnet, so it dropped every reply.' }],
    wrap: 'Methodical, layer-by-layer diagnosis turned “it doesn’t work” into a one-line fix.' },

  { id: 'cap-secure', module: MOD, name: 'Attack, detect, defend', difficulty: 'advanced', minutes: 24,
    objectives: ['Execute an ARP-spoof MITM', 'Detect the tampered cache', 'Apply and verify a defence'],
    theory: ['Security is a loop: understand the attack, detect it, and defend. Here you will poison a victim’s gateway entry, confirm the compromise, then restore and lock the correct mapping with a **static ARP** entry — and verify the attack can no longer change it.'],
    build: () => scene('cap-secure', 'Attack, detect, defend', 'Spoof the gateway, detect it, then defend and verify.', [{ id: 'defended', label: 'After the fix, the gateway entry is correct and locked', kind: 'arpEntry', node: 'Victim', ip: '10.0.0.1', mac: '02:00:00:03:00:00' }], (st) => {
      const sw = E.addSwitch(st, 380, 140, 8, 'Switch1'); const victim = E.addHost(st, 'laptop', 140, 340, 'Victim'); const gw = E.addHost(st, 'router', 380, 340, 'Gateway'); const attacker = E.addHost(st, 'desktop', 620, 340, 'Attacker'); const srv = E.addHost(st, 'server', 380, 500, 'Server');
      E.connect(st, victim.id, 0, sw.id, 0); E.connect(st, gw.id, 0, sw.id, 1); E.connect(st, attacker.id, 0, sw.id, 2); E.connect(st, gw.id, 1, srv.id, 0);
      E.setIfaceIp(st, victim, 'eth0', ip('10.0.0.10'), m(24)); E.setDefaultGateway(victim, ip('10.0.0.1'));
      E.setIfaceIp(st, gw, 'eth0', ip('10.0.0.1'), m(24)); E.setIfaceIp(st, gw, 'eth1', ip('10.0.9.1'), m(24));
      E.setIfaceIp(st, attacker, 'eth0', ip('10.0.0.66'), m(24));
      E.setIfaceIp(st, srv, 'eth0', ip('10.0.9.10'), m(24)); E.setDefaultGateway(srv, ip('10.0.9.1'));
    }),
    checks: [{ id: 'defended', label: 'After the fix, the gateway entry is correct and locked', kind: 'arpEntry', node: 'Victim', ip: '10.0.0.1', mac: '02:00:00:03:00:00' }],
    steps: [
      { title: 'Attack', do: 'On **Attacker** poison the victim’s gateway entry, then Turbo.', set: ['arpspoof 10.0.0.1'], observe: 'The victim now believes the gateway is at the attacker’s MAC.', note: 'Confirm with `arp -a` on the Victim. What MAC does 10.0.0.1 show?' },
      { title: 'Detect', do: 'On **Victim** inspect the cache and compare to the Gateway’s real MAC (the Gateway is node 3 → `02:00:00:02:00:00`).', set: ['Victim: arp -a'], note: 'How would a monitoring tool spot this automatically (hint: an IP–MAC binding changed unexpectedly)?' },
      { title: 'Defend', do: 'On **Victim** pin the correct mapping with a static ARP entry.', set: ['arp -s 10.0.0.1 02:00:00:03:00:00'], note: 'Why does a static entry stop the spoof?' },
      { title: 'Verify the defence', do: 'On **Attacker** run `arpspoof 10.0.0.1` again and Turbo; then check the Victim’s cache once more.', set: ['Attacker: arpspoof 10.0.0.1', 'Victim: arp -a'], observe: 'The gateway entry stays correct — the static binding wins.', checkId: 'defended' },
    ],
    questions: [{ q: 'Static ARP defends one host. What scales this defence to a whole switched network?', a: 'Dynamic ARP Inspection (DAI) with DHCP snooping: the switch validates every ARP against a trusted IP–MAC–port table and drops forgeries, protecting all ports without per-host static entries.' }],
    wrap: 'Attack → detect → defend → verify: the security mindset applied end to end on a network you built.' },
];
