import { describe, it, expect } from 'vitest';
import { createState, addHost, connect, setIfaceIp, addSniffer, advance } from '@/engine/engine';
import { runCommand } from '@/engine/terminal';
import { applyCmd } from '@/engine/commands';
import { CapsuleRecorder, replayCapsule, hashState } from '@/session/capsule';
import { jainFairness, throughputBps, flowRates, flowKeyOf, lossFromFrames } from '@/engine/metrics';
import { framesToPcap, framesToLabels } from '@/engine/export/pcap';
import { trace, summarizeCmd } from '@/ui/trace';
import { ipToU32, prefixToMask } from '@/shared/bytes';
import { SEC } from '@/engine/core';
import type { CapturedFrame, EngineState, HostState } from '@/engine/types';

const m24 = prefixToMask(24);

// Build a tiny two-host LAN the same way twice: once with direct engine calls, once via applyCmd.
function directLan(seed = 7): EngineState {
  const st = createState(seed);
  const a = addHost(st, 'laptop', 0, 0, 'A'); const b = addHost(st, 'laptop', 0, 0, 'B');
  connect(st, a.id, 0, b.id, 0);
  setIfaceIp(st, a, 'eth0', ipToU32('10.0.0.1'), m24);
  setIfaceIp(st, b, 'eth0', ipToU32('10.0.0.2'), m24);
  const sid = addSniffer(st, Object.values(st.links)[0]!.id)!;
  runCommand(st, a, 'ping -c 3 10.0.0.2');
  advance(st, 5 * SEC, 5_000_000);
  return st; void sid;
}
function cmdLan(seed = 7): EngineState {
  let st = createState(seed);
  const route = (c: Parameters<typeof applyCmd>[1]) => { const r = applyCmd(st, c); if (r.newState) st = r.newState; return r; };
  route({ type: 'addNode', nodeType: 'host', kind: 'laptop', x: 0, y: 0, name: 'A' });
  route({ type: 'addNode', nodeType: 'host', kind: 'laptop', x: 0, y: 0, name: 'B' });
  route({ type: 'connect', a: 1, aIface: 0, b: 2, bIface: 0 });
  route({ type: 'setIface', node: 1, iface: 'eth0', ip: '10.0.0.1', prefix: 24 });
  route({ type: 'setIface', node: 2, iface: 'eth0', ip: '10.0.0.2', prefix: 24 });
  route({ type: 'addSniffer', link: 1 });
  route({ type: 'runCmd', node: 1, line: 'ping -c 3 10.0.0.2' });
  advance(st, 5 * SEC, 5_000_000);
  return st;
}

describe('E1 capsule: determinism and reproducibility', () => {
  it('applyCmd reproduces the same state as direct engine calls (hash equal)', async () => {
    const h1 = await hashState(directLan());
    const h2 = await hashState(cmdLan());
    expect(h2).toBe(h1);
  });

  it('a recorded capsule replays to a byte-identical final state', async () => {
    const rec = CapsuleRecorder.fromSeed(7);
    rec.cmd({ type: 'addNode', nodeType: 'host', kind: 'laptop', x: 0, y: 0, name: 'A' });
    rec.cmd({ type: 'addNode', nodeType: 'host', kind: 'laptop', x: 0, y: 0, name: 'B' });
    rec.cmd({ type: 'connect', a: 1, aIface: 0, b: 2, bIface: 0 });
    rec.cmd({ type: 'setIface', node: 1, iface: 'eth0', ip: '10.0.0.1', prefix: 24 });
    rec.cmd({ type: 'setIface', node: 2, iface: 'eth0', ip: '10.0.0.2', prefix: 24 });
    rec.cmd({ type: 'addSniffer', link: 1 });
    rec.cmd({ type: 'runCmd', node: 1, line: 'ping -c 3 10.0.0.2' });
    rec.advance(5 * SEC);
    const cap = await rec.capsule();
    const r1 = await replayCapsule(cap);
    const r2 = await replayCapsule(cap);
    expect(r1.ok).toBe(true);
    expect(r1.gotHash).toBe(cap.finalHash);
    expect(r2.gotHash).toBe(r1.gotHash);   // replay is itself deterministic
  });

  it('a different seed produces a different final hash', async () => {
    const a = await hashState(directLan(7));
    const b = await hashState(directLan(8));
    expect(a).not.toBe(b);
  });
});

describe('E5 metrics', () => {
  it('Jain fairness index: perfectly fair is 1, fully unfair tends to 1/n', () => {
    expect(jainFairness([10, 10, 10, 10])).toBeCloseTo(1, 10);
    expect(jainFairness([40, 0, 0, 0])).toBeCloseTo(1, 10);      // one flow: only positive counted
    expect(jainFairness([10, 10, 10, 0])).toBeCloseTo(1, 10);
    expect(jainFairness([30, 10])).toBeCloseTo((40 * 40) / (2 * (900 + 100)), 10);
    expect(jainFairness([])).toBe(0);
  });

  it('throughput and loss over a synthetic capture', () => {
    const frames: CapturedFrame[] = [
      { n: 1, t: 0, dir: 'ab', bytes: new Uint8Array(100), from: 1, to: 2, frameId: 1 },
      { n: 2, t: 1_000_000, dir: 'ab', bytes: new Uint8Array(100), from: 1, to: 2, frameId: 2 },
      { n: 3, t: 1_000_000, dir: 'ab', bytes: new Uint8Array(50), from: 1, to: 2, frameId: 3, drop: 'queue full' },
    ];
    // 200 non-dropped bytes over 1s = 1600 bps
    expect(throughputBps(frames)).toBeCloseTo(1600, 6);
    expect(lossFromFrames(frames)).toBeCloseTo(1 / 3, 10);
  });

  it('flowRates groups real ping traffic into IP flows', () => {
    const st = directLan();
    const sn = Object.values(st.sniffers)[0]!;
    const rates = flowRates(sn.frames);
    // ICMP echo + reply between 10.0.0.1 and 10.0.0.2 should appear as flows
    expect(rates.length).toBeGreaterThan(0);
    const keys = rates.map(r => r.key).join(' | ');
    expect(keys).toContain('10.0.0.1');
    expect(keys).toContain('10.0.0.2');
    // every captured, non-dropped IP frame maps to a flow key
    const ipFrames = sn.frames.filter(f => !f.drop && flowKeyOf(f.bytes));
    expect(ipFrames.length).toBeGreaterThan(0);
  });
});

// minimal libpcap reader to validate what framesToPcap writes
function parsePcap(buf: Uint8Array): { snaplen: number; network: number; packets: { sec: number; usec: number; inclLen: number; origLen: number }[] } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = dv.getUint32(0, true);
  if (magic !== 0xa1b2c3d4) throw new Error('bad magic');
  const snaplen = dv.getUint32(16, true); const network = dv.getUint32(20, true);
  const packets: { sec: number; usec: number; inclLen: number; origLen: number }[] = [];
  let o = 24;
  while (o + 16 <= buf.length) {
    const sec = dv.getUint32(o, true), usec = dv.getUint32(o + 4, true), inclLen = dv.getUint32(o + 8, true), origLen = dv.getUint32(o + 12, true);
    o += 16 + inclLen; packets.push({ sec, usec, inclLen, origLen });
  }
  return { snaplen, network, packets };
}

describe('E2 pcap export + ground-truth labels', () => {
  it('exports a well-formed Ethernet pcap that round-trips through a reader', () => {
    const st = directLan();
    const sn = Object.values(st.sniffers)[0]!;
    const onWire = sn.frames.filter(f => !f.drop);
    const pcap = framesToPcap(sn.frames);
    const parsed = parsePcap(pcap);
    expect(parsed.network).toBe(1);                 // DLT_EN10MB
    expect(parsed.snaplen).toBe(65535);
    expect(parsed.packets.length).toBe(onWire.length);
    // timestamps and lengths line up with the source frames
    parsed.packets.forEach((p, i) => {
      const f = onWire[i]!;
      expect(p.origLen).toBe(f.bytes.length);
      expect(p.sec * 1_000_000 + p.usec).toBe(f.t);
    });
  });

  it('frame provenance labels attack traffic by construction (purity 1.0)', () => {
    const st = directLan();     // benign ping A -> B already ran (txTag was null: no origins)
    const before = Object.keys(st.frameOrigins ?? {}).length;
    expect(before).toBe(0);     // benign traffic is unlabeled

    // a second burst, this time from B, marked as an attack class
    const b = st.nodes[2] as HostState;
    st.txTag = 'synflood';
    runCommand(st, b, 'ping -c 2 10.0.0.1');
    advance(st, st.time + 5 * SEC, 5_000_000);
    st.txTag = null;

    const origins = st.frameOrigins ?? {};
    expect(Object.keys(origins).length).toBeGreaterThan(0);
    for (const o of Object.values(origins)) expect(o.tag).toBe('synflood');   // purity 1.0

    const sn = Object.values(st.sniffers)[0]!;
    const { summary } = framesToLabels(sn.frames, origins);
    // benign and attack frames partition the whole capture, both present
    expect(summary.counts['synflood']).toBeGreaterThan(0);
    expect(summary.counts['benign']).toBeGreaterThan(0);
    expect((summary.counts['synflood'] ?? 0) + (summary.counts['benign'] ?? 0)).toBe(summary.total);
  });
});

describe('E6 trace recorder (opt-in, anonymized)', () => {
  it('summarizeCmd keeps identifiers and verbs but never free text', () => {
    expect(summarizeCmd({ type: 'runCmd', node: 3, line: 'ping -c 5 10.0.0.9' })).toEqual({ type: 'runCmd', node: 3, verb: 'ping' });
    expect(summarizeCmd({ type: 'setHosts', node: 2, text: 'secret.internal 10.0.0.5' })).toEqual({ type: 'setHosts', node: 2 });
    expect(summarizeCmd({ type: 'addBreakpoint', expr: 'tcp.flags.syn == 1', milestones: ['tx'] })).toEqual({ type: 'addBreakpoint', expr: 'tcp.flags.syn == 1' });
    expect(summarizeCmd({ type: 'addNode', nodeType: 'host', kind: 'laptop', x: 0, y: 0 })).toEqual({ type: 'addNode', nodeType: 'host' });
  });

  it('is a no-op until enabled, then records and exports valid JSON', () => {
    trace.disable();
    trace.record('cmd', { type: 'play' });
    expect(trace.count()).toBe(0);                 // disabled: nothing recorded

    trace.enable();                                // records session.start
    trace.cmd({ type: 'runCmd', node: 1, line: 'dig example.com' });
    trace.record('breakpoint.hit', { frameId: 7 });
    expect(trace.count()).toBeGreaterThanOrEqual(3);

    const dump = JSON.parse(trace.export());
    expect(dump.format).toBe('netsim-trace');
    expect(Array.isArray(dump.events)).toBe(true);
    const verbs = dump.events.filter((e: { kind: string }) => e.kind === 'cmd');
    expect(verbs[0].data.verb).toBe('dig');
    expect(JSON.stringify(dump)).not.toContain('example.com');   // free text never stored
    trace.disable();
  });
});

// @ts-expect-error Node builtin available at test runtime (no @types/node in tsconfig).
import { readFileSync } from 'fs';
import { startClangProgram } from '@/engine/apps/clangrun';
import { RandomScheduler, ReplayScheduler, withScheduler, setScheduler } from '@/engine/cc/scheduler';

const THREADS_FIXTURE = new Uint8Array(readFileSync(new URL('../fixtures/clang-threads.wasm', import.meta.url)) as Uint8Array);

function runThreads(sched: { seed?: number; decisions?: number[] } | null): { st: EngineState; out: string } {
  const st = createState(1);
  const b = addHost(st, 'laptop', 0, 0, 'B');
  startClangProgram(st, b, THREADS_FIXTURE, 'threads', []);
  const go = () => advance(st, 60 * SEC, 1_000_000);
  if (!sched) go();
  else if (sched.decisions) withScheduler(new ReplayScheduler(sched.decisions), go);
  else withScheduler(new RandomScheduler(sched.seed ?? 1), go);
  setScheduler(null);
  return { st, out: (b as HostState).terminal.join('\n') };
}

describe('E3 controlled scheduler oracle', () => {
  const CORRECT = '[threads] main: joined counter=6 r1=10 r2=20';

  it('default (no oracle) runs the pthreads program correctly', () => {
    expect(runThreads(null).out).toContain(CORRECT);   // baseline: round-robin, unchanged
  });

  it('a correctly-synchronized program is interleaving-robust under a random schedule', () => {
    for (const seed of [1, 7, 42, 1000]) {
      const r = runThreads({ seed });
      expect(r.out).toContain(CORRECT);                 // any valid interleaving -> same result
    }
  });

  it('a seeded schedule is reproducible, and a recorded schedule replays byte-identically', async () => {
    // two runs with the same random seed are byte-identical
    const h1 = await hashState(runThreads({ seed: 123 }).st);
    const h2 = await hashState(runThreads({ seed: 123 }).st);
    expect(h2).toBe(h1);

    // record the decisions of a random run, then replay them and reach the same final state
    const rnd = new RandomScheduler(777);
    const st = createState(1); const b = addHost(st, 'laptop', 0, 0, 'B');
    startClangProgram(st, b, THREADS_FIXTURE, 'threads', []);
    withScheduler(rnd, () => advance(st, 60 * SEC, 1_000_000)); setScheduler(null);
    const recHash = await hashState(st);
    const decisions = rnd.schedule();
    expect(decisions.length).toBeGreaterThan(0);        // the oracle actually made choices

    const replayHash = await hashState(runThreads({ decisions }).st);
    expect(replayHash).toBe(recHash);
  });
});
