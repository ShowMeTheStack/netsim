/* netsim socket shim: supplies the socket-creation calls stock wasi-libc lacks, as thin wrappers
   over imports the NetSim runtime implements against the engine. clang links these in alongside the
   student's program; the result imports env.ns_sock_* which we bind to the simulated TCP/UDP stack. */
typedef unsigned socklen_t;
struct sockaddr;

#define NSIMPORT(n) __attribute__((import_module("env"), import_name(#n)))

NSIMPORT(ns_sock_socket) int __ns_socket(int domain, int type, int proto);
NSIMPORT(ns_sock_connect) int __ns_connect(int fd, const void *addr, socklen_t len);
NSIMPORT(ns_sock_bind) int __ns_bind(int fd, const void *addr, socklen_t len);
NSIMPORT(ns_sock_listen) int __ns_listen(int fd, int backlog);
NSIMPORT(ns_sock_accept) int __ns_accept(int fd, void *addr, socklen_t *len);

int socket(int domain, int type, int proto) { return __ns_socket(domain, type, proto); }
int connect(int fd, const struct sockaddr *addr, socklen_t len) { return __ns_connect(fd, addr, len); }
int bind(int fd, const struct sockaddr *addr, socklen_t len) { return __ns_bind(fd, addr, len); }
int listen(int fd, int backlog) { return __ns_listen(fd, backlog); }
int accept(int fd, struct sockaddr *addr, socklen_t *len) { return __ns_accept(fd, addr, len); }

typedef unsigned long size_t;
typedef long ssize_t;
NSIMPORT(ns_sock_sendto) int __ns_sendto(int fd, const void *buf, size_t len, int flags, const void *addr, socklen_t alen);
NSIMPORT(ns_sock_recvfrom) int __ns_recvfrom(int fd, void *buf, size_t len, int flags, void *addr, socklen_t *alen);
ssize_t sendto(int fd, const void *buf, size_t len, int flags, const struct sockaddr *addr, socklen_t alen) { return __ns_sendto(fd, buf, len, flags, addr, alen); }
ssize_t recvfrom(int fd, void *buf, size_t len, int flags, struct sockaddr *addr, socklen_t *alen) { return __ns_recvfrom(fd, buf, len, flags, addr, alen); }
