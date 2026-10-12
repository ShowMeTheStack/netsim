// Socket Programming in C — guided labs for the Code workspace. Students open a host's Code tab,
// write C against the sockets API, compile it to WebAssembly in the browser (the nsC compiler), and
// run it on the simulated network. Everything is sandboxed: no real sockets, no real ports.
import type { Lab, LabModule } from './types';
import { E, ip, m, scene } from './helpers';
import type { ScenarioCheck } from '@/engine/types';

export const SOCKETS_C_MODULE: LabModule = { id: 'sockets', name: 'Socket Programming in C', blurb: 'write real C, compiled to wasm, on the sim' };
const MOD = 'Socket Programming in C';   // lab.module matches the module NAME (the launcher filters on it)

// Client (10.0.0.2) and Server (10.0.0.1) on a switch, with a sniffer on the client's link.
const cs = () => (st: Parameters<typeof E.addHost>[0]) => {
  const cli = E.addHost(st, 'laptop', 160, 300, 'Client');
  const sw = E.addSwitch(st, 360, 180, 8, 'Switch1');
  const srv = E.addHost(st, 'server', 560, 300, 'Server');
  const l1 = E.connect(st, cli.id, 0, sw.id, 0)!; E.connect(st, srv.id, 0, sw.id, 1);
  E.setIfaceIp(st, cli, 'eth0', ip('10.0.0.2'), m(24));
  E.setIfaceIp(st, srv, 'eth0', ip('10.0.0.1'), m(24));
  E.addSniffer(st, l1);
};

const codeStep = (prog: string, host: string, extra?: string) => ({
  title: `Open ${host}'s Code tab`, do: `Double-click **${host}**, open the **Code** tab, choose **${prog}** from the program menu${extra ? ', ' + extra : ''}, then press **Compile & Run**.`,
  set: [prog], observe: 'The program compiles to WebAssembly and appears in the running list.',
});
const runStep = { title: 'Run the simulation', do: 'Press **Turbo** (or step with **Event / Packet / Syscall**) to let the programs run.', observe: 'Output appears in each program\'s console, and packets appear in the sniffer.' };

export const SOCKETS_C: Lab[] = [
  (() => {
    const checks: ScenarioCheck[] = [
      { id: 'got', label: 'The server received the datagram', kind: 'terminalContains', node: 'Server', text: 'datagram from' },
      { id: 'udp', label: 'A UDP datagram was captured', kind: 'sniffHas', expr: 'udp' },
    ];
    return {
      id: 'sock-udp-send', module: MOD, name: 'Your first socket program (UDP)', difficulty: 'intro', minutes: 15,
      objectives: ['Create a UDP socket in C', 'Send a datagram with sendto()', 'See it arrive and on the wire'],
      theory: ['A **socket** is an endpoint for communication. `socket(AF_INET, SOCK_DGRAM, 0)` makes a UDP socket.',
        '`sendto(fd, buf, len, 0, addr, alen)` sends one datagram to an address. UDP is connectionless: no handshake, no guarantee of delivery.',
        'In the Code tab, the **UDP sender (nsC)** program is real C that compiles to WebAssembly in your browser and runs on this host.'],
      build: () => scene('sock-udp-send', 'Your first socket program (UDP)', 'Send a UDP datagram from a C program you compile in the browser.', checks, cs()),
      checks,
      steps: [
        { title: 'Start a server to receive', do: 'On **Server**, run `crun udp-echo-server 7` in the terminal (or pick the UDP echo server in its Code tab).', set: ['crun udp-echo-server 7'] },
        codeStep('UDP sender (nsC)', 'Client', 'with args `10.0.0.1 7`'),
        runStep,
        { title: 'Read the datagram', do: 'Select the captured UDP frame in the sniffer and read its bytes.', note: 'Which source port did the kernel pick for your client?' },
      ],
      questions: [{ q: 'Why did your client get a source port without calling bind()?', a: 'The stack auto-assigns an ephemeral port on the first send.' }],
      wrap: 'You compiled C to WebAssembly in the browser and put a real datagram on the simulated wire.',
    };
  })(),
  (() => {
    const checks: ScenarioCheck[] = [
      { id: 'reply', label: 'The client printed the echoed reply', kind: 'terminalContains', node: 'Client', text: 'hello from nsC' },
      { id: 'syn', label: 'A SYN was captured (the handshake began)', kind: 'sniffHas', expr: 'tcp.flags.syn == 1 and tcp.flags.ack == 0' },
    ];
    return {
      id: 'sock-tcp-client', module: MOD, name: 'A TCP echo client', difficulty: 'core', minutes: 20,
      objectives: ['connect() to a server', 'send() and recv() a reply', 'See the three-way handshake your connect() creates'],
      theory: ['TCP is connection-oriented. `connect()` performs the **three-way handshake** (SYN, SYN-ACK, ACK) and blocks until it completes.',
        '`send()` writes bytes to the connection; `recv()` reads up to N bytes and **blocks** until some arrive (or returns 0 at end of stream).',
        'The nsC compiler turns a blocking `connect()`/`recv()` into a WebAssembly state machine that suspends and resumes on the virtual clock, so you can watch it with **Step Syscall**.'],
      build: () => scene('sock-tcp-client', 'A TCP echo client', 'Write a C client that connects, sends, and reads the reply.', checks, cs()),
      checks,
      steps: [
        { title: 'Start the echo server', do: 'On **Server**, run `crun echo-server 7`.', set: ['crun echo-server 7'] },
        codeStep('TCP echo client (nsC)', 'Client', 'with args `10.0.0.1 7`'),
        { title: 'Step through the syscalls', do: 'Use **⏭ Syscall** to advance one blocking call at a time: watch connect() complete, then recv() wake when the reply arrives.', observe: 'The inspector shows the program blocked in connect(), then recv().' },
        runStep,
      ],
      questions: [{ q: 'What does recv() return when the server closes the connection?', a: '0, signalling end of stream.' }],
      wrap: 'Your compiled C client drove a real TCP handshake and echo exchange.',
    };
  })(),
  (() => {
    const checks: ScenarioCheck[] = [
      { id: 'reply', label: 'The client received the echo', kind: 'terminalContains', node: 'Client', text: 'hello world' },
      { id: 'tcp', label: 'TCP segments were captured', kind: 'sniffHas', expr: 'tcp' },
    ];
    return {
      id: 'sock-tcp-server', module: MOD, name: 'A TCP echo server', difficulty: 'core', minutes: 25,
      objectives: ['bind() and listen() on a port', 'accept() a connection', 'Echo bytes back in a loop'],
      theory: ['A server `bind()`s a socket to a port, `listen()`s to make it passive, then `accept()`s connections. `accept()` **blocks** until a client arrives and returns a new socket for that client.',
        'An iterative server handles one client at a time: accept, then recv/send in a loop until the client closes, then accept the next.',
        'The nsC compiler supports blocking calls **inside loops** now, so an `accept()`/`recv()` loop compiles correctly.'],
      build: () => scene('sock-tcp-server', 'A TCP echo server', 'Write a C server that accepts a connection and echoes bytes.', checks, cs()),
      checks,
      steps: [
        codeStep('TCP echo server (nsC)', 'Server', 'with args `0.0.0.0 7`'),
        { title: 'Connect a client', do: 'On **Client**, run `crun echo-client 10.0.0.1 7 hello world`.', set: ['crun echo-client 10.0.0.1 7 hello world'] },
        runStep,
        { title: 'Confirm the echo', do: 'Read the client console: it printed the bytes the server sent back.', note: 'Which socket does accept() return, and how is it different from the listening socket?' },
      ],
      wrap: 'You built a working TCP echo server in C, compiled in the browser.',
    };
  })(),
  (() => {
    const checks: ScenarioCheck[] = [
      { id: 'syn', label: 'A SYN was captured', kind: 'sniffHas', expr: 'tcp.flags.syn == 1 and tcp.flags.ack == 0' },
      { id: 'synack', label: 'A SYN-ACK was captured', kind: 'sniffHas', expr: 'tcp.flags.syn == 1 and tcp.flags.ack == 1' },
      { id: 'reply', label: 'The exchange completed', kind: 'terminalContains', node: 'Client', text: 'hello from nsC' },
    ];
    return {
      id: 'sock-handshake', module: MOD, name: 'Watch the handshake your code makes', difficulty: 'core', minutes: 15,
      objectives: ['Relate connect() to the SYN on the wire', 'Identify SYN, SYN-ACK, ACK', 'Read sequence and acknowledgement numbers'],
      theory: ['One `connect()` call becomes three packets. The client sends a **SYN** with its initial sequence number; the server replies **SYN-ACK**; the client finishes with **ACK**.',
        'Only after the ACK does `connect()` return and the connection become ESTABLISHED.'],
      build: () => scene('sock-handshake', 'Watch the handshake your code makes', 'Run a C client and dissect the SYN / SYN-ACK / ACK it produces.', checks, cs()),
      checks,
      steps: [
        { title: 'Start the server', do: 'On **Server**, run `crun echo-server 7`.', set: ['crun echo-server 7'] },
        codeStep('TCP echo client (nsC)', 'Client', 'with args `10.0.0.1 7`'),
        { title: 'Step packet by packet', do: 'Use **⏭ Packet** to advance one packet at a time and find the SYN, SYN-ACK, and ACK in the sniffer.', observe: 'Three packets precede any data.' },
        runStep,
      ],
      wrap: 'You connected the connect() call to the exact bytes of the handshake.',
    };
  })(),
  (() => {
    const checks: ScenarioCheck[] = [
      { id: 'reply', label: 'The client printed the reply', kind: 'terminalContains', node: 'Client', text: 'hello from nsC' },
      { id: 'tcp', label: 'TCP data crossed the wire', kind: 'sniffHas', expr: 'tcp' },
    ];
    return {
      id: 'sock-blocking', module: MOD, name: 'Blocking and resuming', difficulty: 'core', minutes: 15,
      objectives: ['Understand why recv() blocks', 'Use the inspector to see what a program waits on', 'Step one syscall at a time'],
      theory: ['A blocking call like `recv()` has no data to return yet, so the program **waits**. In a real OS the kernel parks the thread; here the compiled program suspends and the virtual clock advances until the data arrives.',
        'The Code tab inspector shows exactly what a program is blocked in, and **⏭ Syscall** advances to its next blocking call.'],
      build: () => scene('sock-blocking', 'Blocking and resuming', 'Watch a compiled program block in recv() and resume when data arrives.', checks, cs()),
      checks,
      steps: [
        { title: 'Start the server', do: 'On **Server**, run `crun echo-server 7`.', set: ['crun echo-server 7'] },
        codeStep('TCP echo client (nsC)', 'Client', 'with args `10.0.0.1 7`'),
        { title: 'Observe the block', do: 'Step with **⏭ Syscall**. After send(), the inspector shows the program blocked in recv() with no data.', observe: 'blocked in recv() until the server replies.' },
        runStep,
      ],
      wrap: 'You saw a blocking syscall suspend and resume, driven by the simulated clock.',
    };
  })(),
  (() => {
    const checks: ScenarioCheck[] = [
      { id: 'a', label: 'The first client got its echo', kind: 'terminalContains', node: 'Client', text: 'reply: alpha' },
      { id: 'b', label: 'The second client got its echo', kind: 'terminalContains', node: 'Client', text: 'reply: bravo' },
      { id: 'tcp', label: 'TCP connections were established', kind: 'sniffHas', expr: 'tcp.flags.syn == 1' },
    ];
    return {
      id: 'sock-threads', module: MOD, name: 'A concurrent server with pthreads', difficulty: 'advanced', minutes: 30,
      objectives: ['Spawn a worker thread per connection', 'Serve two clients at once', 'Understand why one slow client no longer blocks the rest'],
      theory: ['An iterative server handles one client at a time: while it is busy in recv() for client A, client B waits. A **concurrent** server spawns a **thread** per connection so each is served independently.',
        '`pthread_create(&t, NULL, fn, arg)` starts a thread running `fn(arg)`; `pthread_detach(t)` lets it clean up on its own. Threads share the process memory, so a mutex guards anything shared.',
        'This needs full C, so pick the **Threaded TCP server (real C, pthreads)** program - it compiles with the one-time clang download. The threads run as cooperative green threads that switch at each blocking call, so the behaviour (and the packets) match a real concurrent server.'],
      build: () => scene('sock-threads', 'A concurrent server with pthreads', 'Run a thread-per-connection C server and serve two clients at once.', checks, cs()),
      checks,
      steps: [
        codeStep('Threaded TCP server (real C, pthreads)', 'Server', 'with args `7`'),
        { title: 'Connect the first client', do: 'On **Client**, run `crun echo-client 10.0.0.1 7 alpha`.', set: ['crun echo-client 10.0.0.1 7 alpha'] },
        { title: 'Connect a second client', do: 'On **Client**, run `crun echo-client 10.0.0.1 7 bravo`.', set: ['crun echo-client 10.0.0.1 7 bravo'] },
        runStep,
        { title: 'See both served', do: 'Both clients printed their echoed line. In the server console, each connection spawned its own worker thread.', note: 'If the server were iterative, which client would have to wait?' },
      ],
      questions: [{ q: 'What does the worker thread share with the main thread, and what is private to it?', a: 'They share the process memory (globals, the heap); each thread has its own stack and local variables.' }],
      wrap: 'You built a concurrent, thread-per-connection TCP server in C and served two clients at once.',
    };
  })(),
  ...(() => {
    // One single-threaded, multiplexing echo server, three ways. Each lab runs the real-C server and
    // two clients, and asserts both clients got served by the one server (no threads, no fork).
    const mux = (id: string, prog: string, call: string, extra: string[]): Lab => {
      const checks: ScenarioCheck[] = [
        { id: 'a', label: 'The first client got its echo', kind: 'terminalContains', node: 'Client', text: 'reply: alpha' },
        { id: 'b', label: 'The second client got its echo', kind: 'terminalContains', node: 'Client', text: 'reply: bravo' },
        { id: 'tcp', label: 'TCP connections were established', kind: 'sniffHas', expr: 'tcp.flags.syn == 1' },
      ];
      return {
        id, module: MOD, name: `I/O multiplexing with ${call}`, difficulty: 'advanced', minutes: 25,
        objectives: [`Serve many clients from one thread with ${call}`, 'Watch one event loop wake for whichever socket is ready', 'Compare it to the thread-per-connection design'],
        theory: [`An iterative server serves one client at a time; a threaded one spends a thread per client. **${call}** is the third way: one thread watches a *set* of sockets and blocks until any is ready, then handles whichever woke up.`,
          ...extra,
          `This needs full C, so pick **${prog}** (the one-time clang download). The listening socket and every client socket go in the set; when the listener is readable you accept(), when a client is readable you recv()/send().`],
        build: () => scene(id, `I/O multiplexing with ${call}`, `Run a single-threaded ${call} server and serve two clients at once.`, checks, cs()),
        checks,
        steps: [
          codeStep(prog, 'Server', 'with args `7`'),
          { title: 'Connect the first client', do: 'On **Client**, run `crun echo-client 10.0.0.1 7 alpha`.', set: ['crun echo-client 10.0.0.1 7 alpha'] },
          { title: 'Connect a second client', do: 'On **Client**, run `crun echo-client 10.0.0.1 7 bravo`.', set: ['crun echo-client 10.0.0.1 7 bravo'] },
          runStep,
          { title: 'One loop, many clients', do: `Both clients were served by a single thread. The server never blocked on one client while another had data - ${call} woke it for whichever was ready.`, note: 'How would this server behave if one client stopped sending mid-message?' },
        ],
        questions: [{ q: `What does ${call} return, and how do you know which socket to handle?`, a: 'The number of ready sockets; you test each one (FD_ISSET / .revents / the returned event list) to see which fired.' }],
        wrap: `You built a concurrent echo server in one thread using ${call} - no threads, no fork.`,
      };
    };
    return [
      mux('sock-select', 'select() server (real C, one thread)', 'select()', ['`select()` takes three `fd_set`s (read/write/error) and an optional timeout. Build them with `FD_ZERO`/`FD_SET`, and after it returns test each fd with `FD_ISSET`.']),
      mux('sock-poll', 'poll() server (real C, one thread)', 'poll()', ['`poll()` takes an array of `struct pollfd` ({fd, events}); you set `.events` to `POLLIN`/`POLLOUT` and read back `.revents`. No `FD_SETSIZE` limit, and the array is easy to grow.']),
      mux('sock-epoll', 'epoll() server (real C, one thread)', 'epoll()', ['`epoll` registers interest once with `epoll_ctl(EPOLL_CTL_ADD)`, then `epoll_wait()` returns *only* the ready fds - O(ready), not O(total). It is the idiom behind nginx and Redis.']),
    ];
  })(),
  (() => {
    const checks: ScenarioCheck[] = [
      { id: 'fired', label: 'The SIGALRM handler ran', kind: 'terminalContains', node: 'Server', text: 'handler: SIGALRM' },
      { id: 'eintr', label: 'The blocked accept() returned EINTR', kind: 'terminalContains', node: 'Server', text: 'interrupted by signal (EINTR)' },
    ];
    return {
      id: 'sock-eintr', module: MOD, name: 'Signals and EINTR', difficulty: 'advanced', minutes: 20,
      objectives: ['Install a signal handler with signal()', 'See a signal interrupt a blocking syscall', 'Handle the EINTR return correctly'],
      theory: ['A **signal** can arrive at any time. If it arrives while the program is blocked in a syscall like `accept()` or `recv()`, the kernel runs the handler and then the syscall returns **-1 with errno == EINTR** instead of completing.',
        'Robust code checks for `EINTR` and usually retries the call. Here we arm `alarm(2)` to deliver **SIGALRM** after two seconds while the program is blocked in `accept()` with no client connecting.',
        'This needs full C, so pick the **signals + EINTR (real C)** program. The handler is a real C function the runtime invokes through the module function table.'],
      build: () => scene('sock-eintr', 'Signals and EINTR', 'Watch a signal interrupt a blocking accept() and surface EINTR.', checks, cs()),
      checks,
      steps: [
        codeStep('signals + EINTR (real C)', 'Server'),
        { title: 'Run it (no client needed)', do: 'Press **Turbo**. The server blocks in accept(); after two seconds the alarm fires.', observe: 'The handler prints, then accept() returns with EINTR.' },
        { title: 'Read the sequence', do: 'In the Server console: "blocking in accept()", then the handler line, then the EINTR line - exactly the POSIX order (handler first, then the interrupted call returns).', note: 'Why might a real program wrap accept() in a retry loop?' },
      ],
      questions: [{ q: 'What value does accept() return when interrupted, and what is errno?', a: '-1, with errno set to EINTR.' }],
      wrap: 'You saw a signal interrupt a blocking syscall and return EINTR, with the handler running first.',
    };
  })(),
  (() => {
    const checks: ScenarioCheck[] = [
      { id: 'reply', label: 'The client got its echo from your compiled server', kind: 'terminalContains', node: 'Client', text: 'hello from nsC' },
      { id: 'tcp', label: 'A TCP connection was established', kind: 'sniffHas', expr: 'tcp.flags.syn == 1' },
    ];
    return {
      id: 'sock-capstone', module: MOD, name: 'Capstone: client and server, both in C', difficulty: 'advanced', minutes: 30,
      objectives: ['Run a compiled server and a compiled client together', 'Trace a full exchange end to end', 'Appreciate both sides of a connection'],
      theory: ['Both ends of a TCP connection are just programs calling the sockets API. Here you run **two** programs you compiled in the browser, one listening and one connecting, and watch the whole conversation on the wire.'],
      build: () => scene('sock-capstone', 'Capstone: client and server, both in C', 'Run a compiled C server and a compiled C client and trace the whole exchange.', checks, cs()),
      checks,
      steps: [
        codeStep('TCP echo server (nsC)', 'Server', 'with args `0.0.0.0 7`'),
        codeStep('TCP echo client (nsC)', 'Client', 'with args `10.0.0.1 7`'),
        runStep,
        { title: 'Trace it end to end', do: 'Follow the handshake, the data echo, and the teardown in the sniffer; relate each packet to a syscall in one of your two programs.', note: 'Which program sends the first FIN?' },
      ],
      wrap: 'You wrote, compiled, and ran both sides of a TCP conversation in C, entirely in the browser.',
    };
  })(),
];
