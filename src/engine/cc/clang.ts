// The real in-browser C compiler: C source -> (clang -cc1) -> (wasm-ld) -> (Asyncify) -> a wasm
// module that the clang runtime (apps/clangrun.ts) runs on the engine. Environment-agnostic: the
// caller injects `readBuffer` (fetch in the browser, fs in tests) and `asyncify` (binaryen). The
// ~60MB toolchain (clang/lld/sysroot/memfs) is fetched same-origin as the opt-in C download.
import { WasmClangAPI } from './wasmclang.js';
import type { CDiagnostic } from '@/shared/cprograms';

// The socket shim linked into every program: supplies the socket-creation calls stock wasi-libc
// lacks, as imports the runtime binds to the engine. (Mirror of tests/fixtures/nssock.c.)
export const NSSOCK_C = `typedef unsigned socklen_t; typedef unsigned long size_t; typedef long ssize_t; struct sockaddr;
#include <errno.h>
#include <sys/select.h>
#include <poll.h>
#include <sys/epoll.h>
#define NSIMPORT(n) __attribute__((import_module("env"), import_name(#n)))
#define NS_EINTR (-4)
static int __ns_errno_v;
int *__ns_errno_location(void){return &__ns_errno_v;}
NSIMPORT(ns_sock_socket) int __ns_socket(int,int,int);
NSIMPORT(ns_sock_connect) int __ns_connect(int,const void*,socklen_t);
NSIMPORT(ns_sock_bind) int __ns_bind(int,const void*,socklen_t);
NSIMPORT(ns_sock_listen) int __ns_listen(int,int);
NSIMPORT(ns_sock_accept) int __ns_accept(int,void*,socklen_t*);
NSIMPORT(ns_sock_sendto) int __ns_sendto(int,const void*,size_t,int,const void*,socklen_t);
NSIMPORT(ns_sock_recvfrom) int __ns_recvfrom(int,void*,size_t,int,void*,socklen_t*);
NSIMPORT(ns_fork) int __ns_fork(void);
NSIMPORT(ns_getpid) int __ns_getpid(void);
NSIMPORT(ns_waitpid) int __ns_waitpid(int);
NSIMPORT(ns_exec) int __ns_exec(const char*,void*);
int fork(void){return __ns_fork();}
int getpid(void){return __ns_getpid();}
int waitpid(int pid,void*st,int opt){(void)st;(void)opt;return __ns_waitpid(pid);}
int wait(void*st){(void)st;return __ns_waitpid(-1);}
int execv(const char*path,char*const argv[]){return __ns_exec(path,(void*)argv);}
int execvp(const char*file,char*const argv[]){return __ns_exec(file,(void*)argv);}
typedef void (*__sighandler_t)(int);
NSIMPORT(ns_signal) int __ns_signal(int,int);
NSIMPORT(ns_raise) int __ns_raise(int);
NSIMPORT(ns_kill) int __ns_kill(int,int);
NSIMPORT(ns_alarm) int __ns_alarm(unsigned);
__sighandler_t signal(int sig,__sighandler_t h){__ns_signal(sig,(int)(long)h);return (__sighandler_t)0;}
int raise(int sig){return __ns_raise(sig);}
int kill(int pid,int sig){return __ns_kill(pid,sig);}
unsigned alarm(unsigned s){return (unsigned)__ns_alarm(s);}
int socket(int d,int t,int p){return __ns_socket(d,t,p);}
int connect(int f,const struct sockaddr*a,socklen_t l){int r=__ns_connect(f,a,l);if(r==NS_EINTR){errno=EINTR;return -1;}return r;}
int bind(int f,const struct sockaddr*a,socklen_t l){return __ns_bind(f,a,l);}
int listen(int f,int b){return __ns_listen(f,b);}
int accept(int f,struct sockaddr*a,socklen_t*l){int r=__ns_accept(f,a,l);if(r==NS_EINTR){errno=EINTR;return -1;}return r;}
ssize_t sendto(int f,const void*b,size_t n,int fl,const struct sockaddr*a,socklen_t l){return __ns_sendto(f,b,n,fl,a,l);}
ssize_t recvfrom(int f,void*b,size_t n,int fl,struct sockaddr*a,socklen_t*l){ssize_t r=__ns_recvfrom(f,b,n,fl,a,l);if(r==NS_EINTR){errno=EINTR;return -1;}return r;}
NSIMPORT(ns_select) int __ns_select(int,void*,void*,void*,void*);
NSIMPORT(ns_poll) int __ns_poll(void*,unsigned long,int);
NSIMPORT(ns_epoll_create) int __ns_epoll_create(void);
NSIMPORT(ns_epoll_ctl) int __ns_epoll_ctl(int,int,int,void*);
NSIMPORT(ns_epoll_wait) int __ns_epoll_wait(int,void*,int,int);
int select(int n,fd_set*r,fd_set*w,fd_set*e,struct timeval*t){int x=__ns_select(n,r,w,e,t);if(x==NS_EINTR){errno=EINTR;return -1;}return x;}
int poll(struct pollfd*f,nfds_t n,int to){int x=__ns_poll(f,(unsigned long)n,to);if(x==NS_EINTR){errno=EINTR;return -1;}return x;}
int epoll_create(int sz){(void)sz;return __ns_epoll_create();}
int epoll_create1(int fl){(void)fl;return __ns_epoll_create();}
int epoll_ctl(int ep,int op,int fd,struct epoll_event*ev){return __ns_epoll_ctl(ep,op,fd,ev);}
int epoll_wait(int ep,struct epoll_event*ev,int mx,int to){int x=__ns_epoll_wait(ep,ev,mx,to);if(x==NS_EINTR){errno=EINTR;return -1;}return x;}
#include <pthread.h>
NSIMPORT(ns_thread_create) int __ns_thread_create(int,int);
NSIMPORT(ns_thread_join) int __ns_thread_join(int,int);
NSIMPORT(ns_thread_exit) void __ns_thread_exit(int);
NSIMPORT(ns_thread_self) int __ns_thread_self(void);
NSIMPORT(ns_yield) void __ns_yield(void);
__attribute__((export_name("__ns_thread_run")))
void __ns_thread_run(int fn,int arg){void*(*f)(void*)=(void*(*)(void*))(long)fn;void*r=f((void*)(long)arg);__ns_thread_exit((int)(long)r);}
int pthread_create(pthread_t*t,const pthread_attr_t*a,void*(*f)(void*),void*arg){(void)a;int tid=__ns_thread_create((int)(long)f,(int)(long)arg);if(tid<0)return 11;if(t)*t=(pthread_t)tid;return 0;}
int pthread_join(pthread_t t,void**r){return __ns_thread_join((int)t,(int)(long)r);}
void pthread_exit(void*r){__ns_thread_exit((int)(long)r);for(;;){}}
pthread_t pthread_self(void){return (pthread_t)__ns_thread_self();}
int pthread_detach(pthread_t t){(void)t;return 0;}
int pthread_equal(pthread_t a,pthread_t b){return a==b;}
int pthread_mutex_init(pthread_mutex_t*m,const pthread_mutexattr_t*a){(void)a;m->locked=0;return 0;}
int pthread_mutex_destroy(pthread_mutex_t*m){(void)m;return 0;}
int pthread_mutex_lock(pthread_mutex_t*m){while(m->locked)__ns_yield();m->locked=1;return 0;}
int pthread_mutex_trylock(pthread_mutex_t*m){if(m->locked)return 16;m->locked=1;return 0;}
int pthread_mutex_unlock(pthread_mutex_t*m){m->locked=0;return 0;}
int pthread_cond_init(pthread_cond_t*c,const pthread_condattr_t*a){(void)a;c->seq=0;return 0;}
int pthread_cond_destroy(pthread_cond_t*c){(void)c;return 0;}
int pthread_cond_wait(pthread_cond_t*c,pthread_mutex_t*m){int s=c->seq;m->locked=0;while(c->seq==s)__ns_yield();while(m->locked)__ns_yield();m->locked=1;return 0;}
int pthread_cond_signal(pthread_cond_t*c){c->seq++;return 0;}
int pthread_cond_broadcast(pthread_cond_t*c){c->seq++;return 0;}
int sched_yield(void){__ns_yield();return 0;}
`;

// <pthread.h> is absent from this (clang-8, --no-threads) wasi-libc sysroot, so we inject one. It is
// added to memfs at /include so the student's `#include <pthread.h>` resolves. Opaque attr types; the
// mutex/cond are plain flags because the cooperative scheduler runs one fiber at a time (no preemption,
// no real atomics needed).
export const PTHREAD_H = `#ifndef _PTHREAD_H
#define _PTHREAD_H
typedef unsigned long pthread_t;
typedef struct { int _a; } pthread_attr_t;
typedef struct { volatile int locked; } pthread_mutex_t;
typedef struct { int _a; } pthread_mutexattr_t;
typedef struct { volatile int seq; } pthread_cond_t;
typedef struct { int _a; } pthread_condattr_t;
#define PTHREAD_MUTEX_INITIALIZER {0}
#define PTHREAD_COND_INITIALIZER {0}
int pthread_create(pthread_t*, const pthread_attr_t*, void*(*)(void*), void*);
int pthread_join(pthread_t, void**);
void pthread_exit(void*) __attribute__((noreturn));
pthread_t pthread_self(void);
int pthread_detach(pthread_t);
int pthread_equal(pthread_t, pthread_t);
int pthread_mutex_init(pthread_mutex_t*, const pthread_mutexattr_t*);
int pthread_mutex_destroy(pthread_mutex_t*);
int pthread_mutex_lock(pthread_mutex_t*);
int pthread_mutex_trylock(pthread_mutex_t*);
int pthread_mutex_unlock(pthread_mutex_t*);
int pthread_cond_init(pthread_cond_t*, const pthread_condattr_t*);
int pthread_cond_destroy(pthread_cond_t*);
int pthread_cond_wait(pthread_cond_t*, pthread_mutex_t*);
int pthread_cond_signal(pthread_cond_t*);
int pthread_cond_broadcast(pthread_cond_t*);
#endif
`;

// This wasi-libc declares errno as `_Thread_local`, which clang 8's wasm backend cannot lower
// (TLS "Cannot select"). We inject a function-based <errno.h> instead - errno becomes
// *__ns_errno_location(), a plain global in the shim - so programs that check errno (e.g. for EINTR)
// compile. The numeric codes come from the sysroot's own __errno_values.h.
export const NS_ERRNO_H = `#ifndef _ERRNO_H
#define _ERRNO_H
#include <__errno_values.h>
int *__ns_errno_location(void);
#define errno (*__ns_errno_location())
#endif
`;

// <sys/epoll.h> is absent from this sysroot, so we inject one. struct epoll_event has its natural
// layout (events @0 as u32, data @8 as the 8-byte union - a 4-byte pad after events on wasm32), which
// the runtime reads/writes to match.
export const EPOLL_H = `#ifndef _SYS_EPOLL_H
#define _SYS_EPOLL_H
#include <stdint.h>
#define EPOLL_CTL_ADD 1
#define EPOLL_CTL_DEL 2
#define EPOLL_CTL_MOD 3
#define EPOLLIN   0x001
#define EPOLLPRI  0x002
#define EPOLLOUT  0x004
#define EPOLLERR  0x008
#define EPOLLHUP  0x010
#define EPOLLRDHUP 0x2000
#define EPOLLONESHOT 0x40000000
#define EPOLLET   0x80000000
typedef union epoll_data { void *ptr; int fd; uint32_t u32; uint64_t u64; } epoll_data_t;
struct epoll_event { uint32_t events; epoll_data_t data; };
int epoll_create(int);
int epoll_create1(int);
int epoll_ctl(int, int, int, struct epoll_event *);
int epoll_wait(int, struct epoll_event *, int, int);
#endif
`;

// Blocking syscalls Asyncify must be allowed to suspend at (connect/recv/accept, the I/O-multiplexing
// calls select/poll/epoll_wait, fork/exec, and the cooperative-threading suspend points yield/join/exit).
export const ASYNCIFY_IMPORTS = ['env.ns_sock_connect', 'env.ns_sock_accept', 'env.ns_sock_recvfrom', 'env.ns_select', 'env.ns_poll', 'env.ns_epoll_wait', 'env.ns_fork', 'env.ns_waitpid', 'env.ns_exec', 'env.ns_yield', 'env.ns_thread_join', 'env.ns_thread_exit', 'wasi_unstable.sock_recv'];

// --import-memory: the runtime owns the linear memory so fork() can clone it. Proven safe in
// isolation (asyncify + import-memory + resume all compose).
// --import-memory: runtime owns memory (for fork clone). --export-table: so the runtime can call a
// registered signal handler by its function-pointer index.
const LINK_ARGS = ['wasm-ld', '--no-threads', '--export-dynamic', '--allow-undefined', '--export=malloc', '--import-memory', '--export-table', '-z', 'stack-size=1048576', '-Llib/wasm32-wasi', 'lib/wasm32-wasi/crt1.o'];
const modCache = new Map<string, WebAssembly.Module>();   // cache the 31MB clang etc. across compiles

export interface ClangDeps {
  readBuffer: (name: string) => Promise<Uint8Array> | Uint8Array;   // toolchain asset bytes
  asyncify: (wasm: Uint8Array) => Promise<Uint8Array> | Uint8Array;  // post-link binaryen pass (see finalizeWasm)
}

// Post-link binaryen pass, injected (with binaryen) by the caller so this module stays binaryen-free.
// Two jobs in one session: (1) export the linker's stack-pointer global as `__ns_sp` so the runtime
// can save/restore a per-thread C shadow stack (the mechanism green-thread pthreads ride on) - it is
// the single mutable i32 global, found BEFORE asyncify adds its own mutable-i32 globals; (2) run the
// Asyncify pass so blocking syscalls and thread switches can suspend/resume. mutable-globals is
// enabled so the exported mutable global validates (universally supported by our target engines).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function finalizeWasm(binaryen: any, raw: Uint8Array): Uint8Array {
  const m = binaryen.readBinary(raw);
  m.setFeatures(binaryen.Features.MutableGlobals | binaryen.Features.BulkMemory | binaryen.Features.SignExt);
  let sp: string | null = null;
  for (let i = 0; i < m.getNumGlobals(); i++) { const g = binaryen.getGlobalInfo(m.getGlobalByIndex(i)); if (g.type === binaryen.i32 && g.mutable) { sp = g.name; break; } }
  if (sp) m.addGlobalExport(sp, '__ns_sp');
  binaryen.setPassArgument('asyncify-imports', ASYNCIFY_IMPORTS.join(','));
  m.runPasses(['asyncify']);
  const out = m.emitBinary(); m.dispose(); return out;
}
export type ClangResult = { ok: true; wasm: Uint8Array } | { ok: false; diagnostics: CDiagnostic[] };

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');
function parseDiagnostics(output: string): CDiagnostic[] {
  const out: CDiagnostic[] = []; const re = /prog\.c:(\d+):(\d+):\s*(error|warning):\s*(.*)/g; let m: RegExpExecArray | null;
  const clean = stripAnsi(output);
  while ((m = re.exec(clean))) out.push({ line: Number(m[1]), col: Number(m[2]), message: m[4]!.trim(), severity: m[3] === 'error' ? 'error' : 'warning' });
  if (!out.some(d => d.severity === 'error')) out.push({ line: 1, col: 1, message: 'compilation failed', severity: 'error' });
  return out;
}

export async function clangCompile(source: string, deps: ClangDeps): Promise<ClangResult> {
  let output = '';
  const compileStreaming = async (name: string) => { if (!modCache.has(name)) modCache.set(name, await WebAssembly.compile(await deps.readBuffer(name) as BufferSource)); return modCache.get(name)!; };
  const api = new WasmClangAPI({ readBuffer: deps.readBuffer, compileStreaming, hostWrite: (s: string) => { output += s; }, clang: 'clang.wasm', lld: 'lld.wasm', sysroot: 'sysroot.tar', memfs: 'memfs.wasm' });
  await api.ready;
  try {
    const clang = await api.getModule('clang.wasm');
    api.memfs.addFile('include/errno.h', NS_ERRNO_H);    // override TLS errno with a function-based one
    api.memfs.addFile('include/pthread.h', PTHREAD_H);   // sysroot lacks it; resolves <pthread.h>
    api.memfs.addFile('include/sys/epoll.h', EPOLL_H);   // sysroot lacks it; resolves <sys/epoll.h>
    api.memfs.addFile('prog.c', source);
    api.memfs.addFile('nssock.c', NSSOCK_C);
    await api.run(clang, 'clang', '-cc1', '-emit-obj', ...api.clangCommonArgs, '-O2', '-o', 'prog.o', '-x', 'c', 'prog.c');
    await api.run(clang, 'clang', '-cc1', '-emit-obj', ...api.clangCommonArgs, '-O2', '-o', 'nssock.o', '-x', 'c', 'nssock.c');
    const lld = await api.getModule('lld.wasm');
    await api.run(lld, ...LINK_ARGS, 'prog.o', 'nssock.o', '-lc', '-lc++', '-lc++abi', '-lcanvas', '-o', 'prog.wasm');
    const raw = new Uint8Array(api.memfs.getFileContents('prog.wasm'));
    return { ok: true, wasm: await deps.asyncify(raw) };
  } catch {
    return { ok: false, diagnostics: parseDiagnostics(output) };
  }
}
