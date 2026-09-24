import { describe, it, expect } from 'vitest';
import { createState, addHost, addSwitch, connect, setIfaceIp, addSniffer, advance, stepEvent, stepPacket, snapshot, restore, addBreakpoint, flights } from '@/engine/engine';
import { runCommand } from '@/engine/terminal';
import { ipToU32, prefixToMask } from '@/shared/bytes';
import { decodeFrame } from '@/engine/codecs/decode';
import { SEC } from '@/engine/core';
import type { EngineState, HostState } from '@/engine/types';

function lan(seed = 1) {
  const st = createState(seed);
  const a = addHost(st, 'laptop', 100, 100, 'A'); const b = addHost(st, 'desktop', 300, 100, 'B'); const sw = addSwitch(st, 200, 200);
  const l1 = connect(st, a.id, 0, sw.id, 0)!; const l2 = connect(st, b.id, 0, sw.id, 1)!;
  setIfaceIp(st, a, 'eth0', ipToU32('10.0.0.1'), prefixToMask(24)); setIfaceIp(st, b, 'eth0', ipToU32('10.0.0.2'), prefixToMask(24));
  return { st, a, b, sw, l1, l2 };
}
const protos = (st: EngineState, sid: number) => st.sniffers[sid]!.frames.map(f => decodeFrame(f.bytes).proto);

describe('ping across a switch', () => {
  it('resolves ARP, gets 4 replies, switch learns both MACs', () => {
    const { st, a, b, sw, l1, l2 } = lan(); const s1 = addSniffer(st, l1)!; const s2 = addSniffer(st, l2)!;
    runCommand(st, a, 'ping 10.0.0.2');
    const r = advance(st, 20 * SEC, 1e6); expect(r.idle).toBe(true);
    const out = a.terminal.join('\n');
    expect(out).toContain('4 packets transmitted, 4 received, 0% packet loss');
    expect(out).toMatch(/icmp_seq=1 ttl=64 time=\d+\.\d+ ms/);
    expect(protos(st, s1).slice(0, 4)).toEqual(['ARP', 'ARP', 'ICMP', 'ICMP']);
    expect(protos(st, s2).slice(0, 2)).toEqual(['ARP', 'ARP']); // request flooded, reply back
    expect(Object.keys(sw.macTable).map(k => k.replace(/^\d+:/, '')).sort()).toEqual([a.ifaces[0]!.mac, b.ifaces[0]!.mac].sort());
    expect(sw.counters.flooded).toBeGreaterThan(0); expect(sw.counters.forwarded).toBeGreaterThan(0);
    expect(a.arp['10.0.0.2']!.mac).toBe(b.ifaces[0]!.mac); expect(b.arp['10.0.0.1']!.mac).toBe(a.ifaces[0]!.mac);
    // First RTT includes ARP resolution (~4ms) + echo (~4ms); later ones are just the echo.
    const rtts = [...out.matchAll(/time=(\d+\.\d+) ms/g)].map(m => Number(m[1]));
    expect(rtts[0]).toBeGreaterThan(8); expect(rtts[0]).toBeLessThan(9);
    expect(rtts[1]).toBeGreaterThan(4); expect(rtts[1]).toBeLessThan(5);
  });
  it('times out when the destination does not exist', () => {
    const { st, a } = lan(); runCommand(st, a, 'ping -c 2 10.0.0.9'); advance(st, 30 * SEC, 1e6);
    const out = a.terminal.join('\n'); expect(out).toContain('Destination Host Unreachable'); expect(out).toContain('2 packets transmitted, 0 received, +2 errors, 100% packet loss');
  });
  it('reports network unreachable without a route', () => {
    const { st, a } = lan(); runCommand(st, a, 'ping 192.168.5.5'); expect(a.terminal.join('\n')).toContain('Network is unreachable');
  });
  it('random loss produces lost packets and annotates the capture', () => {
    const { st, a, l1 } = lan(7); st.links[l1]!.lossPct = 100; const s = addSniffer(st, l1)!;
    runCommand(st, a, 'ping -c 2 10.0.0.2'); advance(st, 30 * SEC, 1e6);
    expect(a.terminal.join('\n')).toContain('100% packet loss');
    expect(st.sniffers[s]!.frames.some(f => f.drop === 'lost on wire')).toBe(true);
  });
});

describe('determinism and snapshots', () => {
  it('same seed => identical capture logs', () => {
    const run = () => { const { st, a, l1 } = lan(42); st.links[l1]!.lossPct = 30; st.links[l1]!.jitterUs = 500; const s = addSniffer(st, l1)!; runCommand(st, a, 'ping -c 5 10.0.0.2'); advance(st, 30 * SEC, 1e6); return st.sniffers[s]!.frames.map(f => `${f.t}:${f.dir}:${f.drop ?? ''}:${Array.from(f.bytes).join(',')}`); };
    expect(run()).toEqual(run());
  });
  it('restore(snapshot(x)) deep-equals x and continues identically', () => {
    const { st, a, l1 } = lan(3); addSniffer(st, l1); runCommand(st, a, 'ping -c 3 10.0.0.2'); advance(st, 1.5 * SEC, 1e6);
    const snap = snapshot(st); expect(restore(snap)).toEqual(st);
    const cont = restore(snap); advance(st, 20 * SEC, 1e6); advance(cont, 20 * SEC, 1e6);
    expect((cont.nodes[a.id] as HostState).terminal).toEqual(a.terminal); expect(cont.time).toBe(st.time); expect(cont.seq).toBe(st.seq);
    expect(JSON.stringify(cont.sniffers, (k, v) => v instanceof Uint8Array ? Array.from(v) : v)).toBe(JSON.stringify(st.sniffers, (k, v) => v instanceof Uint8Array ? Array.from(v) : v));
  });
});

describe('stepping and breakpoints', () => {
  it('stepEvent advances exactly one event; stepPacket stops at a milestone', () => {
    const { st, a } = lan(); runCommand(st, a, 'ping -c 1 10.0.0.2');
    const before = st.events.length; const r = stepEvent(st); expect(r.events).toBe(1); expect(st.events.length).toBeLessThanOrEqual(before + 2);
    const r2 = stepPacket(st); expect(r2.stoppedOnPacket).toBe(true); expect(st.recentMilestones.length).toBeGreaterThan(0);
  });
  it('breaks on an ARP reply and records the hit', () => {
    const { st, a } = lan(); addBreakpoint(st, 'arp.opcode == 2', ['tx']); runCommand(st, a, 'ping -c 1 10.0.0.2');
    const r = advance(st, 20 * SEC, 1e6); expect(r.hit).not.toBeNull(); expect(decodeFrame(r.hit!.bytes).info).toContain('is at');
    expect(a.terminal.join('\n')).not.toContain('1 received'); // no replies yet
    st.breakpoints[0]!.enabled = false; const r2 = advance(st, 20 * SEC, 1e6); expect(r2.idle).toBe(true); expect(a.terminal.join('\n')).toContain('1 received');
  });
  it('flights are derived from pending deliveries', () => {
    const { st, a } = lan(); runCommand(st, a, 'ping -c 1 10.0.0.2'); stepEvent(st); stepEvent(st);
    const f = flights(st); expect(f.length).toBe(1); expect(f[0]!.proto).toBe('ARP'); expect(f[0]!.end).toBeGreaterThan(f[0]!.start);
  });
});

describe('terminal', () => {
  it('ip/route/arp commands work', () => {
    const { st, a } = lan(); runCommand(st, a, 'ip addr'); expect(a.terminal.join('\n')).toContain('inet 10.0.0.1/24');
    runCommand(st, a, 'ip route add default via 10.0.0.254'); runCommand(st, a, 'route -n'); expect(a.terminal.join('\n')).toContain('10.0.0.254');
    runCommand(st, a, 'ip route add default via 1.2.3.4'); expect(a.terminal.join('\n')).toContain('invalid gateway');
    runCommand(st, a, 'arp -s 10.0.0.7 aa:bb:cc:dd:ee:ff'); runCommand(st, a, 'arp -a'); expect(a.terminal.join('\n')).toContain('aa:bb:cc:dd:ee:ff');
    runCommand(st, a, 'bogus'); expect(a.terminal.join('\n')).toContain('command not found');
  });
});
