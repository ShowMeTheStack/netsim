// Runtime for programs built by the REAL in-browser clang toolchain (full C: structs, pointers,
// libc). A clang-built wasm "command" exports `_start` and imports WASI (`wasi_unstable.*`) plus our
// socket shim (`env.ns_sock_*` from nssock.c, supplying the socket-creation calls stock wasi-libc
// lacks). This file implements both surfaces against the NetSim engine so the program's syscalls
// move real packets on the simulated wire. Nothing touches a real socket; every call mutates only
// EngineState.
//
// Blocking (connect/recv/accept) is handled with ASYNCIFY: the linked module is post-processed by
// `wasm-opt --asyncify`, exposing asyncify_{start,stop}_{unwind,rewind}. A blocking syscall that has
// no result yet records what it waits on, unwinds the wasm stack (suspending the program), and
// returns to the engine event loop. When the awaited procNotify fires, the engine rewinds the stack
// back into the syscall, which now returns the ready value - exactly the resume contract the rest of
// the engine already speaks. Modules without asyncify exports run straight through (non-blocking).
//
// THREADS (pthreads) ride on the same Asyncify machinery as cooperative green fibers. The post-link
// pass (finalizeWasm) exports the linker's stack-pointer global as `__ns_sp`; each fiber gets its own
// C shadow stack (malloc'd) + its own Asyncify buffer, and a context switch saves/restores __ns_sp.
// One fiber runs at a time; a fiber yields control at a blocking syscall, pthread_yield, join, or a
// mutex/cond spin. That is why the mutex/cond primitives in nssock.c need no real atomics. When every
// fiber is blocked on I/O the process parks (as the single-threaded case always did); when the only
// runnable fibers are spinning on yield while I/O is pending, the scheduler hands control back to the
// engine on a short timer so virtual time can advance and the awaited packet can arrive.
import { term } from '../devices/host';
import { timer } from '../core';
import { tcpSocket, tcpListen, tcpConnect, tcpAccept, tcpSend, tcpRecv, tcpClose, tcpSendSpace } from '../stack/tcp';
import { udpSocket, udpSend } from '../stack/udp';
import { getScheduler } from '../cc/scheduler';
import type { EngineState, HostState, CProc, Socket } from '../types';

const EBADF = 8, EINTR = 27, ESPIPE = 70, ENOTSUP = 58;
const NS_EINTR = -4;                // sentinel returned to the shim's connect/accept/recvfrom/select/poll/epoll_wait wrappers
const POLLIN = 0x001, POLLOUT = 0x004, POLLERR = 0x008, POLLHUP = 0x010;
const EPOLLIN = 0x001, EPOLLOUT = 0x004, EPOLLERR = 0x008, EPOLLHUP = 0x010;
const SOCK_DGRAM = 5;               // WASI __WASI_FILETYPE_SOCKET_DGRAM (not Linux 2)
const ASYNC_STACK = 65536;          // bytes for a fiber's asyncify unwind buffer (heap-allocated via malloc)
const THREAD_STACK = 256 * 1024;    // bytes for a spawned thread's C shadow stack (heap-allocated)
const YIELD_QUANTUM = 1000;         // us of virtual time to yield to the engine when spinning on yield with I/O pending
const YIELD_CAP = 200000;           // hard bound on consecutive yields processed synchronously per scheduler pass

const NORMAL = 0, REWINDING = 2;    // asyncify_get_state() values

type WaitReq = { kind: 'connected' | 'readable' | 'accept' | 'udprx'; sock: number };
// A multiplexed wait (select/poll/epoll_wait): a set of socket ids to watch plus an optional deadline
// (virtual us; null = block forever). The blocking import recomputes readiness on resume, so only the
// watched socks + deadline need to persist across the suspension.
type MWait = { socks: number[]; deadline: number | null };
type Suspend = { kind: 'io'; wait: WaitReq } | { kind: 'mio' } | { kind: 'yield' } | { kind: 'join' } | { kind: 'exit' } | { kind: 'fork' } | { kind: 'exec' };
// One epoll instance's interest list: fd -> event mask + the opaque 64-bit user data to echo back.
type EReg = { fd: number; events: number; dataLo: number; dataHi: number };

// A fiber: one C thread of control. The main thread is fiber 0 (entry `_start`); pthread_create spawns
// fibers (entry `__ns_thread_run`, the trampoline that calls the start routine by table index).
interface Fiber {
  fid: number;                       // 0 = main; >0 = pthread_t
  entry: 'start' | 'thread';
  fn: number; arg: number;           // thread start routine (table index) + its argument
  sp: number;                        // saved C shadow-stack pointer (restored into __ns_sp before running)
  dataAddr: number; stackStart: number; stackEnd: number;   // this fiber's asyncify buffer
  state: 'new' | 'running' | 'ready' | 'blocked' | 'joinwait' | 'done';
  wait: WaitReq | null;              // what it blocks on (single-fd blocking call; state 'blocked')
  mwait: MWait | null;               // what it blocks on (select/poll/epoll_wait; state 'blocked')
  interrupted: boolean;              // a signal arrived while blocked: the syscall must return EINTR
  suspend: Suspend | null;           // why it last unwound (transient, read right after)
  forkReturn: number;                // value fork() returns on resume (child pid in parent, 0 in child)
  retval: number;                    // pthread return value (for join)
  joinTarget: number; joinSlot: number; joiners: number[];   // join bookkeeping
}
interface Ctx {
  inst: WebAssembly.Instance;
  mod: WebAssembly.Module;
  memory: WebAssembly.Memory;
  exp: Record<string, (...a: number[]) => number>;
  sp: WebAssembly.Global | null;     // exported stack-pointer global (null = no thread support)
  fibers: Fiber[]; curFid: number; nextTid: number; rrIdx: number; yieldStreak: number;
  epolls: Map<number, EReg[]>;       // epfd -> interest list (epoll_create/_ctl/_wait)
  execTo: Uint8Array | null; execArgv: string[];
  pid: number;
  handlers: Record<number, number>;  // signum -> handler function-pointer (table index)
  schedStep: number;                 // E3: monotonic scheduling-decision index (for the oracle)
}
const ctxs = new Map<string, Ctx>();
// Programs available to exec() by name (populated when a clang program is compiled/run).
const programs = new Map<string, Uint8Array>();
export function registerClangProgram(name: string, wasm: Uint8Array) { programs.set(name, wasm); }
function readCStr(dv: DataView, ptr: number): string { let s = ''; for (let i = ptr; ; i++) { const b = dv.getUint8(i); if (!b) break; s += String.fromCharCode(b); } return s; }
const td = new TextDecoder();
class ProcExit { constructor(public code: number) {} }

const dvOf = (m: WebAssembly.Memory) => new DataView(m.buffer);
const u8Of = (m: WebAssembly.Memory) => new Uint8Array(m.buffer);
const curFiber = (c: Ctx) => c.fibers.find(f => f.fid === c.curFid)!;
const live = (c: Ctx) => c.fibers.filter(f => f.state !== 'done');
const hasIOBlocked = (c: Ctx) => c.fibers.some(f => f.state === 'blocked');

function newFiber(c: Ctx, entry: 'start' | 'thread', fn = 0, arg = 0): Fiber | null {
  if (typeof c.exp.malloc !== 'function') return null;
  const dataAddr = c.exp.malloc(8 + ASYNC_STACK); if (!dataAddr) return null;
  let sp = 0;
  if (entry === 'thread') { const base = c.exp.malloc(THREAD_STACK); if (!base) return null; sp = base + THREAD_STACK; }
  else sp = c.sp ? c.sp.value : 0;   // main keeps the default stack
  const fid = entry === 'start' ? 0 : c.nextTid++;
  const f: Fiber = { fid, entry, fn, arg, sp, dataAddr, stackStart: dataAddr + 8, stackEnd: dataAddr + 8 + ASYNC_STACK,
    state: 'new', wait: null, mwait: null, interrupted: false, suspend: null, forkReturn: 0, retval: 0, joinTarget: -1, joinSlot: 0, joiners: [] };
  c.fibers.push(f); return f;
}

export function startClangProgram(st: EngineState, h: HostState, bytes: Uint8Array, name: string, argv: string[] = []): CProc | string {
  const pid = h.nextPid++; const rid = `c${pid}:${h.id}`;
  const p: CProc = { kind: 'cprog', pid, rid, name, argv, fds: {}, nextFd: 3, blocked: null, stdout: [], done: false, exitCode: null };
  try {
    const mod = new WebAssembly.Module(bytes as unknown as BufferSource);
    const memory = new WebAssembly.Memory({ initial: 258, maximum: 16384 });   // runtime-owned, so fork() can clone it
    const c: Ctx = { inst: null as unknown as WebAssembly.Instance, mod, memory, exp: {}, sp: null, fibers: [], curFid: 0, nextTid: 1, rrIdx: 0, yieldStreak: 0, epolls: new Map(), execTo: null, execArgv: [], pid, handlers: {}, schedStep: 0 };
    ctxs.set(rid, c);
    const imports = buildImports(st, h, p, rid) as { wasi_unstable: Record<string, unknown>; env: Record<string, unknown> };
    imports.env.memory = memory;
    const inst = new WebAssembly.Instance(mod, imports as unknown as WebAssembly.Imports);
    c.inst = inst; c.exp = inst.exports as unknown as Ctx['exp'];
    c.sp = (inst.exports as Record<string, unknown>).__ns_sp as WebAssembly.Global ?? null;
    if (typeof c.exp.asyncify_start_unwind === 'function') {
      // The asyncify buffer must live in heap memory the program's allocator owns, or malloc (called
      // by printf etc.) would hand the same bytes out and corrupt the saved stack. Allocate via the
      // module's exported malloc. Each fiber gets its own; here, the main fiber.
      if (typeof c.exp.malloc !== 'function') { ctxs.delete(rid); return 'asyncify program must export malloc'; }
      if (!newFiber(c, 'start')) { ctxs.delete(rid); return 'malloc for asyncify buffer failed'; }
    } else {
      // Non-asyncify module (never blocks): still represent it as a single fiber for a uniform driver.
      c.fibers.push({ fid: 0, entry: 'start', fn: 0, arg: 0, sp: 0, dataAddr: 0, stackStart: 0, stackEnd: 0, state: 'new', wait: null, mwait: null, interrupted: false, suspend: null, forkReturn: 0, retval: 0, joinTarget: -1, joinSlot: 0, joiners: [] });
    }
  } catch (e) { ctxs.delete(rid); return `instantiate failed: ${(e as Error).message}`; }
  h.procs[pid] = p; p.blocked = { syscall: 'start' };
  timer(st, h.id, 0, `proc:${pid}:run`);
  return p;
}

function out(h: HostState, p: CProc, s: string) { for (const line of s.split('\n')) { if (line === '') continue; p.stdout.push(line); term(h, `[${p.name}] ${line}`); } if (p.stdout.length > 500) p.stdout.splice(0, p.stdout.length - 500); }
function readSockaddr(dv: DataView, off: number) { return { port: dv.getUint16(off + 2, false), ip: dv.getUint32(off + 4, false) }; }
const asyncifyState = (c: Ctx) => (c.exp.asyncify_get_state ? c.exp.asyncify_get_state() : NORMAL);
// Suspend the current fiber: stash its asyncify buffer pointers and start the unwind. `reason` tells
// the scheduler (in afterRun) what to do once the stack has unwound back to it.
function suspend(c: Ctx, reason: Suspend) { const f = curFiber(c); const dv = dvOf(c.memory); dv.setUint32(f.dataAddr, f.stackStart, true); dv.setUint32(f.dataAddr + 4, f.stackEnd, true); f.suspend = reason; c.exp.asyncify_start_unwind!(f.dataAddr); }

// ---- readiness, as select/poll/epoll see it (never consuming) ----
function sReadable(s: Socket): boolean {
  if (s.proto === 'udp') return s.rx.length > 0 || !!s.err;
  if (s.err) return true;
  if (s.state === 'LISTEN') return !!(s.listenBacklog && s.listenBacklog.length > 0);   // acceptable
  if (s.recvBuf.length > 0) return true;
  return s.state === 'CLOSE_WAIT' || s.state === 'TIME_WAIT' || s.state === 'CLOSED' || s.state === 'LAST_ACK';   // EOF
}
function sWritable(s: Socket): boolean {
  if (s.proto === 'udp') return true;
  return (s.state === 'ESTABLISHED' || s.state === 'CLOSE_WAIT') && tcpSendSpace(s) > 0;
}
function sError(s: Socket): boolean { return !!s.err; }

// wasi-libc fd_set is { size_t __nfds @0; int __fds[] @4 } - a list of the set fds, not a bitmask.
function readFdSet(dv: DataView, ptr: number): number[] { if (!ptr) return []; const n = dv.getUint32(ptr, true); const out: number[] = []; for (let i = 0; i < n; i++) out.push(dv.getInt32(ptr + 4 + i * 4, true)); return out; }
function writeFdSet(dv: DataView, ptr: number, fds: number[]) { if (!ptr) return; dv.setUint32(ptr, fds.length, true); fds.forEach((fd, i) => dv.setInt32(ptr + 4 + i * 4, fd, true)); }

function buildImports(st: EngineState, h: HostState, p: CProc, rid: string) {
  const C = () => ctxs.get(rid)!;
  const dv = () => dvOf(C().memory); const u8 = () => u8Of(C().memory);
  const asyncify = () => typeof C().exp.asyncify_start_unwind === 'function';
  const sockOf = (fd: number): Socket | null => { const id = p.fds[fd]; return id === undefined ? null : h.sockets[id] ?? null; };
  // gather iovec byte ranges (each entry: ptr u32, len u32) -> flat Uint8Array copy / targets
  const iovecs = (ptr: number, len: number) => { const d = dv(); const out: { base: number; len: number }[] = []; for (let i = 0; i < len; i++) out.push({ base: d.getUint32(ptr + i * 8, true), len: d.getUint32(ptr + i * 8 + 4, true) }); return out; };

  const wasi_unstable = {
    args_sizes_get: (argcPtr: number, bufPtr: number) => { const d = dv(); d.setUint32(argcPtr, p.argv.length + 1, true); let n = p.name.length + 1; for (const a of p.argv) n += a.length + 1; d.setUint32(bufPtr, n, true); return 0; },
    args_get: (argvPtr: number, bufPtr: number) => { const d = dv(); const bytes = u8(); let ptr = bufPtr; const w = (s: string, slot: number) => { d.setUint32(slot, ptr, true); for (let i = 0; i < s.length; i++) bytes[ptr++] = s.charCodeAt(i); bytes[ptr++] = 0; }; w(p.name, argvPtr); p.argv.forEach((a, i) => w(a, argvPtr + 4 * (i + 1))); return 0; },
    environ_sizes_get: (cPtr: number, bufPtr: number) => { const d = dv(); d.setUint32(cPtr, 0, true); d.setUint32(bufPtr, 0, true); return 0; },
    environ_get: () => 0,
    fd_prestat_get: () => EBADF, fd_prestat_dir_name: () => EBADF,
    fd_fdstat_get: (fd: number, ptr: number) => { const d = dv(); d.setUint8(ptr, fd <= 2 ? 2 : 6); d.setUint8(ptr + 1, 0); d.setBigUint64(ptr + 8, 0n, true); d.setBigUint64(ptr + 16, 0n, true); return 0; },
    fd_seek: () => ESPIPE,
    fd_close: (fd: number) => { const s = sockOf(fd); if (s) { if (s.proto === 'tcp') tcpClose(st, h, s); else delete h.sockets[s.id]; } const c = C(); if (c.epolls.has(fd)) c.epolls.delete(fd); delete p.fds[fd]; return 0; },
    fd_write: (fd: number, iovs: number, iovsLen: number, nwritten: number) => { const bytes = u8(); const chunks: number[] = []; let total = 0; for (const v of iovecs(iovs, iovsLen)) { for (let j = 0; j < v.len; j++) chunks.push(bytes[v.base + j]!); total += v.len; } if (fd === 1 || fd === 2) out(h, p, td.decode(new Uint8Array(chunks))); dv().setUint32(nwritten, total, true); return 0; },
    fd_read: () => EBADF,
    clock_time_get: (_id: number, _p: number, ptr: number) => { dv().setBigUint64(ptr, BigInt(Math.round(st.time * 1000)), true); return 0; },
    random_get: (ptr: number, len: number) => { const bytes = u8(); for (let i = 0; i < len; i++) bytes[ptr + i] = (st.seq + i) & 0xff; return 0; },
    poll_oneoff: () => ENOTSUP,
    proc_exit: (code: number) => { throw new ProcExit(code); },
    // connected-socket send (non-blocking) / recv (blocking via asyncify)
    sock_send: (fd: number, si: number, siLen: number, _f: number, soPtr: number) => { const s = sockOf(fd); if (!s || s.proto !== 'tcp') return EBADF; const bytes = u8(); const buf: number[] = []; for (const v of iovecs(si, siLen)) for (let j = 0; j < v.len; j++) buf.push(bytes[v.base + j]!); tcpSend(st, h, s, new Uint8Array(buf)); dv().setUint32(soPtr, buf.length, true); return 0; },
    sock_recv: (fd: number, ri: number, riLen: number, _f: number, roData: number, roFlags: number) => {
      const c = C(); if (asyncifyState(c) === REWINDING) { c.exp.asyncify_stop_rewind!(); const f = curFiber(c); if (f.interrupted) { f.interrupted = false; return EINTR; } }
      const s = sockOf(fd); if (!s || s.proto !== 'tcp') return EBADF;
      const cap = iovecs(ri, riLen).reduce((a, v) => a + v.len, 0);
      const data = tcpRecv(st, h, s, cap);
      if (data.length === 0 && s.state !== 'CLOSE_WAIT' && s.state !== 'TIME_WAIT' && s.state !== 'CLOSED' && s.state !== 'LAST_ACK') { if (asyncify()) suspend(c, { kind: 'io', wait: { kind: 'readable', sock: s.id } }); return 0; }
      const d = dv(); const bytes = u8(); let off = 0; for (const v of iovecs(ri, riLen)) { const take = Math.min(v.len, data.length - off); for (let j = 0; j < take; j++) bytes[v.base + j] = data[off + j]!; off += take; }
      d.setUint32(roData, data.length, true); d.setUint16(roFlags, 0, true);   // ro_flags is a WASI u16
      return 0;
    },
    sock_shutdown: () => 0,
  };

  const env = {
    ns_sock_socket: (_d: number, type: number) => { const s = type === SOCK_DGRAM ? udpSocket(h, p.pid) : tcpSocket(st, h, p.pid); if (typeof s === 'string') return -1; const fd = p.nextFd++; p.fds[fd] = s.id; return fd; },
    ns_sock_sendto: (fd: number, buf: number, len: number, _f: number, addr: number) => { const s = sockOf(fd); if (!s || s.proto !== 'udp') return -1; const { ip, port } = readSockaddr(dv(), addr); const r = udpSend(st, h, s, ip, port, u8().slice(buf, buf + len)); return r.status === 'ok' ? len : -1; },
    ns_sock_recvfrom: (fd: number, buf: number, len: number, _f: number, addr: number) => {
      const c = C(); if (asyncifyState(c) === REWINDING) { c.exp.asyncify_stop_rewind!(); const f = curFiber(c); if (f.interrupted) { f.interrupted = false; return NS_EINTR; } }
      const s = sockOf(fd); if (!s || s.proto !== 'udp') return -1;
      const dg = s.rx.shift();
      if (!dg) { if (s.err) { s.err = null; return 0; } if (asyncify()) suspend(c, { kind: 'io', wait: { kind: 'udprx', sock: s.id } }); return 0; }
      const n = Math.min(len, dg.data.length); u8().set(dg.data.subarray(0, n), buf);
      if (addr) { const d = dv(); d.setUint16(addr, 2, true); d.setUint16(addr + 2, dg.sport, false); d.setUint32(addr + 4, dg.src, false); }
      return n;
    },
    ns_sock_bind: (fd: number, addr: number) => { const s = sockOf(fd); if (!s) return -1; s.localPort = readSockaddr(dv(), addr).port; return 0; },
    ns_sock_connect: (fd: number, addr: number) => {
      const c = C(); if (asyncifyState(c) === REWINDING) { c.exp.asyncify_stop_rewind!(); const f = curFiber(c); if (f.interrupted) { f.interrupted = false; return NS_EINTR; } const s = sockOf(fd); return s && s.proto === 'tcp' && s.state === 'ESTABLISHED' ? 0 : -1; }
      const s = sockOf(fd); if (!s || s.proto !== 'tcp') return -1;
      const { ip, port } = readSockaddr(dv(), addr); const e = tcpConnect(st, h, s, ip, port); if (e) return -1;
      if (asyncify()) suspend(c, { kind: 'io', wait: { kind: 'connected', sock: s.id } }); return 0;
    },
    ns_getpid: () => p.pid,
    ns_waitpid: () => -1,   // reaping is a stub for now; fork()'d children run to completion on their own
    ns_fork: () => {
      const c = C();
      if (asyncifyState(c) === REWINDING) { c.exp.asyncify_stop_rewind!(); return curFiber(c).forkReturn; }
      if (!asyncify()) return -1;
      suspend(c, { kind: 'fork' }); return 0;   // doFork runs from afterRun
    },
    ns_exec: (pathPtr: number, argvPtr: number) => {
      const c = C(); if (!asyncify()) return -1;
      const d = dv(); const path = readCStr(d, pathPtr);
      const wasm = programs.get(path) ?? programs.get(path.replace(/^.*\//, ''));
      if (!wasm) return -1;   // no such program: exec fails, caller continues
      const args: string[] = []; if (argvPtr) for (let i = 0; ; i++) { const sp = d.getUint32(argvPtr + i * 4, true); if (!sp) break; args.push(readCStr(d, sp)); }
      c.execTo = wasm; c.execArgv = args.length ? args.slice(1) : c.execArgv;   // drop argv[0] (the program name)
      suspend(c, { kind: 'exec' }); return 0;   // abandon current image; doExec runs from afterRun
    },
    ns_signal: (sig: number, fnptr: number) => { const c = C(); const old = c.handlers[sig] ?? 0; if (fnptr) c.handlers[sig] = fnptr; else delete c.handlers[sig]; return old; },
    ns_raise: (sig: number) => { deliver(st, h, p, C(), sig); return 0; },
    ns_kill: (targetPid: number, sig: number) => { const tc = ctxs.get(`c${targetPid}:${h.id}`); const tp = h.procs[targetPid]; if (!tc || !tp) return -1; deliver(st, h, tp as CProc, tc, sig); return 0; },
    ns_alarm: (secs: number) => { timer(st, h.id, secs * 1_000_000, `proc:${p.pid}:alarm`); return 0; },
    ns_sock_listen: (fd: number) => { const s = sockOf(fd); if (!s || s.proto !== 'tcp') return -1; return tcpListen(st, h, s, s.localPort) ? -1 : 0; },
    ns_sock_accept: (fd: number) => {
      const c = C(); const ls = sockOf(fd); if (!ls || ls.proto !== 'tcp') return -1;
      if (asyncifyState(c) === REWINDING) { c.exp.asyncify_stop_rewind!(); const f = curFiber(c); if (f.interrupted) { f.interrupted = false; return NS_EINTR; } }
      const child = tcpAccept(h, ls); if (child) { const cfd = p.nextFd++; p.fds[cfd] = child.id; return cfd; }
      if (asyncify()) suspend(c, { kind: 'io', wait: { kind: 'accept', sock: ls.id } }); return 0;
    },
    // ---- I/O multiplexing: select / poll / epoll (block on a SET of fds, with an optional timeout) ----
    ns_select: (_nfds: number, rptr: number, wptr: number, eptr: number, tptr: number) => {
      const c = C(); const f = curFiber(c); const d = dv();
      const resuming = asyncifyState(c) === REWINDING;
      if (resuming) { c.exp.asyncify_stop_rewind!(); if (f.interrupted) { f.interrupted = false; f.mwait = null; return NS_EINTR; } }
      const rfds = readFdSet(d, rptr), wfds = readFdSet(d, wptr), efds = readFdSet(d, eptr);
      const rr: number[] = [], wr: number[] = [], er: number[] = [];
      for (const fd of rfds) { const s = sockOf(fd); if (s && sReadable(s)) rr.push(fd); }
      for (const fd of wfds) { const s = sockOf(fd); if (s && sWritable(s)) wr.push(fd); }
      for (const fd of efds) { const s = sockOf(fd); if (s && sError(s)) er.push(fd); }
      const ready = rr.length + wr.length + er.length;
      let infinite = false, nonblock = false, deadline = 0;
      if (!resuming) { if (tptr === 0) infinite = true; else { const sec = Number(d.getBigInt64(tptr, true)); const usec = Number(d.getBigInt64(tptr + 8, true)); if (sec === 0 && usec === 0) nonblock = true; else deadline = st.time + sec * 1e6 + usec; } }
      const timedOut = resuming && f.mwait !== null && f.mwait.deadline !== null && st.time >= f.mwait.deadline;
      if (ready > 0 || nonblock || timedOut) { writeFdSet(d, rptr, rr); writeFdSet(d, wptr, wr); writeFdSet(d, eptr, er); f.mwait = null; return ready; }
      if (!resuming) { const socks = [...new Set([...rfds, ...wfds, ...efds].map(fd => { const s = sockOf(fd); return s ? s.id : -1; }).filter(x => x >= 0))]; f.mwait = { socks, deadline: infinite ? null : deadline }; if (!infinite) timer(st, h.id, Math.max(0, deadline - st.time), `proc:${p.pid}:iowake`); }
      suspend(c, { kind: 'mio' }); return 0;
    },
    ns_poll: (fptr: number, nfds: number, timeoutMs: number) => {
      const c = C(); const f = curFiber(c); const d = dv();
      const resuming = asyncifyState(c) === REWINDING;
      if (resuming) { c.exp.asyncify_stop_rewind!(); if (f.interrupted) { f.interrupted = false; f.mwait = null; return NS_EINTR; } }
      let ready = 0; const socks: number[] = [];
      for (let i = 0; i < nfds; i++) {
        const base = fptr + i * 8; const fd = d.getInt32(base, true); const events = d.getUint16(base + 4, true);
        let rev = 0; const s = fd >= 0 ? sockOf(fd) : null;
        if (s) { if ((events & POLLIN) && sReadable(s)) rev |= POLLIN; if ((events & POLLOUT) && sWritable(s)) rev |= POLLOUT; if (sError(s)) rev |= POLLERR; socks.push(s.id); }
        d.setUint16(base + 6, rev, true); if (rev) ready++;
      }
      const timedOut = resuming && f.mwait !== null && f.mwait.deadline !== null && st.time >= f.mwait.deadline;
      const nonblock = !resuming && timeoutMs === 0;
      if (ready > 0 || nonblock || timedOut) { f.mwait = null; return ready; }
      if (!resuming) { const infinite = timeoutMs < 0; f.mwait = { socks: [...new Set(socks)], deadline: infinite ? null : st.time + timeoutMs * 1000 }; if (!infinite) timer(st, h.id, Math.max(0, timeoutMs * 1000), `proc:${p.pid}:iowake`); }
      suspend(c, { kind: 'mio' }); return 0;
    },
    ns_epoll_create: () => { const c = C(); const epfd = p.nextFd++; c.epolls.set(epfd, []); return epfd; },
    ns_epoll_ctl: (epfd: number, op: number, fd: number, evptr: number) => {
      const c = C(); const reg = c.epolls.get(epfd); if (!reg) return -1; const d = dv();
      if (op === 1 || op === 3) {   // ADD / MOD
        const events = evptr ? d.getUint32(evptr, true) : 0; const lo = evptr ? d.getUint32(evptr + 8, true) : 0; const hi = evptr ? d.getUint32(evptr + 12, true) : 0;
        const ex = reg.find(e => e.fd === fd);
        if (op === 1 && ex) return -1; if (op === 3 && !ex) return -1;
        if (ex) { ex.events = events; ex.dataLo = lo; ex.dataHi = hi; } else reg.push({ fd, events, dataLo: lo, dataHi: hi });
        return 0;
      }
      if (op === 2) { const i = reg.findIndex(e => e.fd === fd); if (i < 0) return -1; reg.splice(i, 1); return 0; }   // DEL
      return -1;
    },
    ns_epoll_wait: (epfd: number, evptr: number, maxevents: number, timeoutMs: number) => {
      const c = C(); const f = curFiber(c); const d = dv(); const reg = c.epolls.get(epfd); if (!reg) return -1;
      const resuming = asyncifyState(c) === REWINDING;
      if (resuming) { c.exp.asyncify_stop_rewind!(); if (f.interrupted) { f.interrupted = false; f.mwait = null; return NS_EINTR; } }
      const out: { ev: number; lo: number; hi: number }[] = []; const socks: number[] = [];
      for (const e of reg) { const s = sockOf(e.fd); if (!s) continue; socks.push(s.id); let ev = 0; if ((e.events & EPOLLIN) && sReadable(s)) ev |= EPOLLIN; if ((e.events & EPOLLOUT) && sWritable(s)) ev |= EPOLLOUT; if (sError(s)) ev |= EPOLLERR; if (ev && out.length < maxevents) out.push({ ev, lo: e.dataLo, hi: e.dataHi }); }
      const ready = out.length;
      const timedOut = resuming && f.mwait !== null && f.mwait.deadline !== null && st.time >= f.mwait.deadline;
      const nonblock = !resuming && timeoutMs === 0;
      if (ready > 0 || nonblock || timedOut) { out.forEach((o, i) => { const base = evptr + i * 16; d.setUint32(base, o.ev, true); d.setUint32(base + 8, o.lo, true); d.setUint32(base + 12, o.hi, true); }); f.mwait = null; return ready; }
      if (!resuming) { const infinite = timeoutMs < 0; f.mwait = { socks: [...new Set(socks)], deadline: infinite ? null : st.time + timeoutMs * 1000 }; if (!infinite) timer(st, h.id, Math.max(0, timeoutMs * 1000), `proc:${p.pid}:iowake`); }
      suspend(c, { kind: 'mio' }); return 0;
    },
    // ---- pthreads (cooperative green fibers) ----
    ns_yield: () => { const c = C(); if (asyncifyState(c) === REWINDING) { c.exp.asyncify_stop_rewind!(); return; } suspend(c, { kind: 'yield' }); },
    ns_thread_self: () => C().curFid,
    ns_thread_create: (fn: number, arg: number) => { const c = C(); if (!c.sp || !asyncify()) return -1; const f = newFiber(c, 'thread', fn, arg); return f ? f.fid : -1; },
    ns_thread_exit: (ret: number) => { const c = C(); if (asyncifyState(c) === REWINDING) { c.exp.asyncify_stop_rewind!(); return; } curFiber(c).retval = ret; suspend(c, { kind: 'exit' }); },
    ns_thread_join: (tid: number, slot: number) => {
      const c = C(); const me = curFiber(c);
      if (asyncifyState(c) === REWINDING) { c.exp.asyncify_stop_rewind!(); const t = c.fibers.find(f => f.fid === tid); if (slot && t) dv().setUint32(slot, t.retval >>> 0, true); return 0; }
      const t = c.fibers.find(f => f.fid === tid);
      if (!t || t.state === 'done') { if (slot && t) dv().setUint32(slot, t.retval >>> 0, true); return 0; }   // already finished
      me.joinTarget = tid; me.joinSlot = slot; t.joiners.push(me.fid); suspend(c, { kind: 'join' }); return 0;
    },
  };
  return { wasi_unstable, env };
}

// ---- driver: the cooperative scheduler ----
// Run one fiber until it unwinds (block/yield/join/exit/fork/exec) or returns. Returns an outcome tag
// the scheduler uses to decide what to run next.
function runFiber(st: EngineState, h: HostState, p: CProc, c: Ctx, f: Fiber): 'process-done' | 'blocked' | 'yield' | 'progress' {
  c.curFid = f.fid; f.suspend = null;
  if (c.sp) c.sp.value = f.sp;
  const rewind = f.state === 'ready';
  f.state = 'running';
  try {
    if (rewind) c.exp.asyncify_start_rewind!(f.dataAddr);
    if (f.entry === 'start') c.exp._start!(); else c.exp.__ns_thread_run!(f.fn, f.arg);
  } catch (e) {
    if (e instanceof ProcExit) { p.exitCode = e.code; finishClang(st, h, p); return 'process-done'; }
    out(h, p, `runtime error: ${(e as Error).message}`); finishClang(st, h, p); return 'process-done';
  }
  if (asyncifyState(c) !== NORMAL) {           // it unwound: inspect why
    c.exp.asyncify_stop_unwind!();
    if (c.sp) f.sp = c.sp.value;               // save this fiber's shadow-stack pointer
    const r = f.suspend!;
    if (r.kind === 'io') { f.wait = r.wait; f.state = 'blocked'; p.blocked = { syscall: r.wait.kind, sock: r.wait.sock }; return 'blocked'; }
    if (r.kind === 'mio') { f.wait = null; f.state = 'blocked'; p.blocked = { syscall: 'select' }; return 'blocked'; }
    if (r.kind === 'yield') { f.state = 'ready'; return 'yield'; }
    if (r.kind === 'join') { f.state = 'joinwait'; return 'yield'; }
    if (r.kind === 'exit') { finishFiber(c, f); return 'progress'; }
    if (r.kind === 'fork') { f.state = 'ready'; doFork(st, h, p, c, f); return 'progress'; }
    if (r.kind === 'exec') { doExec(st, h, p, c, f); return 'progress'; }
  }
  // returned normally
  if (f.entry === 'start') { if (p.exitCode === null) p.exitCode = 0; finishClang(st, h, p); return 'process-done'; }
  finishFiber(c, f); return 'progress';
}

function pickRunnable(c: Ctx): Fiber | null {
  const sch = getScheduler();
  if (sch) {   // E3: an oracle chooses the next runnable fiber (headless search only)
    const runnable = c.fibers.filter(f => f.state === 'new' || f.state === 'ready');
    if (runnable.length === 0) return null;
    const fid = sch.choose({ pid: c.pid, step: c.schedStep++, runnable: runnable.map(f => f.fid) });
    return runnable.find(f => f.fid === fid) ?? runnable[0]!;
  }
  const n = c.fibers.length;   // default: round-robin, bit-identical to before
  for (let i = 0; i < n; i++) { const f = c.fibers[(c.rrIdx + i) % n]!; if (f.state === 'new' || f.state === 'ready') { c.rrIdx = (c.rrIdx + i + 1) % n; return f; } }
  return null;
}

/** E3: a canonical summary of every live program's fibers, for search-state deduplication. */
export function clangSchedSummary(): string {
  const parts: string[] = [];
  for (const [rid, c] of ctxs) for (const f of c.fibers) if (f.state !== 'done') parts.push(`${rid}#${f.fid}:${f.state}:${f.wait ? f.wait.kind + f.wait.sock : f.mwait ? 'm' : ''}`);
  return parts.sort().join('|');
}

function schedule(st: EngineState, h: HostState, p: CProc, c: Ctx) {
  for (;;) {
    const f = pickRunnable(c);
    if (!f) break;
    const r = runFiber(st, h, p, c, f);
    if (r === 'process-done') return;
    c.yieldStreak = r === 'yield' ? c.yieldStreak + 1 : 0;
    // A full round of pure yields while a socket read/accept is pending means no further progress is
    // possible until virtual time advances and the packet arrives. Hand control back to the engine on
    // a short timer so it can deliver that I/O, then resume. (The runaway cap guards pure-spin loops.)
    if ((c.yieldStreak >= live(c).length && hasIOBlocked(c)) || c.yieldStreak > YIELD_CAP) { parkYield(st, h, p, c); return; }
  }
  const alive = live(c);
  if (alive.length === 0) { finishClang(st, h, p); return; }
  if (hasIOBlocked(c)) { const b = c.fibers.find(f => f.state === 'blocked')!; p.blocked = b.wait ? { syscall: b.wait.kind, sock: b.wait.sock } : { syscall: 'select' }; return; }  // park for a procNotify (or an iowake timer)
  // Nobody runnable, nobody on I/O, not all done: a join/cond deadlock. End rather than hang.
  out(h, p, 'deadlock: all threads blocked with no way to make progress'); finishClang(st, h, p);
}
function parkYield(st: EngineState, h: HostState, p: CProc, c: Ctx) { c.yieldStreak = 0; p.blocked = { syscall: 'yield' }; timer(st, h.id, YIELD_QUANTUM, `proc:${p.pid}:run`); }

// A spawned fiber finished (returned, or pthread_exit): mark done and wake anyone joined on it.
function finishFiber(c: Ctx, f: Fiber) {
  f.state = 'done';
  for (const jid of f.joiners) { const j = c.fibers.find(x => x.fid === jid); if (j && j.state === 'joinwait') j.state = 'ready'; }
  f.joiners = [];
}

// fork(): the calling fiber unwound at the fork() call with its full stack saved in linear memory.
// Clone the whole memory into a new process with a single fiber (the caller - POSIX fork in a threaded
// process keeps only the calling thread), then resume both: the fork() import returns the child pid to
// the parent and 0 to the child, so each continues exactly at the fork() call. (This wasi-libc is
// --no-threads/no-fork; this is real multi-process C, proven safe in isolation first.)
function doFork(st: EngineState, h: HostState, parent: CProc, pc: Ctx, caller: Fiber) {
  const childPid = h.nextPid++; const childRid = `c${childPid}:${h.id}`;
  const child: CProc = { kind: 'cprog', pid: childPid, rid: childRid, name: parent.name, argv: parent.argv, fds: { ...parent.fds }, nextFd: parent.nextFd, blocked: null, stdout: [], done: false, exitCode: null };
  const pages = pc.memory.buffer.byteLength / 65536;
  const childMem = new WebAssembly.Memory({ initial: pages, maximum: 16384 });
  new Uint8Array(childMem.buffer).set(new Uint8Array(pc.memory.buffer));   // byte-for-byte clone at the fork point
  const cc: Ctx = { inst: null as unknown as WebAssembly.Instance, mod: pc.mod, memory: childMem, exp: {}, sp: null, fibers: [], curFid: caller.fid, nextTid: pc.nextTid, rrIdx: 0, yieldStreak: 0, epolls: new Map(), execTo: null, execArgv: [], pid: childPid, handlers: { ...pc.handlers }, schedStep: 0 };
  ctxs.set(childRid, cc);
  const imports = buildImports(st, h, child, childRid) as { wasi_unstable: Record<string, unknown>; env: Record<string, unknown> };
  imports.env.memory = childMem;
  cc.inst = new WebAssembly.Instance(pc.mod, imports as unknown as WebAssembly.Imports); cc.exp = cc.inst.exports as unknown as Ctx['exp'];
  cc.sp = (cc.inst.exports as Record<string, unknown>).__ns_sp as WebAssembly.Global ?? null;
  // the child has exactly one fiber: a clone of the caller (same asyncify buffer + shadow stack, since
  // memory is identical), poised to resume at the fork() call and return 0.
  cc.fibers.push({ ...caller, forkReturn: 0, state: 'ready', suspend: null, mwait: null, interrupted: false, joiners: [] });
  h.procs[childPid] = child; child.blocked = { syscall: 'fork' };
  timer(st, h.id, 0, `proc:${childPid}:run`);
  caller.forkReturn = childPid;   // parent resumes with the child pid; scheduler reruns it (state 'ready')
}
// exec(): replace the process image. Discard the current instance, instantiate the new program's wasm
// with a fresh memory (exec does NOT preserve memory) and a fresh single main fiber, but keep the pid
// and fd table, then run its main() from the top. The classic fork()+exec() server pattern works on
// top of this.
function doExec(st: EngineState, h: HostState, p: CProc, c: Ctx, _caller: Fiber) {
  const wasm = c.execTo!; c.execTo = null;
  const memory = new WebAssembly.Memory({ initial: 258, maximum: 16384 });
  c.memory = memory; c.fibers = []; c.curFid = 0; c.nextTid = 1; c.rrIdx = 0; c.yieldStreak = 0;
  p.argv = c.execArgv; p.blocked = null;
  try {
    const imports = buildImports(st, h, p, p.rid) as { wasi_unstable: Record<string, unknown>; env: Record<string, unknown> };
    imports.env.memory = memory;
    const inst = new WebAssembly.Instance(new WebAssembly.Module(wasm as unknown as BufferSource), imports as unknown as WebAssembly.Imports);
    c.inst = inst; c.exp = inst.exports as unknown as Ctx['exp'];
    c.sp = (inst.exports as Record<string, unknown>).__ns_sp as WebAssembly.Global ?? null;
    if (typeof c.exp.asyncify_start_unwind === 'function') { if (!newFiber(c, 'start')) { out(h, p, 'exec failed: malloc'); finishClang(st, h, p); return; } }
    else c.fibers.push({ fid: 0, entry: 'start', fn: 0, arg: 0, sp: 0, dataAddr: 0, stackStart: 0, stackEnd: 0, state: 'new', wait: null, mwait: null, interrupted: false, suspend: null, forkReturn: 0, retval: 0, joinTarget: -1, joinSlot: 0, joiners: [] });
  } catch (e) { out(h, p, `exec failed: ${(e as Error).message}`); finishClang(st, h, p); return; }
  schedule(st, h, p, c);   // run the new image from main()
}

// ---- engine hooks (routed from procs.ts for kind 'cprog' whose ctx is a clang program) ----
export function isClangProc(p: CProc) { return ctxs.has(p.rid); }
export function clangTimer(st: EngineState, h: HostState, p: CProc, what: string) {
  const c = ctxs.get(p.rid); if (!c) return;
  if (what === 'run') { if (!p.done) schedule(st, h, p, c); return; }
  if (what === 'iowake') { let woke = false; for (const f of c.fibers) if (f.state === 'blocked' && f.mwait && f.mwait.deadline !== null && st.time >= f.mwait.deadline) { f.state = 'ready'; woke = true; } if (woke) schedule(st, h, p, c); return; }
  if (what === 'alarm') deliver(st, h, p, c, 14);   // SIGALRM
}
// Deliver a signal: invoke the registered handler (a C function pointer) via the exported table, or
// apply the default action (terminate for SIGINT/KILL/TERM/ALRM). Synchronous - handlers run to
// completion. A boundary-delivery model (EINTR of a blocked call) is a later refinement.
function deliver(st: EngineState, h: HostState, p: CProc, c: Ctx, sig: number) {
  const fp = c.handlers[sig];
  if (fp === undefined) { if (sig === 2 || sig === 9 || sig === 14 || sig === 15) finishClang(st, h, p); return; }
  const tbl = c.inst.exports.__indirect_function_table as WebAssembly.Table | undefined;
  if (!tbl) return;
  try { (tbl.get(fp) as (s: number) => void)(sig); }
  catch (e) { if (e instanceof ProcExit) { p.exitCode = (e as ProcExit).code; finishClang(st, h, p); } else out(h, p, `signal handler error: ${(e as Error).message}`); return; }
  if (p.done) return;
  // Boundary delivery: if the signal arrived while the process was parked in a blocking syscall (not
  // synchronously from raise() in a running fiber), interrupt that fiber so its call returns EINTR.
  if (!c.fibers.some(f => f.state === 'running')) {
    const b = c.fibers.find(f => f.state === 'blocked' && (f.wait !== null || f.mwait !== null));
    if (b) { b.interrupted = true; b.state = 'ready'; schedule(st, h, p, c); }
  }
}
export function clangNotify(st: EngineState, h: HostState, p: CProc, ev: { type: string; sock?: number }) {
  const c = ctxs.get(p.rid); if (!c) return;
  const s = ev.sock;
  const matches = (w: WaitReq) => (w.kind === 'connected' && (ev.type === 'tcpConnected' || ev.type === 'tcpError') && s === w.sock)
    || (w.kind === 'readable' && (ev.type === 'tcpReadable' || ev.type === 'tcpEof' || ev.type === 'tcpError') && s === w.sock)
    || (w.kind === 'accept' && ev.type === 'tcpAccept' && s === w.sock)
    || (w.kind === 'udprx' && (ev.type === 'udpRx' || ev.type === 'icmpError') && s === w.sock);
  let woke = false;
  for (const f of c.fibers) {
    if (f.state !== 'blocked') continue;
    if (f.wait && matches(f.wait)) { f.state = 'ready'; f.wait = null; woke = true; }           // single-fd blocking call
    else if (f.mwait && s !== undefined && f.mwait.socks.includes(s)) { f.state = 'ready'; woke = true; }   // select/poll/epoll watcher
  }
  if (woke) schedule(st, h, p, c);
}
export function clangKill(st: EngineState, h: HostState, p: CProc) { finishClang(st, h, p); }
function finishClang(st: EngineState, h: HostState, p: CProc) {
  for (const fd of Object.keys(p.fds).map(Number)) { const id = p.fds[fd]; if (id === undefined) continue; const s = h.sockets[id]; if (s && s.proto === 'tcp' && s.state !== 'CLOSED') tcpClose(st, h, s); }
  p.done = true; p.blocked = null; ctxs.delete(p.rid); delete h.procs[p.pid];
}
