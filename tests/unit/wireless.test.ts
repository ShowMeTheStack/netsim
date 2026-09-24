import { describe, it, expect } from 'vitest';
import { createState, addHost, addSwitch, addAp, connect, setIfaceIp, setWireless, addAirMonitor, ensureServices, advance } from '@/engine/engine';
import { runCommand } from '@/engine/terminal';
import { ipToU32, prefixToMask } from '@/shared/bytes';
import { decodeFrame } from '@/engine/codecs/decode';
import { SEC, MS } from '@/engine/core';
import type { EngineState, HostState, ApState } from '@/engine/types';
const ip = ipToU32; const m24 = prefixToMask(24);
const out = (h: HostState) => h.terminal.join('\n');
const run = (st: EngineState, s: number) => advance(st, st.time + s * SEC, 5e6);

// station(wifi) ~~ AP --wired-- server
function wlan(seed = 1, stationRange = 200) {
  const st = createState(seed); const sta = addHost(st, 'laptop', 100, 100, 'STA'); const ap = addAp(st, 100, 250, 'AP'); const srv = addHost(st, 'server', 300, 250, 'SRV');
  connect(st, ap.id, 0, srv.id, 0, { delayUs: 100 }); // AP wired port Gi0/1 (index 0) to server
  setWireless(sta, 'eth0', { ssid: 'netsim', channel: 6, range: stationRange }); setIfaceIp(st, sta, 'eth0', ip('10.0.0.10'), m24);
  ap.range = 200; ap.x = 100; ap.y = 250; setIfaceIp(st, srv, 'eth0', ip('10.0.0.20'), m24);
  ensureServices(st); return { st, sta, ap, srv };
}

describe('wireless CSMA/CA', () => {
  it('a station associates with an AP by SSID and pings a wired server over WiFi', () => {
    const { st, sta, ap } = wlan(); run(st, 1); // hear a beacon, associate
    expect(sta.ifaces[0]!.wifi!.associated).toBe(ap.id); expect(ap.clients.length).toBe(1);
    runCommand(st, sta, 'ping -c 3 10.0.0.20'); run(st, 12);
    expect(out(sta)).toContain('3 packets transmitted, 3 received');
  });
  it('a station out of range never associates and cannot reach the server', () => {
    const st = createState(1); const sta = addHost(st, 'laptop', 100, 100, 'STA'); const ap = addAp(st, 600, 100, 'AP'); const srv = addHost(st, 'server', 700, 100, 'SRV');
    connect(st, ap.id, 0, srv.id, 0); setWireless(sta, 'eth0', { ssid: 'netsim', channel: 6, range: 150 }); setIfaceIp(st, sta, 'eth0', ip('10.0.0.10'), m24); ap.range = 150; setIfaceIp(st, srv, 'eth0', ip('10.0.0.20'), m24);
    ensureServices(st); run(st, 2); expect(sta.ifaces[0]!.wifi!.associated).toBeNull();
    runCommand(st, sta, 'ping -c 1 10.0.0.20'); run(st, 4); expect(out(sta)).not.toContain('1 received');
  });
  it('air monitor captures beacons and data frames on the channel', () => {
    const { st, sta } = wlan(); const mon = addAirMonitor(st, 6); run(st, 1); runCommand(st, sta, 'ping -c 1 10.0.0.20'); run(st, 6);
    const frames = st.rf.monitors[mon]!.frames; expect(frames.some(f => f.kind === 'beacon')).toBe(true); expect(frames.some(f => f.kind === 'data')).toBe(true);
  });
  it('two stations on one AP both reach the server (CSMA/CA arbitrates the medium)', () => {
    const { st, ap, srv } = wlan(); const stb = addHost(st, 'laptop', 120, 90, 'STB'); connect; // second station near the AP
    setWireless(stb, 'eth0', { ssid: 'netsim', channel: 6, range: 200 }); setIfaceIp(st, stb, 'eth0', ip('10.0.0.11'), m24); ensureServices(st); run(st, 1);
    expect(ap.clients.length).toBe(2); void srv;
    const sta = st.nodes[1] as HostState;
    runCommand(st, sta, 'ping -c 2 10.0.0.20'); runCommand(st, stb, 'ping -c 2 10.0.0.20'); run(st, 20);
    expect(out(sta)).toContain('2 received'); expect(out(stb)).toContain('2 received');
  });
});

describe('hidden node and RTS/CTS', () => {
  // A and C both in range of B (the AP) but NOT each other → hidden terminals collide at B.
  function hidden(rtsCts: boolean) {
    const st = createState(3); const ap = addAp(st, 300, 100, 'AP'); ap.range = 210; ap.rtsCts = rtsCts;
    const A = addHost(st, 'laptop', 150, 100, 'A'); const C = addHost(st, 'laptop', 450, 100, 'C'); const srv = addHost(st, 'server', 300, 250, 'SRV');
    connect(st, ap.id, 0, srv.id, 0); setIfaceIp(st, srv, 'eth0', ip('10.0.0.20'), m24);
    setWireless(A, 'eth0', { ssid: 'netsim', channel: 6, range: 200 }); setWireless(C, 'eth0', { ssid: 'netsim', channel: 6, range: 200 });
    setIfaceIp(st, A, 'eth0', ip('10.0.0.10'), m24); setIfaceIp(st, C, 'eth0', ip('10.0.0.11'), m24);
    ensureServices(st); run(st, 1); return { st, A, C, ap };
  }
  it('A and C are hidden from each other (out of mutual range) but both see the AP', () => {
    const { st, A, C, ap } = hidden(false);
    expect(Math.hypot(A.x - C.x, A.y - C.y)).toBeGreaterThan(200); // beyond each other range
    expect(ap.clients.length).toBe(2);
    // both saturate the medium toward the server; hidden terminals cannot sense each other, so
    // their frames overlap at the AP and collide (heavy UDP load makes this deterministic).
    runCommand(st, A, 'iperf -c 10.0.0.20 -u -b 20M -t 3'); runCommand(st, C, 'iperf -c 10.0.0.20 -u -b 20M -t 3'); run(st, 6);
    expect(ap.counters.collisions + ap.counters.retries).toBeGreaterThan(0);
  });
  it('with RTS/CTS enabled both hidden stations still complete their pings', () => {
    const { st, A, C } = hidden(true);
    runCommand(st, A, 'ping -c 3 -i 0.03 10.0.0.20'); runCommand(st, C, 'ping -c 3 -i 0.03 10.0.0.20'); run(st, 25);
    expect(out(A)).toMatch(/[23] received/); expect(out(C)).toMatch(/[23] received/);
  });
});
