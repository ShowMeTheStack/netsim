import { E, ip, m, scene, type Lab } from './helpers';
import type { ScenarioCheck } from '@/engine/types';
const MOD = 'IPv4 & Subnetting';
export const IPV4_LABS: Lab[] = [
  { id: 'ip-addressing', module: MOD, name: 'Addresses, masks and subnets', difficulty: 'intro', minutes: 14,
    objectives: ['Read an IPv4 address and mask', 'Decide whether two hosts are on the same subnet', 'Configure addresses by hand'],
    theory: ['An IPv4 address is 32 bits, written as four bytes (e.g. `192.168.1.10`). The **subnet mask** (e.g. `/24` = `255.255.255.0`) splits it into a **network** part and a **host** part. Two hosts can talk directly only if their addresses share the same network part under the mask.',
      'Here you will set addresses and reason about masks. `10.0.0.1/24` and `10.0.0.2/24` share `10.0.0`, so they are on-subnet; `10.0.1.2/24` would not be.'],
    build: () => scene('ip-addressing', 'Addresses, masks and subnets', 'Address two hosts in one /24 and confirm they can talk.', [{ id: 'ping', label: 'On-subnet hosts communicate', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.0.2' }], (st) => {
      const a = E.addHost(st, 'laptop', 180, 300, 'PC-A'); const sw = E.addSwitch(st, 380, 180, 8, 'Switch1'); const b = E.addHost(st, 'desktop', 580, 300, 'PC-B');
      E.connect(st, a.id, 0, sw.id, 0); E.connect(st, b.id, 0, sw.id, 1);
    }),
    checks: [{ id: 'ping', label: 'On-subnet hosts communicate', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.0.2' }],
    steps: [
      { title: 'Address PC-A', do: 'Open **PC-A → Config**, set the eth0 IPv4 address and prefix, and Apply.', set: ['IP = 10.0.0.1', 'prefix = 24'] },
      { title: 'Address PC-B', do: 'Do the same for PC-B.', set: ['IP = 10.0.0.2', 'prefix = 24'], note: 'Under a /24 mask, what is the network part they share?' },
      { title: 'Verify', do: 'Ping PC-B from PC-A and Turbo.', set: ['ping -c 2 10.0.0.2'], checkId: 'ping' },
      { title: 'Reason about a mistake', do: 'Predict what happens if PC-B were `10.0.1.2/24` instead.', note: 'Would the ping still work? Why not, under a /24 mask?' },
    ],
    questions: [{ q: 'How does a host decide if a destination is on-subnet?', a: 'It ANDs both its own and the destination address with its mask; if the results match, the destination is on the same subnet and reachable directly, otherwise it must be sent via the gateway.' }],
    wrap: 'Masks are the ruler every host uses to decide “near” (direct) vs “far” (via gateway).' },

  { id: 'ip-two-subnets', module: MOD, name: 'Two subnets cannot talk (yet)', difficulty: 'core', minutes: 12,
    objectives: ['See that different subnets need a router', 'Recognise “Network is unreachable” and its cause'],
    theory: ['Put two hosts in different subnets on the same wire and they still cannot communicate: each sees the other as “off-net” and has no route there. The host reports **Network is unreachable** because it has no gateway toward that network.'],
    build: () => scene('ip-two-subnets', 'Two subnets cannot talk (yet)', 'Two hosts, two subnets, no router — observe the failure.', [{ id: 'fail', label: 'Ping failed with no route', kind: 'terminalMatches', node: 'PC-A', pattern: 'unreachable|0 received' }], (st) => {
      const a = E.addHost(st, 'laptop', 180, 300, 'PC-A'); const sw = E.addSwitch(st, 380, 180, 8, 'Switch1'); const b = E.addHost(st, 'desktop', 580, 300, 'PC-B');
      E.connect(st, a.id, 0, sw.id, 0); E.connect(st, b.id, 0, sw.id, 1);
      E.setIfaceIp(st, a, 'eth0', ip('10.0.1.10'), m(24)); E.setIfaceIp(st, b, 'eth0', ip('10.0.2.10'), m(24));
    }),
    checks: [{ id: 'fail', label: 'Ping failed with no route', kind: 'terminalMatches', node: 'PC-A', pattern: 'unreachable|0 received' }],
    steps: [
      { title: 'Note the addresses', do: 'PC-A is `10.0.1.10/24`, PC-B is `10.0.2.10/24` — different networks.', note: 'Are these on the same subnet under /24? Show the network parts.' },
      { title: 'Try to ping', do: 'From PC-A ping PC-B and Turbo.', set: ['ping -c 1 10.0.2.10'], observe: 'It fails immediately with “Network is unreachable” — PC-A has no route and no gateway.', checkId: 'fail' },
      { title: 'Diagnose', do: 'Run `route -n` on PC-A.', set: ['route -n'], observe: 'Only the connected 10.0.1.0/24 route exists; nothing points at 10.0.2.0.', note: 'What single thing is missing that would fix this?' },
    ],
    questions: [{ q: 'What does “Network is unreachable” mean specifically?', a: 'The host has no matching route (and no default gateway) for the destination network, so it cannot even decide where to send the first packet.' }],
    wrap: 'Same wire, different subnets = no comms. The fix is a router and a default route — next lab.' },

  { id: 'ip-gateway', module: MOD, name: 'Default gateways', difficulty: 'core', minutes: 14,
    objectives: ['Configure a default gateway', 'Understand how off-subnet packets flow to the router'],
    theory: ['A **default gateway** is where a host sends any packet whose destination is not on its own subnet. Add a router between two subnets, give each host the router’s local address as its gateway, and off-subnet traffic now has somewhere to go.'],
    build: () => scene('ip-gateway', 'Default gateways', 'Add gateways so two subnets can communicate via a router.', [{ id: 'ping', label: 'PC-A reached PC-B via the gateway', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.2.10' }], (st) => {
      const a = E.addHost(st, 'laptop', 140, 300, 'PC-A'); const r = E.addHost(st, 'router', 360, 200, 'R1'); const b = E.addHost(st, 'desktop', 580, 300, 'PC-B');
      E.connect(st, a.id, 0, r.id, 0); E.connect(st, r.id, 1, b.id, 0);
      E.setIfaceIp(st, a, 'eth0', ip('10.0.1.10'), m(24)); E.setIfaceIp(st, r, 'eth0', ip('10.0.1.1'), m(24)); E.setIfaceIp(st, r, 'eth1', ip('10.0.2.1'), m(24)); E.setIfaceIp(st, b, 'eth0', ip('10.0.2.10'), m(24));
    }),
    checks: [{ id: 'ping', label: 'PC-A reached PC-B via the gateway', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.2.10' }],
    steps: [
      { title: 'Set PC-A’s gateway', do: 'Open **PC-A → Config**, set the default gateway to the router’s near interface and Apply.', set: ['Default gateway = 10.0.1.1'] },
      { title: 'Set PC-B’s gateway', do: 'Set PC-B’s gateway to the router’s other interface.', set: ['Default gateway = 10.0.2.1'] },
      { title: 'Test', do: 'Ping PC-B from PC-A and Turbo.', set: ['ping -c 3 10.0.2.10'], observe: 'Now it works — the router forwards between subnets.', checkId: 'ping' },
      { title: 'Confirm both directions need it', do: 'Predict what happens if you remove PC-B’s gateway.', note: 'Why does the reply need PC-B to have a gateway too?' },
    ],
    questions: [{ q: 'Why must PC-B also have a gateway, not just PC-A?', a: 'The echo reply from PC-B is destined off its subnet (back to 10.0.1.10). Without a gateway PC-B cannot send that reply, so the ping would still fail.' }],
    wrap: 'A default gateway is a host’s “when in doubt, send it here” rule — the seed of all routing.' },

  { id: 'ip-lpm', module: MOD, name: 'Longest-prefix match', difficulty: 'advanced', minutes: 14,
    objectives: ['Understand how routers choose among overlapping routes', 'Add a static route more specific than the default'],
    theory: ['A routing table can hold overlapping routes. The router always picks the **most specific** match — the one with the **longest prefix** (largest mask). A `/32` host route beats a `/24`, which beats the `/0` default. This lets you send most traffic one way but carve out exceptions.'],
    build: () => scene('ip-lpm', 'Longest-prefix match', 'Add a specific route that overrides a broader one.', [{ id: 'route', label: 'A static route to 10.0.9.0/24 exists', kind: 'routeKind', node: 'R1', prefix: '10.0.9.0/24', routeKind: 'static' }, { id: 'ping', label: 'PC-A reached the far host', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.9.10' }], (st) => {
      const a = E.addHost(st, 'laptop', 120, 320, 'PC-A'); const r1 = E.addHost(st, 'router', 320, 220, 'R1'); const r2 = E.addHost(st, 'router', 540, 220, 'R2'); const far = E.addHost(st, 'server', 740, 320, 'Far');
      E.connect(st, a.id, 0, r1.id, 0); E.connect(st, r1.id, 1, r2.id, 0); E.connect(st, r2.id, 1, far.id, 0);
      E.setIfaceIp(st, a, 'eth0', ip('10.0.1.10'), m(24)); E.setDefaultGateway(a, ip('10.0.1.1'));
      E.setIfaceIp(st, r1, 'eth0', ip('10.0.1.1'), m(24)); E.setIfaceIp(st, r1, 'eth1', ip('10.0.12.1'), m(24));
      E.setIfaceIp(st, r2, 'eth0', ip('10.0.12.2'), m(24)); E.setIfaceIp(st, r2, 'eth1', ip('10.0.9.1'), m(24));
      E.setIfaceIp(st, far, 'eth0', ip('10.0.9.10'), m(24)); E.setDefaultGateway(far, ip('10.0.9.1'));
      E.addStaticRoute(r2, ip('10.0.1.0'), m(24), ip('10.0.12.1'));
    }),
    checks: [{ id: 'route', label: 'A static route to 10.0.9.0/24 exists', kind: 'routeKind', node: 'R1', prefix: '10.0.9.0/24', routeKind: 'static' }, { id: 'ping', label: 'PC-A reached the far host', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.9.10' }],
    steps: [
      { title: 'Look at R1’s table', do: 'Open **R1 → Routes**. It knows its connected networks but not `10.0.9.0/24` behind R2.', note: 'List the routes R1 starts with and their masks.' },
      { title: 'Add the specific route', do: 'On R1 → Routes, add a static route to the far network via R2.', set: ['10.0.9.0/24', 'via 10.0.12.2'], checkId: 'route' },
      { title: 'Test end to end', do: 'From PC-A ping the far host and Turbo.', set: ['ping -c 3 10.0.9.10'], observe: 'The `/24` route is chosen over any broader match.', checkId: 'ping' },
      { title: 'Reason about precedence', do: 'If R1 also had a default route (`0.0.0.0/0`) pointing elsewhere, which wins for `10.0.9.10`?', note: 'Explain using prefix length.' },
    ],
    questions: [{ q: 'Between a `/24` and a `/0` default that both match, which is used and why?', a: 'The `/24`, because longest-prefix match always prefers the more specific route (larger mask); the default is only a fallback when nothing more specific matches.' }],
    wrap: 'Longest-prefix match is the single rule behind every routing decision you will make from here on.' },
];
