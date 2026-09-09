import { E, ip, m, scene, type Lab } from './helpers';
import type { ScenarioCheck } from '@/engine/types';
const MOD = 'VLANs';
export const VLAN_LABS: Lab[] = [
  { id: 'vlan-access', module: MOD, name: 'Access VLANs isolate traffic', difficulty: 'core', minutes: 15,
    objectives: ['Configure access-port VLANs on a switch', 'Prove that different VLANs cannot talk, even on the same switch'],
    theory: ['A **VLAN** splits one physical switch into several virtual switches. Each **access port** belongs to one VLAN; the switch only forwards a frame among ports in the *same* VLAN. This creates separate broadcast domains without extra hardware.',
      'Here all four PCs share `10.0.0.0/24` addresses, but PC-A/PC-B are in **VLAN 10** and PC-C/PC-D in **VLAN 20**. Same-VLAN pings succeed; cross-VLAN pings fail even though the IPs are in the same subnet, because Layer 2 keeps them apart.'],
    build: () => scene('vlan-access', 'Access VLANs isolate traffic', 'Put ports in VLAN 10 and 20 and prove isolation.', [{ id: 'same', label: 'PC-A reached PC-B (same VLAN)', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.0.2' }, { id: 'cross', label: 'PC-A could NOT reach PC-C (different VLAN)', kind: 'terminalContains', node: 'PC-A', text: '0 received' }], (st) => {
      const sw = E.addSwitch(st, 360, 140, 8, 'Switch1');
      ['PC-A', 'PC-B', 'PC-C', 'PC-D'].forEach((nm, i) => { const h = E.addHost(st, 'desktop', 120 + i * 150, 320, nm); E.connect(st, h.id, 0, sw.id, i); E.setIfaceIp(st, h, 'eth0', ip(`10.0.0.${i + 1}`), m(24)); });
      sw.vlanEnabled = true; sw.ports[0]!.vlan = 10; sw.ports[1]!.vlan = 10; sw.ports[2]!.vlan = 20; sw.ports[3]!.vlan = 20;
    }),
    checks: [{ id: 'same', label: 'PC-A reached PC-B (same VLAN)', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.0.2' }, { id: 'cross', label: 'PC-A could NOT reach PC-C (different VLAN)', kind: 'terminalContains', node: 'PC-A', text: '0 received' }],
    steps: [
      { title: 'Confirm the VLAN plan', do: 'Open **Switch1 → VLANs**. VLANs are enabled: ports 1–2 in VLAN 10, ports 3–4 in VLAN 20.', note: 'Which ports are in which VLAN?' },
      { title: 'Same-VLAN ping', do: 'From PC-A ping PC-B (both VLAN 10) and Turbo.', set: ['ping -c 3 10.0.0.2'], observe: 'Success.', checkId: 'same' },
      { title: 'Cross-VLAN ping', do: 'From PC-A ping PC-C (VLAN 20) and Turbo.', set: ['ping -c 3 10.0.0.3'], observe: '100% loss — the switch will not bridge between VLANs.', note: 'The IPs are in the same subnet, yet it fails. Explain why in terms of Layer 2.', checkId: 'cross' },
    ],
    questions: [{ q: 'Both PCs are in `10.0.0.0/24`. Why does cross-VLAN ping fail?', a: 'VLANs partition the switch at Layer 2 into separate broadcast domains. The ARP broadcast never reaches the other VLAN, so no MAC is learned and no frame is bridged — regardless of the IP subnet.' }],
    wrap: 'VLANs give you isolation “for free” on shared hardware. Getting *between* them needs a router — next lab.' },

  { id: 'vlan-trunk', module: MOD, name: 'Trunks and 802.1Q tags', difficulty: 'advanced', minutes: 16,
    objectives: ['Carry multiple VLANs between switches over a trunk', 'See the 802.1Q tag on the wire'],
    theory: ['A **trunk** link carries several VLANs between switches. To keep them separate, each frame gets an **802.1Q tag** containing its VLAN ID. Access ports send/receive untagged frames; trunk ports add the tag on egress and read it on ingress.',
      'Here VLAN 10 spans two switches over a trunk. You will see the VLAN tag appear in the sniffer only on the trunk link.'],
    build: () => scene('vlan-trunk', 'Trunks and 802.1Q tags', 'Span VLAN 10 across a trunk and find the tag.', [{ id: 'ping', label: 'PC-A reached PC-B across the trunk', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.0.2' }, { id: 'tag', label: 'A tagged (802.1Q) frame was captured on the trunk', kind: 'sniffHas', expr: 'vlan.vid == 10' }], (st) => {
      const sw1 = E.addSwitch(st, 300, 160, 8, 'Switch1'); const sw2 = E.addSwitch(st, 560, 160, 8, 'Switch2');
      const trunk = E.connect(st, sw1.id, 7, sw2.id, 7)!;
      const a = E.addHost(st, 'laptop', 220, 320, 'PC-A'); const b = E.addHost(st, 'desktop', 640, 320, 'PC-B');
      E.connect(st, a.id, 0, sw1.id, 0); E.connect(st, b.id, 0, sw2.id, 0);
      E.setIfaceIp(st, a, 'eth0', ip('10.0.0.1'), m(24)); E.setIfaceIp(st, b, 'eth0', ip('10.0.0.2'), m(24));
      for (const sw of [sw1, sw2]) { sw.vlanEnabled = true; sw.ports[0]!.vlan = 10; sw.ports[7]!.mode = 'trunk'; sw.ports[7]!.trunkVlans = [10, 20]; }
      E.addSniffer(st, trunk);
    }),
    checks: [{ id: 'ping', label: 'PC-A reached PC-B across the trunk', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.0.2' }, { id: 'tag', label: 'A tagged (802.1Q) frame was captured on the trunk', kind: 'sniffHas', expr: 'vlan.vid == 10' }],
    steps: [
      { title: 'Review the trunk', do: 'On each switch, port Fa0/8 is a **trunk** allowing VLANs 10 and 20; the PCs are on access VLAN 10.' },
      { title: 'Ping across', do: 'From PC-A ping PC-B and Turbo.', set: ['ping -c 3 10.0.0.2'], checkId: 'ping' },
      { title: 'Find the tag', do: 'On the trunk sniffer, click a frame and expand the **802.1Q Virtual LAN** layer; filter with `vlan.vid == 10`.', observe: 'Only trunk frames carry the tag; access-port frames are untagged.', note: 'What VLAN ID and priority does the tag carry? Why do access ports stay untagged?', checkId: 'tag' },
    ],
    questions: [{ q: 'Why tag frames on the trunk but not on access ports?', a: 'The trunk multiplexes several VLANs on one wire, so each frame must say which VLAN it belongs to. An access port belongs to exactly one VLAN, so the tag is unnecessary and hosts would not understand it.' }],
    wrap: 'The 4-byte 802.1Q tag is how one cable safely carries many VLANs.' },

  { id: 'vlan-intervlan', module: MOD, name: 'Inter-VLAN routing', difficulty: 'advanced', minutes: 16,
    objectives: ['Route between two VLANs with a router', 'Combine Layer-2 isolation with Layer-3 forwarding'],
    theory: ['VLANs cannot talk at Layer 2 — by design. To connect them you route at **Layer 3**. Here VLAN 10 (`10.0.10.0/24`) and VLAN 20 (`10.0.20.0/24`) each connect to a router interface; the router forwards between them. Each host uses the router’s VLAN address as its default gateway.'],
    build: () => scene('vlan-intervlan', 'Inter-VLAN routing', 'Give each VLAN its own subnet and route between them.', [{ id: 'ping', label: 'PC-A (VLAN10) reached PC-C (VLAN20) via the router', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.20.10' }], (st) => {
      const sw = E.addSwitch(st, 360, 140, 8, 'Switch1'); const r = E.addHost(st, 'router', 360, 320, 'Router');
      const a = E.addHost(st, 'laptop', 140, 300, 'PC-A'); const c = E.addHost(st, 'desktop', 600, 300, 'PC-C');
      E.connect(st, a.id, 0, sw.id, 0); E.connect(st, c.id, 0, sw.id, 1); E.connect(st, r.id, 0, sw.id, 2); E.connect(st, r.id, 1, sw.id, 3);
      sw.vlanEnabled = true; sw.ports[0]!.vlan = 10; sw.ports[2]!.vlan = 10; sw.ports[1]!.vlan = 20; sw.ports[3]!.vlan = 20;
      E.setIfaceIp(st, a, 'eth0', ip('10.0.10.10'), m(24)); E.setDefaultGateway(a, ip('10.0.10.1'));
      E.setIfaceIp(st, c, 'eth0', ip('10.0.20.10'), m(24)); E.setDefaultGateway(c, ip('10.0.20.1'));
      E.setIfaceIp(st, r, 'eth0', ip('10.0.10.1'), m(24)); E.setIfaceIp(st, r, 'eth1', ip('10.0.20.1'), m(24));
    }),
    checks: [{ id: 'ping', label: 'PC-A (VLAN10) reached PC-C (VLAN20) via the router', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.20.10' }],
    steps: [
      { title: 'Understand the design', do: 'The router has one interface in VLAN 10 (`10.0.10.1`) and one in VLAN 20 (`10.0.20.1`). Each PC’s gateway is its VLAN’s router address.', note: 'Why does each VLAN need its own subnet here?' },
      { title: 'Route between VLANs', do: 'From PC-A (VLAN 10) ping PC-C (VLAN 20) and Turbo.', set: ['ping -c 3 10.0.20.10'], observe: 'Success — the router bridges the two Layer-3 networks.', checkId: 'ping' },
      { title: 'Confirm the hop', do: 'Run `traceroute 10.0.20.10` on PC-A and **Turbo**.', set: ['traceroute 10.0.20.10'], observe: 'One router hop appears.', note: 'How many hops? Which address is the intermediate hop?' },
    ],
    questions: [{ q: 'Why do the two VLANs need different IP subnets now?', a: 'Routing is between subnets. If both VLANs shared one subnet the router could not tell them apart at Layer 3; giving each its own subnet lets the router forward and lets hosts know the far side is “off-net” and must go via the gateway.' }],
    wrap: 'Isolate at Layer 2 with VLANs, then reconnect deliberately at Layer 3 with a router.' },
];
