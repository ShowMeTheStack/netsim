# NetSim Socket Programming Extension — Design & Build Plan

Status: **BUILT (full C + all four non-negotiables), updated 2026-10-16.** Students write real C
against the sockets API in a host's Code tab, compile it to WebAssembly **in the browser**, and run
it on the simulated network, fully sandboxed (no real sockets or ports, nothing exposed). Two
backends: the opt-in **real clang** path (LLVM + wasi-libc + Asyncify, a one-time ~60 MB download,
cached) that compiles arbitrary full C — structs, pointers, malloc, `<string.h>`, printf — and the
in-app **nsC** subset compiler (no download) as an instant fallback. Delivered end to end:
- **Sockets**: socket/bind/listen/accept/connect/send/recv/sendto/recvfrom/close against the engine's
  TCP/UDP stack; blocking calls suspend/resume via Asyncify on the virtual clock.
- **fork / exec**: real multi-process C by cloning the WebAssembly memory / replacing the image.
- **signals**: signal()/raise()/kill()/alarm() delivered to a real C handler via the function table.
- **pthreads**: `#include <pthread.h>` works — pthread_create/join/detach/exit/self, mutex, cond,
  sched_yield — as cooperative green threads (each its own C shadow stack + Asyncify buffer; the
  runtime switches them by saving/restoring the exported stack-pointer global). Multi-threaded,
  thread-per-connection TCP servers run and are machine-tested.
- **I/O multiplexing**: `select()`, `poll()`, and `epoll_create1/epoll_ctl/epoll_wait` - one thread
  waits on a whole set of sockets with an optional timeout; single-threaded concurrent servers run.
- **EINTR / boundary signal delivery**: a signal delivered while the program is blocked in a syscall
  runs the handler and then the call returns -1 with `errno == EINTR`, as POSIX specifies. (errno is
  usable at all only because we inject a function-based `<errno.h>`; this wasi-libc's `_Thread_local`
  errno does not compile on clang 8's wasm backend.)
The Code workspace (editor + side-by-side API reference incl. Processes/Threads/Multiplexing + console
+ live fd/socket inspector + inline clang diagnostics), a **Step Syscall** control, a **welcome tour**
that introduces the opt-in C feature, and a **Socket Programming in C** lab module (11 guided labs:
UDP/TCP, blocking, the handshake, a pthreads concurrent server, select/poll/epoll multiplexing, and
signals+EINTR - all machine-verified completable). 203 unit tests + e2e green (including live-toolchain
compile tests for pthreads/select/epoll/EINTR and a headless-browser real-clang run).

Still optional/future (documented, not fake-shipped): `epoll` edge-triggered mode, true waitpid
reaping, and per-thread signal masks (the §5 plan). The original proposal follows.

---

Author seam verified against the live codebase (engine, apps, labs, UI) on 2026-10-15.

---

## 0. Goal, in one paragraph

Let a student write **real C** against the **real BSD sockets API** (`socket/bind/listen/accept/connect/send/recv/sendto/recvfrom/shutdown/setsockopt`), with **`select`/`poll`/`epoll`**, **`pthreads`**, **`fork`/`exec`**, and **signals**, compile it **inside the browser**, run it **on a simulated host inside NetSim**, and watch the exact bytes their code puts on the wire in the existing capture/decode/trace panes. Every run is **sandboxed inside the browser**: no real socket, no real port on any machine, nothing exposed. The feature is **opt-in** behind a clear button and introduced in a **welcome tour**. It ships with **~32 guided lab programs** spanning UDP, TCP, multi-threaded TCP, `select`/`poll`, `fork`, and signals, all of which work with **Play / Step / Turbo**. The editor **actively helps** the student: a side-by-side API reference, scaffolds, autocomplete, inline compiler diagnostics, and a live runtime inspector, so nobody has to memorize boilerplate or guess why `recv` is blocking.

This fits NetSim's architecture unusually well because the network half already exists and is validated, and because a program is just another `Proc` driven by the same deterministic event loop.

---

## 1. Why this is feasible here (grounded in the current code)

NetSim already has every piece a socket runtime needs except the C execution itself:

| Need | Already in the codebase |
|---|---|
| A socket object with a real TCP state machine | `src/engine/stack/tcp.ts` (`TcpSocket`, RFC 793 states, NewReno/CUBIC, SACK, RTO, zero-window, TIME-WAIT) and `src/engine/stack/udp.ts` |
| A per-host socket table + ephemeral ports | `HostState.sockets`, `nextSock`, `nextEphemeral`, `ephemeralPort()` |
| A process abstraction with event delivery | `src/engine/apps/procs.ts`: `h.procs`, `nextPid`, `procNotify()`, `procTimer()`, `killProc()` |
| The exact socket calls a libc needs to bind to | `tcpSocket/tcpListen/tcpConnect/tcpAccept/tcpSend/tcpRecv/tcpClose/tcpAbort`, `udpSocket/udpSend` |
| The exact async events a blocking syscall waits on | `ProcEvent`: `tcpConnected / tcpReadable / tcpWritable / tcpEof / tcpAccept / tcpClosed / tcpFinAcked / tcpError / udpRx / icmpError` |
| A worked example of "a socket program as a Proc" | `src/engine/apps/nc.ts` (netcat), `iperf.ts`, `http.ts`, `ping.ts` |
| A deterministic event loop with Play/Step/Turbo | `engine.ts` `advance()/stepEvent()/stepPacket()`; `worker.ts` `tickPlay/tickTurbo`; `TopBar.tsx` controls |
| Name resolution (for `getaddrinfo`) | `src/engine/apps/dns.ts`, host `dns`/`hosts`/`resolutions` |
| Packet capture + byte decode + trace, cross-linked to sockets | `SnifferPanel.tsx`, `TcpPanel.tsx` (`SocketsTab`), `decode.ts`, filters |
| Deterministic, serializable state + snapshot/restore | `createState()`, `structuredClone` in `snapshot/restore`, seeded `rng.ts` |
| Dockable panels + 40 themes to host an editor | `Dock.tsx`, `layout.ts`, `themes.ts` |

**The entire new surface reduces to:** (a) run C in the browser, (b) a libc/syscall shim that calls the functions above, (c) a cooperative scheduler that turns blocking syscalls into event-loop suspensions, and (d) UI (editor + API reference + tour). The hard systems problem — a correct TCP — is already solved and cross-validated against ns-3/tshark/Scapy.

---

## 2. Non-negotiables and how each is met

1. **fork / exec / pthreads / signals** — delivered. §5 specifies the mechanism for each (Asyncify stack-capture for `fork`, cooperative green threads for `pthreads`, pending-flag + EINTR delivery for signals, instance-replacement for `exec`).
2. **All runs sandboxed in the browser, no real ports, nothing exposed** — every "syscall" is a function we wrote that only mutates `EngineState`. The WASM sandbox has no access to a real socket; there is no WebSocket, no `fetch`, no listener. The toolchain assets are served from the **same origin** as the app (self-hosted, no third-party CDN) and cached for offline use. This is consistent with the standing rule in memory `laptop-no-external-exposure` and `netsim-security-constraints`, and is in fact *safer* than real socket programming because nothing can escape the sandbox. No dev/preview server change: the existing loopback bind (`127.0.0.1`, `--strictPort`) is unchanged.
3. **Clear opt-in button + welcome tour** — §7. A first-run welcome tour (new; none exists today) introduces the tool and ends on a clear "Enable C socket programming" card that explains the one-time download; the same opt-in is reachable from the top bar and the Code tab.
4. **~32 lab programs across UDP / TCP / multi-threaded TCP / select-poll / signals / fork** — §6.
5. **Works with Play / Step / Turbo** — §4.3. Program execution *is* engine events, so the existing controls drive it; we add an optional "Step Syscall".
6. **Aid the writer so they are not burdened** — §8. API reference side-by-side, scaffolds, autocomplete, signature hints, inline clang diagnostics with fix-its, a live fd/socket/thread/signal inspector, and a "common mistakes" helper.

---

## 3. Toolchain and download size

### 3.1 Components
- **Compiler:** a trimmed, **C-only** `clang` + `lld` compiled to WASM, targeting `wasm32`. Runs entirely in the worker; student source compiles to a WASM module in-browser. No server compile (would violate the no-exposure rule and the offline goal).
- **Standard library:** `wasi-libc` (or a musl-wasi build) for the pure parts we will *not* rewrite: `stdio`, `string`, `malloc`, `printf`, math, etc.
- **netsim-posix shim (ours):** the syscall-backed parts that `wasi-libc` does not provide for our environment — sockets, `select/poll/epoll`, `fork/exec`, `pthreads`, signals — implemented in a mix of C (thin wrappers) and the JS/TS host (the actual engine binding). This is the only sizeable new C/TS we author; it is small relative to a compiler.
- **Asyncify runtime:** for blocking suspension, `fork` stack capture, and green-thread context switches.
- **Editor + API reference UI:** shipped in the same opt-in chunk so the base app stays tiny.

### 3.2 Size budget
- **Base NetSim (no C):** unchanged, ~0.2 MB gzipped. Students who never open C pay nothing.
- **C runtime, one-time opt-in download (brotli):**
  - trimmed clang + lld: ~15–25 MB (the dominant cost; C-only + hard strip targets the low end)
  - wasi sysroot / libc archives actually linked: ~2–5 MB
  - netsim-posix shim + Asyncify runtime + editor + API ref: < 1 MB
  - **Total: ~20–30 MB, trimmable toward ~15 MB**, downloaded only when C is first enabled, then **cached by a service worker and available offline**.
- A compact interpreter (picoc/TCC) was rejected: it cannot give a faithful `fork`/`pthreads`/signal model with a real libc. Full POSIX process semantics require a real compiler and sysroot; that is the irreducible cost.

### 3.3 Hosting (security)
Toolchain assets live under the app origin (`public/csys/…` or a lazy Vite chunk). Dev = `127.0.0.1`, prod = `netsim.jyotiprakash.org`. No external port, no third-party fetch, offline after first load. A service worker (added as part of this feature) caches both the app shell and the toolchain for offline/loopback use.

---

## 4. Execution model (the core design)

### 4.1 A C program is a Proc
New proc kind `'cprog'` in `src/engine/types.ts` and `apps/procs.ts`, alongside `ping/traceroute/iperf/nc/http`. State:
```
CProc = {
  kind: 'cprog'; pid; node;
  source; argv; env;
  fds: FdTable;                 // 0/1/2 → console; sockets → engine socket ids; epoll sets; pipes
  threads: GreenThread[];       // ≥1; each an Asyncify context (saved stack region)
  runnable: ThreadId[];         // scheduler queue
  blocked: Map<ThreadId, WaitCond>;  // what each blocked thread awaits
  pendingSignals; sigHandlers; sigMask;
  children: pid[]; pgid;
  stdout; stderr;               // ring buffers shown in the console pane
  exited?: { code } ;
}
```
All of this is created/driven inside the **engine worker**, exactly where `nc`/`iperf` live. The WASM instance(s) for the program run in that worker.

### 4.2 Syscalls bind to existing engine functions
The netsim-posix shim resolves libc calls to host functions. Representative mapping (not exhaustive):

| C call | Engine binding |
|---|---|
| `socket(AF_INET, SOCK_STREAM, …)` | allocate fd → `tcpSocket(st,h,pid)` |
| `socket(AF_INET, SOCK_DGRAM, …)` | allocate fd → `udpSocket(h,pid)` |
| `bind` | set `localPort/localIp` (+ `tcpListen`-style port check); `SO_REUSEADDR` honored |
| `listen` | `tcpListen(st,h,s,port)` |
| `accept` | `tcpAccept(h,ls)`; blocks (see §4.3) until `tcpAccept` notify |
| `connect` | `tcpConnect(st,h,s,dst,port)`; blocks until `tcpConnected`/`tcpError` (or returns `EINPROGRESS` if non-blocking) |
| `send/write` | `tcpSend(...)`; short write when send buffer full → may block or `EAGAIN` |
| `recv/read` | `tcpRecv(...)`; blocks until `tcpReadable`/`tcpEof` when empty (or `EAGAIN`) |
| `sendto/recvfrom` | `udpSend(...)` / drain `UdpSocket.rx`; blocks until `udpRx` |
| `shutdown(SHUT_WR)` | `tcpClose` half-close path |
| `close` | `tcpClose`/`tcpAbort` or free udp sock; release fd |
| `setsockopt/getsockopt` | `SO_REUSEADDR, SO_RCVBUF/SNDBUF, TCP_NODELAY(nagle), SO_RCVTIMEO, SO_ERROR` mapped onto `HostState.tcp`/socket fields |
| `select/poll/epoll_wait` | register readiness interest across fds + a virtual-time timeout; block until any ready or timeout |
| `getaddrinfo/gethostbyname` | resolve via `apps/dns.ts` + host `hosts`/`dns` (blocks like a real resolver) |
| `gettimeofday/clock_gettime` | **virtual** time `st.time` |
| `sleep/usleep/nanosleep/alarm` | schedule an engine `timer(...)`, block/deliver `SIGALRM` |
| `fork/exec/waitpid` | §5 |
| `pthread_*` | §5 |
| `signal/sigaction/kill/raise/sigprocmask` | §5 |

`errno` is maintained per thread. `EINTR` is returned from blocking calls interrupted by a delivered signal, exactly per POSIX (a teaching-relevant detail labs will exercise).

### 4.3 Blocking = suspend to the event loop (this is what makes Play/Step/Turbo work)
A blocking syscall with no immediately-available result does three things:
1. records a `WaitCond` for the current thread (e.g. "sock 5 readable", "any of fds {3,5,7} readable or 2s timeout", "child exited", "connected"),
2. uses **Asyncify** to unwind the WASM stack back into the host, and
3. returns control to the engine. The engine keeps processing its `(time, seq)` event heap, advancing **virtual** time, exactly as today.

When the awaited condition becomes true, it is already signaled through the existing machinery:
- `procNotify(st,h,pid,{type:'tcpReadable',…})` (from `tcp.ts`) → the `cprog` notify handler marks the waiting thread runnable and schedules a `programRun` event at the current virtual time.
- A `programRun` event (new event kind, dispatched in `engine.ts`) **rewinds** the Asyncify stack and the syscall returns its value; the student's code continues until the next block or exit.

Consequences:
- **Play** advances virtual time and runs programs as events arrive. **Turbo** runs them to completion/idle. **Step Event** advances one engine event (one program slice or one packet). **Step Packet** stops at the next packet the program emits. We add an optional **Step Syscall** control that stops at each blocking boundary, so a student can literally watch `connect()` emit the SYN, then `accept()` wake on the client's SYN, etc.
- A program's CPU work between syscalls runs in bounded **count-based** slices (a deterministic instruction/step budget), never wall-clock, so determinism and reproducibility are preserved. Compute cost in virtual time is configurable, default negligible (consistent with how the sim abstracts host CPU today).
- `sleep(10)` costs **zero** wall-clock and advances virtual time, so Turbo/Step still behave.

### 4.4 Output and cross-linking
`stdout`/`stderr` stream to a per-program **console pane** (new, dockable via `Dock.tsx`), timestamped in sim time. The existing **Sockets tab** (`TcpPanel.tsx`) already shows socket state and charts; we surface the owning program and its fds there, and clicking a packet in the capture pane highlights the socket and the line of C that produced it (best-effort via the send call site).

---

## 5. fork, exec, pthreads, signals (the non-negotiables)

### 5.1 pthreads — deterministic green threads (default)
Each `pthread` is a **cooperative green thread**: its own stack region in the program's linear memory, switched by an Asyncify context swap, scheduled by the engine event loop. `pthread_mutex`/`pthread_cond`/`pthread_rwlock`/`sem_*` are implemented against the scheduler (a blocked lock parks the thread on a wait queue; `unlock`/`signal`/`broadcast` wakes it via a `programRun` event). `pthread_create/join/detach/exit`, TLS (`pthread_key_*`), and `pthread_cancel` (deferred-cancel at boundaries) are supported.

Why green, not real OS threads:
- Preserves the single deterministic event loop, the virtual clock, snapshot/restore, and the verification harness — all load-bearing for NetSim's validation story.
- Needs **no** `SharedArrayBuffer` and therefore **no COOP/COEP headers**, so the GitHub Pages mirror keeps working with zero config.
- **Multi-threaded TCP servers do not need true parallelism.** Thread-per-connection and thread-pool servers are I/O-bound; their threads live blocked in `accept`/`recv`, which are yield points. Cooperative scheduling reproduces their behavior faithfully and deterministically. This is exactly the workload the labs target.

Optional later: a true-parallel mode (workers + `SharedArrayBuffer`) behind COOP/COEP on `netsim.jyotiprakash.org`, for a lab that demonstrates real data races. Not required for the non-negotiables and not in the default path.

### 5.2 fork
Within a `programRun` slice, `fork()`:
1. Asyncify-captures the calling thread's stack (it lives in linear memory, hence serializable),
2. clones the program's entire linear memory into a fresh WASM instance (no hardware COW; full copy — fine at teaching scale),
3. creates a new `CProc` (new pid) inheriting the fd table (sockets are shared/duplicated with refcounts like real fds),
4. schedules `programRun` for both; parent returns child pid, child returns 0.
`waitpid`/`wait` block until a child posts `exited` (and `SIGCHLD` is raised). This is the same Asyncify-fork technique proven in Emscripten and the WebVM-class systems.

### 5.3 exec
`execve`/`execvp` replaces the current process image: tear down the instance, load the target program's compiled WASM from a small in-memory VFS (programs attached to the project), keep pid and inherited fds, start at `main`. `fork`+`exec` gives the classic "accept → fork → exec a handler" and shell-style spawning. (The VFS also backs `open/read/write/close` on regular files for labs that need a file to serve.)

### 5.4 signals
Pending-flag model with boundary delivery:
- `sigaction/signal` register handlers; `kill/raise` set a pending bit on the target proc/thread; `sigprocmask` manages the mask.
- Delivery happens at the next scheduler yield or syscall boundary: if unmasked, the handler is invoked via an Asyncify frame at the handler pointer, then the interrupted context resumes. Blocking syscalls return `-1`/`EINTR` when interrupted.
- Natural mappings already exist in the loop: `SIGCHLD` on child exit, `SIGPIPE` on write to a closed connection, `SIGALRM` from `alarm()/setitimer()` as an engine timer, `SIGINT/SIGTERM` for graceful shutdown (and a UI "send signal" button).
- The one thing cooperative scheduling cannot do precisely is async delivery mid-computation; we approximate with a deterministic step-budget yield. Irrelevant for networked teaching code, which takes signals at syscall boundaries anyway.

### 5.5 Determinism, snapshot, and the verification harness
- **Session save/load and cold restart:** a program is persisted as **source + node + argv + autostart**, NOT as live WASM memory. On load/restart the sim is deterministic and seeded, so programs are re-created and **replayed** to reach the same state. This keeps session JSON small and keeps `coldRestart()` semantics (which already wipes `procs` and re-runs). Clean and reproducible.
- **Mid-run snapshot equality proof (the campaign's `snapshot==straight-execution`):** this is the one place live program memory matters. Decision for review: either (a) exclude `cprog` from that specific mid-run equality harness initially (documented limitation), or (b) serialize each program's linear memory + Asyncify stack + fd table as bytes inside the proc so `structuredClone` captures it. Recommend (a) for Phase 1–4, (b) only if we want C programs inside that proof. Deterministic replay (above) already covers reproducibility for everything else.

---

## 6. The ~32 lab programs (new lab module 19: "Socket Programming in C")

Delivered as a new module in `src/ui/labs/19-sockets-c.ts`, authored with the existing `Lab`/`LabStep`/`ScenarioCheck` machinery (`labs/types.ts`, `labs/helpers.ts`). Each lab provides: objectives, short theory, a **starter `.c` with the right scaffold**, step-by-step instructions that use Play/Step/Turbo, auto-checks, and a wrap-up. Checks reuse existing kinds (`terminalContains`, `tcpStat`, `sniffHas`, `count`) plus two new kinds: `progExited{node,code}` and `progOutput{node,pattern}`.

**Cluster A — TCP fundamentals (8)**
1. Hello TCP client — `socket/connect/send/recv/close`, read the handshake in the capture pane.
2. Iterative TCP echo server — `bind/listen/accept` loop, `recv`/`send`.
3. TCP echo client with an input loop.
4. Read until EOF — `recv` loop, partial reads, framing.
5. Short writes — `send` returns `< len`; write-all loop.
6. Connect by name — `getaddrinfo` → simulated DNS → connect.
7. `SO_REUSEADDR` — rebind a listener after restart.
8. Half-close — `shutdown(SHUT_WR)`, drain the peer.

**Cluster B — UDP (6)**
9. UDP sender — `sendto`.
10. UDP receiver — `recvfrom`, print sender addr/port.
11. UDP echo server.
12. UDP client with timeout — `SO_RCVTIMEO` or `select` timeout; handle loss on a lossy link.
13. Connected UDP — `connect` on a datagram socket; `send/recv`; see ICMP port-unreachable.
14. UDP broadcast — `SO_BROADCAST`, send to the subnet broadcast.

**Cluster C — I/O multiplexing (6)**
15. `select` echo server — `fd_set`, many clients, one thread.
16. `poll` echo server — `pollfd` array.
17. `select` with timeout — periodic housekeeping tick.
18. Non-blocking `connect` + `select` for writability + `SO_ERROR`.
19. Chat client — multiplex stdin and a socket.
20. `epoll` server (advanced) — level vs edge triggered.

**Cluster D — Multi-threaded TCP (5)**
21. Thread-per-connection echo server — `pthread_create`/`detach`.
22. Thread-pool server — fixed workers, shared accept queue, `mutex`+`cond`.
23. Producer/consumer — bounded buffer with `mutex`+`cond`.
24. Join and return values — collect per-thread results.
25. Graceful worker shutdown — shutdown flag + `cond` broadcast + `join`.

**Cluster E — fork & signals (7)**
26. `SIGINT` graceful shutdown — `sigaction`, flag, drain, close listener.
27. Reaping children — `SIGCHLD` + `waitpid(WNOHANG)` in a fork server.
28. Ignore `SIGPIPE`, handle `EPIPE` on write to a closed peer.
29. `SIGALRM` timeout on a blocking `recv` — `alarm` + `EINTR` retry.
30. fork-per-connection server — classic `accept/fork/close`.
31. `fork` + `exec` a handler, passing the connection fd (advanced).
32. Double-fork / daemonize pattern (illustrative).

**Cluster F — Capstones (2, optional extra beyond 30)**
33. Mini HTTP/1.0 server — parse the request line, serve a body with `Content-Length`; cross-links to the existing HTTP labs and the capture pane.
34. Concurrent chat relay — broadcast across clients using select (single-thread) or a thread pool.

Every lab is **machine-verified completable** (same guarantee as the current 70 labs; checks run in the engine), and runs under Step/Play/Turbo so a student can watch the packets their own code generates.

---

## 7. Opt-in and the welcome tour

No onboarding/tour exists today (verified). This feature adds a small, theme-aware, dismissible one.

- **First-run welcome tour** (`src/ui/Tour.tsx`, a handful of coachmark steps, state in `localStorage` with try/catch): what NetSim is → place a node → run with Play/Step/Turbo → read a packet → open a lab. The **final card** is: *"New: write real C socket programs here."* with a clear **"Enable C socket programming"** button that explains the one-time ~20–30 MB download, that it runs fully offline and sandboxed in the browser with no real network access, and a "Maybe later" option.
- **Persistent opt-in entry points:** a top-bar button (`data-testid="btn-enable-c"`) and the **Code** tab on a host popup both offer the same enable flow when C is off. A tiny progress indicator shows the toolchain downloading; once cached, it is instant and offline thereafter.
- Opt-in state persists in `localStorage`; the service worker keeps the toolchain cached. Nothing about C loads or downloads unless the student opts in, so the base experience and size are untouched.

---

## 8. Helping the student write C (so they are not burdened)

A dedicated **Code** workspace: editor on the left, **API reference** on the right, **console** and **capture** below, all dockable.

- **API reference panel** (`src/ui/CApiReference.tsx`, data-driven from a table): searchable man-page cards for every supported call — signature, parameters, return value, `errno` values, a one-paragraph plain explanation, and a **copy/insert** snippet. Grouped (sockets, addresses, multiplexing, threads, process, signals, byte order, stdio). Clicking a symbol in the editor jumps to its card.
- **Scaffolds / insert menu:** one click inserts correct boilerplate — "TCP server skeleton", "TCP client", "UDP echo", "select loop", "thread-per-connection", "sigaction handler", "fork+waitpid" — so nobody memorizes `struct sockaddr_in` from scratch.
- **Editor affordances:** C syntax highlighting, symbol autocomplete for the supported libc, inline **signature hints** as you type the arguments, and bracket/`#include` help. (Editor component shipped inside the opt-in C chunk, so base size is unaffected.)
- **Inline diagnostics with fix-its:** clang's errors/warnings are parsed (line/col) and shown in the gutter and inline; clang fix-it hints are offered as one-click applies. A plain-language layer rewrites the most common messages.
- **"Common mistakes" helper:** targeted hints for the classic errors — forgot `htons`, unchecked `accept`/`recv` return, no `SO_REUSEADDR` after restart, blocking `recv` on an empty socket (the inspector shows *why* it is parked), ignoring short writes, missing `SIGPIPE` handling.
- **Live runtime inspector:** a panel showing, per running program, its **fd table**, each socket's TCP state (reusing `tcpStateSummary`), **thread states** (running/blocked-on-what), **pending signals**, and children. When a program is parked, it says exactly what it is waiting for ("thread 2 blocked in `recv(fd=5)` — no data; peer in ESTABLISHED"). This is the single biggest anti-frustration feature and reuses data the engine already has.

---

## 9. UI / file touch-list

New files (UI): `src/ui/Tour.tsx`, `src/ui/CodePanel.tsx` (editor + layout), `src/ui/CApiReference.tsx`, `src/ui/CConsole.tsx`, `src/ui/cRuntime/*` (loader, Asyncify glue, service-worker registration), `src/ui/labs/19-sockets-c.ts`, and the C api/reference/snippets data tables.

New files (engine): `src/engine/apps/cprog.ts` (the `'cprog'` proc: notify/timer/kill + scheduler), `src/engine/cposix/*` (syscall shim host side: fd table, sockets, select/poll, fork/exec, pthreads, signals), and the netsim-posix C sources + build artifacts under `public/csys/` (toolchain) — all same-origin, cached.

Edited files: `src/engine/types.ts` (add `CProc`, `programRun` event kind, new `ScenarioCheck` kinds, fd/thread/signal types), `src/engine/engine.ts` (`dispatch` a `programRun` event; `advance` unchanged in spirit), `src/engine/apps/procs.ts` (wire `cprog` into `procNotify/procTimer/killProc`), `src/engine/worker.ts` (commands: `compileProgram`, `startProgram`, `signalProgram`, `stepSyscall`; the compile runs in the worker), `src/shared/protocol.ts` (new `Cmd`/`Msg` variants), `src/ui/store.ts` (C-enabled state, program state, actions), `src/ui/NodePopup.tsx` (add a **Code** tab for hosts), `src/ui/TopBar.tsx` (enable-C button + optional "Step Syscall"), `src/ui/App.tsx` (mount Tour + CodePanel), `src/ui/themes.ts` (editor tokens if needed), `src/session/session.ts` (persist programs as source+node+argv+autostart).

Nothing about the existing engine protocols changes; this is strictly additive.

---

## 10. Testing & verification (keep `npm run verify` green, keep the paper's rigor)

- **Unit (vitest):** the cposix shim — fd allocation, `select/poll` readiness math, `errno`/`EINTR`, fork memory-clone, green-thread mutex/cond correctness, signal masking/delivery. Byte-for-byte: a C client's packets equal `nc`'s for the same scenario (regression against the validated stack).
- **E2E (playwright):** enable C → compile a sample → run under Turbo → assert console output, assert the expected frames appear in the capture, assert `select`/thread/fork servers serve N clients, assert `SIGINT` shutdown. All on the existing loopback preview; **no external port**, consistent with the security memory and the current `shots.mjs` approach.
- **Determinism campaign:** extend the existing campaign to include `cprog` labs via **replay-from-source** (same seed → identical trace). The mid-run snapshot-equality proof follows the §5.5 decision.
- **Lab completability:** all ~32 new labs machine-verified completable, same gate as the current 70.
- **Mutation testing:** extend to the cposix shim.
- **a11y:** the editor, API panel, tour, and console audited with the existing axe setup; keyboard-navigable; theme-contrast checked across light/dark themes.
- **Size budget check:** CI asserts base shell stays ~0.2 MB and the C chunk is lazy (never in the base bundle).

---

## 11. Phasing (each phase is shippable and keeps verify green)

- **Phase 0 — Spike (prove the loop & the size):** trimmed `clang.wasm` + `wasi-libc` compiling a trivial TCP client in-browser; one blocking `recv` suspending via Asyncify and resuming from a `tcpReadable` notify, driven by Step/Play. Measure the real download. Decision gate on size and the suspend/resume mechanism.
- **Phase 1 — Single-process TCP/UDP + Code workspace:** editor, API reference, console, inspector, compile-in-worker, `socket/bind/listen/accept/connect/send/recv/sendto/recvfrom/close/shutdown/setsockopt/getaddrinfo`. Clusters A + B labs (~14). Step Syscall control.
- **Phase 2 — Multiplexing:** `select/poll/epoll`, non-blocking fds, `fcntl(O_NONBLOCK)`. Cluster C (~6).
- **Phase 3 — Threads:** green `pthreads` + sync primitives. Cluster D (~5).
- **Phase 4 — fork/exec/signals:** Asyncify fork, exec+VFS, signals+EINTR+alarm, waitpid/SIGCHLD. Cluster E (~7).
- **Phase 5 — Onboarding, capstones, polish, verification:** welcome tour + opt-in flow + service-worker caching, capstones (F), full test/verify/a11y/size pass, docs, optional paper "future work → now shipped" note.

---

## 12. Risks & honest limits (for review)
- **Download weight** (~20–30 MB opt-in) is the real cost; mitigated by lazy load + offline cache; base app unaffected. Trimming clang is the main lever (target ~15 MB).
- **Mid-run snapshot of live C memory** is the one determinism wrinkle (§5.5); default plan excludes C from that specific equality proof, with replay-from-source covering reproducibility.
- **True parallel threads** are deliberately out of the default (green threads instead); added later only behind COOP/COEP on our own origin if a lab needs real races.
- **Async signal delivery mid-computation** is approximate under cooperative scheduling; irrelevant for networked code.
- **Compiler UX in-browser** (first compile latency after download) — mitigated by caching and a warm instance; incremental compiles are fast and local.
- **Scope:** this is a substantial feature (new runtime + editor + ~32 labs). The phasing keeps each step small, verified, and reversible, and never touches the existing engine protocols.

---

## 13. What I need from you before writing code
Approve, and tell me:
1. Go ahead with **Phase 0 spike first** (recommended — it pins the real download size and proves the suspend/resume loop before committing), or build straight into Phase 1?
2. Green threads as default with SAB-true-threads deferred — OK? (Recommended.)
3. Mid-run snapshot: exclude C initially (recommended) or serialize WASM memory from the start?
4. Any preference on the in-browser C compiler (trimmed clang+lld) vs. exploring WASIX as the ABI — default is trimmed clang + wasi-libc + our netsim-posix shim.

No code will be written until you approve.
