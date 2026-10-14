// End-to-end proof of the REAL in-browser compile pipeline: C source -> clang -cc1 -> wasm-ld ->
// Asyncify -> run on the engine. Uses the same clangCompile() the browser worker will call, with
// `readBuffer` from disk and `asyncify` from binaryen. Skips when the ~60MB toolchain isn't present
// (run `tools/fetch-csys.sh` to get it); the committed fixtures in clang.test.ts cover CI.
import { describe, it, expect } from 'vitest';
// @ts-expect-error Node builtin (no @types/node in tsconfig).
import { readFileSync, existsSync } from 'fs';
import binaryen from 'binaryen';
import { clangCompile, finalizeWasm } from '@/engine/cc/clang';
import { startClangProgram } from '@/engine/apps/clangrun';
import { startProgram } from '@/engine/apps/cprog';
import { createState, addHost, addSwitch, connect, setIfaceIp, advance } from '@/engine/engine';
import { ipToU32, prefixToMask } from '@/shared/bytes';
import { SEC } from '@/engine/core';

const CSYS = new URL('../../public/csys/', import.meta.url);
const asset = (n: string) => new URL(n, CSYS);
const haveToolchain = existsSync(asset('clang.wasm'));

const SRC = `#include <stdio.h>
#include <string.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <arpa/inet.h>
#include <unistd.h>
int main(void) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in a; memset(&a, 0, sizeof a);
  a.sin_family = AF_INET; a.sin_port = htons(7);
  inet_pton(AF_INET, "10.0.0.1", &a.sin_addr);
  if (connect(fd, (struct sockaddr *)&a, sizeof a) < 0) { printf("connect failed\\n"); return 1; }
  const char *m = "hi from browser clang\\n";
  send(fd, m, strlen(m), 0);
  char buf[256]; int n = recv(fd, buf, sizeof buf, 0);
  printf("echo: %.*s", n > 0 ? n : 0, buf);
  close(fd);
  return 0;
}`;

const deps = {
  readBuffer: (n: string) => new Uint8Array(readFileSync(asset(n)) as Uint8Array),
  asyncify: (wasm: Uint8Array) => new Uint8Array(finalizeWasm(binaryen, wasm)),
};

// A multi-threaded TCP client: each pthread connects, sends, and blocks in recv independently.
const THREADS_SRC = `#include <stdio.h>
#include <string.h>
#include <pthread.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <arpa/inet.h>
#include <unistd.h>
void *worker(void *arg) {
  long id = (long)arg;
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in a; memset(&a, 0, sizeof a);
  a.sin_family = AF_INET; a.sin_port = htons(7);
  inet_pton(AF_INET, "10.0.0.1", &a.sin_addr);
  if (connect(fd, (struct sockaddr *)&a, sizeof a) < 0) { printf("thread %ld connect failed\\n", id); return (void *)1; }
  char msg[64]; int ml = snprintf(msg, sizeof msg, "hi from thread %ld\\n", id);
  send(fd, msg, ml, 0);
  char buf[128]; int n = recv(fd, buf, sizeof buf, 0);
  printf("thread %ld got: %.*s", id, n > 0 ? n : 0, buf);
  close(fd);
  return (void *)(id * 100);
}
int main(void) {
  pthread_t t1, t2;
  pthread_create(&t1, NULL, worker, (void *)1);
  pthread_create(&t2, NULL, worker, (void *)2);
  void *r1 = 0, *r2 = 0; pthread_join(t1, &r1); pthread_join(t2, &r2);
  printf("main joined r1=%ld r2=%ld\\n", (long)r1, (long)r2);
  return 0;
}`;

describe.skipIf(!haveToolchain)('real in-browser compile pipeline (clang -> wasm-ld -> asyncify)', () => {
  it('compiles C source to a runnable program that talks to a server', { timeout: 120000 }, async () => {
    const r = await clangCompile(SRC, deps);
    expect(r.ok, r.ok ? '' : JSON.stringify(r.diagnostics)).toBe(true);
    if (!r.ok) return;

    const st = createState(1);
    const a = addHost(st, 'server', 100, 100, 'A'); const b = addHost(st, 'laptop', 300, 100, 'B'); const sw = addSwitch(st, 200, 200);
    connect(st, a.id, 0, sw.id, 0); connect(st, b.id, 0, sw.id, 1);
    setIfaceIp(st, a, 'eth0', ipToU32('10.0.0.1'), prefixToMask(24)); setIfaceIp(st, b, 'eth0', ipToU32('10.0.0.2'), prefixToMask(24));
    startProgram(st, a, 'echo-server', ['7']);
    startClangProgram(st, b, r.wasm, 'typed-in-browser', []);
    advance(st, 200 * SEC, 1e6);
    expect(b.terminal.join('\n')).toContain('[typed-in-browser] echo: hi from browser clang');
  });

  it('compiles a pthreads program (#include <pthread.h>) whose threads each block in recv', { timeout: 120000 }, async () => {
    const r = await clangCompile(THREADS_SRC, deps);
    expect(r.ok, r.ok ? '' : JSON.stringify(r.diagnostics)).toBe(true);
    if (!r.ok) return;

    const st = createState(1);
    const a = addHost(st, 'server', 100, 100, 'A'); const b = addHost(st, 'laptop', 300, 100, 'B'); const sw = addSwitch(st, 200, 200);
    connect(st, a.id, 0, sw.id, 0); connect(st, b.id, 0, sw.id, 1);
    setIfaceIp(st, a, 'eth0', ipToU32('10.0.0.1'), prefixToMask(24)); setIfaceIp(st, b, 'eth0', ipToU32('10.0.0.2'), prefixToMask(24));
    startProgram(st, a, 'echo-server', ['7']);
    startClangProgram(st, b, r.wasm, 'threaded', []);
    advance(st, 300 * SEC, 1e6);
    const t = b.terminal.join('\n');
    expect(t).toContain('[threaded] thread 1 got: hi from thread 1');
    expect(t).toContain('[threaded] thread 2 got: hi from thread 2');
    expect(t).toContain('[threaded] main joined r1=100 r2=200');
  });

  it('compiles a select() server and multiplexes two clients in one thread', { timeout: 120000 }, async () => {
    const SRC = `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
int main(void){
  int ls=socket(AF_INET,SOCK_STREAM,0);
  struct sockaddr_in a; memset(&a,0,sizeof a); a.sin_family=AF_INET; a.sin_addr.s_addr=htonl(INADDR_ANY); a.sin_port=htons(7);
  bind(ls,(struct sockaddr*)&a,sizeof a); listen(ls,16);
  printf("select up\\n");
  int cl[8]; int nc=0;
  for(;;){ fd_set r; FD_ZERO(&r); FD_SET(ls,&r); int mx=ls; for(int i=0;i<nc;i++){FD_SET(cl[i],&r); if(cl[i]>mx)mx=cl[i];}
    if(select(mx+1,&r,0,0,0)<0) break;
    if(FD_ISSET(ls,&r)){ int c=accept(ls,0,0); if(nc<8)cl[nc++]=c; }
    for(int i=0;i<nc;i++) if(FD_ISSET(cl[i],&r)){ char b[256]; int k=recv(cl[i],b,sizeof b,0); if(k<=0){close(cl[i]);cl[i]=cl[--nc];i--;} else send(cl[i],b,k,0);} }
  return 0;
}`;
    const r = await clangCompile(SRC, deps);
    expect(r.ok, r.ok ? '' : JSON.stringify(r.diagnostics)).toBe(true);
    if (!r.ok) return;
    const st = createState(1);
    const a = addHost(st, 'server', 100, 100, 'A'); const b = addHost(st, 'laptop', 300, 100, 'B'); const sw = addSwitch(st, 200, 200);
    connect(st, a.id, 0, sw.id, 0); connect(st, b.id, 0, sw.id, 1);
    setIfaceIp(st, a, 'eth0', ipToU32('10.0.0.1'), prefixToMask(24)); setIfaceIp(st, b, 'eth0', ipToU32('10.0.0.2'), prefixToMask(24));
    startClangProgram(st, a, r.wasm, 'sel', []);
    startProgram(st, b, 'echo-client', ['10.0.0.1', '7', 'alpha']);
    startProgram(st, b, 'echo-client', ['10.0.0.1', '7', 'bravo']);
    advance(st, 300 * SEC, 1e6);
    expect(b.terminal.join('\n')).toContain('reply: alpha');
    expect(b.terminal.join('\n')).toContain('reply: bravo');
  });

  it('compiles an epoll() server (injected <sys/epoll.h>) and multiplexes two clients', { timeout: 120000 }, async () => {
    const SRC = `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
int main(void){
  int ls=socket(AF_INET,SOCK_STREAM,0);
  struct sockaddr_in a; memset(&a,0,sizeof a); a.sin_family=AF_INET; a.sin_addr.s_addr=htonl(INADDR_ANY); a.sin_port=htons(7);
  bind(ls,(struct sockaddr*)&a,sizeof a); listen(ls,16);
  int ep=epoll_create1(0);
  struct epoll_event ev={.events=EPOLLIN,.data={.fd=ls}}; epoll_ctl(ep,EPOLL_CTL_ADD,ls,&ev);
  printf("epoll up\\n");
  struct epoll_event es[16];
  for(;;){ int n=epoll_wait(ep,es,16,-1); if(n<0)break;
    for(int i=0;i<n;i++){ int fd=es[i].data.fd;
      if(fd==ls){ int c=accept(ls,0,0); struct epoll_event ce={.events=EPOLLIN,.data={.fd=c}}; epoll_ctl(ep,EPOLL_CTL_ADD,c,&ce); }
      else { char b[256]; int k=recv(fd,b,sizeof b,0); if(k<=0){ epoll_ctl(ep,EPOLL_CTL_DEL,fd,0); close(fd);} else send(fd,b,k,0);} } }
  return 0;
}`;
    const r = await clangCompile(SRC, deps);
    expect(r.ok, r.ok ? '' : JSON.stringify(r.diagnostics)).toBe(true);
    if (!r.ok) return;
    const st = createState(1);
    const a = addHost(st, 'server', 100, 100, 'A'); const b = addHost(st, 'laptop', 300, 100, 'B'); const sw = addSwitch(st, 200, 200);
    connect(st, a.id, 0, sw.id, 0); connect(st, b.id, 0, sw.id, 1);
    setIfaceIp(st, a, 'eth0', ipToU32('10.0.0.1'), prefixToMask(24)); setIfaceIp(st, b, 'eth0', ipToU32('10.0.0.2'), prefixToMask(24));
    startClangProgram(st, a, r.wasm, 'ep', []);
    startProgram(st, b, 'echo-client', ['10.0.0.1', '7', 'alpha']);
    startProgram(st, b, 'echo-client', ['10.0.0.1', '7', 'bravo']);
    advance(st, 300 * SEC, 1e6);
    expect(b.terminal.join('\n')).toContain('reply: alpha');
    expect(b.terminal.join('\n')).toContain('reply: bravo');
  });

  it('compiles a program that detects EINTR (errno) from a signal-interrupted accept()', { timeout: 120000 }, async () => {
    const SRC = `#include <stdio.h>
#include <signal.h>
#include <errno.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
void on(int s){ printf("caught %d\\n", s); }
int main(void){
  signal(SIGALRM,on);
  int ls=socket(AF_INET,SOCK_STREAM,0);
  struct sockaddr_in a; memset(&a,0,sizeof a); a.sin_family=AF_INET; a.sin_addr.s_addr=htonl(INADDR_ANY); a.sin_port=htons(7);
  bind(ls,(struct sockaddr*)&a,sizeof a); listen(ls,16);
  alarm(1);
  int c=accept(ls,0,0);
  printf(c<0 && errno==EINTR ? "EINTR ok\\n" : "no eintr\\n");
  return 0;
}`;
    const r = await clangCompile(SRC, deps);
    expect(r.ok, r.ok ? '' : JSON.stringify(r.diagnostics)).toBe(true);
    if (!r.ok) return;
    const st = createState(1);
    const h = addHost(st, 'laptop', 100, 100, 'H');
    startClangProgram(st, h, r.wasm, 'ei', []);
    advance(st, 30 * SEC, 1e6);
    expect(h.terminal.join('\n')).toContain('[ei] caught 14');
    expect(h.terminal.join('\n')).toContain('[ei] EINTR ok');
  });

  it('reports real clang diagnostics for broken C (with line numbers)', { timeout: 120000 }, async () => {
    const r = await clangCompile('int main(void){ int x = ; return 0; }', deps);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.diagnostics.some(d => d.severity === 'error')).toBe(true); expect(r.diagnostics[0]!.line).toBeGreaterThan(0); }
  });
});
