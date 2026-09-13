import { E, ip, m, scene, type Lab } from './helpers';
import type { HostState, ScenarioCheck } from '@/engine/types';
const MOD = 'OSPF';
function ospfOn(r: HostState, costs: Record<string, number> = {}) { r.routing.ospf.enabled = true; r.routing.ospf.networks = r.ifaces.filter(i => i.ip !== null).map(i => ({ net: (i.ip! & i.mask) >>> 0, mask: i.mask })); r.routing.ospf.ifaceCosts = costs; }
function triangle(costs?: { [rid: string]: Record<string, number> }) { return (st: import('@/engine/types').EngineState) => {
  const a = E.addHost(st, 'laptop', 120, 360, 'PC-A'); const R1 = E.addHost(st, 'router', 320, 260, 'R1'); const R2 = E.addHost(st, 'router', 480, 120, 'R2'); const R3 = E.addHost(st, 'router', 640, 260, 'R3'); const b = E.addHost(st, 'server', 820, 360, 'Server');
  E.connect(st, a.id, 0, R1.id, 0); E.connect(st, R1.id, 1, R2.id, 0, { delayUs: 1000 }); E.connect(st, R1.id, 2, R3.id, 0, { delayUs: 1000 }); E.connect(st, R2.id, 1, R3.id, 1, { delayUs: 1000 }); E.connect(st, R3.id, 2, b.id, 0);
  E.setIfaceIp(st, a, 'eth0', ip('10.0.1.10'), m(24)); E.setDefaultGateway(a, ip('10.0.1.1'));
  E.setIfaceIp(st, R1, 'eth0', ip('10.0.1.1'), m(24)); E.setIfaceIp(st, R1, 'eth1', ip('10.0.12.1'), m(24)); E.setIfaceIp(st, R1, 'eth2', ip('10.0.13.1'), m(24));
  E.setIfaceIp(st, R2, 'eth0', ip('10.0.12.2'), m(24)); E.setIfaceIp(st, R2, 'eth1', ip('10.0.23.2'), m(24));
  E.setIfaceIp(st, R3, 'eth0', ip('10.0.13.3'), m(24)); E.setIfaceIp(st, R3, 'eth1', ip('10.0.23.3'), m(24)); E.setIfaceIp(st, R3, 'eth2', ip('10.0.9.1'), m(24));
  E.setIfaceIp(st, b, 'eth0', ip('10.0.9.10'), m(24)); E.setDefaultGateway(b, ip('10.0.9.1'));
  ospfOn(R1, costs?.R1); ospfOn(R2, costs?.R2); ospfOn(R3, costs?.R3);
  return { R1, R2, R3 };
}; }
export const OSPF_LABS: Lab[] = [
  { id: 'ospf-adjacency', module: MOD, name: 'OSPF adjacencies and the LSDB', difficulty: 'core', minutes: 16,
    objectives: ['See routers form OSPF neighbours', 'Understand the link-state database (LSDB)', 'Contrast link-state with distance vector'],
    theory: ['**OSPF** is a **link-state** protocol. Routers discover neighbours with **Hello** packets and form **adjacencies**. Each router then floods a **Link-State Advertisement (LSA)** describing its own links; every router collects all LSAs into an identical **link-state database (LSDB)** and runs **Dijkstra’s algorithm** to compute shortest paths. Unlike RIP, each router sees the *whole map*, so it converges fast and uses **cost**, not hop count.'],
    build: () => scene('ospf-adjacency', 'OSPF adjacencies and the LSDB', 'Bring up OSPF and inspect neighbours and the LSDB.', [{ id: 'full', label: 'R1 formed a FULL adjacency', kind: 'ospfFull', node: 'R1' }, { id: 'ping', label: 'End-to-end connectivity via OSPF', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.9.10' }], triangle()),
    checks: [{ id: 'full', label: 'R1 formed a FULL adjacency', kind: 'ospfFull', node: 'R1' }, { id: 'ping', label: 'End-to-end connectivity via OSPF', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.9.10' }],
    steps: [
      { title: 'Converge', do: 'Press **Turbo** and let Hellos and LSAs flow.' },
      { title: 'Check neighbours', do: 'Open **R1 → Routing → OSPF**.', observe: 'Neighbours are listed as “full”; the LSDB holds one LSA per router.', note: 'How many LSAs does R1’s LSDB hold, and from how many routers?', checkId: 'full' },
      { title: 'Verify routes', do: 'Ping the server from PC-A and Turbo.', set: ['ping -c 3 10.0.9.10'], checkId: 'ping' },
      { title: 'Compare with RIP', do: 'Recall the RIP labs.', note: 'In one sentence, how does OSPF’s “whole-map” view differ from RIP’s “rumours from neighbours”?' },
    ],
    questions: [{ q: 'Why does every OSPF router end up with the same LSDB?', a: 'LSAs are flooded reliably to all routers in the area, so each builds an identical map of the topology and can independently compute consistent shortest paths.' }],
    wrap: 'Shared map + Dijkstra = fast, loop-free routing that understands link cost.' },

  { id: 'ospf-cost', module: MOD, name: 'Cost and shortest path', difficulty: 'core', minutes: 15,
    objectives: ['Understand OSPF cost', 'See Dijkstra pick the lowest-cost path, not fewest hops'],
    theory: ['OSPF assigns each link a **cost** (lower is better). The best path is the one with the smallest **total cost**, which may have *more* hops than an alternative if those hops are cheaper. You set per-interface cost to steer traffic.'],
    build: () => scene('ospf-cost', 'Cost and shortest path', 'Make the two-hop path cheaper than the one-hop path.', [{ id: 'ping', label: 'Server reachable via OSPF', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.9.10' }], triangle({ R1: { eth2: 100 }, R3: { eth0: 100 } })),
    checks: [{ id: 'ping', label: 'Server reachable via OSPF', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.9.10' }],
    steps: [
      { title: 'Note the costs', do: 'The direct R1–R3 link has been made expensive (cost 100 each end); the R1–R2–R3 links are the default cost 10.', note: 'Total cost of the direct path vs the via-R2 path? Which should OSPF choose?' },
      { title: 'Converge and trace', do: 'Turbo, then run traceroute from PC-A to the server.', set: ['traceroute 10.0.9.10'], observe: 'OSPF prefers the cheaper two-hop path through R2, even though a one-hop path exists.', checkId: 'ping', note: 'Which path did traceroute show? Does it match your cost calculation?' },
      { title: 'Experiment', do: 'Open **R1 → Routing → OSPF** and lower the eth2 (direct) cost back to 10, then Turbo and traceroute again.', set: ['R1 eth2 cost = 10'], note: 'Now which path wins, and why?' },
    ],
    questions: [{ q: 'How can a 2-hop path beat a 1-hop path in OSPF?', a: 'OSPF sums link costs, not hops. If the single hop is expensive (high cost) and the two hops are cheap, the two-hop path has a lower total cost and is chosen.' }],
    wrap: 'Cost is your steering wheel: set it to reflect bandwidth and OSPF routes traffic where you want it.' },

  { id: 'ospf-reroute', module: MOD, name: 'Fast reroute on failure', difficulty: 'advanced', minutes: 16,
    objectives: ['See OSPF reconverge quickly when a link fails', 'Contrast the speed with RIP'],
    theory: ['When a link fails, the attached router floods an updated LSA immediately; every router recomputes Dijkstra and switches to the next-best path within seconds — much faster than RIP’s timeout-based reconvergence.'],
    build: () => scene('ospf-reroute', 'Fast reroute on failure', 'Fail the primary link and watch OSPF switch paths fast.', [{ id: 'ping', label: 'Connectivity restored via the backup path', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.9.10' }], triangle()),
    checks: [{ id: 'ping', label: 'Connectivity restored via the backup path', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.9.10' }],
    steps: [
      { title: 'Converge on the direct path', do: 'Turbo, then traceroute from PC-A. With equal costs OSPF uses the one-hop R1–R3 path.', set: ['traceroute 10.0.9.10'] },
      { title: 'Fail the link', do: 'Open **R1 → Config**, set interface **eth2** (R1–R3) **down**, Apply.', set: ['R1 eth2 = down'] },
      { title: 'Reconverge', do: 'Turbo, then ping and traceroute the server from PC-A.', set: ['ping -c 3 10.0.9.10', 'traceroute 10.0.9.10'], observe: 'OSPF re-routes through R2 almost immediately after the LSA floods.', checkId: 'ping', note: 'Compare how quickly OSPF recovered here versus RIP in the earlier failure lab.' },
    ],
    questions: [{ q: 'Why is OSPF reconvergence faster than RIP’s?', a: 'OSPF floods a failure LSA at once and every router recomputes shortest paths immediately, whereas RIP must first let the dead route time out before it can react.' }],
    wrap: 'Immediate flooding plus local Dijkstra makes OSPF the workhorse of enterprise routing.' },

  { id: 'ospf-multiarea-note', module: MOD, name: 'OSPF areas: the big picture', difficulty: 'core', minutes: 10,
    objectives: ['Understand why OSPF uses areas (concept)', 'Verify single-area behaviour here'],
    theory: ['Large OSPF networks split into **areas** to keep LSDBs small and flooding local; a backbone (**area 0**) ties them together. This simulator models a **single area**, which is exactly area 0. Everything you learned about adjacencies, LSAs and Dijkstra applies within each area.'],
    build: () => scene('ospf-multiarea-note', 'OSPF areas: the big picture', 'Confirm single-area OSPF and reflect on scaling with areas.', [{ id: 'ping', label: 'Single-area OSPF works end to end', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.9.10' }], triangle()),
    checks: [{ id: 'ping', label: 'Single-area OSPF works end to end', kind: 'terminalContains', node: 'PC-A', text: 'bytes from 10.0.9.10' }],
    steps: [
      { title: 'Confirm area 0', do: 'Open any router → Routing → OSPF. All routers are in area 0.', note: 'Why does keeping every router in one huge area become a problem as the network grows?' },
      { title: 'Verify it works', do: 'Turbo and ping the server from PC-A.', set: ['ping -c 2 10.0.9.10'], checkId: 'ping' },
    ],
    questions: [{ q: 'What problem do multiple areas solve?', a: 'They limit the size of each LSDB and confine flooding to an area, so a change in one area does not force every router in the network to recompute — improving scalability and stability.' }],
    wrap: 'You have the full single-area toolkit; areas are the same ideas applied hierarchically.' },
];
