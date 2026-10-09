// C socket programs shown in the Code workspace and used as lab starters, plus the API reference.
// Pure data (no engine imports) so it can be used by the UI without pulling engine internals into
// the main bundle. The program `name`s must match the engine's runnable registry in
// engine/apps/cprog.ts (a unit test pins them together so they cannot drift).

export interface CProgramMeta {
  name: string;          // matches engine PROGRAM_NAMES for 'stub' programs
  title: string;         // human label
  proto: 'tcp' | 'udp';
  blurb: string;         // one line
  defaultArgs: string;   // prefilled args
  source: string;        // the C a student reads and edits
  // 'clang' = real in-browser clang + wasi-libc (full C), via the opt-in toolchain download.
  // 'nsc'   = the small in-app C-subset compiler (no download, no structs/pointers).
  // 'stub'  = run the engine's reference generator by name (terminal/labs).
  backend: 'clang' | 'nsc' | 'stub';
}

const ECHO_SERVER = `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

/* Iterative TCP echo server: accept one client at a time and bounce
   back whatever it sends, until the client half-closes (EOF). */
int main(int argc, char **argv) {
    int port = argc > 1 ? atoi(argv[1]) : 7;

    int ls = socket(AF_INET, SOCK_STREAM, 0);

    struct sockaddr_in addr = {0};
    addr.sin_family      = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port        = htons(port);
    bind(ls, (struct sockaddr *)&addr, sizeof addr);
    listen(ls, 16);
    printf("listening on :%d\\n", port);

    for (;;) {
        int c = accept(ls, NULL, NULL);          /* blocks until a client connects */
        printf("accepted a connection\\n");

        char buf[4096];
        ssize_t n;
        while ((n = recv(c, buf, sizeof buf, 0)) > 0)
            send(c, buf, n, 0);                   /* echo the bytes back */

        close(c);
        printf("connection closed\\n");
    }
}
`;

const ECHO_CLIENT = `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <unistd.h>

/* TCP client: connect, send one line, read the reply, print it, close. */
int main(int argc, char **argv) {
    const char *ip  = argc > 1 ? argv[1] : "10.0.0.1";
    int         port= argc > 2 ? atoi(argv[2]) : 7;
    const char *msg = argc > 3 ? argv[3] : "hello world";

    int fd = socket(AF_INET, SOCK_STREAM, 0);

    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET;
    addr.sin_port   = htons(port);
    inet_pton(AF_INET, ip, &addr.sin_addr);

    if (connect(fd, (struct sockaddr *)&addr, sizeof addr) < 0) {
        printf("connect failed\\n");
        return 1;
    }
    printf("connected to %s:%d\\n", ip, port);

    char line[512];
    int len = snprintf(line, sizeof line, "%s\\n", msg);
    send(fd, line, len, 0);

    char buf[4096];
    ssize_t n = recv(fd, buf, sizeof buf, 0);
    printf("reply: %.*s\\n", (int)(n > 0 ? n - 1 : 0), buf);  /* drop trailing newline */

    close(fd);
    printf("done\\n");
}
`;

const UDP_ECHO_SERVER = `#include <stdio.h>
#include <stdlib.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <arpa/inet.h>
#include <unistd.h>

/* UDP echo server: bind a port, bounce each datagram back to its sender. */
int main(int argc, char **argv) {
    int port = argc > 1 ? atoi(argv[1]) : 7;

    int fd = socket(AF_INET, SOCK_DGRAM, 0);

    struct sockaddr_in addr = {0};
    addr.sin_family      = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port        = htons(port);
    bind(fd, (struct sockaddr *)&addr, sizeof addr);
    printf("listening on udp :%d\\n", port);

    for (;;) {
        char buf[4096];
        struct sockaddr_in from;
        socklen_t flen = sizeof from;
        ssize_t n = recvfrom(fd, buf, sizeof buf, 0, (struct sockaddr *)&from, &flen);
        if (n <= 0) continue;

        char ipstr[16];
        inet_ntop(AF_INET, &from.sin_addr, ipstr, sizeof ipstr);
        printf("datagram from %s:%d\\n", ipstr, ntohs(from.sin_port));

        sendto(fd, buf, n, 0, (struct sockaddr *)&from, flen);  /* echo back */
    }
}
`;

const UDP_CLIENT = `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <unistd.h>

/* UDP client: send one datagram, wait for the reply (or report none). */
int main(int argc, char **argv) {
    const char *ip  = argc > 1 ? argv[1] : "10.0.0.1";
    int         port= argc > 2 ? atoi(argv[2]) : 7;
    const char *msg = argc > 3 ? argv[3] : "ping";

    int fd = socket(AF_INET, SOCK_DGRAM, 0);

    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET;
    addr.sin_port   = htons(port);
    inet_pton(AF_INET, ip, &addr.sin_addr);

    char line[512];
    int len = snprintf(line, sizeof line, "%s\\n", msg);
    sendto(fd, line, len, 0, (struct sockaddr *)&addr, sizeof addr);
    printf("sent to %s:%d\\n", ip, port);

    char buf[4096];
    ssize_t n = recvfrom(fd, buf, sizeof buf, 0, NULL, NULL);
    if (n > 0) printf("reply: %.*s\\n", (int)(n - 1), buf);
    else       printf("no reply\\n");

    close(fd);
    printf("done\\n");
}
`;

const FORK_DEMO = `/* Real multi-process C: fork() clones the process. Both parent and child continue
   from the fork() call - the parent gets the child's pid, the child gets 0.
   (Compiled by real clang; fork is implemented by cloning the WebAssembly memory.) */
#include <stdio.h>
#include <unistd.h>

int main(void) {
    printf("before fork (pid %d)\\n", getpid());
    int pid = fork();
    if (pid == 0) {
        printf("  child: I am pid %d\\n", getpid());
    } else {
        printf("  parent: my child is pid %d\\n", pid);
    }
    printf("both processes reach here\\n");
    return 0;
}
`;

const SIGNALS_DEMO = `/* Signals: register a handler with signal(), then raise() it. The handler is a
   real C function the runtime calls via the module's function table. (Compiled by real clang.) */
#include <stdio.h>
#include <signal.h>

static int hits = 0;
void on_signal(int s) { hits++; printf("  handler: caught signal %d\\n", s); }

int main(void) {
    signal(SIGINT, on_signal);
    printf("installed a SIGINT handler; raising it twice\\n");
    raise(SIGINT);
    raise(SIGINT);
    printf("done - handled %d signals\\n", hits);
    return 0;
}
`;

const THREADED_SERVER = `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

/* Concurrent TCP echo server: the accept() loop spawns a worker thread per
   connection, so a slow client never blocks the others. Compiled by real clang;
   <pthread.h> works, and the threads run as cooperative green threads that switch
   at each blocking call (connect/accept/recv). Run this, then connect two clients. */
void *serve(void *arg) {
    int c = (int)(long)arg;                       /* the accepted connection fd */
    char buf[4096];
    ssize_t n;
    while ((n = recv(c, buf, sizeof buf, 0)) > 0)  /* this thread blocks here... */
        send(c, buf, n, 0);                        /* ...others keep running     */
    close(c);
    printf("worker: client gone\\n");
    return NULL;
}

int main(int argc, char **argv) {
    int port = argc > 1 ? atoi(argv[1]) : 7;

    int ls = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in addr = {0};
    addr.sin_family      = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port        = htons(port);
    bind(ls, (struct sockaddr *)&addr, sizeof addr);
    listen(ls, 16);
    printf("threaded server listening on :%d\\n", port);

    for (;;) {
        int c = accept(ls, NULL, NULL);            /* blocks for the next client */
        printf("accepted; spawning a worker\\n");
        pthread_t t;
        pthread_create(&t, NULL, serve, (void *)(long)c);
        pthread_detach(t);                         /* reap on its own */
    }
}
`;

const THREADS_DEMO = `/* pthreads: two threads share a mutex-protected counter; the main thread joins
   them and reads each one's return value. Compiled by real clang (#include <pthread.h>).
   The threads are cooperative green threads - they switch at pthread_mutex_lock and
   at sched_yield(). No real OS threads, no data races, same API. */
#include <stdio.h>
#include <pthread.h>
int sched_yield(void);

pthread_mutex_t mtx = PTHREAD_MUTEX_INITIALIZER;
int counter = 0;

void *worker(void *arg) {
    long id = (long)arg;
    for (int i = 0; i < 3; i++) {
        pthread_mutex_lock(&mtx);
        counter++;
        printf("thread %ld: counter = %d\\n", id, counter);
        pthread_mutex_unlock(&mtx);
        sched_yield();                 /* give the other thread a turn */
    }
    return (void *)(id * 100);
}

int main(void) {
    pthread_t t1, t2;
    pthread_create(&t1, NULL, worker, (void *)1);
    pthread_create(&t2, NULL, worker, (void *)2);
    void *r1, *r2;
    pthread_join(t1, &r1);
    pthread_join(t2, &r2);
    printf("joined: counter=%d, returns %ld and %ld\\n", counter, (long)r1, (long)r2);
    return 0;
}
`;

const SELECT_SERVER = `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>

/* select() echo server: ONE thread serving many clients. select() blocks until
   any of the watched fds is ready, then we handle whichever woke up. No threads,
   no fork - just an fd_set and a loop. Compiled by real clang. */
int main(int argc, char **argv) {
    int port = argc > 1 ? atoi(argv[1]) : 7;
    int ls = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in a = {0};
    a.sin_family = AF_INET; a.sin_addr.s_addr = htonl(INADDR_ANY); a.sin_port = htons(port);
    bind(ls, (struct sockaddr *)&a, sizeof a);
    listen(ls, 16);
    printf("select server on :%d\\n", port);

    int cl[16], nc = 0;
    for (;;) {
        fd_set r; FD_ZERO(&r); FD_SET(ls, &r); int mx = ls;
        for (int i = 0; i < nc; i++) { FD_SET(cl[i], &r); if (cl[i] > mx) mx = cl[i]; }

        if (select(mx + 1, &r, NULL, NULL, NULL) < 0) break;   /* blocks on the whole set */

        if (FD_ISSET(ls, &r)) {                                 /* a new connection */
            int c = accept(ls, NULL, NULL);
            if (nc < 16) cl[nc++] = c;
            printf("accepted; now %d clients\\n", nc);
        }
        for (int i = 0; i < nc; i++) if (FD_ISSET(cl[i], &r)) {  /* a client has data */
            char buf[512];
            int k = recv(cl[i], buf, sizeof buf, 0);
            if (k <= 0) { close(cl[i]); cl[i] = cl[--nc]; i--; }  /* client left */
            else send(cl[i], buf, k, 0);                         /* echo */
        }
    }
    return 0;
}
`;

const POLL_SERVER = `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <poll.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>

/* The same single-thread concurrent echo server, written with poll() instead of
   select(). poll() takes an array of struct pollfd and fills in .revents. It
   scales better than select() and has no FD_SETSIZE limit. Compiled by real clang. */
int main(int argc, char **argv) {
    int port = argc > 1 ? atoi(argv[1]) : 7;
    int ls = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in a = {0};
    a.sin_family = AF_INET; a.sin_addr.s_addr = htonl(INADDR_ANY); a.sin_port = htons(port);
    bind(ls, (struct sockaddr *)&a, sizeof a);
    listen(ls, 16);
    printf("poll server on :%d\\n", port);

    struct pollfd fds[17];
    fds[0].fd = ls; fds[0].events = POLLIN; int nf = 1;
    for (;;) {
        if (poll(fds, nf, -1) < 0) break;                        /* -1 = block forever */

        if (fds[0].revents & POLLIN) {
            int c = accept(ls, NULL, NULL);
            if (nf < 17) { fds[nf].fd = c; fds[nf].events = POLLIN; nf++; }
        }
        for (int i = 1; i < nf; i++)
            if (fds[i].revents & (POLLIN | POLLHUP | POLLERR)) {
                char buf[512];
                int k = recv(fds[i].fd, buf, sizeof buf, 0);
                if (k <= 0) { close(fds[i].fd); fds[i] = fds[--nf]; i--; }
                else send(fds[i].fd, buf, k, 0);
            }
    }
    return 0;
}
`;

const EPOLL_SERVER = `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>

/* The Linux epoll() version: register fds once with epoll_ctl(), then epoll_wait()
   returns only the fds that are ready - O(ready) instead of O(all). The idiom
   behind high-concurrency servers. Compiled by real clang (<sys/epoll.h>). */
int main(int argc, char **argv) {
    int port = argc > 1 ? atoi(argv[1]) : 7;
    int ls = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in a = {0};
    a.sin_family = AF_INET; a.sin_addr.s_addr = htonl(INADDR_ANY); a.sin_port = htons(port);
    bind(ls, (struct sockaddr *)&a, sizeof a);
    listen(ls, 16);

    int ep = epoll_create1(0);
    struct epoll_event ev = { .events = EPOLLIN, .data = { .fd = ls } };
    epoll_ctl(ep, EPOLL_CTL_ADD, ls, &ev);
    printf("epoll server on :%d\\n", port);

    struct epoll_event evs[16];
    for (;;) {
        int n = epoll_wait(ep, evs, 16, -1);
        if (n < 0) break;
        for (int i = 0; i < n; i++) {
            int fd = evs[i].data.fd;
            if (fd == ls) {
                int c = accept(ls, NULL, NULL);
                struct epoll_event ce = { .events = EPOLLIN, .data = { .fd = c } };
                epoll_ctl(ep, EPOLL_CTL_ADD, c, &ce);
            } else {
                char buf[512];
                int k = recv(fd, buf, sizeof buf, 0);
                if (k <= 0) { epoll_ctl(ep, EPOLL_CTL_DEL, fd, NULL); close(fd); }
                else send(fd, buf, k, 0);
            }
        }
    }
    return 0;
}
`;

const EINTR_DEMO = `#include <stdio.h>
#include <signal.h>
#include <errno.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>

/* Signals + EINTR: a blocking syscall interrupted by a signal returns -1 with
   errno == EINTR. We arm alarm(2), block in accept() with no client, and watch
   the SIGALRM handler fire and the accept() come back interrupted. Compiled by
   real clang; the handler is a real C function the runtime calls via the table. */
volatile sig_atomic_t fired = 0;
void on_alarm(int sig) { fired = sig; printf("  handler: SIGALRM (%d)\\n", sig); }

int main(void) {
    signal(SIGALRM, on_alarm);
    int ls = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in a = {0};
    a.sin_family = AF_INET; a.sin_addr.s_addr = htonl(INADDR_ANY); a.sin_port = htons(7);
    bind(ls, (struct sockaddr *)&a, sizeof a);
    listen(ls, 16);

    alarm(2);                               /* deliver SIGALRM in 2 seconds */
    printf("blocking in accept()...\\n");
    int c = accept(ls, NULL, NULL);          /* no client: this blocks */
    if (c < 0 && errno == EINTR)
        printf("accept() interrupted by signal (EINTR); fired=%d\\n", fired);
    else
        printf("accept() returned %d\\n", c);
    return 0;
}
`;

const NSC_TCP_CLIENT = `/* nsC, really compiled: a blocking TCP echo client.
   connect() and recv() suspend the program and resume when the network is
   ready - compiled to a WebAssembly state machine, driven by the sim clock.
   Builtins: tcp(), connect(fd, ip, port), send(fd, "msg"),
   recv(fd) -> length (data in a buffer), printbuf(len), close(fd). */
int main(void) {
    int fd = tcp();
    connect(fd, ip(), port());        /* blocks until the handshake completes */
    send(fd, "hello from nsC\\n");
    int n = recv(fd);                 /* blocks until the server replies */
    printbuf(n);
    close(fd);
}
`;

const NSC_TCP_SERVER = `/* nsC, really compiled: an iterative TCP echo server.
   accept() and recv() block and resume via the compiled wasm state machine -
   blocking works inside loops now. recv(c) lands bytes in a buffer; sendbuf(c, n)
   sends n of them back. Run this on one host and the TCP echo client on another. */
int main(void) {
    int ls = tcp();
    bind(ls, port());
    listen(ls);
    while (1) {
        int c = accept(ls);           /* blocks for the next client */
        int n = recv(c);              /* blocks for its first bytes */
        while (n > 0) {
            sendbuf(c, n);            /* echo them back */
            n = recv(c);
        }
        close(c);
    }
}
`;

const NSC_UDP_SEND = `/* nsC: a small, real subset of C compiled to WebAssembly in your browser.
   No headers or structs yet. Builtins: udp(), bind(fd, port),
   sendto(fd, ip, port, "msg"), print("..."), close(fd), ip(), port().
   ip()/port() are the two arguments on the right. Edit and re-run! */
int main(void) {
    int fd = udp();
    sendto(fd, ip(), port(), "hello from nsC\\n");
    print("datagram sent");
    close(fd);
}
`;

export const CPROGRAMS: CProgramMeta[] = [
  // Real clang (full C): compiled in-browser by the opt-in toolchain. These are ordinary C programs.
  { name: 'echo-client', title: 'TCP echo client (real C)', proto: 'tcp', blurb: 'connect, send a line, read the reply - full C, real clang', defaultArgs: '10.0.0.1 7 hello world', source: ECHO_CLIENT, backend: 'clang' },
  { name: 'echo-server', title: 'TCP echo server (real C)', proto: 'tcp', blurb: 'accept() loop that echoes each client - full C, real clang', defaultArgs: '7', source: ECHO_SERVER, backend: 'clang' },
  { name: 'udp-echo-server', title: 'UDP echo server (real C)', proto: 'udp', blurb: 'recvfrom/sendto datagram bounce - full C, real clang', defaultArgs: '7', source: UDP_ECHO_SERVER, backend: 'clang' },
  { name: 'udp-client', title: 'UDP client (real C)', proto: 'udp', blurb: 'send one datagram, await the reply - full C, real clang', defaultArgs: '10.0.0.1 7 ping', source: UDP_CLIENT, backend: 'clang' },
  { name: 'threaded-server', title: 'Threaded TCP server (real C, pthreads)', proto: 'tcp', blurb: 'accept() loop spawns a worker thread per connection - full C, #include <pthread.h>', defaultArgs: '7', source: THREADED_SERVER, backend: 'clang' },
  { name: 'threads-demo', title: 'pthreads demo (real C)', proto: 'tcp', blurb: 'two threads, a mutex-protected counter, and join() return values', defaultArgs: '', source: THREADS_DEMO, backend: 'clang' },
  { name: 'select-server', title: 'select() server (real C, one thread)', proto: 'tcp', blurb: 'one thread serving many clients with select() and an fd_set', defaultArgs: '7', source: SELECT_SERVER, backend: 'clang' },
  { name: 'poll-server', title: 'poll() server (real C, one thread)', proto: 'tcp', blurb: 'the same, with poll() and a struct pollfd array', defaultArgs: '7', source: POLL_SERVER, backend: 'clang' },
  { name: 'epoll-server', title: 'epoll() server (real C, one thread)', proto: 'tcp', blurb: 'the Linux epoll_create/_ctl/_wait idiom behind high-concurrency servers', defaultArgs: '7', source: EPOLL_SERVER, backend: 'clang' },
  { name: 'eintr-demo', title: 'signals + EINTR (real C)', proto: 'tcp', blurb: 'a blocking accept() interrupted by SIGALRM returns -1 / errno EINTR', defaultArgs: '', source: EINTR_DEMO, backend: 'clang' },
  { name: 'fork-demo', title: 'fork() demo (real C, multi-process)', proto: 'tcp', blurb: 'fork() clones the process; parent and child both continue', defaultArgs: '', source: FORK_DEMO, backend: 'clang' },
  { name: 'signals-demo', title: 'signals demo (real C)', proto: 'tcp', blurb: 'signal() + raise(): a handler the runtime calls via the function table', defaultArgs: '', source: SIGNALS_DEMO, backend: 'clang' },
  // nsC fallback (no download): a small C subset compiled in-app without the toolchain.
  { name: 'tcp-client-nsc', title: 'TCP echo client (nsC, no download)', proto: 'tcp', blurb: 'nsC subset - compiles instantly without the toolchain', defaultArgs: '10.0.0.1 7', source: NSC_TCP_CLIENT, backend: 'nsc' },
  { name: 'tcp-server-nsc', title: 'TCP echo server (nsC, no download)', proto: 'tcp', blurb: 'nsC subset accept/recv loop', defaultArgs: '0.0.0.0 7', source: NSC_TCP_SERVER, backend: 'nsc' },
  { name: 'udp-send-nsc', title: 'UDP sender (nsC, no download)', proto: 'udp', blurb: 'nsC subset UDP sender', defaultArgs: '10.0.0.1 7', source: NSC_UDP_SEND, backend: 'nsc' },
];
export const CPROGRAM_NAMES = CPROGRAMS.map(p => p.name);
// Names that run via the engine's reference generators (terminal `crun` + lab solvers).
export const CPROGRAM_GENERATOR_NAMES = ['echo-client', 'echo-server', 'udp-echo-server', 'udp-client'];

// A compiler diagnostic, shaped like clang's (line/col/message/severity) so the stub and the real
// in-browser clang produce the same thing and the UI renders both identically.
export interface CDiagnostic { line: number; col: number; message: string; severity: 'error' | 'warning' }

export interface CApiEntry { group: string; name: string; sig: string; desc: string }
export const C_API: CApiEntry[] = [
  { group: 'Sockets', name: 'socket', sig: 'int socket(int domain, int type, int proto)', desc: 'Create an endpoint. AF_INET + SOCK_STREAM = TCP, SOCK_DGRAM = UDP. Returns a file descriptor.' },
  { group: 'Sockets', name: 'bind', sig: 'int bind(int fd, const struct sockaddr *a, socklen_t n)', desc: 'Give a socket a local address/port before listen() or recvfrom().' },
  { group: 'Sockets', name: 'listen', sig: 'int listen(int fd, int backlog)', desc: 'Mark a bound TCP socket passive so it can accept() connections.' },
  { group: 'Sockets', name: 'accept', sig: 'int accept(int fd, struct sockaddr *a, socklen_t *n)', desc: 'Take the next established connection off the queue; returns a new fd. Blocks if none.' },
  { group: 'Sockets', name: 'connect', sig: 'int connect(int fd, const struct sockaddr *a, socklen_t n)', desc: 'Initiate a TCP connection (the 3-way handshake). Blocks until established or error.' },
  { group: 'Transfer', name: 'send', sig: 'ssize_t send(int fd, const void *buf, size_t n, int flags)', desc: 'Write bytes to a connected socket. May send fewer than n; loop for the rest.' },
  { group: 'Transfer', name: 'recv', sig: 'ssize_t recv(int fd, void *buf, size_t n, int flags)', desc: 'Read up to n bytes. Returns 0 at EOF (peer closed), <0 on error. Blocks if empty.' },
  { group: 'Transfer', name: 'sendto', sig: 'ssize_t sendto(int fd, const void *buf, size_t n, int flags, const struct sockaddr *to, socklen_t tn)', desc: 'Send one UDP datagram to an address.' },
  { group: 'Transfer', name: 'recvfrom', sig: 'ssize_t recvfrom(int fd, void *buf, size_t n, int flags, struct sockaddr *from, socklen_t *fn)', desc: 'Receive one UDP datagram and learn the sender address. Blocks if none.' },
  { group: 'Transfer', name: 'close', sig: 'int close(int fd)', desc: 'Close a socket. For TCP this starts the orderly FIN teardown.' },
  { group: 'Addresses', name: 'htons / htonl', sig: 'uint16_t htons(uint16_t); uint32_t htonl(uint32_t)', desc: 'Host-to-network byte order. Ports and addresses go on the wire big-endian.' },
  { group: 'Addresses', name: 'inet_pton', sig: 'int inet_pton(int af, const char *src, void *dst)', desc: 'Parse "10.0.0.1" into a struct in_addr.' },
  { group: 'Addresses', name: 'inet_ntop', sig: 'const char *inet_ntop(int af, const void *src, char *dst, socklen_t n)', desc: 'Format a struct in_addr back into a dotted-quad string.' },
  { group: 'Processes', name: 'fork', sig: 'int fork(void)', desc: 'Clone the process. Returns the child pid in the parent, 0 in the child; both continue from here.' },
  { group: 'Processes', name: 'execv / execvp', sig: 'int execv(const char *path, char *const argv[])', desc: 'Replace the current process image with another compiled program, by name.' },
  { group: 'Processes', name: 'signal', sig: 'void (*signal(int sig, void (*handler)(int)))(int)', desc: 'Install a handler for a signal (SIGINT, SIGALRM, ...). raise()/alarm()/kill() deliver them. A signal that arrives during a blocking call interrupts it: the call returns -1 with errno == EINTR.' },
  { group: 'Multiplexing', name: 'select', sig: 'int select(int nfds, fd_set *r, fd_set *w, fd_set *e, struct timeval *t)', desc: 'Block until any fd in a set is readable/writable/errored, or the timeout elapses. Build sets with FD_ZERO/FD_SET, test results with FD_ISSET. One thread, many sockets.' },
  { group: 'Multiplexing', name: 'poll', sig: 'int poll(struct pollfd *fds, nfds_t n, int timeout_ms)', desc: 'Like select but with an array of {fd, events} - set .events to POLLIN/POLLOUT, read back .revents. timeout_ms = -1 blocks, 0 polls.' },
  { group: 'Multiplexing', name: 'epoll_create / _ctl / _wait', sig: 'int epoll_create1(int); int epoll_ctl(int, int op, int fd, struct epoll_event *); int epoll_wait(int, struct epoll_event *, int, int)', desc: 'Register fds once (EPOLL_CTL_ADD), then epoll_wait returns only the ready ones - the scalable Linux idiom. Each event carries your epoll_data back.' },
  { group: 'Threads', name: 'pthread_create', sig: 'int pthread_create(pthread_t *t, const pthread_attr_t *a, void *(*fn)(void *), void *arg)', desc: 'Start a thread running fn(arg). Threads share memory; they run as cooperative green threads that switch at blocking calls.' },
  { group: 'Threads', name: 'pthread_join', sig: 'int pthread_join(pthread_t t, void **ret)', desc: 'Block until thread t finishes; receive its return value. Pair with pthread_detach to reap automatically instead.' },
  { group: 'Threads', name: 'pthread_mutex_lock', sig: 'int pthread_mutex_lock(pthread_mutex_t *m) / _unlock', desc: 'Guard shared state. Initialize with PTHREAD_MUTEX_INITIALIZER. No real contention (one thread runs at a time), but the API is honored.' },
  { group: 'Threads', name: 'pthread_cond_wait', sig: 'int pthread_cond_wait(pthread_cond_t *c, pthread_mutex_t *m) / _signal / _broadcast', desc: 'Condition variables for worker-pool patterns: wait releases the mutex and blocks until signaled.' },
  { group: 'Threads', name: 'sched_yield', sig: 'int sched_yield(void)', desc: 'Voluntarily give another runnable thread a turn.' },
];
