// Proof that a program compiled by the REAL in-browser clang toolchain (full C: structs, pointers,
// printf, <string.h>) runs on the NetSim engine and moves a real packet. The fixture
// tests/fixtures/clang-udpsend.wasm was produced by clang+wasm-ld from tests/fixtures/udpsend.c +
// nssock.c (the socket shim). The toolchain itself (~60 MB) is a runtime download, not committed;
// this small fixture lets the engine integration be tested without it.
import { describe, it, expect } from 'vitest';
// @ts-expect-error Node builtin available at test runtime (no @types/node in tsconfig).
import { readFileSync } from 'fs';
import { createState, addHost, addSwitch, connect, setIfaceIp, addSniffer, advance } from '@/engine/engine';
import { startProgram } from '@/engine/apps/cprog';
import { startClangProgram, registerClangProgram } from '@/engine/apps/clangrun';
import { ipToU32, prefixToMask } from '@/shared/bytes';
import { decodeFrame } from '@/engine/codecs/decode';
import { SEC } from '@/engine/core';

const FIXTURE = new Uint8Array(readFileSync(new URL('../fixtures/clang-udpsend.wasm', import.meta.url)) as Uint8Array);
const TCP_FIXTURE = new Uint8Array(readFileSync(new URL('../fixtures/clang-tcpcli.wasm', import.meta.url)) as Uint8Array);
const FORK_FIXTURE = new Uint8Array(readFileSync(new URL('../fixtures/clang-fork.wasm', import.meta.url)) as Uint8Array);
const GREETER_FIXTURE = new Uint8Array(readFileSync(new URL('../fixtures/clang-greeter.wasm', import.meta.url)) as Uint8Array);
const LAUNCHER_FIXTURE = new Uint8Array(readFileSync(new URL('../fixtures/clang-launcher.wasm', import.meta.url)) as Uint8Array);
const SIGNAL_FIXTURE = new Uint8Array(readFileSync(new URL('../fixtures/clang-signal.wasm', import.meta.url)) as Uint8Array);
const THREADS_FIXTURE = new Uint8Array(readFileSync(new URL('../fixtures/clang-threads.wasm', import.meta.url)) as Uint8Array);
const MTCLIENT_FIXTURE = new Uint8Array(readFileSync(new URL('../fixtures/clang-mtclient.wasm', import.meta.url)) as Uint8Array);
const SELECT_FIXTURE = new Uint8Array(readFileSync(new URL('../fixtures/clang-select-server.wasm', import.meta.url)) as Uint8Array);
const POLL_FIXTURE = new Uint8Array(readFileSync(new URL('../fixtures/clang-poll-server.wasm', import.meta.url)) as Uint8Array);
const EPOLL_FIXTURE = new Uint8Array(readFileSync(new URL('../fixtures/clang-epoll-server.wasm', import.meta.url)) as Uint8Array);
const EINTR_FIXTURE = new Uint8Array(readFileSync(new URL('../fixtures/clang-eintr.wasm', import.meta.url)) as Uint8Array);

function lan(seed = 1) {
  const st = createState(seed);
  const a = addHost(st, 'server', 100, 100, 'A'); const b = addHost(st, 'laptop', 300, 100, 'B'); const sw = addSwitch(st, 200, 200);
  const l1 = connect(st, a.id, 0, sw.id, 0)!; connect(st, b.id, 0, sw.id, 1);
  setIfaceIp(st, a, 'eth0', ipToU32('10.0.0.1'), prefixToMask(24)); setIfaceIp(st, b, 'eth0', ipToU32('10.0.0.2'), prefixToMask(24));
  return { st, a, b, l1 };
}

describe('real clang toolchain: full-C program runs on the engine', () => {
  it('a clang-compiled UDP sender (structs, pointers, printf) puts a real datagram on the wire', () => {
    const { st, a, b, l1 } = lan();
    const sniff = addSniffer(st, l1)!;
    startProgram(st, a, 'udp-echo-server', ['7']);                     // generator server on A:7
    const started = startClangProgram(st, b, FIXTURE, 'clang-udp', []); // REAL clang program on B
    expect(typeof started).not.toBe('string');

    advance(st, 60 * SEC, 1e6);

    // The clang program's printf("sent %d bytes\n") ran through our WASI fd_write shim.
    expect(b.terminal.join('\n')).toContain('[clang-udp] sent 22 bytes');
    // Its sendto() moved a real UDP datagram to the server, decoded on the wire.
    expect(a.terminal.join('\n')).toContain('[udp-echo-server] datagram from 10.0.0.2:');
    const protos = st.sniffers[sniff]!.frames.map(f => { try { return decodeFrame(f.bytes).proto; } catch { return '?'; } });
    expect(protos).toContain('UDP');
    // Program exited cleanly (return 0) with no cprog left behind.
    expect(Object.values(b.procs).some(p => p.kind === 'cprog')).toBe(false);
  });

  it('rejects malformed module bytes without crashing', () => {
    const { st, b } = lan();
    expect(typeof startClangProgram(st, b, new Uint8Array([0, 1, 2, 3]), 'bad', [])).toBe('string');
  });

  it('a clang+Asyncify TCP client blocks on connect/recv and resumes on the wire', () => {
    const { st, a, b, l1 } = lan();
    const sniff = addSniffer(st, l1)!;
    startProgram(st, a, 'echo-server', ['7']);                          // generator TCP echo server on A:7
    const started = startClangProgram(st, b, TCP_FIXTURE, 'clang-tcp', []); // REAL clang+Asyncify client on B
    expect(typeof started).not.toBe('string');

    advance(st, 200 * SEC, 1e6);

    // connect() suspended until the handshake completed, recv() suspended until the echo arrived.
    expect(b.terminal.join('\n')).toContain('[clang-tcp] connected');
    expect(b.terminal.join('\n')).toContain('[clang-tcp] reply: hello from clang tcp');
    expect(a.terminal.join('\n')).toContain('[echo-server] accepted a connection');
    const protos = st.sniffers[sniff]!.frames.map(f => { try { return decodeFrame(f.bytes).proto; } catch { return '?'; } });
    expect(protos.filter(pr => pr === 'TCP').length).toBeGreaterThan(3);   // SYN/SYN-ACK/ACK + data + teardown
    expect(Object.values(b.procs).some(p => p.kind === 'cprog')).toBe(false);  // exited cleanly
  });

  it('fork() clones the process: parent and child both continue from the fork point', () => {
    const { st, b } = lan();
    startClangProgram(st, b, FORK_FIXTURE, 'forker', []);
    advance(st, 60 * SEC, 1e6);
    const t = b.terminal.join('\n');
    expect(t).toContain('[forker] before fork');            // printed once, before fork
    expect(t).toContain('[forker] child running');          // child branch (fork returned 0)
    expect(t).toContain('[forker] parent sees child pid');  // parent branch (fork returned a pid)
    expect((t.match(/both reach here/g) || []).length).toBe(2);  // both processes ran past the fork
  });

  it('exec() replaces the process image with another program', () => {
    registerClangProgram('greeter', GREETER_FIXTURE);   // make it exec()-able by name
    const { st, b } = lan();
    startClangProgram(st, b, LAUNCHER_FIXTURE, 'launcher', []);
    advance(st, 60 * SEC, 1e6);
    const t = b.terminal.join('\n');
    expect(t).toContain('launcher before exec');          // ran before exec
    expect(t).toContain("hello from exec'd program");      // the new image ran
    expect(t).not.toContain('NOT REACHED');                // code after a successful exec never runs
  });

  it('signal() registers a handler that raise() invokes', () => {
    const { st, b } = lan();
    startClangProgram(st, b, SIGNAL_FIXTURE, 'sig', []);
    advance(st, 60 * SEC, 1e6);
    const t = b.terminal.join('\n');
    expect(t).toContain('[sig] before raise');
    expect(t).toContain('[sig] caught signal 2 (count 1)');   // handler ran on the first raise
    expect(t).toContain('[sig] caught signal 2 (count 2)');   // and the second
    expect(t).toContain('[sig] after raise, count=2');         // control returned, handler mutated state
  });

  it('pthreads: two threads interleave via a mutex-protected counter; join returns their values', () => {
    const { st, b } = lan();
    startClangProgram(st, b, THREADS_FIXTURE, 'threads', []);
    advance(st, 60 * SEC, 1e6);
    const t = b.terminal.join('\n');
    expect(t).toContain('[threads] main: spawning two threads');
    expect((t.match(/worker 1 inc/g) || []).length).toBe(3);      // each thread ran its full loop
    expect((t.match(/worker 2 inc/g) || []).length).toBe(3);
    expect(t).toContain('[threads] main: joined counter=6 r1=10 r2=20');  // shared state + return values via join
    expect(Object.values(b.procs).some(p => p.kind === 'cprog')).toBe(false);   // all threads exited, process gone
  });

  it('pthreads + sockets: two worker threads each do a blocking connect/recv against the echo server', () => {
    const { st, a, b, l1 } = lan();
    const sniff = addSniffer(st, l1)!;
    startProgram(st, a, 'echo-server', ['7']);                          // iterative generator server on A:7
    const started = startClangProgram(st, b, MTCLIENT_FIXTURE, 'mtcli', []);  // threaded clang client on B
    expect(typeof started).not.toBe('string');

    advance(st, 300 * SEC, 1e6);

    const t = b.terminal.join('\n');
    // Each thread connected (blocking), sent, and blocked in recv until its echo came back; the
    // scheduler drove the other thread meanwhile. Both got their own reply.
    expect(t).toContain('[mtcli] thread 1 got: hi from thread 1');
    expect(t).toContain('[mtcli] thread 2 got: hi from thread 2');
    expect(t).toContain('[mtcli] main joined r1=100 r2=200');
    const protos = st.sniffers[sniff]!.frames.map(f => { try { return decodeFrame(f.bytes).proto; } catch { return '?'; } });
    expect(protos.filter(pr => pr === 'TCP').length).toBeGreaterThan(6);   // two full TCP conversations on the wire
    expect(Object.values(b.procs).some(p => p.kind === 'cprog')).toBe(false);
  });

  // One single-threaded server multiplexing two clients at once, three ways.
  for (const [name, fixture, tag] of [['select', SELECT_FIXTURE, 'select server'], ['poll', POLL_FIXTURE, 'poll server'], ['epoll', EPOLL_FIXTURE, 'epoll server']] as const) {
    it(`${name}(): a single-threaded server multiplexes two concurrent clients`, () => {
      const { st, a, b } = lan();
      startClangProgram(st, a, fixture, name, ['7']);                    // mux server on A:7 (one thread)
      startProgram(st, b, 'echo-client', ['10.0.0.1', '7', 'alpha']);    // two clients from B
      startProgram(st, b, 'echo-client', ['10.0.0.1', '7', 'bravo']);
      advance(st, 300 * SEC, 1e6);
      expect(a.terminal.join('\n')).toContain(`[${name}] ${tag} on :7`);
      expect(b.terminal.join('\n')).toContain('reply: alpha');           // both clients got their echo
      expect(b.terminal.join('\n')).toContain('reply: bravo');           // from the one multiplexing server
    });
  }

  it('EINTR: a blocking accept() is interrupted by SIGALRM and the handler runs', () => {
    const { st, b } = lan();
    startClangProgram(st, b, EINTR_FIXTURE, 'eintr', []);   // installs SIGALRM handler, alarm(2), blocks in accept
    advance(st, 60 * SEC, 1e6);
    const t = b.terminal.join('\n');
    expect(t).toContain('blocking in accept()');
    expect(t).toContain('handler: SIGALRM (14)');                             // the handler ran at the boundary
    expect(t).toContain('accept() interrupted by signal (EINTR); fired=14');  // accept returned -1 with errno=EINTR
    expect(Object.values(b.procs).some(p => p.kind === 'cprog')).toBe(false);         // then the program exited cleanly
  });
});
