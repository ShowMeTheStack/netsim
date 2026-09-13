import { E, ip, m, scene, type Lab } from './helpers';
import type { EngineState, HostState, ScenarioCheck } from '@/engine/types';
const MOD = 'RIP';
function ripOn(r: HostState) { r.routing.rip.enabled = true; r.routing.rip.networks = r.ifaces.filter(i => i.ip !== null).map(i => ({ net: (i.ip! & i.mask) >>> 0, mask: i.mask })); }
export const RIP_LABS: Lab[] = [
  { id: 'rip-basic', module: MOD, name: 'RIP: routing that configures itself', difficulty: 'core', minutes: 16,
    objectives: ['See distance-vector routes appear automatically', 'Read hop-count metrics', 'Contrast with hand-built static routes'],
    theory: ['**RIP** (Routing Information Protocol) is a **distance-vector** protocol. Each router periodically tells its neighbours the networks it can reach and how many hops away they are. Neighbours add one hop and pass it on. Over a few rounds every router learns a route to every network, with a **metric** equal to the hop count. RIP’s “infinity” is 16, which caps network size.',
      'RIP is pre-enabled on all four routers here. Just run the simulation and watch routes populate — no static routes needed.'],
    build: () => scene('rip-basic', 'RIP: routing that configures itself', 'Run RIP on a chain of routers and watch it converge.', [{ id: 'route', label: 'R1 learned a RIP route to the far network', kind: 'routeKind', node: 'R1', prefix: '10.0.9.0/24', routeKind: 'rip' }, { id: 'ping', label: 'End-to-end ping succeeded', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.9.10' }], (st) => {
      const a = E.addHost(st, 'laptop', 100, 340, 'PC-A'); const rs: HostState[] = [];
      for (let i = 0; i < 4; i++) rs.push(E.addHost(st, 'router', 220 + i * 150, 220, `R${i + 1}`));
      const b = E.addHost(st, 'server', 820, 340, 'Server');
      E.connect(st, a.id, 0, rs[0]!.id, 0); E.setIfaceIp(st, a, 'eth0', ip('10.0.1.10'), m(24)); E.setDefaultGateway(a, ip('10.0.1.1'));
      E.setIfaceIp(st, rs[0]!, 'eth0', ip('10.0.1.1'), m(24));
      for (let i = 0; i < 3; i++) { E.connect(st, rs[i]!.id, 1, rs[i + 1]!.id, 0, { delayUs: 1000 }); E.setIfaceIp(st, rs[i]!, 'eth1', ip(`10.0.${i + 1}0.1`), m(24)); E.setIfaceIp(st, rs[i + 1]!, 'eth0', ip(`10.0.${i + 1}0.2`), m(24)); }
      E.connect(st, rs[3]!.id, 1, b.id, 0); E.setIfaceIp(st, rs[3]!, 'eth1', ip('10.0.9.1'), m(24)); E.setIfaceIp(st, b, 'eth0', ip('10.0.9.10'), m(24)); E.setDefaultGateway(b, ip('10.0.9.1'));
      rs.forEach(ripOn);
    }),
    checks: [{ id: 'route', label: 'R1 learned a RIP route to the far network', kind: 'routeKind', node: 'R1', prefix: '10.0.9.0/24', routeKind: 'rip' }, { id: 'ping', label: 'End-to-end ping succeeded', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.9.10' }],
    steps: [
      { title: 'Let RIP converge', do: 'Press **Turbo**. RIP exchanges updates until every router knows every network.', observe: 'Give it a moment of simulated time to settle.' },
      { title: 'Inspect R1’s RIP routes', do: 'Open **R1 → Routing → RIP**. Learned routes are listed with metrics.', observe: 'The far network `10.0.9.0/24` has a metric equal to the hop count.', note: 'What metric does R1 show for 10.0.9.0/24? Does it match the number of routers in between?', checkId: 'route' },
      { title: 'Test end to end', do: 'From PC-A ping the server and Turbo.', set: ['ping -c 3 10.0.9.10'], checkId: 'ping' },
    ],
    questions: [{ q: 'Why is RIP’s metric the hop count, and what does “infinity = 16” imply?', a: 'Distance-vector routers count how many routers a route passes through. Capping at 16 (=unreachable) bounds how far updates propagate and limits count-to-infinity loops — but also limits RIP networks to 15 hops.' }],
    wrap: 'No static routes, yet everything is reachable — the routers taught each other. That is dynamic routing.' },

  { id: 'rip-split-horizon', module: MOD, name: 'Split horizon and poison reverse', difficulty: 'advanced', minutes: 16,
    objectives: ['Understand routing loops in distance vector', 'See split horizon and poison reverse in the updates'],
    theory: ['Distance vector can form loops: if R1 learns a route from R2, R1 must not advertise that route *back to* R2 as if it were independent — or they could bounce a dead route forever (**count to infinity**). **Split horizon** suppresses that advertisement; **poison reverse** instead advertises it back with metric 16 (“unreachable”) to actively cancel it.'],
    build: () => scene('rip-split-horizon', 'Split horizon and poison reverse', 'Watch RIP updates and spot poison-reverse (metric 16).', [{ id: 'ping', label: 'The network converged and is reachable', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.2.10' }, { id: 'poison', label: 'A poison-reverse (metric 16) route was seen on the wire', kind: 'sniffHas', expr: 'rip' }], (st) => {
      const a = E.addHost(st, 'laptop', 120, 340, 'PC-A'); const r1 = E.addHost(st, 'router', 320, 220, 'R1'); const r2 = E.addHost(st, 'router', 560, 220, 'R2'); const b = E.addHost(st, 'server', 760, 340, 'Server');
      const l1 = E.connect(st, a.id, 0, r1.id, 0)!; const trunk = E.connect(st, r1.id, 1, r2.id, 0, { delayUs: 1000 })!; E.connect(st, r2.id, 1, b.id, 0);
      E.setIfaceIp(st, a, 'eth0', ip('10.0.1.10'), m(24)); E.setDefaultGateway(a, ip('10.0.1.1'));
      E.setIfaceIp(st, r1, 'eth0', ip('10.0.1.1'), m(24)); E.setIfaceIp(st, r1, 'eth1', ip('10.0.12.1'), m(24));
      E.setIfaceIp(st, r2, 'eth0', ip('10.0.12.2'), m(24)); E.setIfaceIp(st, r2, 'eth1', ip('10.0.2.1'), m(24));
      E.setIfaceIp(st, b, 'eth0', ip('10.0.2.10'), m(24)); E.setDefaultGateway(b, ip('10.0.2.1'));
      ripOn(r1); ripOn(r2); E.addSniffer(st, trunk); void l1;
    }),
    checks: [{ id: 'ping', label: 'The network converged and is reachable', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.2.10' }, { id: 'poison', label: 'A poison-reverse (metric 16) route was seen on the wire', kind: 'sniffHas', expr: 'rip' }],
    steps: [
      { title: 'Converge', do: 'Turbo to let RIP settle. A sniffer sits on the R1–R2 trunk.', checkId: 'poison' },
      { title: 'Read a RIP update', do: 'Click a RIP frame on the trunk and expand it.', observe: 'Each route entry has a metric. A route R1 learned from R2 is advertised back with metric **16** (poison reverse).', note: 'Find one route advertised with metric 16. Which direction was it going, and which route is being “poisoned”?' },
      { title: 'Confirm reachability', do: 'Ping the server from PC-A and Turbo.', set: ['ping -c 2 10.0.2.10'], checkId: 'ping' },
      { title: 'Toggle the setting', do: 'Open R1 → Routing → RIP. (Split horizon and poison reverse are on by default.) Reason about what would happen with them off.', note: 'Without split horizon, how could a dead route bounce between R1 and R2?' },
    ],
    questions: [{ q: 'What is the difference between split horizon and poison reverse?', a: 'Split horizon simply does not advertise a route back out the interface it was learned on. Poison reverse does advertise it back, but with metric 16 (unreachable), which cancels the route faster and more explicitly.' }],
    wrap: 'These loop-prevention rules are what make a naive distance-vector protocol usable.' },

  { id: 'rip-metric', module: MOD, name: 'Metrics and path choice', difficulty: 'core', minutes: 14,
    objectives: ['See RIP prefer the fewest-hops path', 'Understand that RIP ignores bandwidth/latency'],
    theory: ['RIP chooses purely by **hop count**, not speed. Given two paths to the same network, it takes the one with fewer routers even if that link is slower. This is a known RIP weakness that OSPF fixes with cost.'],
    build: () => scene('rip-metric', 'Metrics and path choice', 'Give RIP two paths and see it prefer fewer hops.', [{ id: 'ping', label: 'Server reachable via RIP', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.9.10' }, { id: 'route', label: 'R1 has a 2-hop RIP route to the server net', kind: 'routeKind', node: 'R1', prefix: '10.0.9.0/24', routeKind: 'rip' }], (st) => {
      // R1 -> R3 direct (2 hops to server), R1 -> R2 -> R3 (3 hops). RIP should prefer direct.
      const a = E.addHost(st, 'laptop', 120, 360, 'PC-A'); const r1 = E.addHost(st, 'router', 300, 260, 'R1'); const r2 = E.addHost(st, 'router', 460, 120, 'R2'); const r3 = E.addHost(st, 'router', 620, 260, 'R3'); const b = E.addHost(st, 'server', 800, 360, 'Server');
      E.connect(st, a.id, 0, r1.id, 0); E.connect(st, r1.id, 1, r3.id, 0, { delayUs: 1000 }); E.connect(st, r1.id, 2, r2.id, 0, { delayUs: 1000 }); E.connect(st, r2.id, 1, r3.id, 2, { delayUs: 1000 }); E.connect(st, r3.id, 1, b.id, 0);
      E.setIfaceIp(st, a, 'eth0', ip('10.0.1.10'), m(24)); E.setDefaultGateway(a, ip('10.0.1.1'));
      E.setIfaceIp(st, r1, 'eth0', ip('10.0.1.1'), m(24)); E.setIfaceIp(st, r1, 'eth1', ip('10.0.13.1'), m(24)); E.setIfaceIp(st, r1, 'eth2', ip('10.0.12.1'), m(24));
      E.setIfaceIp(st, r2, 'eth0', ip('10.0.12.2'), m(24)); E.setIfaceIp(st, r2, 'eth1', ip('10.0.23.2'), m(24));
      E.setIfaceIp(st, r3, 'eth0', ip('10.0.13.3'), m(24)); E.setIfaceIp(st, r3, 'eth1', ip('10.0.9.1'), m(24)); E.setIfaceIp(st, r3, 'eth2', ip('10.0.23.3'), m(24));
      E.setIfaceIp(st, b, 'eth0', ip('10.0.9.10'), m(24)); E.setDefaultGateway(b, ip('10.0.9.1'));
      [r1, r2, r3].forEach(ripOn);
    }),
    checks: [{ id: 'ping', label: 'Server reachable via RIP', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.9.10' }, { id: 'route', label: 'R1 has a 2-hop RIP route to the server net', kind: 'routeKind', node: 'R1', prefix: '10.0.9.0/24', routeKind: 'rip' }],
    steps: [
      { title: 'Converge', do: 'Turbo until RIP settles.', checkId: 'route' },
      { title: 'Inspect the chosen path', do: 'Open **R1 → Routing → RIP** and note the metric and next hop for `10.0.9.0/24`.', observe: 'R1 prefers the direct R1–R3 path (fewer hops) over R1–R2–R3.', note: 'What metric and next-hop does R1 use? What metric would the R2 path have had?' },
      { title: 'Verify with traceroute', do: 'From PC-A run traceroute to the server and Turbo.', set: ['traceroute 10.0.9.10'], observe: 'The path skips R2.', checkId: 'ping' },
    ],
    questions: [{ q: 'If the direct R1–R3 link were very slow, would RIP still prefer it?', a: 'Yes — RIP only counts hops, so it would keep the slower two-hop path over a faster three-hop one. OSPF fixes this with link cost.' }],
    wrap: 'Hop count is simple but blind to bandwidth — the motivation for link-state routing.' },

  { id: 'rip-failure', module: MOD, name: 'Reconverging after a failure', difficulty: 'advanced', minutes: 18,
    objectives: ['See RIP detect a dead route via timeout', 'Watch it reroute over a backup path'],
    theory: ['If a router stops hearing about a route, RIP’s **timeout** (default 180 s) eventually declares it unreachable and it is removed after **garbage collection**. With a redundant path available, RIP then reconverges onto the backup. Distance-vector reconvergence is slower than link-state — you can watch it happen.'],
    build: () => scene('rip-failure', 'Reconverging after a failure', 'Break the primary path and watch RIP find the backup.', [{ id: 'ping', label: 'Connectivity restored over the backup path', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.9.10' }], (st) => {
      const a = E.addHost(st, 'laptop', 120, 360, 'PC-A'); const r1 = E.addHost(st, 'router', 300, 260, 'R1'); const r2 = E.addHost(st, 'router', 460, 120, 'R2'); const r3 = E.addHost(st, 'router', 620, 260, 'R3'); const b = E.addHost(st, 'server', 800, 360, 'Server');
      E.connect(st, a.id, 0, r1.id, 0); E.connect(st, r1.id, 1, r3.id, 0, { delayUs: 1000 }); E.connect(st, r1.id, 2, r2.id, 0, { delayUs: 1000 }); E.connect(st, r2.id, 1, r3.id, 2, { delayUs: 1000 }); E.connect(st, r3.id, 1, b.id, 0);
      E.setIfaceIp(st, a, 'eth0', ip('10.0.1.10'), m(24)); E.setDefaultGateway(a, ip('10.0.1.1'));
      E.setIfaceIp(st, r1, 'eth0', ip('10.0.1.1'), m(24)); E.setIfaceIp(st, r1, 'eth1', ip('10.0.13.1'), m(24)); E.setIfaceIp(st, r1, 'eth2', ip('10.0.12.1'), m(24));
      E.setIfaceIp(st, r2, 'eth0', ip('10.0.12.2'), m(24)); E.setIfaceIp(st, r2, 'eth1', ip('10.0.23.2'), m(24));
      E.setIfaceIp(st, r3, 'eth0', ip('10.0.13.3'), m(24)); E.setIfaceIp(st, r3, 'eth1', ip('10.0.9.1'), m(24)); E.setIfaceIp(st, r3, 'eth2', ip('10.0.23.3'), m(24));
      E.setIfaceIp(st, b, 'eth0', ip('10.0.9.10'), m(24)); E.setDefaultGateway(b, ip('10.0.9.1'));
      [r1, r2, r3].forEach(r => { ripOn(r); r.routing.rip.timeoutUs = 20_000_000; r.routing.rip.gcUs = 10_000_000; });
    }),
    checks: [{ id: 'ping', label: 'Connectivity restored over the backup path', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.9.10' }],
    steps: [
      { title: 'Converge on the primary', do: 'Turbo. RIP uses the direct R1–R3 link. Confirm with traceroute from PC-A.', set: ['traceroute 10.0.9.10'], observe: 'Path is R1 → R3 → Server (no R2).' },
      { title: 'Break the primary link', do: 'Open **R1 → Config** and set interface **eth1** (the R1–R3 link) **down** (untick “up”), Apply.', set: ['R1 eth1 = down'], note: 'Immediately after, is the server reachable? What must expire first?' },
      { title: 'Watch reconvergence', do: 'Press **Turbo** (timers are shortened for this lab). RIP times the dead route out and switches to R1 → R2 → R3.', observe: 'This takes simulated time — distance vector is not instant.' },
      { title: 'Confirm the backup', do: 'Ping the server and traceroute again from PC-A, and Turbo.', set: ['ping -c 3 10.0.9.10', 'traceroute 10.0.9.10'], observe: 'Now the path goes through R2.', checkId: 'ping', note: 'Roughly how much simulated time did reconvergence take? Why is distance-vector slow here?' },
    ],
    questions: [{ q: 'Why is RIP reconvergence slow?', a: 'A router must wait for the route to *time out* (no updates) before believing it is gone, then let the new information propagate hop by hop. Link-state protocols instead flood a failure notice immediately, so they reconverge faster.' }],
    wrap: 'RIP heals, but slowly, and only if you built in a backup path. Speed is where OSPF shines next.' },
];
