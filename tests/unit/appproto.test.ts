import { describe, it, expect } from 'vitest';
import { createState, addHost, addSwitch, connect, setIfaceIp, setDefaultGateway, addStaticRoute, setDnsZone, ensureServices, addSniffer, advance, DEFAULT_ROOTS } from '@/engine/engine';
import { runCommand } from '@/engine/terminal';
import { ipToU32, prefixToMask, u32ToIp } from '@/shared/bytes';
import { decodeFrame, fieldValue } from '@/engine/codecs/decode';
import { encodeDns, decodeDnsMessage, newQuery } from '@/engine/codecs/dns';
import { encodeDhcp, decodeDhcpMessage, DHCP_OFFER } from '@/engine/codecs/dhcp';
import { SEC } from '@/engine/core';
import type { EngineState, HostState } from '@/engine/types';

const ip = ipToU32; const m24 = prefixToMask(24);
const out = (h: HostState) => h.terminal.join('\n');
const run = (st: EngineState, secs: number) => advance(st, st.time + secs * SEC, 5e6);
const frames = (st: EngineState, sid: number) => st.sniffers[sid]!.frames.map(f => Object.assign(decodeFrame(f.bytes), { dir: f.dir }));

describe('dns/dhcp codecs', () => {
  it('dns query/response round-trips with compression', () => {
    const q = newQuery(0x1234, 'www.example.com'); const b = encodeDns(q); const d = decodeDnsMessage(b, 0, b.length);
    expect(d.id).toBe(0x1234); expect(d.questions[0]!.name).toBe('www.example.com'); expect(d.rd).toBe(true);
    const resp = { ...q, qr: true, aa: true, answers: [{ name: 'www.example.com', type: 5, cls: 1, ttl: 300, data: { kind: 'cname' as const, name: 'example.com' } }, { name: 'example.com', type: 1, cls: 1, ttl: 300, data: { kind: 'a' as const, ip: ip('93.184.216.34') } }] };
    const b2 = encodeDns(resp); const d2 = decodeDnsMessage(b2, 0, b2.length);
    expect(d2.answers).toHaveLength(2); expect(d2.answers[0]!.data).toEqual({ kind: 'cname', name: 'example.com' }); expect((d2.answers[1]!.data as { ip: number }).ip).toBe(ip('93.184.216.34'));
    // compression: 'example.com' appears in the CNAME target and the second name; encoded once
    expect(b2.length).toBeLessThan(80);
  });
  it('dhcp round-trips options', () => { const b = encodeDhcp({ op: 2, xid: 0xabcd, secs: 0, flags: 0x8000, ciaddr: 0, yiaddr: ip('10.0.0.50'), siaddr: ip('10.0.0.1'), giaddr: 0, chaddr: new Uint8Array([2, 0, 0, 1, 0, 0]), msgType: DHCP_OFFER, options: { serverId: ip('10.0.0.1'), leaseTime: 3600, subnet: m24, router: ip('10.0.0.1'), dns: [ip('10.0.0.1')] } }); const d = decodeDhcpMessage(b, 0, b.length); expect(d.msgType).toBe(DHCP_OFFER); expect(d.yiaddr).toBe(ip('10.0.0.50')); expect(d.options.leaseTime).toBe(3600); expect(d.options.dns).toEqual([ip('10.0.0.1')]); });
});

function lan3(seed = 1) {
  const st = createState(seed); const gw = addHost(st, 'router', 0, 0, 'GW'); const sw = addSwitch(st, 0, 0); const a = addHost(st, 'laptop', 0, 0, 'A'); const b = addHost(st, 'laptop', 0, 0, 'B'); const srv = addHost(st, 'server', 0, 0, 'SRV');
  connect(st, gw.id, 0, sw.id, 0); connect(st, a.id, 0, sw.id, 1); connect(st, b.id, 0, sw.id, 2); connect(st, srv.id, 0, sw.id, 3);
  setIfaceIp(st, gw, 'eth0', ip('10.0.0.1'), m24); setIfaceIp(st, srv, 'eth0', ip('10.0.0.53'), m24);
  return { st, gw, sw, a, b, srv };
}

describe('DHCP', () => {
  it('DORA: client gets an address, mask, gateway and DNS from the server', () => {
    const { st, gw, a, srv } = lan3(); const l = st.links[1]!; void l; const s = addSniffer(st, 1)!;
    gw.dhcpServer = { enabled: true, iface: 'eth0', poolStart: ip('10.0.0.100'), poolEnd: ip('10.0.0.110'), mask: m24, gateway: ip('10.0.0.1'), dns: [ip('10.0.0.53')], leaseUs: 3600 * SEC, leases: {} }; void srv;
    ensureServices(st); runCommand(st, a, 'dhclient eth0'); run(st, 10);
    expect(a.ifaces[0]!.ip).toBe(ip('10.0.0.100')); expect(a.ifaces[0]!.mask).toBe(m24);
    expect(a.routes.some(r => r.kind === 'default' && r.gw === ip('10.0.0.1'))).toBe(true); expect(a.dns).toEqual(['10.0.0.53']);
    expect(out(a)).toContain('DHCPACK'); expect(out(a)).toContain('bound to 10.0.0.100');
    const kinds = frames(st, s).filter(f => f.proto === 'DHCP').map(f => f.info);
    expect(kinds.join(' ')).toMatch(/DISCOVER/); expect(kinds.join(' ')).toMatch(/OFFER/); expect(kinds.join(' ')).toMatch(/REQUEST/); expect(kinds.join(' ')).toMatch(/ACK/);
  });
  it('two clients get distinct addresses; server tracks leases', () => {
    const { st, gw, a, b } = lan3(2); gw.dhcpServer = { enabled: true, iface: 'eth0', poolStart: ip('10.0.0.100'), poolEnd: ip('10.0.0.110'), mask: m24, gateway: ip('10.0.0.1'), dns: [], leaseUs: 3600 * SEC, leases: {} };
    ensureServices(st); runCommand(st, a, 'dhclient'); run(st, 10); runCommand(st, b, 'dhclient'); run(st, 10);
    expect(a.ifaces[0]!.ip).not.toBe(b.ifaces[0]!.ip); expect(Object.keys(gw.dhcpServer.leases)).toHaveLength(2);
  });
});

describe('DNS hierarchy', () => {
  // root(.), TLD(com), authoritative(example.com), plus a recursive resolver; a client uses the resolver.
  function dnsWorld(seed = 1) {
    const st = createState(seed); const sw = addSwitch(st, 0, 0, 16);
    const mk = (name: string, addr: string) => { const n = addHost(st, 'server', 0, 0, name); connect(st, n.id, 0, sw.id, 0); const port = Object.values(st.links).length; void port; setIfaceIp(st, n, 'eth0', ip(addr), prefixToMask(16)); return n; };
    // connect each to its own switch port
    const nodes: HostState[] = []; let port = 0;
    const add = (name: string, addr: string) => { const n = addHost(st, 'server', 0, 0, name); connect(st, n.id, 0, sw.id, port++); setIfaceIp(st, n, 'eth0', ip(addr), prefixToMask(16)); nodes.push(n); return n; };
    void mk;
    const root = add('root', '10.1.0.1'); const tld = add('com-tld', '10.1.0.2'); const auth = add('ns-example', '10.1.0.3'); const resolver = add('resolver', '10.1.0.4'); const client = add('client', '10.1.0.5');
    root.dnsZones = [{ origin: '', text: '', records: [
      { name: '', type: 2, ttl: 3600, data: { kind: 'ns', name: 'a.gtld-servers.net' } },
      { name: 'com', type: 2, ttl: 3600, data: { kind: 'ns', name: 'a.gtld-servers.net' } },
      { name: 'a.gtld-servers.net', type: 1, ttl: 3600, data: { kind: 'a', ip: ip('10.1.0.2') } } ] }];
    tld.dnsZones = [{ origin: 'com', text: '', records: [
      { name: 'com', type: 2, ttl: 3600, data: { kind: 'ns', name: 'a.gtld-servers.net' } },
      { name: 'example.com', type: 2, ttl: 3600, data: { kind: 'ns', name: 'ns.example.com' } },
      { name: 'ns.example.com', type: 1, ttl: 3600, data: { kind: 'a', ip: ip('10.1.0.3') } } ] }];
    setDnsZone(auth, 'example.com', '$TTL 300\n@ IN SOA ns.example.com. admin.example.com. 1 7200 3600 604800 300\n@ IN NS ns.example.com.\nns IN A 10.1.0.3\n@ IN A 93.184.216.34\nwww IN CNAME example.com.\nmail IN A 93.184.216.35\n');
    resolver.dnsRecursion = true; resolver.dnsRoots = [ip('10.1.0.1')]; // iterative from our own root
    client.dns = ['10.1.0.4'];
    ensureServices(st); return { st, root, tld, auth, resolver, client };
  }
  it('recursive resolver walks root → TLD → authoritative and returns the A record', () => {
    const { st, client, resolver } = dnsWorld(); runCommand(st, client, 'dig www.example.com'); run(st, 15);
    const o = out(client); expect(o).toContain('status: NOERROR'); expect(o).toContain('CNAME'); expect(o).toContain('93.184.216.34');
    // resolver cached the answer
    expect(Object.keys(resolver.dnsCache).length).toBeGreaterThan(0);
  });
  it('a second lookup is served from the resolver cache (no root traffic)', () => {
    const { st, client, root } = dnsWorld(3); runCommand(st, client, 'dig example.com'); run(st, 15);
    const rootRxBefore = root.counters.udpRx; runCommand(st, client, 'dig example.com'); run(st, 15);
    expect(root.counters.udpRx).toBe(rootRxBefore); // cache hit, root not consulted again
    expect(out(client).split(';; SERVER').length - 1).toBe(2);
  });
  it('NXDOMAIN for an unknown name under example.com', () => { const { st, client } = dnsWorld(4); runCommand(st, client, 'dig nope.example.com'); run(st, 15); expect(out(client)).toContain('status: NXDOMAIN'); });
  it('ping resolves a hostname via DNS then pings the address', () => {
    const { st, client } = dnsWorld(5); runCommand(st, client, 'ping -c 1 mail.example.com'); run(st, 15);
    expect(out(client)).toContain('mail.example.com resolved to 93.184.216.35');
    // no host at that address, so it will be unreachable, but resolution worked
  });
});

describe('HTTP', () => {
  function web(seed = 1) {
    const st = createState(seed); const sw = addSwitch(st, 0, 0); const c = addHost(st, 'laptop', 0, 0, 'client'); const s = addHost(st, 'server', 0, 0, 'web');
    connect(st, c.id, 0, sw.id, 0); connect(st, s.id, 0, sw.id, 1); setIfaceIp(st, c, 'eth0', ip('10.0.0.2'), m24); setIfaceIp(st, s, 'eth0', ip('10.0.0.80'), m24);
    s.httpDocroot = { 'index.html': '<html><head><link rel="stylesheet" href="/a.css"></head><body><img src="/img.png"><script src="/b.js"></script></body></html>', 'a.css': 'body{}', 'b.js': 'x=1', 'img.png': 'PNG'.repeat(500) };
    runCommand(st, s, 'httpd'); return { st, c, s };
  }
  it('GET fetches the page and its three embedded resources over a persistent connection', () => {
    const { st, c } = web(); const sn = addSniffer(st, 2)!; runCommand(st, c, 'curl http://10.0.0.80/'); run(st, 10);
    const o = out(c); expect(o).toContain('200 OK'); expect(o).toContain('references 3 resource'); expect(o).toContain('Fetched 4 resource(s)');
    const http = frames(st, sn).filter(f => f.proto === 'HTTP'); expect(http.some(f => f.info.includes('GET /a.css'))).toBe(true); expect(http.filter(f => f.info.startsWith('GET')).length).toBe(4);
    // persistent: single TCP connection (one SYN)
    const syns = frames(st, sn).filter(f => f.proto === 'TCP' && f.info.includes('[SYN]')); expect(syns.length).toBe(1);
  });
  it('non-persistent (HTTP/1.0) opens a fresh connection per object', () => {
    const { st, c } = web(2); const sn = addSniffer(st, 2)!; runCommand(st, c, 'curl -0 http://10.0.0.80/'); run(st, 10);
    expect(out(c)).toContain('Fetched 4 resource(s)');
    const syns = frames(st, sn).filter(f => f.proto === 'TCP' && f.info.includes('[SYN]')); expect(syns.length).toBe(4);
  });
  it('404 for a missing path; HEAD returns headers only', () => {
    const { st, c } = web(3); runCommand(st, c, 'curl --no-recurse http://10.0.0.80/missing'); run(st, 5); expect(out(c)).toContain('404 Not Found');
    runCommand(st, c, 'curl -I http://10.0.0.80/'); run(st, 5); expect(out(c)).toContain('200 OK');
  });
  it('curl by hostname uses DNS then HTTP', () => {
    const { st, c, s } = web(4); const dns = addHost(st, 'server', 0, 0, 'dns'); const sw = st.nodes[Object.values(st.nodes).find(n => n.type === 'switch')!.id]!;
    connect(st, dns.id, 0, sw.id, 2); setIfaceIp(st, dns, 'eth0', ip('10.0.0.53'), m24);
    setDnsZone(dns, 'test.local', '$TTL 300\nweb IN A 10.0.0.80\n'); ensureServices(st); c.dns = ['10.0.0.53']; void s;
    runCommand(st, c, 'curl http://web.test.local/'); run(st, 10); expect(out(c)).toContain('200 OK');
  });
});
