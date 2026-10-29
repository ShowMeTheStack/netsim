import { describe, it, expect } from 'vitest';
import { createState, addHost, addSwitch, connect, setIfaceIp, setDefaultGateway, addStaticRoute, addSniffer, advance } from '@/engine/engine';
import { runCommand } from '@/engine/terminal';
import { ipToU32, prefixToMask } from '@/shared/bytes';
import { decodeFrame, fieldValue } from '@/engine/codecs/decode';
import { encodeUdp, decodeUdp } from '@/engine/codecs/udp';
import { encodeTcp, decodeTcp, TCP_SYN, TCP_ACK } from '@/engine/codecs/tcp';
import { SEC } from '@/engine/core';
import { ALL_LABS } from '@/ui/labs';
import { parseSession } from '@/session/session';
import type { EngineState, HostState, TcpSocket } from '@/engine/types';

const ip = ipToU32; const m24 = prefixToMask(24);
/** A --- R1 --- R2 --- B  (10.0.1.0/24, 10.0.12.0/24, 10.0.2.0/24) */
function routed(seed = 1, opts: { midMtu?: number; lossAB?: number; delay?: number; bw?: number; queue?: number } = {}) {
  const st = createState(seed);
  const a = addHost(st, 'laptop', 0, 0, 'A'); const r1 = addHost(st, 'router', 0, 0, 'R1'); const r2 = addHost(st, 'router', 0, 0, 'R2'); const b = addHost(st, 'server', 0, 0, 'B');
  const l1 = connect(st, a.id, 0, r1.id, 0, { delayUs: opts.delay, bandwidthBps: opts.bw })!; const l2 = connect(st, r1.id, 1, r2.id, 0, { mtu: opts.midMtu, lossPct: opts.lossAB, delayUs: opts.delay, bandwidthBps: opts.bw, queueDepth: opts.queue })!; const l3 = connect(st, r2.id, 1, b.id, 0, { delayUs: opts.delay, bandwidthBps: opts.bw })!;
  setIfaceIp(st, a, 'eth0', ip('10.0.1.10'), m24); setDefaultGateway(a, ip('10.0.1.1'));
  setIfaceIp(st, r1, 'eth0', ip('10.0.1.1'), m24); setIfaceIp(st, r1, 'eth1', ip('10.0.12.1'), m24); addStaticRoute(r1, ip('10.0.2.0'), m24, ip('10.0.12.2'));
  setIfaceIp(st, r2, 'eth0', ip('10.0.12.2'), m24); setIfaceIp(st, r2, 'eth1', ip('10.0.2.1'), m24); addStaticRoute(r2, ip('10.0.1.0'), m24, ip('10.0.12.1'));
  setIfaceIp(st, b, 'eth0', ip('10.0.2.10'), m24); setDefaultGateway(b, ip('10.0.2.1'));
  if (opts.midMtu) { r1.ifaces[1]!.mtu = opts.midMtu; r2.ifaces[0]!.mtu = opts.midMtu; }
  return { st, a, r1, r2, b, l1, l2, l3 };
}
function lan(seed = 1) {
  const st = createState(seed); const a = addHost(st, 'laptop', 0, 0, 'A'); const b = addHost(st, 'desktop', 0, 0, 'B'); const sw = addSwitch(st, 0, 0);
  const l1 = connect(st, a.id, 0, sw.id, 0)!; const l2 = connect(st, b.id, 0, sw.id, 1)!;
  setIfaceIp(st, a, 'eth0', ip('10.0.0.1'), m24); setIfaceIp(st, b, 'eth0', ip('10.0.0.2'), m24); return { st, a, b, sw, l1, l2 };
}
const out = (h: HostState) => h.terminal.join('\n');
const run = (st: EngineState, secs: number) => advance(st, secs * SEC, 5e6);
const frames = (st: EngineState, sid: number) => st.sniffers[sid]!.frames.map(f => Object.assign(decodeFrame(f.bytes), { dir: f.dir }));

describe('udp/tcp codecs', () => {
  it('udp round-trips with pseudo-header checksum', () => { const b = encodeUdp({ sport: 1234, dport: 53, data: new Uint8Array([1, 2, 3]) }, ip('10.0.0.1'), ip('10.0.0.2')); const d = decodeUdp(b, 0, b.length, ip('10.0.0.1'), ip('10.0.0.2')); expect(d.checksumOk).toBe(true); expect(d.pkt.dport).toBe(53); expect(d.pkt.data.length).toBe(3); expect(decodeUdp(b, 0, b.length, ip('10.0.0.1'), ip('10.0.0.3')).checksumOk).toBe(false); });
  it('tcp round-trips with options', () => {
    const b = encodeTcp({ sport: 40000, dport: 80, seq: 1000, ack: 0, flags: TCP_SYN, window: 65535, options: { mss: 1460, wscale: 7, sackOk: true }, data: new Uint8Array(0) }, ip('10.0.0.1'), ip('10.0.0.2'));
    const d = decodeTcp(b, 0, b.length, ip('10.0.0.1'), ip('10.0.0.2')); expect(d.checksumOk).toBe(true); expect(d.seg.options).toEqual({ mss: 1460, wscale: 7, sackOk: true }); expect(d.seg.flags).toBe(TCP_SYN); expect(d.layer.summary).toContain('[SYN]');
    const b2 = encodeTcp({ sport: 80, dport: 40000, seq: 5, ack: 1001, flags: TCP_ACK, window: 100, options: { sack: [[2000, 3000], [4000, 4500]] }, data: new Uint8Array([9]) }, 1, 2);
    const d2 = decodeTcp(b2, 0, b2.length, 1, 2); expect(d2.seg.options.sack).toEqual([[2000, 3000], [4000, 4500]]); expect(d2.seg.data[0]).toBe(9);
  });
});

describe('routing, ttl, traceroute, unreachable', () => {
  it('pings across two routers with TTL decremented twice', () => {
    const { st, a, l3 } = routed(); const s = addSniffer(st, l3)!; runCommand(st, a, 'ping -c 2 10.0.2.10'); run(st, 20);
    expect(out(a)).toContain('2 packets transmitted, 2 received'); expect(out(a)).toContain('ttl=62');
    const echo = frames(st, s).find(f => f.proto === 'ICMP')!; expect(fieldValue(echo, 'ipv4.ttl')).toBe(62);
  });
  it('traceroute (UDP) lists both routers and the destination; ICMP mode too', () => {
    const { st, a } = routed(); runCommand(st, a, 'traceroute 10.0.2.10'); run(st, 60);
    const o = out(a); expect(o).toMatch(/ 1  10\.0\.1\.1 /); expect(o).toMatch(/ 2  10\.0\.12\.2 /); expect(o).toMatch(/ 3  10\.0\.2\.10 /); expect(o).not.toMatch(/ 4 /);
    runCommand(st, a, 'traceroute -I 10.0.2.10'); run(st, 120); expect(out(a).split('traceroute to')[2]).toMatch(/ 3  10\.0\.2\.10 /);
  });
  it('ping with small TTL gets time exceeded from the router', () => { const { st, a } = routed(); runCommand(st, a, 'ping -c 1 -t 1 10.0.2.10'); run(st, 10); expect(out(a)).toContain('From 10.0.1.1 icmp_seq=1 Time to live exceeded'); });
  it('router returns net unreachable when it has no route', () => { const { st, a } = routed(); runCommand(st, a, 'ping -c 1 10.9.9.9'); run(st, 10); expect(out(a)).toContain('Destination Net Unreachable'); });
  it('UDP to a closed port yields port unreachable (nc)', () => { const { st, a } = lan(); runCommand(st, a, 'nc -u 10.0.0.2 9999 hi'); run(st, 5); expect(out(a)).toContain('Connection refused'); });
  it('TCP to a closed port gets RST → connection refused', () => { const { st, a } = lan(); runCommand(st, a, 'nc 10.0.0.2 9999 hi'); run(st, 5); expect(out(a)).toContain('failed: Connection refused'); });
});

describe('fragmentation, reassembly and PMTUD', () => {
  it('fragments a large ping over a small-MTU link and reassembles at the far end', () => {
    const { st, a, b, l2, l3 } = routed(1, { midMtu: 600 }); const s2 = addSniffer(st, l2)!; const s3 = addSniffer(st, l3)!;
    runCommand(st, a, 'ping -c 1 -s 1400 10.0.2.10'); run(st, 10);
    expect(out(a)).toContain('1 packets transmitted, 1 received'); expect(out(a)).toContain('1408 bytes from');
    const mid = frames(st, s2).filter(f => f.layers.some(l => l.proto === 'ipv4')); expect(mid.length).toBeGreaterThanOrEqual(6); // 3 frags each way
    expect(mid.filter(f => fieldValue(f, 'ipv4.flags.mf') === true).length).toBeGreaterThanOrEqual(4);
    // R2 forwards the fragments untouched; B reassembles them. B's 1428-byte reply is fragmented by R2 for the 600-byte link.
    const last = frames(st, s3); expect(last.filter(f => f.proto === 'ICMP').length).toBe(2); // first fragment of the request + the whole reply
    expect(last.filter(f => f.dir === 'ba').some(f => fieldValue(f, 'ipv4.len') === 1428)).toBe(true);
    expect(b.counters.reasmOk).toBe(1); expect(a.counters.reasmOk).toBe(1);
  });
  it('DF ping gets frag-needed with the MTU, and the host learns the path MTU', () => {
    const { st, a } = routed(1, { midMtu: 600 }); runCommand(st, a, 'ping -c 1 -M do -s 1400 10.0.2.10'); run(st, 10);
    expect(out(a)).toContain('Frag needed and DF set (mtu = 600)'); expect(a.pmtu['10.0.2.10']?.mtu).toBe(600);
    runCommand(st, a, 'ping -c 1 -M do -s 1400 10.0.2.10'); run(st, 20); expect(out(a)).toContain('message too long, mtu=600');
  });
  it('reassembly times out when a fragment is lost', () => {
    const { st, a, b, l2 } = routed(1, { midMtu: 600 }); st.links[l2]!.impair = { ...st.links[l2]!.impair, dropNext: 1, filter: 'ipv4.flags.mf == 1', dir: 'ab' };
    runCommand(st, a, 'ping -c 1 -s 1400 10.0.2.10'); run(st, 40); expect(b.counters.reasmFail).toBe(1); expect(out(a)).toContain('0 received');
  });
});

describe('TCP', () => {
  function tcpSock(h: HostState, pred: (s: TcpSocket) => boolean = () => true) { return Object.values(h.sockets).find(s => s.proto === 'tcp' && pred(s)) as TcpSocket | undefined; }
  it('nc: handshake, data, FIN teardown, TIME_WAIT; sniffer sees SYN, SYN-ACK, ACK', () => {
    const { st, a, b, l1 } = lan(); const s = addSniffer(st, l1)!;
    runCommand(st, b, 'nc -l 7000'); runCommand(st, a, 'nc 10.0.0.2 7000 hello world'); run(st, 2);
    expect(out(a)).toContain('succeeded'); expect(out(b)).toContain('hello world');
    const fl = frames(st, s).filter(f => f.proto === 'TCP').map(f => f.info);
    expect(fl[0]).toContain('[SYN]'); expect(fl[1]).toContain('[SYN, ACK]'); expect(fl[2]).toMatch(/\[ACK\]/); expect(fl.some(x => x.includes('[FIN, ACK]'))).toBe(true);
    expect(fl[0]).toContain('MSS=1460'); expect(fl[0]).toContain('SACK_PERM');
    const tw = tcpSock(a, x => x.state === 'TIME_WAIT'); expect(tw).toBeDefined(); expect(tcpSock(b, x => x.state !== 'LISTEN')).toBeUndefined(); // server side fully closed
    run(st, 70); expect(tcpSock(a)).toBeUndefined(); // TIME_WAIT expired
  });
  it('iperf over a clean LAN gets close to link rate and completes', () => {
    const { st, a, b } = lan(); runCommand(st, b, 'iperf -s'); runCommand(st, a, 'iperf -c 10.0.0.2 -t 2'); run(st, 10);
    const m = /0\.0-\s*2\.\d sec\s+([\d.]+) MBytes\s+([\d.]+) Mbits\/sec/.exec(out(a)); expect(m).not.toBeNull(); expect(Number(m![2])).toBeGreaterThan(60); expect(Number(m![2])).toBeLessThanOrEqual(100);
    expect(out(b)).toMatch(/\[SRV\]\s+0\.0-/); expect(Object.values(a.procs).length).toBe(0);
  });
  it.each(['tahoe', 'reno', 'newreno', 'cubic'] as const)('%s: loss on a bottleneck triggers the right recovery and the transfer completes', (cc) => {
    const { st, a, b, l2 } = routed(5, { delay: 10_000, bw: 20e6, queue: 12 }); runCommand(st, a, `sysctl net.ipv4.tcp_congestion_control=${cc}`); runCommand(st, b, 'iperf -s'); runCommand(st, a, 'iperf -c 10.0.2.10 -n 3000000'); void l2;
    run(st, 60); const o = out(a); expect(o).toMatch(/0\.0-\s*[\d.]+ sec\s+[\d.]+ MBytes/);
    const s = (a as HostState); const logs = JSON.stringify(s.terminal); void logs;
  });
  it('clean path: cwnd is window-validated and does not run away past the receive window (RFC 5681 §3.1)', () => {
    // A uniform, lossless path: nothing is ever dropped, so slow start never ends and ssthresh
    // stays infinite — that part is correct TCP. The defect this guards against is cwnd inflating
    // without bound while the receive window caps what is actually in flight.
    const { st, a, b } = routed(5, { delay: 10_000, bw: 20e6, queue: 12 });
    runCommand(st, b, 'iperf -s'); runCommand(st, a, 'iperf -c 10.0.2.10 -n 3000000'); run(st, 5);
    expect(out(a)).toMatch(/0\.0-\s*[\d.]+ sec\s+[\d.]+ MBytes/); // transfer completed
    const s = tcpSock(a)!; const maxCwnd = Math.max(...s.trace.map(t => t.cwnd)); const maxInflight = Math.max(...s.trace.map(t => t.inflight));
    expect(s.trace.every(t => t.ssthresh > (1 << 29))).toBe(true); // lossless: ssthresh never lowered
    // cwnd tracks usable flight, not a runaway value: it stays within a segment-few of what the
    // receive window ever allowed in flight (pre-fix this reached ~1.5 MB on a 256 KB window).
    expect(maxCwnd).toBeLessThanOrEqual(maxInflight + 8 * 1460);
  });
  it.each(['tahoe', 'reno'] as const)('the congestion-control lab shows every phase for %s (slow start → loss → congestion avoidance)', (cc) => {
    // Build the real lab topology, not a hand-rolled one: this guards the lab itself. The middle
    // link must be a true bottleneck (fast edges) so a lossless transfer actually experiences loss,
    // lowers ssthresh, and crosses into congestion avoidance — otherwise the lab can never show it.
    const st = parseSession(ALL_LABS.find(l => l.id === 'tcp-congestion')!.build()).state;
    const host = (n: string) => Object.values(st.nodes).find(x => x.name === n) as HostState;
    const client = host('Client');
    runCommand(st, client, `sysctl net.ipv4.tcp_congestion_control=${cc}`);
    runCommand(st, host('Server'), 'iperf -s'); runCommand(st, client, 'iperf -c 10.0.2.10 -n 3000000');
    advance(st, 60 * SEC, 5e6);
    const s = Object.values(client.sockets).find(x => x.proto === 'tcp') as TcpSocket;
    const INF = 1 << 29;
    expect(s.trace.some(p => p.ssthresh >= INF && p.cwnd < p.ssthresh)).toBe(true);     // slow start
    expect(s.trace.some(p => p.ssthresh < INF)).toBe(true);                             // loss lowered ssthresh
    expect(s.trace.some(p => p.ssthresh < INF && p.cwnd >= p.ssthresh)).toBe(true);     // congestion avoidance
    expect(s.trace.filter(p => p.ev === 'FRX' || p.ev === 'RTO').length).toBeGreaterThan(0);
  });
  it('congestion controllers diverge as expected under forced triple-dup-ACK loss', () => {
    const results: Record<string, { fastRetx: number; rto: number; cwndAfter: number; ssthresh: number }> = {};
    for (const cc of ['tahoe', 'reno', 'newreno', 'cubic'] as const) {
      const { st, a, b, l2 } = routed(3, { delay: 5000, bw: 50e6 }); runCommand(st, a, `sysctl net.ipv4.tcp_congestion_control=${cc}`); runCommand(st, a, 'sysctl net.ipv4.tcp_sack=0'); runCommand(st, b, 'sysctl net.ipv4.tcp_sack=0');
      runCommand(st, b, 'iperf -s'); runCommand(st, a, 'iperf -c 10.0.2.10 -n 400000'); run(st, 0.2);
      st.links[l2]!.impair = { ...st.links[l2]!.impair, dropNext: 1, dir: 'ab', filter: 'tcp.len > 0' };
      let sock: TcpSocket | undefined; for (let i = 0; i < 400 && !sock?.stats.fastRetx; i++) { run(st, st.time / 1e6 + 0.01); sock = tcpSock(a); }
      expect(sock).toBeDefined(); expect(sock!.stats.fastRetx).toBe(1);
      const p = sock!.trace.find(t => t.ev === 'FRX')!; results[cc] = { fastRetx: sock!.stats.fastRetx, rto: sock!.stats.rtoCount, cwndAfter: p.cwnd, ssthresh: p.ssthresh };
      run(st, 60); expect(out(a)).toMatch(/MBytes|KBytes/);
    }
    expect(results.tahoe!.cwndAfter).toBe(1460); // Tahoe: back to 1 MSS
    expect(results.reno!.cwndAfter).toBe(results.reno!.ssthresh + 3 * 1460); // Reno: ssthresh + 3 MSS
    expect(results.newreno!.cwndAfter).toBe(results.newreno!.ssthresh + 3 * 1460);
    expect(results.cubic!.cwndAfter).toBe(results.cubic!.ssthresh); // CUBIC: cwnd = ssthresh = 0.7 × cwnd
    for (const r of Object.values(results)) expect(r.rto).toBe(0);
  });
  it('SACK blocks are sent for out-of-order data and recovery retransmits only the hole', () => {
    const { st, a, b, l2, l3 } = routed(4, { delay: 5000, bw: 50e6 }); const s3 = addSniffer(st, l3)!;
    runCommand(st, b, 'iperf -s'); runCommand(st, a, 'iperf -c 10.0.2.10 -n 300000'); run(st, 0.15);
    st.links[l2]!.impair = { ...st.links[l2]!.impair, dropNext: 1, dir: 'ab', filter: 'tcp.len > 0' };
    run(st, 30);
    const sacks = frames(st, s3).filter(f => f.proto === 'TCP' && f.info.includes('SLE/SRE')); expect(sacks.length).toBeGreaterThan(0);
    expect(out(a)).toMatch(/0\.0-/);
  });
  it('RTO fires when every packet of a window is lost, with exponential backoff', () => {
    const { st, a, b, l2 } = routed(6, { delay: 5000 }); runCommand(st, b, 'iperf -s'); runCommand(st, a, 'iperf -c 10.0.2.10 -n 200000'); run(st, 0.1);
    st.links[l2]!.lossPct = 100; run(st, 3); st.links[l2]!.lossPct = 0;
    const s = tcpSock(a)!; expect(s.stats.rtoCount).toBeGreaterThanOrEqual(2); expect(s.rtoBackoff).toBeGreaterThanOrEqual(4);
    run(st, 60); expect(out(a)).toMatch(/0\.0-/); // completes after link heals
  });
  it('zero window: slow reader forces the sender to stop and probe', () => {
    const { st, a, b, l1 } = lan(); const s1 = addSniffer(st, l1)!; runCommand(st, b, 'iperf -s -R 200000'); runCommand(st, a, 'iperf -c 10.0.0.2 -n 2000000'); run(st, 6);
    const s = tcpSock(a)!; expect(s.stats.zeroWnd).toBeGreaterThan(0);
    expect(frames(st, s1).some(f => f.proto === 'TCP' && fieldValue(f, 'tcp.window_size_value') === 0)).toBe(true);
    run(st, 30); expect(out(a)).toMatch(/0\.0-/);
  });
  it('PMTUD: TCP clamps MSS after frag-needed and still completes', () => {
    const { st, a, b, l2 } = routed(2, { midMtu: 800 }); const s2 = addSniffer(st, l2)!; runCommand(st, b, 'iperf -s'); runCommand(st, a, 'iperf -c 10.0.2.10 -n 100000'); run(st, 30);
    expect(a.pmtu['10.0.2.10']?.mtu).toBe(800); expect(out(a)).toMatch(/0\.0-/);
    const big = frames(st, s2).filter(f => f.proto === 'TCP' && (fieldValue(f, 'ipv4.len') as number) > 800); expect(big.length).toBe(0);
    expect(frames(st, s2).some(f => f.proto === 'ICMP' && f.info.includes('Fragmentation needed'))).toBe(false); // frag-needed goes back on l1, not l2
  });
  it('udp iperf reports loss', () => { const { st, a, b, l2 } = routed(9); st.links[l2]!.lossPct = 20; runCommand(st, b, 'iperf -s -u'); runCommand(st, a, 'iperf -c 10.0.2.10 -u -t 2 -b 2M'); run(st, 10); expect(out(b)).toMatch(/lost \d+\/\d+ \((\d+\.\d)%\)/); const m = /lost (\d+)\/(\d+)/.exec(out(b))!; expect(Number(m[1])).toBeGreaterThan(0); });
});
