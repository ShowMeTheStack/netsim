import { E, ip, m, scene, type Lab } from './helpers';
import type { HostState, ScenarioCheck } from '@/engine/types';
import { SEC } from '@/engine/core';
const MOD = 'BGP';
function nb(peerIp: number, peerAs: number) { return { peerIp, peerAs, state: 'idle' as const, sock: null, routerId: 0, holdUs: 90 * SEC, keepaliveUs: 30 * SEC, isClient: false, up: false, rxOpen: false, gen: 0 }; }
function bgpOn(r: HostState, as: number, routerId: string, networks: [string, number][], neighbors: { ip: string; as: number }[], rr = false) {
  r.routing.bgp = { enabled: true, as, routerId: ip(routerId), neighbors: neighbors.map(n => nb(ip(n.ip), n.as)), networks: networks.map(([n, p]) => ({ net: ip(n) >>> 0, mask: m(p) })), rib: [], routeReflector: rr };
}
export const BGP_LABS: Lab[] = [
  { id: 'bgp-ebgp', module: MOD, name: 'eBGP between two autonomous systems', difficulty: 'advanced', minutes: 18,
    objectives: ['Understand what an AS and eBGP are', 'See prefixes exchanged with an AS_PATH', 'Read the BGP table (RIB)'],
    theory: ['The Internet is a mesh of **Autonomous Systems (AS)** — independently run networks identified by an **AS number**. **BGP** is the protocol they use to advertise which IP **prefixes** they can reach. **eBGP** runs between routers in *different* ASes. Each advertisement carries an **AS_PATH** listing the ASes it crossed, which prevents loops and is a key tie-breaker in path selection.'],
    build: () => scene('bgp-ebgp', 'eBGP between two autonomous systems', 'Peer two ASes and watch prefixes cross with AS_PATH.', [{ id: 'est', label: 'The eBGP session is established', kind: 'bgpEstablished', node: 'R1' }, { id: 'route', label: 'R1 learned the other AS’s prefix', kind: 'routeKind', node: 'R1', prefix: '192.168.2.0/24', routeKind: 'bgp' }], (st) => {
      const R1 = E.addHost(st, 'router', 300, 220, 'R1'); const R2 = E.addHost(st, 'router', 560, 220, 'R2');
      const a = E.addHost(st, 'server', 160, 340, 'Net-A'); const b = E.addHost(st, 'server', 700, 340, 'Net-B');
      const link = E.connect(st, R1.id, 0, R2.id, 0, { delayUs: 3000 })!; E.connect(st, R1.id, 1, a.id, 0); E.connect(st, R2.id, 1, b.id, 0);
      E.setIfaceIp(st, R1, 'eth0', ip('203.0.113.1'), m(30)); E.setIfaceIp(st, R1, 'eth1', ip('192.168.1.1'), m(24));
      E.setIfaceIp(st, R2, 'eth0', ip('203.0.113.2'), m(30)); E.setIfaceIp(st, R2, 'eth1', ip('192.168.2.1'), m(24));
      E.setIfaceIp(st, a, 'eth0', ip('192.168.1.10'), m(24)); E.setDefaultGateway(a, ip('192.168.1.1'));
      E.setIfaceIp(st, b, 'eth0', ip('192.168.2.10'), m(24)); E.setDefaultGateway(b, ip('192.168.2.1'));
      bgpOn(R1, 65001, '1.1.1.1', [['192.168.1.0', 24]], [{ ip: '203.0.113.2', as: 65002 }]);
      bgpOn(R2, 65002, '2.2.2.2', [['192.168.2.0', 24]], [{ ip: '203.0.113.1', as: 65001 }]);
      E.addSniffer(st, link);
    }),
    checks: [{ id: 'est', label: 'The eBGP session is established', kind: 'bgpEstablished', node: 'R1' }, { id: 'route', label: 'R1 learned the other AS’s prefix', kind: 'routeKind', node: 'R1', prefix: '192.168.2.0/24', routeKind: 'bgp' }],
    steps: [
      { title: 'Bring up the peering', do: 'Press **Turbo**. R1 (AS 65001) and R2 (AS 65002) open a TCP session on port 179 and exchange OPEN/KEEPALIVE.' },
      { title: 'Confirm establishment', do: 'Open **R1 → Routing → BGP**.', observe: 'The neighbour shows “established”.', checkId: 'est' },
      { title: 'Read the RIB', do: 'In the same panel, look at the BGP table.', observe: 'R1 has the remote prefix `192.168.2.0/24` with AS_PATH `65002`; the `>` marks the best path.', note: 'What AS_PATH does R2’s prefix carry at R1? What would it be two ASes away?', checkId: 'route' },
      { title: 'Sniff the session', do: 'On the R1–R2 link sniffer, find the BGP OPEN and UPDATE messages.', note: 'Which TCP port does BGP use? Record one UPDATE’s advertised prefix.' },
    ],
    questions: [{ q: 'What is the AS_PATH for and why does it prevent loops?', a: 'It lists every AS a route has traversed. A router rejects any advertisement that already contains its own AS number, so a route can never loop back into an AS it already left.' }],
    wrap: 'eBGP is how independent networks stitch the Internet together, one prefix and AS_PATH at a time.' },

  { id: 'bgp-path', module: MOD, name: 'BGP path selection', difficulty: 'advanced', minutes: 18,
    objectives: ['See BGP choose among multiple paths', 'Understand AS_PATH length and local preference'],
    theory: ['When BGP knows several paths to a prefix it picks one **best** path by a strict tie-break order: highest **local preference** first, then shortest **AS_PATH**, then origin, then MED, and so on. Local preference is set *inside* your AS to prefer one exit over another; AS_PATH length is the main inter-AS tie-break.'],
    build: () => scene('bgp-path', 'BGP path selection', 'Offer two paths to one prefix and see the shorter AS_PATH win.', [{ id: 'est', label: 'BGP sessions established at R3', kind: 'bgpEstablished', node: 'R3' }, { id: 'route', label: 'R3 selected a best path to 192.168.9.0/24', kind: 'routeKind', node: 'R3', prefix: '192.168.9.0/24', routeKind: 'bgp' }], (st) => {
      // AS65009 (origin, R0) reachable from R3 (AS65003) two ways: directly, and via R2 (AS65002).
      const R0 = E.addHost(st, 'router', 500, 120, 'R0-AS9'); const R2 = E.addHost(st, 'router', 300, 240, 'R2-AS2'); const R3 = E.addHost(st, 'router', 560, 320, 'R3-AS3'); const orig = E.addHost(st, 'server', 700, 120, 'Prefix9');
      E.connect(st, R0.id, 0, R3.id, 0, { delayUs: 3000 }); E.connect(st, R0.id, 1, R2.id, 0, { delayUs: 3000 }); E.connect(st, R2.id, 1, R3.id, 1, { delayUs: 3000 }); E.connect(st, R0.id, 2, orig.id, 0);
      E.setIfaceIp(st, R0, 'eth0', ip('203.0.0.1'), m(30)); E.setIfaceIp(st, R0, 'eth1', ip('203.0.0.5'), m(30)); E.setIfaceIp(st, R0, 'eth2', ip('192.168.9.1'), m(24));
      E.setIfaceIp(st, R2, 'eth0', ip('203.0.0.6'), m(30)); E.setIfaceIp(st, R2, 'eth1', ip('203.0.0.9'), m(30));
      E.setIfaceIp(st, R3, 'eth0', ip('203.0.0.2'), m(30)); E.setIfaceIp(st, R3, 'eth1', ip('203.0.0.10'), m(30));
      E.setIfaceIp(st, orig, 'eth0', ip('192.168.9.10'), m(24)); E.setDefaultGateway(orig, ip('192.168.9.1'));
      bgpOn(R0, 65009, '9.9.9.9', [['192.168.9.0', 24]], [{ ip: '203.0.0.2', as: 65003 }, { ip: '203.0.0.6', as: 65002 }]);
      bgpOn(R2, 65002, '2.2.2.2', [], [{ ip: '203.0.0.5', as: 65009 }, { ip: '203.0.0.10', as: 65003 }]);
      bgpOn(R3, 65003, '3.3.3.3', [], [{ ip: '203.0.0.1', as: 65009 }, { ip: '203.0.0.9', as: 65002 }]);
    }),
    checks: [{ id: 'est', label: 'BGP sessions established at R3', kind: 'bgpEstablished', node: 'R3-AS3' }, { id: 'route', label: 'R3 selected a best path to 192.168.9.0/24', kind: 'routeKind', node: 'R3-AS3', prefix: '192.168.9.0/24', routeKind: 'bgp' }],
    steps: [
      { title: 'Converge', do: 'Turbo. R3 (AS65003) can reach prefix `192.168.9.0/24` two ways: directly from AS65009, or via AS65002.' },
      { title: 'Inspect R3’s RIB', do: 'Open **R3-AS3 → Routing → BGP**.', observe: 'Two entries for the prefix; the `>` best one has the shorter AS_PATH (direct: `65009`) over the longer (`65002 65009`).', note: 'Write both AS_PATHs. Which is chosen and by which rule?', checkId: 'route' },
      { title: 'Reason about local preference', do: 'Local preference would override AS_PATH length if set. Predict: to force the longer path, what would you change?', note: 'Which attribute is checked *before* AS_PATH length?', checkId: 'est' },
    ],
    questions: [{ q: 'List the first three BGP best-path tie-breakers in order.', a: 'Highest local preference, then shortest AS_PATH, then lowest origin type. Local pref is policy inside your AS; AS_PATH is the main neutral tie-break between ASes.' }],
    wrap: 'BGP does not pick the fastest path — it picks the one your policy and AS_PATH rules prefer.' },

  { id: 'bgp-ibgp', module: MOD, name: 'iBGP and a route reflector', difficulty: 'advanced', minutes: 18,
    objectives: ['Understand why iBGP exists inside an AS', 'See the iBGP split-horizon rule and how a route reflector fixes it'],
    theory: ['Inside one AS, routers use **iBGP** to share externally-learned prefixes. A crucial rule: a router must **not** re-advertise an iBGP-learned route to another iBGP peer (to prevent loops), which normally forces a full mesh of sessions. A **route reflector** is allowed to break that rule and “reflect” routes to its clients, so you avoid the full mesh.'],
    build: () => scene('bgp-ibgp', 'iBGP and a route reflector', 'Learn a prefix via eBGP and reflect it over iBGP.', [{ id: 'est', label: 'R2’s iBGP session is established', kind: 'bgpEstablished', node: 'R2' }, { id: 'reflected', label: 'R2 learned the external prefix via iBGP reflection', kind: 'count', node: 'R2', path: 'routing.bgp.rib', min: 1 }], (st) => {
      // AS65000 origin (R0) -- eBGP -- R1 (AS65001, route reflector) -- iBGP -- R2 (AS65001 client)
      const R0 = E.addHost(st, 'router', 200, 200, 'R0-AS0'); const R1 = E.addHost(st, 'router', 440, 200, 'R1-RR'); const R2 = E.addHost(st, 'router', 660, 320, 'R2');
      const ext = E.addHost(st, 'server', 120, 340, 'Ext');
      E.connect(st, R0.id, 0, R1.id, 0, { delayUs: 3000 }); E.connect(st, R1.id, 1, R2.id, 0, { delayUs: 3000 }); E.connect(st, R0.id, 1, ext.id, 0);
      E.setIfaceIp(st, R0, 'eth0', ip('203.0.113.1'), m(30)); E.setIfaceIp(st, R0, 'eth1', ip('198.51.100.1'), m(24));
      E.setIfaceIp(st, R1, 'eth0', ip('203.0.113.2'), m(30)); E.setIfaceIp(st, R1, 'eth1', ip('10.1.0.1'), m(30));
      E.setIfaceIp(st, R2, 'eth0', ip('10.1.0.2'), m(30));
      E.setIfaceIp(st, ext, 'eth0', ip('198.51.100.10'), m(24)); E.setDefaultGateway(ext, ip('198.51.100.1'));
      bgpOn(R0, 65000, '0.0.0.1', [['198.51.100.0', 24]], [{ ip: '203.0.113.2', as: 65001 }]);
      bgpOn(R1, 65001, '1.1.1.1', [], [{ ip: '203.0.113.1', as: 65000 }, { ip: '10.1.0.2', as: 65001 }], true); // route reflector
      bgpOn(R2, 65001, '2.2.2.2', [], [{ ip: '10.1.0.1', as: 65001 }]);
      // R2 needs to reach the eBGP next-hop network to use the route; give it a static path via R1
      R2.routes.push({ dst: ip('203.0.113.0'), mask: m(30), gw: ip('10.1.0.1'), iface: 'eth0', metric: 1, kind: 'static' });
    }),
    checks: [{ id: 'est', label: 'R2’s iBGP session is established', kind: 'bgpEstablished', node: 'R2' }, { id: 'reflected', label: 'R2 learned the external prefix via iBGP reflection', kind: 'count', node: 'R2', path: 'routing.bgp.rib', min: 1 }],
    steps: [
      { title: 'Converge', do: 'Turbo. R0 (AS65000) advertises `198.51.100.0/24` to R1 via eBGP; R1 is a **route reflector** for its client R2.' },
      { title: 'Confirm iBGP up', do: 'Open **R2 → Routing → BGP**. The iBGP session to R1 is established.', checkId: 'est' },
      { title: 'See the reflected prefix', do: 'In R2’s BGP table, the external prefix appears with AS_PATH `65000`, learned over iBGP.', observe: 'Without the route reflector, R1 would have withheld it (iBGP split-horizon).', note: 'What AS_PATH does R2 see, and why is it not prepended with 65001?', checkId: 'reflected' },
    ],
    questions: [{ q: 'Why is a route reflector (or full mesh) needed for iBGP?', a: 'The iBGP split-horizon rule forbids re-advertising iBGP-learned routes to other iBGP peers, to avoid loops. A full mesh gives everyone the routes directly; a route reflector is allowed to relay them, avoiding the mesh.' }],
    wrap: 'iBGP carries the outside world across your AS; a route reflector makes that scale without a full mesh.' },
];
