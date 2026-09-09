import { E, ip, m, scene, type Lab } from './helpers';
import type { EngineState, ScenarioCheck } from '@/engine/types';
const MOD = 'Static Routing';
export const STATIC_ROUTING: Lab[] = [
  { id: 'static-2router', module: MOD, name: 'Static routes between two routers', difficulty: 'core', minutes: 16,
    objectives: ['Add static routes so two LANs can reach each other', 'See that routing must be configured in both directions'],
    theory: ['A router only knows its **directly connected** networks. To reach anything else it needs a **route**. A **static route** is one you configure by hand: “to reach network X, send to next-hop Y”. Reachability requires routes in *both* directions — the request and the reply each need a path.'],
    build: () => scene('static-2router', 'Static routes between two routers', 'Teach R1 and R2 about each other’s LANs.', [{ id: 'r1', label: 'R1 has a static route to 10.0.2.0/24', kind: 'routeKind', node: 'R1', prefix: '10.0.2.0/24', routeKind: 'static' }, { id: 'r2', label: 'R2 has a static route to 10.0.1.0/24', kind: 'routeKind', node: 'R2', prefix: '10.0.1.0/24', routeKind: 'static' }, { id: 'ping', label: 'PC-A reached PC-B', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.2.10' }], (st) => {
      const a = E.addHost(st, 'laptop', 120, 320, 'PC-A'); const r1 = E.addHost(st, 'router', 320, 220, 'R1'); const r2 = E.addHost(st, 'router', 540, 220, 'R2'); const b = E.addHost(st, 'server', 740, 320, 'PC-B');
      E.connect(st, a.id, 0, r1.id, 0); E.connect(st, r1.id, 1, r2.id, 0); E.connect(st, r2.id, 1, b.id, 0);
      E.setIfaceIp(st, a, 'eth0', ip('10.0.1.10'), m(24)); E.setDefaultGateway(a, ip('10.0.1.1'));
      E.setIfaceIp(st, r1, 'eth0', ip('10.0.1.1'), m(24)); E.setIfaceIp(st, r1, 'eth1', ip('10.0.12.1'), m(24));
      E.setIfaceIp(st, r2, 'eth0', ip('10.0.12.2'), m(24)); E.setIfaceIp(st, r2, 'eth1', ip('10.0.2.1'), m(24));
      E.setIfaceIp(st, b, 'eth0', ip('10.0.2.10'), m(24)); E.setDefaultGateway(b, ip('10.0.2.1'));
    }),
    checks: [{ id: 'r1', label: 'R1 has a static route to 10.0.2.0/24', kind: 'routeKind', node: 'R1', prefix: '10.0.2.0/24', routeKind: 'static' }, { id: 'r2', label: 'R2 has a static route to 10.0.1.0/24', kind: 'routeKind', node: 'R2', prefix: '10.0.1.0/24', routeKind: 'static' }, { id: 'ping', label: 'PC-A reached PC-B', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.2.10' }],
    steps: [
      { title: 'Confirm the gap', do: 'From PC-A ping PC-B and Turbo — it fails: R1 has no route to `10.0.2.0/24`.', set: ['ping -c 1 10.0.2.10'], observe: 'No route yet.' },
      { title: 'Route on R1', do: 'Open **R1 → Routes** and add a static route to PC-B’s network via R2.', set: ['10.0.2.0/24', 'via 10.0.12.2'], checkId: 'r1' },
      { title: 'Route on R2', do: 'Open **R2 → Routes** and add the return route to PC-A’s network via R1.', set: ['10.0.1.0/24', 'via 10.0.12.1'], checkId: 'r2', note: 'Why is this second route essential even though we only ping from PC-A?' },
      { title: 'Test', do: 'Ping PC-B from PC-A and Turbo.', set: ['ping -c 3 10.0.2.10'], checkId: 'ping' },
    ],
    questions: [{ q: 'You only ping from PC-A. Why must R2 also have a route?', a: 'The echo *reply* travels from PC-B back to PC-A’s network, which is remote to R2. Without R2’s return route the reply is dropped, so the ping fails.' }],
    wrap: 'Static routing is explicit and predictable, but every network needs a hand-written entry in both directions — which is why we automate it next with RIP and OSPF.' },

  { id: 'static-default', module: MOD, name: 'Default routes', difficulty: 'core', minutes: 12,
    objectives: ['Use a default route (0.0.0.0/0) as a catch-all', 'Understand when a stub network only needs one route'],
    theory: ['A **default route** (`0.0.0.0/0`) matches any destination with the shortest possible prefix, so it is the last resort. A **stub** site with one uplink does not need routes for every remote network — just “send everything unknown to my upstream router”.'],
    build: () => scene('static-default', 'Default routes', 'Give a stub router a single default route to reach everything.', [{ id: 'def', label: 'R1 has a default route', kind: 'routeKind', node: 'R1', prefix: '0.0.0.0/0', routeKind: 'default' }, { id: 'ping', label: 'PC-A reached the far server', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.2.10' }], (st) => {
      const a = E.addHost(st, 'laptop', 120, 320, 'PC-A'); const r1 = E.addHost(st, 'router', 320, 220, 'R1'); const core = E.addHost(st, 'router', 540, 220, 'Core'); const b = E.addHost(st, 'server', 740, 320, 'Server');
      E.connect(st, a.id, 0, r1.id, 0); E.connect(st, r1.id, 1, core.id, 0); E.connect(st, core.id, 1, b.id, 0);
      E.setIfaceIp(st, a, 'eth0', ip('10.0.1.10'), m(24)); E.setDefaultGateway(a, ip('10.0.1.1'));
      E.setIfaceIp(st, r1, 'eth0', ip('10.0.1.1'), m(24)); E.setIfaceIp(st, r1, 'eth1', ip('10.0.12.1'), m(24));
      E.setIfaceIp(st, core, 'eth0', ip('10.0.12.2'), m(24)); E.setIfaceIp(st, core, 'eth1', ip('10.0.2.1'), m(24)); E.addStaticRoute(core, ip('10.0.1.0'), m(24), ip('10.0.12.1'));
      E.setIfaceIp(st, b, 'eth0', ip('10.0.2.10'), m(24)); E.setDefaultGateway(b, ip('10.0.2.1'));
    }),
    checks: [{ id: 'def', label: 'R1 has a default route', kind: 'routeKind', node: 'R1', prefix: '0.0.0.0/0', routeKind: 'default' }, { id: 'ping', label: 'PC-A reached the far server', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.2.10' }],
    steps: [
      { title: 'Add R1’s default route', do: 'Open **R1 → Routes** and add a default route toward Core. (Type `0.0.0.0/0` as the destination and Core’s address as the gateway.)', set: ['0.0.0.0/0', 'via 10.0.12.2'], checkId: 'def' },
      { title: 'Test', do: 'From PC-A ping the far server and Turbo.', set: ['ping -c 3 10.0.2.10'], checkId: 'ping', note: 'R1 has no specific route for 10.0.2.0/24 — which route did it use?' },
      { title: 'Inspect', do: 'Run `route -n` on R1 (via its terminal) or view R1 → Routes.', set: ['route -n'], observe: 'The default appears with a `/0` mask and “UG” flags.' },
    ],
    questions: [{ q: 'Why can a stub site survive with just a default route?', a: 'It has only one way out, so “anything not local goes upstream” is always correct. The upstream router holds the specific routes.' }],
    wrap: 'One `/0` route replaces a table full of specifics for any single-uplink network.' },

  { id: 'static-multihop', module: MOD, name: 'A three-router path', difficulty: 'advanced', minutes: 16,
    objectives: ['Chain static routes across three routers', 'Verify the full path with traceroute'],
    theory: ['With more than two routers, every router in the path needs routes toward both ends. Missing one entry breaks connectivity at that hop — a classic source of “works halfway” bugs. traceroute helps you find exactly where the path dies.'],
    build: () => scene('static-multihop', 'A three-router path', 'Wire static routes across R1–R2–R3 and trace the path.', [{ id: 'ping', label: 'PC-A reached PC-B across three routers', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.3.10' }], (st) => {
      const a = E.addHost(st, 'laptop', 100, 340, 'PC-A'); const r1 = E.addHost(st, 'router', 260, 240, 'R1'); const r2 = E.addHost(st, 'router', 440, 240, 'R2'); const r3 = E.addHost(st, 'router', 620, 240, 'R3'); const b = E.addHost(st, 'server', 780, 340, 'PC-B');
      E.connect(st, a.id, 0, r1.id, 0); E.connect(st, r1.id, 1, r2.id, 0); E.connect(st, r2.id, 1, r3.id, 0); E.connect(st, r3.id, 1, b.id, 0);
      E.setIfaceIp(st, a, 'eth0', ip('10.0.1.10'), m(24)); E.setDefaultGateway(a, ip('10.0.1.1'));
      E.setIfaceIp(st, r1, 'eth0', ip('10.0.1.1'), m(24)); E.setIfaceIp(st, r1, 'eth1', ip('10.0.12.1'), m(24));
      E.setIfaceIp(st, r2, 'eth0', ip('10.0.12.2'), m(24)); E.setIfaceIp(st, r2, 'eth1', ip('10.0.23.2'), m(24));
      E.setIfaceIp(st, r3, 'eth0', ip('10.0.23.3'), m(24)); E.setIfaceIp(st, r3, 'eth1', ip('10.0.3.1'), m(24));
      E.setIfaceIp(st, b, 'eth0', ip('10.0.3.10'), m(24)); E.setDefaultGateway(b, ip('10.0.3.1'));
      // pre-seed R2 correctly; leave R1 and R3 for the student
      E.addStaticRoute(r2, ip('10.0.1.0'), m(24), ip('10.0.12.1')); E.addStaticRoute(r2, ip('10.0.3.0'), m(24), ip('10.0.23.3'));
    }),
    checks: [{ id: 'ping', label: 'PC-A reached PC-B across three routers', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.3.10' }],
    steps: [
      { title: 'R2 is done for you', do: 'R2 already knows both end networks. You must complete R1 and R3.', note: 'List which networks R1 and R3 are each missing a route to.' },
      { title: 'Route on R1', do: 'On **R1 → Routes** add a route to PC-B’s network. Everything beyond R1 is via R2.', set: ['10.0.3.0/24', 'via 10.0.12.2'] },
      { title: 'Route on R3', do: 'On **R3 → Routes** add the return route to PC-A’s network via R2.', set: ['10.0.1.0/24', 'via 10.0.23.2'] },
      { title: 'Test and trace', do: 'Ping PC-B from PC-A, then run traceroute, and Turbo.', set: ['ping -c 2 10.0.3.10', 'traceroute 10.0.3.10'], observe: 'Three router hops before the server.', checkId: 'ping', note: 'If you had left out R3’s route, at which hop would traceroute stall?' },
    ],
    questions: [{ q: 'You forget R3’s return route. The forward path works but the ping still fails — why?', a: 'Requests reach PC-B, but PC-B’s replies must travel back through R3, which has no route to PC-A’s network, so replies are dropped. Both directions must be complete.' }],
    wrap: 'Every hop needs the full picture. This tedium is exactly why dynamic routing protocols exist — up next.' },
];
