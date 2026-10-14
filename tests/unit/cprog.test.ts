// Phase 0 spike: a C-style socket program (sequential, blocking) runs inside the deterministic
// event loop. This proves the suspend/resume contract the full C runtime will use.
import { describe, it, expect } from 'vitest';
import { createState, addHost, addSwitch, connect, setIfaceIp, addSniffer, advance, stepSyscall } from '@/engine/engine';
import { startProgram, startWasmProgram, compile, compileAndStart, PROGRAM_NAMES } from '@/engine/apps/cprog';
import { nsCompile } from '@/engine/cc/nsc';
import { CPROGRAMS } from '@/shared/cprograms';
import { runCommand } from '@/engine/terminal';
import { CPROGRAM_GENERATOR_NAMES } from '@/shared/cprograms';
import { ipToU32, prefixToMask } from '@/shared/bytes';
import { decodeFrame } from '@/engine/codecs/decode';
import { SEC } from '@/engine/core';
import type { CProc, HostState } from '@/engine/types';

function lan(seed = 1) {
  const st = createState(seed);
  const a = addHost(st, 'server', 100, 100, 'A'); const b = addHost(st, 'laptop', 300, 100, 'B'); const sw = addSwitch(st, 200, 200);
  const l1 = connect(st, a.id, 0, sw.id, 0)!; const l2 = connect(st, b.id, 0, sw.id, 1)!;
  setIfaceIp(st, a, 'eth0', ipToU32('10.0.0.1'), prefixToMask(24)); setIfaceIp(st, b, 'eth0', ipToU32('10.0.0.2'), prefixToMask(24));
  return { st, a, b, sw, l1, l2 };
}
const hasCprog = (h: HostState) => Object.values(h.procs).some(p => p.kind === 'cprog');

describe('cprog spike: blocking socket program on the event loop', () => {
  it('a C echo client and server exchange bytes over the simulated wire', () => {
    const { st, a, b, l1 } = lan();
    const sniff = addSniffer(st, l1)!;
    startProgram(st, a, 'echo-server', ['7']);          // server daemon on A:7
    startProgram(st, b, 'echo-client', ['10.0.0.1', '7', 'hello', 'world']);  // client on B

    const r = advance(st, 200 * SEC, 1e6);
    expect(r.idle).toBe(true);

    const srv = a.terminal.join('\n'); const cli = b.terminal.join('\n');
    expect(srv).toContain('[echo-server] listening on :7');
    expect(srv).toContain('[echo-server] accepted a connection');
    expect(srv).toContain('[echo-server] connection closed');
    expect(cli).toContain('[echo-client] connected to 10.0.0.1:7');
    expect(cli).toContain('[echo-client] reply: hello world');   // the server echoed our bytes back
    expect(cli).toContain('[echo-client] done');

    // The client program exited (removed); the server is still a running daemon, blocked in accept().
    expect(hasCprog(b)).toBe(false);
    const server = Object.values(a.procs).find(p => p.kind === 'cprog') as CProc | undefined;
    expect(server?.blocked?.syscall).toBe('accept');

    // The program's send()/connect() produced real packets on the wire: a real TCP handshake.
    const protos = st.sniffers[sniff]!.frames.map(f => { try { return decodeFrame(f.bytes).proto; } catch { return '?'; } });
    expect(protos.filter(p => p === 'TCP').length).toBeGreaterThan(3);
  });

  it('same seed => identical wire bytes (deterministic under the event loop)', () => {
    const run = () => {
      const { st, a, b, l1 } = lan(9);
      const s = addSniffer(st, l1)!;
      startProgram(st, a, 'echo-server', ['7']);
      startProgram(st, b, 'echo-client', ['10.0.0.1', '7', 'ping']);
      advance(st, 200 * SEC, 1e6);
      return st.sniffers[s]!.frames.map(f => `${f.t}:${f.dir}:${Array.from(f.bytes).join(',')}`);
    };
    expect(run()).toEqual(run());
  });

  it('connect to a port with no listener fails cleanly (RST -> error, no crash)', () => {
    const { st, b } = lan();
    startProgram(st, b, 'echo-client', ['10.0.0.1', '7', 'anyone there']);  // nobody listening on A
    const r = advance(st, 60 * SEC, 1e6);
    expect(r.idle).toBe(true);
    expect(b.terminal.join('\n')).toContain('[echo-client] connect failed');
    expect(hasCprog(b)).toBe(false);  // program exited, did not hang
  });

  it('UDP: a datagram client and echo server exchange a datagram', () => {
    const { st, a, b } = lan();
    startProgram(st, a, 'udp-echo-server', ['7']);
    startProgram(st, b, 'udp-client', ['10.0.0.1', '7', 'hi', 'there']);
    const r = advance(st, 60 * SEC, 1e6);
    expect(r.idle).toBe(true);
    expect(a.terminal.join('\n')).toContain('[udp-echo-server] datagram from 10.0.0.2:');
    expect(b.terminal.join('\n')).toContain('[udp-client] reply: hi there');
    expect(hasCprog(b)).toBe(false);
  });

  it('is launchable from the host terminal (in-app path via runCommand)', () => {
    const { st, a, b } = lan();
    runCommand(st, a, 'crun echo-server 7');
    runCommand(st, b, 'crun echo-client 10.0.0.1 7 hello world');
    advance(st, 200 * SEC, 1e6);
    expect(a.terminal.join('\n')).toContain('echo-server started');
    expect(b.terminal.join('\n')).toContain('[echo-client] reply: hello world');
    // `crun` with no args lists the available programs.
    runCommand(st, a, 'crun');
    expect(a.terminal.join('\n')).toContain('udp-echo-server');
  });

  it('every reference-generator name the UI/labs use exists in the engine registry', () => {
    // The terminal `crun` and lab solvers run these by name; if one is missing from the engine
    // registry this fails before it can confuse a student. (clang/nsC programs are compiled, not run
    // by a generator, so they are not required here.)
    for (const n of CPROGRAM_GENERATOR_NAMES) expect(PROGRAM_NAMES).toContain(n);
  });
});

describe('compile() boundary (stub)', () => {
  it('accepts every shipped reference source', () => {
    for (const p of CPROGRAMS.filter(p => p.backend === 'stub')) expect(compile(p.source, p.name)).toEqual({ ok: true, name: p.name });
  });
  it('reports a missing main() with a diagnostic', () => {
    const r = compile('int notmain(){return 0;}', 'echo-server');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0]!.message).toContain('main');
  });
  it('reports unbalanced braces with a line number', () => {
    const r = compile('int main(){\n  if (1) {\n  // missing close\n}\n', 'echo-server');
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.diagnostics.some(d => /unbalanced braces/.test(d.message))).toBe(true); expect(r.diagnostics[0]!.line).toBeGreaterThan(0); }
  });
  it('compileAndStart runs a good program and returns diagnostics for a bad one', () => {
    const { st, a } = lan();
    const good = compileAndStart(st, a, CPROGRAMS[0]!.source, 'echo-server', ['7']);
    expect('kind' in good && good.kind).toBe('cprog');
    const bad = compileAndStart(st, a, 'oops(', 'echo-server', []);
    expect('diagnostics' in bad).toBe(true);
  });
});

// A real compiled WebAssembly module (what the in-browser clang will emit) drives the engine's TCP
// stack through the netsim-posix import boundary, blocking on recv() and resuming via procNotify.
// The module is a hand-written WAT state machine using the host-driven resume protocol (start/resume
// return 1 when blocked). This proves the production execution substrate independent of clang.
async function wat2wasm(src: string): Promise<Uint8Array> {
  const init = (await import('wabt')).default as unknown as () => Promise<any>;  // eslint-disable-line @typescript-eslint/no-explicit-any
  const wabt = await init();
  const mod = wabt.parseWat('p.wat', src);
  const { buffer } = mod.toBinary({});
  return new Uint8Array(buffer);
}
const WASM_ECHO_CLIENT = `(module
  (import "env" "arg_ip"     (func $arg_ip  (result i32)))
  (import "env" "arg_port"   (func $arg_port(result i32)))
  (import "env" "sys_socket" (func $socket  (param i32) (result i32)))
  (import "env" "sys_connect"(func $connect (param i32 i32 i32) (result i32)))
  (import "env" "sys_send"   (func $send    (param i32 i32 i32) (result i32)))
  (import "env" "sys_recv"   (func $recv    (param i32 i32 i32) (result i32)))
  (import "env" "sys_close"  (func $close   (param i32)))
  (import "env" "sys_print"  (func $print   (param i32 i32)))
  (memory (export "memory") 1)
  (data (i32.const 0) "hi")
  (global $step (mut i32) (i32.const 0))
  (global $fd   (mut i32) (i32.const 0))
  (func $run (result i32) (local $n i32)
    (if (i32.eqz (global.get $step)) (then
      (global.set $fd (call $socket (i32.const 0)))
      (if (i32.lt_s (call $connect (global.get $fd) (call $arg_ip) (call $arg_port)) (i32.const 0))
        (then (return (i32.const 0))))
      (global.set $step (i32.const 1))
      (return (i32.const 1))))
    (if (i32.eq (global.get $step) (i32.const 1)) (then
      (drop (call $send (global.get $fd) (i32.const 0) (i32.const 2)))
      (global.set $step (i32.const 2))))
    (if (i32.eq (global.get $step) (i32.const 2)) (then
      (local.set $n (call $recv (global.get $fd) (i32.const 64) (i32.const 64)))
      (if (i32.eq (local.get $n) (i32.const -2)) (then (return (i32.const 1))))
      (if (i32.gt_s (local.get $n) (i32.const 0)) (then (call $print (i32.const 64) (local.get $n))))
      (call $close (global.get $fd))
      (return (i32.const 0))))
    (i32.const 0))
  (func (export "start")  (result i32) (call $run))
  (func (export "resume") (result i32) (call $run)))`;

describe('real WebAssembly program over the engine syscall boundary', () => {
  it('a compiled wasm TCP client connects, sends, blocks on recv, and prints the echo', async () => {
    const bytes = await wat2wasm(WASM_ECHO_CLIENT);
    const { st, a, b, l1 } = lan();
    const sniff = addSniffer(st, l1)!;
    startProgram(st, a, 'echo-server', ['7']);                       // generator server
    const started = startWasmProgram(st, b, bytes, 'wasm-echo-client', ['10.0.0.1', '7']);  // real wasm client
    expect(typeof started).not.toBe('string');

    const r = advance(st, 200 * SEC, 1e6);
    expect(r.idle).toBe(true);

    // The wasm client printed the echoed bytes via the sys_print syscall.
    expect(b.terminal.join('\n')).toContain('[wasm-echo-client] hi');
    // The server saw a real connection, and a real TCP handshake crossed the wire.
    expect(a.terminal.join('\n')).toContain('[echo-server] accepted a connection');
    const protos = st.sniffers[sniff]!.frames.map(f => { try { return decodeFrame(f.bytes).proto; } catch { return '?'; } });
    expect(protos.filter(pr => pr === 'TCP').length).toBeGreaterThan(3);
    expect(hasCprog(b)).toBe(false);   // the wasm program exited cleanly
  });

  it('rejects malformed module bytes without crashing', () => {
    const { st, b } = lan();
    const res = startWasmProgram(st, b, new Uint8Array([0, 1, 2, 3]), 'bad', []);
    expect(typeof res).toBe('string');   // instantiate failed: ...
  });
});

// The real in-browser nsC compiler: student-edited C-subset source -> wasm -> run on the sim.
describe('nsC compiler (real, in-browser, no download)', () => {
  const SRC = `int main(void) {\n  int fd = udp();\n  sendto(fd, ip(), port(), "hello from nsC\\n");\n  print("datagram sent");\n  close(fd);\n}`;

  it('compiles a UDP sender to runnable wasm that puts a real datagram on the wire', () => {
    const r = nsCompile(SRC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { st, a, b, l1 } = lan();
    const sniff = addSniffer(st, l1)!;
    startProgram(st, a, 'udp-echo-server', ['7']);                      // generator server on A
    const started = startWasmProgram(st, b, r.wasm, 'udp-send-nsc', ['10.0.0.1', '7']);  // compiled client on B
    expect(typeof started).not.toBe('string');

    advance(st, 60 * SEC, 1e6);
    expect(b.terminal.join('\n')).toContain('[udp-send-nsc] datagram sent');
    expect(a.terminal.join('\n')).toContain('[udp-echo-server] datagram from 10.0.0.2:');  // server got our bytes
    const protos = st.sniffers[sniff]!.frames.map(f => { try { return decodeFrame(f.bytes).proto; } catch { return '?'; } });
    expect(protos).toContain('UDP');
  });

  it('compileAndStart(nsc) runs good source and returns diagnostics for bad source', () => {
    const { st, b } = lan();
    const good = compileAndStart(st, b, SRC, 'udp-send-nsc', ['10.0.0.1', '7'], 'nsc');
    expect('kind' in good && good.kind).toBe('cprog');
    const bad = compileAndStart(st, b, 'int main(void) { frobnicate(); }', 'udp-send-nsc', [], 'nsc');
    expect('diagnostics' in bad).toBe(true);
    if ('diagnostics' in bad) expect(bad.diagnostics[0]!.message).toContain("unknown function 'frobnicate'");
  });

  it('reports a parse error with a line/col', () => {
    const r = nsCompile('int main(void) {\n  int x = ;\n}');
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.diagnostics[0]!.line).toBe(2); expect(r.diagnostics[0]!.severity).toBe('error'); }
  });

  it('compiles real control flow: a while loop sends exactly N datagrams', () => {
    const SRC = `int main(void) {
      int fd = udp();
      int n = 0;
      while (n < 3) { sendto(fd, ip(), port(), "x"); n = n + 1; }
      if (n == 3) { print("sent 3"); } else { print("bug"); }
      close(fd);
    }`;
    const r = nsCompile(SRC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { st, a, b, l1 } = lan();
    const sniff = addSniffer(st, l1)!;
    startProgram(st, a, 'udp-echo-server', ['7']);
    startWasmProgram(st, b, r.wasm, 'blast', ['10.0.0.1', '7']);
    advance(st, 60 * SEC, 1e6);
    expect(b.terminal.join('\n')).toContain('[blast] sent 3');              // the if-branch ran
    const udpToServer = st.sniffers[sniff]!.frames.filter(f => { try { return decodeFrame(f.bytes).proto === 'UDP'; } catch { return false; } });
    expect(udpToServer.length).toBeGreaterThanOrEqual(3);                   // exactly the loop's datagrams
  });

  it('compiles a BLOCKING TCP echo client: connect + recv suspend and resume via the state machine', () => {
    const SRC = CPROGRAMS.find(p => p.name === 'tcp-client-nsc')!.source;
    const r = nsCompile(SRC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { st, a, b, l1 } = lan();
    const sniff = addSniffer(st, l1)!;
    startProgram(st, a, 'echo-server', ['7']);                             // generator TCP echo server on A
    startWasmProgram(st, b, r.wasm, 'tcp-client-nsc', ['10.0.0.1', '7']);  // compiled blocking client on B
    advance(st, 200 * SEC, 1e6);
    // The compiled client connected (handshake), sent, blocked on recv, resumed, printed the echo.
    expect(a.terminal.join('\n')).toContain('[echo-server] accepted a connection');
    expect(b.terminal.join('\n')).toContain('[tcp-client-nsc] hello from nsC');
    const protos = st.sniffers[sniff]!.frames.map(f => { try { return decodeFrame(f.bytes).proto; } catch { return '?'; } });
    expect(protos.filter(pr => pr === 'TCP').length).toBeGreaterThan(3);   // real handshake + data + teardown
    expect(hasCprog(b)).toBe(false);                                        // exited cleanly
  });

  it('rejects a blocking call nested in an expression (nsC v1 restriction)', () => {
    const r = nsCompile('int main(void) {\n  int fd = tcp();\n  int n = recv(fd) + 1;\n}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0]!.message).toContain('top-level statement');
  });

  it('relooper: a compiled TCP echo SERVER (blocking inside a while loop) serves a compiled client', () => {
    const srv = nsCompile(CPROGRAMS.find(p => p.name === 'tcp-server-nsc')!.source);
    const cli = nsCompile(CPROGRAMS.find(p => p.name === 'tcp-client-nsc')!.source);
    expect(srv.ok && cli.ok).toBe(true);
    if (!srv.ok || !cli.ok) return;
    const { st, a, b, l1 } = lan();
    const sniff = addSniffer(st, l1)!;
    startWasmProgram(st, a, srv.wasm, 'tcp-server-nsc', ['0.0.0.0', '7']);   // compiled server (accept loop)
    startWasmProgram(st, b, cli.wasm, 'tcp-client-nsc', ['10.0.0.1', '7']);  // compiled client
    advance(st, 200 * SEC, 1e6);
    expect(b.terminal.join('\n')).toContain('[tcp-client-nsc] hello from nsC');  // server echoed, client printed
    const tcp = st.sniffers[sniff]!.frames.filter(f => { try { return decodeFrame(f.bytes).proto === 'TCP'; } catch { return false; } }).length;
    expect(tcp).toBeGreaterThan(5);   // handshake + data + echo + teardown
    // The server is a daemon: still running, blocked in accept().
    const server = Object.values(a.procs).find(p => p.kind === 'cprog');
    expect(server).toBeTruthy();
  });

  it('stepSyscall advances a compiled program one blocking call at a time', () => {
    const cli = nsCompile(CPROGRAMS.find(p => p.name === 'tcp-client-nsc')!.source);
    expect(cli.ok).toBe(true); if (!cli.ok) return;
    const { st, a, b } = lan();
    startProgram(st, a, 'echo-server', ['7']);
    const started = startWasmProgram(st, b, cli.wasm, 'tcp-client-nsc', ['10.0.0.1', '7']);
    const pid = typeof started === 'string' ? -1 : started.pid;
    const blocked = () => (b.procs[pid] as { blocked?: { syscall: string } } | undefined)?.blocked?.syscall ?? (b.procs[pid] ? 'run' : 'gone');
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) { const r = stepSyscall(st); seen.add(blocked()); if (r.idle) break; }
    // Over its life the client passes through connect, recv, and exit.
    expect(seen.has('connected')).toBe(true);
    expect(seen.has('readable')).toBe(true);
    expect(seen.has('gone')).toBe(true);   // exited
    expect(b.terminal.join('\n')).toContain('[tcp-client-nsc] hello from nsC');
  });
});
