// C-program runtime (Phase 0 spike).
//
// This proves the execution model the full feature will use: a program is written as ordinary
// *sequential, blocking* code (connect/accept/send/recv/close), yet it runs inside NetSim's
// single deterministic event loop. A blocking syscall suspends the program and returns control to
// the engine, which keeps advancing virtual time; the program resumes when the condition it waited
// for is signalled through the SAME procNotify() events the engine already emits (tcpConnected,
// tcpReadable, tcpEof, tcpAccept, udpRx, tcpError). Because resumes happen inside event dispatch,
// Play / Step / Turbo drive program execution for free and ordering stays deterministic.
//
// Suspension here uses a JS generator as a stand-in for the Asyncify-compiled WASM coroutine of
// later phases; the engine-side contract (a CProc in h.procs + a side-table execution context) is
// identical, so swapping the substrate does not touch the engine.
//
// CONSTRAINT (types.ts): EngineState must stay structured-cloneable, so the live coroutine CANNOT
// live in it. The serializable CProc lives in h.procs; the non-cloneable Runner lives in the
// module-side table below, keyed by a unique rid. On snapshot/restore the Runner is not cloned;
// programs are reconstructed by deterministic replay-from-source (Phase 5). No real socket or port
// is ever touched: every syscall only mutates EngineState, so runs are fully sandboxed.
import { ipToU32, u32ToIp } from '@/shared/bytes';
import { term } from '../devices/host';
import { timer } from '../core';
import { tcpSocket, tcpListen, tcpConnect, tcpAccept, tcpSend, tcpRecv, tcpClose } from '../stack/tcp';
import { udpSocket, udpSend } from '../stack/udp';
import type { EngineState, HostState, CProc, Socket, TcpSocket, UdpSocket } from '../types';
import type { ProcEvent } from './procs';
import type { CDiagnostic } from '@/shared/cprograms';
import { nsCompile } from '../cc/nsc';

const td = new TextDecoder(); const te = new TextEncoder();
const dec = (b: Uint8Array) => td.decode(b);

// ---------- what a blocked program is waiting for ----------
type WaitReq =
  | { kind: 'connected'; sock: number }
  | { kind: 'readable'; sock: number }
  | { kind: 'accept'; sock: number }
  | { kind: 'udprx'; sock: number };
type Prog = Generator<WaitReq, void, unknown>;
type Blocking<T> = Generator<WaitReq, T, unknown>;
class CError extends Error {}

// ---------- syscall facade handed to a program ----------
export interface Datagram { data: Uint8Array; ip: number; port: number }
export interface Sys {
  tcp(): number;                                   // socket(AF_INET, SOCK_STREAM)
  udp(): number;                                   // socket(AF_INET, SOCK_DGRAM)
  bind(fd: number, port: number): void;            // bind(fd, :port)
  listen(fd: number): void;                        // listen(fd)
  connect(fd: number, ip: number, port: number): Blocking<void>;
  accept(fd: number): Blocking<number>;            // returns a new fd
  recv(fd: number, max?: number): Blocking<Uint8Array>;  // empty return == EOF
  send(fd: number, data: Uint8Array | string): number;
  sendto(fd: number, ip: number, port: number, data: Uint8Array | string): number;
  recvfrom(fd: number): Blocking<Datagram>;        // empty data == no datagram (socket error)
  close(fd: number): void;
  print(line: string): void;                       // stdout -> console + terminal
}

// ---------- non-cloneable execution context (side table) ----------
// Two driver substrates, same engine-side contract. `gen` is the Phase-0 generator stand-in for
// the demo/reference programs. `wasm` runs a real compiled WebAssembly module (what the in-browser
// clang will emit) through the netsim-posix import boundary, suspending via a host-driven resume
// protocol: a syscall that must block records `wait` and the module returns status 1 (blocked); the
// host stores it as `pending` and re-enters start()/resume() when the awaited procNotify fires.
type Driver =
  | { kind: 'gen'; it: Prog }
  | { kind: 'wasm'; inst: WebAssembly.Instance; mem: WebAssembly.Memory; started: boolean };
interface Runner { driver: Driver; pending: WaitReq | null; wait: WaitReq | null }
const runners = new Map<string, Runner>();
let RID = 1;

// ---------- program registry ----------
type ProgramFn = (sys: Sys, argv: string[]) => Prog;
const PROGRAMS: Record<string, ProgramFn> = {
  // Iterative TCP echo server: accept a connection, echo until EOF, close, repeat.
  'echo-server': function* (sys, argv) {
    const port = Number(argv[0] ?? '7');
    const ls = sys.tcp(); sys.bind(ls, port); sys.listen(ls);
    sys.print(`listening on :${port}`);
    for (;;) {
      const c = yield* sys.accept(ls);
      sys.print('accepted a connection');
      for (;;) {
        const data = yield* sys.recv(c);
        if (data.length === 0) break;      // peer half-closed: EOF
        sys.send(c, data);                 // echo it back
      }
      sys.close(c);
      sys.print('connection closed');
    }
  },
  // TCP client: connect, send a line, read the reply, print it, close.
  'echo-client': function* (sys, argv) {
    const ip = ipToU32(argv[0] ?? '10.0.0.1'); const port = Number(argv[1] ?? '7');
    const msg = (argv.slice(2).join(' ') || 'hello world') + '\n';
    const fd = sys.tcp();
    try { yield* sys.connect(fd, ip, port); }
    catch (e) { sys.print(`connect failed: ${(e as Error).message}`); return; }
    sys.print(`connected to ${u32ToIp(ip)}:${port}`);
    sys.send(fd, msg);
    const reply = yield* sys.recv(fd);
    sys.print(`reply: ${dec(reply).replace(/\n$/, '')}`);
    sys.close(fd);
    sys.print('done');
  },
  // UDP echo server: bind a port, bounce each datagram back to its sender.
  'udp-echo-server': function* (sys, argv) {
    const port = Number(argv[0] ?? '7');
    const fd = sys.udp(); sys.bind(fd, port);
    sys.print(`listening on udp :${port}`);
    for (;;) {
      const dg = yield* sys.recvfrom(fd);
      if (dg.data.length === 0) continue;
      sys.print(`datagram from ${u32ToIp(dg.ip)}:${dg.port}`);
      sys.sendto(fd, dg.ip, dg.port, dg.data);
    }
  },
  // UDP client: send one datagram, wait for the reply (or report none).
  'udp-client': function* (sys, argv) {
    const ip = ipToU32(argv[0] ?? '10.0.0.1'); const port = Number(argv[1] ?? '7');
    const msg = (argv.slice(2).join(' ') || 'ping') + '\n';
    const fd = sys.udp();
    sys.sendto(fd, ip, port, msg);
    sys.print(`sent to ${u32ToIp(ip)}:${port}`);
    const dg = yield* sys.recvfrom(fd);
    sys.print(dg.data.length ? `reply: ${dec(dg.data).replace(/\n$/, '')}` : 'no reply');
    sys.close(fd);
    sys.print('done');
  },
};
export const PROGRAM_NAMES = Object.keys(PROGRAMS);

// ---------- helpers ----------
const rkey = (p: CProc) => p.rid;
function anySock(h: HostState, p: CProc, fd: number): Socket | null { const id = p.fds[fd]; return id === undefined ? null : (h.sockets[id] ?? null); }
function sockFor(h: HostState, p: CProc, fd: number): TcpSocket | null { const s = anySock(h, p, fd); return s && s.proto === 'tcp' ? s : null; }
function udpFor(h: HostState, p: CProc, fd: number): UdpSocket | null { const s = anySock(h, p, fd); return s && s.proto === 'udp' ? s : null; }
function allocFd(p: CProc, sockId: number): number { const fd = p.nextFd++; p.fds[fd] = sockId; return fd; }
function out(h: HostState, p: CProc, line: string) { p.stdout.push(line); if (p.stdout.length > 500) p.stdout.splice(0, p.stdout.length - 500); term(h, `[${p.name}] ${line}`); }

function makeSys(st: EngineState, h: HostState, p: CProc): Sys {
  return {
    tcp() { const s = tcpSocket(st, h, p.pid); return allocFd(p, s.id); },
    udp() { const s = udpSocket(h, p.pid); if (typeof s === 'string') throw new CError(s); return allocFd(p, s.id); },
    bind(fd, port) {
      const s = anySock(h, p, fd); if (!s) throw new CError('bad fd');
      if (s.proto === 'udp') { for (const o of Object.values(h.sockets)) if (o !== s && o.proto === 'udp' && o.localPort === port) throw new CError('Address already in use'); }
      s.localPort = port;
    },
    listen(fd) { const s = sockFor(h, p, fd); if (s) { const e = tcpListen(st, h, s, s.localPort); if (e) throw new CError(e); } },
    *connect(fd, ip, port) {
      const s = sockFor(h, p, fd); if (!s) throw new CError('bad fd');
      const e = tcpConnect(st, h, s, ip, port); if (e) throw new CError(e);
      for (;;) { if (s.state === 'ESTABLISHED') return; if (s.err) throw new CError(s.err); yield { kind: 'connected', sock: s.id }; }
    },
    *accept(fd) {
      const ls = sockFor(h, p, fd); if (!ls) throw new CError('bad fd');
      for (;;) { const c = tcpAccept(h, ls); if (c) return allocFd(p, c.id); yield { kind: 'accept', sock: ls.id }; }
    },
    *recv(fd, max) {
      for (;;) {
        const s = sockFor(h, p, fd);
        if (!s || s.state === 'CLOSED' || s.state === 'LAST_ACK') return new Uint8Array(0);
        const d = tcpRecv(st, h, s, max); if (d.length) return d;
        if (s.state === 'CLOSE_WAIT' || s.state === 'TIME_WAIT') return new Uint8Array(0); // EOF, buffer drained
        yield { kind: 'readable', sock: s.id };
      }
    },
    send(fd, data) { const s = sockFor(h, p, fd); if (!s) return -1; const b = typeof data === 'string' ? te.encode(data) : data; return tcpSend(st, h, s, b); },
    sendto(fd, ip, port, data) { const s = udpFor(h, p, fd); if (!s) return -1; const b = typeof data === 'string' ? te.encode(data) : data; const r = udpSend(st, h, s, ip, port, b); return r.status === 'ok' ? b.length : -1; },
    *recvfrom(fd) {
      for (;;) {
        const s = udpFor(h, p, fd); if (!s) return { data: new Uint8Array(0), ip: 0, port: 0 };
        const dg = s.rx.shift(); if (dg) return { data: dg.data, ip: dg.src, port: dg.sport };
        if (s.err) { s.err = null; return { data: new Uint8Array(0), ip: 0, port: 0 }; }   // e.g. ICMP port unreachable
        yield { kind: 'udprx', sock: s.id };
      }
    },
    close(fd) { const s = anySock(h, p, fd); if (s) { if (s.proto === 'tcp') tcpClose(st, h, s); else delete h.sockets[s.id]; } delete p.fds[fd]; },
    print(line) { out(h, p, line); },
  };
}

// ---------- scheduler ----------
/** Resume a program until it blocks again or exits. `pending` is cleared on entry. */
function drive(st: EngineState, h: HostState, p: CProc) {
  const r = runners.get(rkey(p)); if (!r) return;
  r.pending = null; p.blocked = null;
  try {
    if (r.driver.kind === 'gen') {
      const res = r.driver.it.next();
      if (res.done) { finish(st, h, p); return; }
      r.pending = res.value;
    } else {
      r.wait = null;
      const ex = r.driver.inst.exports as Record<string, (() => number) | undefined>;
      const status = r.driver.started ? ex.resume?.() ?? 0 : (r.driver.started = true, ex.start?.() ?? 0);
      if (status === 0) { finish(st, h, p); return; }   // 0 = exited
      if (!r.wait) { finish(st, h, p); return; }         // blocked but recorded nothing: treat as done
      r.pending = r.wait;
    }
  } catch (e) { out(h, p, `error: ${(e as Error).message}`); finish(st, h, p); return; }
  if (r.pending) p.blocked = { syscall: r.pending.kind, sock: r.pending.sock };
}
function finish(st: EngineState, h: HostState, p: CProc) {
  for (const fd of Object.keys(p.fds).map(Number)) { const id = p.fds[fd]; if (id === undefined) continue; const s = h.sockets[id]; if (s && s.proto === 'tcp' && s.state !== 'CLOSED') tcpClose(st, h, s); }
  p.done = true; p.blocked = null; runners.delete(rkey(p)); delete h.procs[p.pid];
}

// ---------- compile boundary ----------
// The contract the real in-browser clang will implement: source text in, a runnable program or a
// list of diagnostics out. Today's STUB cannot compile arbitrary C, so it performs structural
// checks (to exercise the diagnostics pipeline) and, on success, runs the reference build named by
// `name`. When clang lands it compiles `source` directly and `name` becomes just a label.
export type CompileResult = { ok: true; name: string } | { ok: false; diagnostics: CDiagnostic[] };
export function compile(source: string, name: string): CompileResult {
  const diags: CDiagnostic[] = [];
  const lines = source.split('\n');
  if (!/\bint\s+main\s*\(/.test(source)) diags.push({ line: 1, col: 1, message: "expected a definition of 'int main(...)'", severity: 'error' });
  const balance = (open: string, close: string, label: string) => {
    let depth = 0, badLine = 0;
    lines.forEach((ln, i) => { for (const ch of ln) { if (ch === open) depth++; else if (ch === close) { depth--; if (depth < 0 && !badLine) badLine = i + 1; } } });
    if (depth > 0) diags.push({ line: lines.length, col: 1, message: `unbalanced ${label}: missing '${close}'`, severity: 'error' });
    else if (depth < 0) diags.push({ line: badLine || 1, col: 1, message: `unbalanced ${label}: stray '${close}'`, severity: 'error' });
  };
  balance('{', '}', 'braces'); balance('(', ')', 'parentheses');
  if (diags.length) return { ok: false, diagnostics: diags };
  if (!PROGRAMS[name]) return { ok: false, diagnostics: [{ line: 1, col: 1, message: `no reference build for '${name}'`, severity: 'error' }] };
  return { ok: true, name };
}
/** Compile then start. `backend` selects the real nsC compiler vs the reference-build stub.
 *  Returns the running CProc, or the diagnostics that stopped it. */
export function compileAndStart(st: EngineState, h: HostState, source: string, name: string, argv: string[] = [], backend: 'clang' | 'nsc' | 'stub' = 'stub'): CProc | { diagnostics: CDiagnostic[] } {
  const asErr = (m: string): { diagnostics: CDiagnostic[] } => ({ diagnostics: [{ line: 1, col: 1, message: m, severity: 'error' }] });
  if (backend === 'nsc') {
    const r = nsCompile(source);
    if (!r.ok) return { diagnostics: r.diagnostics };
    const p = startWasmProgram(st, h, r.wasm, name, argv);
    return typeof p === 'string' ? asErr(p) : p;
  }
  const r = compile(source, name);
  if (!r.ok) return { diagnostics: r.diagnostics };
  const p = startProgram(st, h, r.name, argv);
  return typeof p === 'string' ? asErr(p) : p;
}

// ---------- public entry ----------
export function startProgram(st: EngineState, h: HostState, name: string, argv: string[] = []): CProc | string {
  const fn = PROGRAMS[name]; if (!fn) return `no such program: ${name}`;
  const pid = h.nextPid++; const rid = `r${RID++}`;
  const p: CProc = { kind: 'cprog', pid, rid, name, argv, fds: {}, nextFd: 3, blocked: null, stdout: [], done: false, exitCode: null };
  h.procs[pid] = p;
  const sys = makeSys(st, h, p);
  runners.set(rid, { driver: { kind: 'gen', it: fn(sys, argv) }, pending: null, wait: null });
  // Begin at the next time the engine runs, so Play / Step / Turbo start the program.
  // proc:<pid>:<what> timers already route to procTimer() -> cprogTimer() via hostTimer().
  p.blocked = { syscall: 'start' };
  timer(st, h.id, 0, `proc:${pid}:run`);
  return p;
}

// ---------- real WebAssembly programs (what the in-browser clang emits) ----------
// Instantiate a compiled module and run it exactly like a generator program: same CProc, same
// side-table runner, same procNotify-driven resume. The module imports the netsim-posix syscalls
// below; a blocking syscall records `wait` on the runner and returns a sentinel, and the module
// returns status 1 from start()/resume(). No wall-clock, no real socket: pure engine state.
export function startWasmProgram(st: EngineState, h: HostState, bytes: Uint8Array, name: string, argv: string[] = []): CProc | string {
  const pid = h.nextPid++; const rid = `r${RID++}`;
  const p: CProc = { kind: 'cprog', pid, rid, name, argv, fds: {}, nextFd: 3, blocked: null, stdout: [], done: false, exitCode: null };
  const runner: Runner = { driver: null as unknown as Driver, pending: null, wait: null };
  const ctx: { mem?: WebAssembly.Memory } = {};
  try {
    const mod = new WebAssembly.Module(bytes as unknown as BufferSource);
    const inst = new WebAssembly.Instance(mod, { env: wasmImports(st, h, p, runner, ctx) });
    const mem = inst.exports.memory;
    if (!(mem instanceof WebAssembly.Memory)) return 'program exports no memory';
    ctx.mem = mem;
    runner.driver = { kind: 'wasm', inst, mem, started: false };
  } catch (e) { return `instantiate failed: ${(e as Error).message}`; }
  h.procs[pid] = p; runners.set(rid, runner);
  p.blocked = { syscall: 'start' };
  timer(st, h.id, 0, `proc:${pid}:run`);
  return p;
}

// The netsim-posix syscall surface a wasm program imports as module "env". Buffers are passed as
// (ptr,len) into the module's own linear memory. Blocking calls record a wait and return a sentinel.
function wasmImports(st: EngineState, h: HostState, p: CProc, r: Runner, ctx: { mem?: WebAssembly.Memory }) {
  const u8 = () => new Uint8Array(ctx.mem!.buffer);
  const argInt = (i: number) => Number(p.argv[i] ?? 0);
  return {
    arg_ip: () => ipToU32(p.argv[0] ?? '10.0.0.1'),
    arg_port: () => argInt(1) || 7,
    sys_socket: (type: number) => { const s = type === 1 ? udpSocket(h, p.pid) : tcpSocket(st, h, p.pid); if (typeof s === 'string') return -1; return allocFd(p, s.id); },
    sys_bind: (fd: number, port: number) => { const s = anySock(h, p, fd); if (!s) return -1; s.localPort = port; return 0; },
    sys_listen: (fd: number) => { const s = sockFor(h, p, fd); if (!s) return -1; const e = tcpListen(st, h, s, s.localPort); return e ? -1 : 0; },
    sys_accept: (fd: number) => { const ls = sockFor(h, p, fd); if (!ls) return -1; const c = tcpAccept(h, ls); if (c) return allocFd(p, c.id); r.wait = { kind: 'accept', sock: ls.id }; return -2; },
    sys_connect: (fd: number, ip: number, port: number) => { const s = sockFor(h, p, fd); if (!s) return -1; const e = tcpConnect(st, h, s, ip, port); if (e) return -1; r.wait = { kind: 'connected', sock: s.id }; return 0; },
    sys_send: (fd: number, ptr: number, len: number) => { const s = sockFor(h, p, fd); if (!s) return -1; return tcpSend(st, h, s, u8().slice(ptr, ptr + len)); },
    sys_recv: (fd: number, ptr: number, len: number) => {
      const s = sockFor(h, p, fd); if (!s || s.state === 'CLOSED' || s.state === 'LAST_ACK') return 0;
      const d = tcpRecv(st, h, s, len); if (d.length) { u8().set(d, ptr); return d.length; }
      if (s.state === 'CLOSE_WAIT' || s.state === 'TIME_WAIT') return 0;    // EOF
      r.wait = { kind: 'readable', sock: s.id }; return -2;                 // would block
    },
    sys_sendto: (fd: number, ip: number, port: number, ptr: number, len: number) => { const s = udpFor(h, p, fd); if (!s) return -1; const res = udpSend(st, h, s, ip, port, u8().slice(ptr, ptr + len)); return res.status === 'ok' ? len : -1; },
    sys_recvfrom: (fd: number, ptr: number, len: number) => {
      const s = udpFor(h, p, fd); if (!s) return -1;
      const dg = s.rx.shift(); if (dg) { const n = Math.min(len, dg.data.length); u8().set(dg.data.subarray(0, n), ptr); return n; }
      if (s.err) { s.err = null; return 0; }
      r.wait = { kind: 'udprx', sock: s.id }; return -2;
    },
    sys_close: (fd: number) => { const s = anySock(h, p, fd); if (s) { if (s.proto === 'tcp') tcpClose(st, h, s); else delete h.sockets[s.id]; } delete p.fds[fd]; return 0; },
    sys_print: (ptr: number, len: number) => { out(h, p, dec(u8().slice(ptr, ptr + len)).replace(/\n$/, '')); },
  };
}

// ---------- engine hooks (wired from procs.ts) ----------
export function cprogTimer(st: EngineState, h: HostState, p: CProc, what: string, _data?: unknown) {
  if (what === 'run') drive(st, h, p);
}
export function cprogNotify(st: EngineState, h: HostState, p: CProc, ev: ProcEvent) {
  const r = runners.get(rkey(p)); if (!r || !r.pending) return;
  const w = r.pending; const sock = 'sock' in ev ? ev.sock : undefined;
  const hit =
    (w.kind === 'connected' && (ev.type === 'tcpConnected' || ev.type === 'tcpError') && sock === w.sock) ||
    (w.kind === 'readable' && (ev.type === 'tcpReadable' || ev.type === 'tcpEof' || ev.type === 'tcpError') && sock === w.sock) ||
    (w.kind === 'accept' && ev.type === 'tcpAccept' && sock === w.sock) ||
    (w.kind === 'udprx' && (ev.type === 'udpRx' || ev.type === 'icmpError') && sock === w.sock);
  if (hit) drive(st, h, p);
}
export function cprogKill(st: EngineState, h: HostState, p: CProc) { finish(st, h, p); }
