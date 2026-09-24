import { describe, it, expect } from 'vitest';
import { createState, addHost, addSwitch, connect, setIfaceIp, setDefaultGateway, addStaticRoute, addSniffer, advance } from '@/engine/engine';
import { runCommand } from '@/engine/terminal';
import { ipToU32, u32ToIp, prefixToMask } from '@/shared/bytes';
import { decodeFrame, fieldValue } from '@/engine/codecs/decode';
import { SEC } from '@/engine/core';
import type { EngineState, HostState } from '@/engine/types';
const ip = ipToU32; const m24 = prefixToMask(24);
const out = (h: HostState) => h.terminal.join('\n');
const run = (st: EngineState, s: number) => advance(st, st.time + s * SEC, 5e6);
const frames = (st: EngineState, sid: number) => st.sniffers[sid]!.frames.map(f => Object.assign(decodeFrame(f.bytes), { dir: f.dir }));

// inside host A(192.168.1.10) -- NATrouter -- outside server S(203.0.113.9)
function nat() {
  const st = createState(1); const a = addHost(st, 'laptop', 0, 0, 'A'); const R = addHost(st, 'router', 0, 0, 'NAT'); const s = addHost(st, 'server', 0, 0, 'S');
  const lIn = connect(st, a.id, 0, R.id, 0, { delayUs: 1000 })!; const lOut = connect(st, R.id, 1, s.id, 0, { delayUs: 1000 })!;
  setIfaceIp(st, a, 'eth0', ip('192.168.1.10'), m24); setDefaultGateway(a, ip('192.168.1.1'));
  setIfaceIp(st, R, 'eth0', ip('192.168.1.1'), m24); setIfaceIp(st, R, 'eth1', ip('203.0.113.1'), m24);
  setIfaceIp(st, s, 'eth0', ip('203.0.113.9'), m24); setDefaultGateway(s, ip('203.0.113.1'));
  R.nat = { enabled: true, outsideIface: 'eth1', insideIfaces: ['eth0'], table: [], portForwards: [], nextPort: 40000 };
  return { st, a, R, s, lIn, lOut };
}

describe('NAT / PAT', () => {
  it('translates an inside TCP connection; the server sees the outside address', () => {
    const { st, a, R, s, lOut } = nat(); const sn = addSniffer(st, lOut)!;
    runCommand(st, s, 'iperf -s'); runCommand(st, a, 'iperf -c 203.0.113.9 -n 40000'); run(st, 15);
    expect(out(a)).toMatch(/0\.0-/); // transfer completed through NAT
    // on the outside link, the source is the router's outside IP, not 192.168.1.10
    const fromInside = frames(st, sn).filter(f => f.dir === 'ab' && f.proto === 'TCP');
    expect(fromInside.length).toBeGreaterThan(0);
    expect(fromInside.every(f => fieldValue(f, 'ipv4.src') === '203.0.113.1')).toBe(true);
    expect(fromInside.some(f => fieldValue(f, 'ipv4.src') === '192.168.1.10')).toBe(false);
    expect(R.nat.table.length).toBeGreaterThan(0); expect(R.nat.table[0]!.insideIp).toBe(ip('192.168.1.10'));
  });
  it('ping from inside is translated (ICMP id) and replies return to the inside host', () => {
    const { st, a } = nat(); runCommand(st, a, 'ping -c 2 203.0.113.9'); run(st, 10);
    expect(out(a)).toContain('2 packets transmitted, 2 received');
  });
  it('port forward exposes an inside server to the outside', () => {
    const { st, a, R, s } = nat();
    R.nat.portForwards.push({ proto: 6, outsidePort: 8080, insideIp: ip('192.168.1.10'), insidePort: 7000 });
    runCommand(st, a, 'nc -l 7000'); runCommand(st, s, 'nc 203.0.113.1 8080 hello-from-outside'); run(st, 10);
    expect(out(a)).toContain('hello-from-outside');
  });
});
