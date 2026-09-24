import { describe, it, expect } from 'vitest';
import { createState, addHost, connect, setIfaceIp, ensureServices, advance } from '@/engine/engine';
import { runCommand } from '@/engine/terminal';
import { ipToU32, u32ToIp, prefixToMask } from '@/shared/bytes';
import { SEC } from '@/engine/core';
import type { EngineState, HostState } from '@/engine/types';

const ip = ipToU32; const m24 = prefixToMask(24);
const run = (st: EngineState, secs: number) => advance(st, st.time + secs * SEC, 5e6);
const routesTo = (h: HostState, dst: string) => h.routes.filter(r => ((ip(dst) & r.mask) >>> 0) === ((r.dst & r.mask) >>> 0) && r.mask !== 0);

/** Linear routers: A(10.0.1.0) - R1 - R2 - R3 - (10.0.4.0). Each link its own /24. */
function line(n: number) {
  const st = createState(1); const routers: HostState[] = [];
  for (let i = 0; i < n; i++) routers.push(addHost(st, 'router', i * 100, 0, `R${i + 1}`));
  for (let i = 0; i < n - 1; i++) { connect(st, routers[i]!.id, 1, routers[i + 1]!.id, 0, { delayUs: 1000 }); setIfaceIp(st, routers[i]!, 'eth1', ip(`10.0.${i + 1}0.1`), m24); setIfaceIp(st, routers[i + 1]!, 'eth0', ip(`10.0.${i + 1}0.2`), m24); }
  // stub networks on the ends
  setIfaceIp(st, routers[0]!, 'eth0', ip('10.0.1.1'), m24); setIfaceIp(st, routers[n - 1]!, 'eth1', ip('10.0.9.1'), m24);
  return { st, routers };
}

describe('RIP', () => {
  it('converges end to end across 4 routers with hop-count metrics', () => {
    const { st, routers } = line(4);
    for (const r of routers) { r.routing.rip.enabled = true; r.routing.rip.networks = r.ifaces.filter(i => i.ip !== null).map(i => ({ net: (i.ip! & i.mask) >>> 0, mask: i.mask })); }
    ensureServices(st); run(st, 120);
    // R1 should reach R4's stub 10.0.9.0/24 with metric 3 (3 hops)
    const r1 = routers[0]!; const toStub = routesTo(r1, '10.0.9.1').find(r => r.kind === 'rip'); expect(toStub).toBeDefined(); expect(toStub!.metric).toBe(3);
    const r4 = routers[3]!; const back = routesTo(r4, '10.0.1.1').find(r => r.kind === 'rip'); expect(back).toBeDefined(); expect(back!.metric).toBe(3);
  });
  it('reconverges after a link failure (route times out, split horizon prevents count-to-infinity blowup)', () => {
    const { st, routers } = line(3);
    for (const r of routers) { r.routing.rip.enabled = true; r.routing.rip.timeoutUs = 20 * SEC; r.routing.rip.gcUs = 10 * SEC; r.routing.rip.networks = r.ifaces.filter(i => i.ip !== null).map(i => ({ net: (i.ip! & i.mask) >>> 0, mask: i.mask })); }
    ensureServices(st); run(st, 120);
    expect(routesTo(routers[0]!, '10.0.9.1').some(r => r.kind === 'rip')).toBe(true);
    // fail R2-R3 link by downing R3's eth0
    routers[2]!.ifaces[0]!.up = false; run(st, 120);
    expect(routesTo(routers[0]!, '10.0.9.1').some(r => r.kind === 'rip')).toBe(false); // R1 no longer reaches the far stub
  });
});

describe('OSPF', () => {
  it('builds adjacencies, floods LSAs and computes SPF routes with link costs', () => {
    const { st, routers } = line(4);
    for (const r of routers) { r.routing.ospf.enabled = true; r.routing.ospf.networks = r.ifaces.filter(i => i.ip !== null).map(i => ({ net: (i.ip! & i.mask) >>> 0, mask: i.mask })); }
    ensureServices(st); run(st, 60);
    const r1 = routers[0]!;
    // full adjacency to R2
    expect(Object.values(r1.routing.ospf.neighbors).some(n => n.state === 'full')).toBe(true);
    // LSDB has an LSA from every router
    expect(new Set(Object.values(r1.routing.ospf.lsdb).map(l => l.advRouter)).size).toBe(4);
    const toStub = routesTo(r1, '10.0.9.1').find(r => r.kind === 'ospf'); expect(toStub).toBeDefined(); expect(toStub!.metric).toBe(40); // 3 transit links + stub link, each cost 10
  });
  it('reroutes when a link cost changes', () => {
    // triangle: R1-R2 (cost 10), R1-R3 (cost 10), R2-R3 (cost 10); R3 has stub 10.9.9.0/24
    const st = createState(1); const R1 = addHost(st, 'router', 0, 0, 'R1'); const R2 = addHost(st, 'router', 0, 0, 'R2'); const R3 = addHost(st, 'router', 0, 0, 'R3');
    connect(st, R1.id, 0, R2.id, 0); connect(st, R1.id, 1, R3.id, 0); connect(st, R2.id, 1, R3.id, 1);
    setIfaceIp(st, R1, 'eth0', ip('10.0.12.1'), m24); setIfaceIp(st, R2, 'eth0', ip('10.0.12.2'), m24);
    setIfaceIp(st, R1, 'eth1', ip('10.0.13.1'), m24); setIfaceIp(st, R3, 'eth0', ip('10.0.13.3'), m24);
    setIfaceIp(st, R2, 'eth1', ip('10.0.23.2'), m24); setIfaceIp(st, R3, 'eth1', ip('10.0.23.3'), m24);
    setIfaceIp(st, R3, 'eth2', ip('10.9.9.1'), m24);
    for (const r of [R1, R2, R3]) { r.routing.ospf.enabled = true; r.routing.ospf.networks = r.ifaces.filter(i => i.ip !== null).map(i => ({ net: (i.ip! & i.mask) >>> 0, mask: i.mask })); }
    ensureServices(st); run(st, 60);
    let toStub = routesTo(R1, '10.9.9.1').find(r => r.kind === 'ospf'); expect(toStub!.metric).toBe(20); expect(u32ToIp(toStub!.gw!)).toBe('10.0.13.3'); // direct via R3
    // make the direct R1-R3 link expensive; now path via R2 (10+10) ties... make it clearly worse
    R1.routing.ospf.ifaceCosts['eth1'] = 100; R3.routing.ospf.ifaceCosts['eth0'] = 100; R1.routing.ospf.seq = 0x80000010;
    ensureServices(st); R1.routing.ospf.gen++; run(st, 90);
    toStub = routesTo(R1, '10.9.9.1').find(r => r.kind === 'ospf'); expect(toStub).toBeDefined(); expect(toStub!.gw && u32ToIp(toStub!.gw)).toBe('10.0.12.2'); // now via R2
  });
});

describe('BGP', () => {
  it('eBGP: two ASes exchange prefixes with AS_PATH', () => {
    const st = createState(1); const R1 = addHost(st, 'router', 0, 0, 'R1'); const R2 = addHost(st, 'router', 0, 0, 'R2');
    connect(st, R1.id, 0, R2.id, 0, { delayUs: 1000 }); setIfaceIp(st, R1, 'eth0', ip('10.0.0.1'), prefixToMask(30)); setIfaceIp(st, R2, 'eth0', ip('10.0.0.2'), prefixToMask(30));
    setIfaceIp(st, R1, 'eth1', ip('192.168.1.1'), m24); setIfaceIp(st, R2, 'eth1', ip('192.168.2.1'), m24);
    R1.routing.bgp = { enabled: true, as: 65001, routerId: ip('1.1.1.1'), neighbors: [{ peerIp: ip('10.0.0.2'), peerAs: 65002, state: 'idle', sock: null, routerId: 0, holdUs: 90 * SEC, keepaliveUs: 30 * SEC, isClient: false, up: false, rxOpen: false, gen: 0 }], networks: [{ net: ip('192.168.1.0'), mask: m24 }], rib: [], routeReflector: false };
    R2.routing.bgp = { enabled: true, as: 65002, routerId: ip('2.2.2.2'), neighbors: [{ peerIp: ip('10.0.0.1'), peerAs: 65001, state: 'idle', sock: null, routerId: 0, holdUs: 90 * SEC, keepaliveUs: 30 * SEC, isClient: false, up: false, rxOpen: false, gen: 0 }], networks: [{ net: ip('192.168.2.0'), mask: m24 }], rib: [], routeReflector: false };
    ensureServices(st); run(st, 30);
    expect(R1.routing.bgp.neighbors[0]!.state).toBe('established');
    const r1toR2net = R1.routing.bgp.rib.find(r => r.prefix === ip('192.168.2.0') && r.best); expect(r1toR2net).toBeDefined(); expect(r1toR2net!.asPath).toEqual([65002]);
    expect(routesTo(R1, '192.168.2.5').some(r => r.kind === 'bgp')).toBe(true);
    const r2toR1net = R2.routing.bgp.rib.find(r => r.prefix === ip('192.168.1.0') && r.best); expect(r2toR1net!.asPath).toEqual([65001]);
  });
  it('iBGP + eBGP: prefix learned via eBGP is reflected to an iBGP peer with route reflector', () => {
    // AS65001: R1 (eBGP to R0 in AS65000) --- iBGP --- R2 (route reflector? here R1 is RR client of R2)
    const st = createState(1); const R0 = addHost(st, 'router', 0, 0, 'R0'); const R1 = addHost(st, 'router', 0, 0, 'R1'); const R2 = addHost(st, 'router', 0, 0, 'R2');
    connect(st, R0.id, 0, R1.id, 0, { delayUs: 1000 }); connect(st, R1.id, 1, R2.id, 0, { delayUs: 1000 });
    setIfaceIp(st, R0, 'eth0', ip('10.0.1.0'), prefixToMask(30)); setIfaceIp(st, R1, 'eth0', ip('10.0.1.1'), prefixToMask(30));
    setIfaceIp(st, R1, 'eth1', ip('10.1.0.1'), prefixToMask(30)); setIfaceIp(st, R2, 'eth0', ip('10.1.0.2'), prefixToMask(30));
    setIfaceIp(st, R0, 'eth1', ip('203.0.113.1'), m24);
    const nb = (peerIp: number, peerAs: number) => ({ peerIp, peerAs, state: 'idle' as const, sock: null, routerId: 0, holdUs: 90 * SEC, keepaliveUs: 30 * SEC, isClient: false, up: false, rxOpen: false, gen: 0 });
    R0.routing.bgp = { enabled: true, as: 65000, routerId: ip('0.0.0.1'), neighbors: [nb(ip('10.0.1.1'), 65001)], networks: [{ net: ip('203.0.113.0'), mask: m24 }], rib: [], routeReflector: false };
    R1.routing.bgp = { enabled: true, as: 65001, routerId: ip('1.1.1.1'), neighbors: [nb(ip('10.0.1.0'), 65000), nb(ip('10.1.0.2'), 65001)], networks: [], rib: [], routeReflector: true };
    R2.routing.bgp = { enabled: true, as: 65001, routerId: ip('2.2.2.2'), neighbors: [nb(ip('10.1.0.1'), 65001)], networks: [], rib: [], routeReflector: false };
    // R2 needs a route to reach 10.0.1.0 nexthop; give static via R1
    R2.routes.push({ dst: ip('10.0.1.0'), mask: prefixToMask(30), gw: ip('10.1.0.1'), iface: 'eth0', metric: 1, kind: 'static' });
    ensureServices(st); run(st, 40);
    expect(R1.routing.bgp.neighbors.every(n => n.state === 'established')).toBe(true);
    // R2 (iBGP) learns 203.0.113.0/24 reflected by R1 with AS_PATH [65000]
    const learned = R2.routing.bgp.rib.find(r => r.prefix === ip('203.0.113.0') && r.best); expect(learned).toBeDefined(); expect(learned!.asPath).toEqual([65000]);
  });
});
