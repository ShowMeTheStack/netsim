#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <poll.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
int main(int argc, char **argv) {
  int port = argc > 1 ? atoi(argv[1]) : 7;
  int ls = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in a; memset(&a, 0, sizeof a);
  a.sin_family = AF_INET; a.sin_addr.s_addr = htonl(INADDR_ANY); a.sin_port = htons(port);
  bind(ls, (struct sockaddr *)&a, sizeof a); listen(ls, 16);
  printf("poll server on :%d\n", port); fflush(stdout);
  struct pollfd fds[17]; int nf = 1; fds[0].fd = ls; fds[0].events = POLLIN;
  for (;;) {
    int n = poll(fds, nf, -1);
    if (n < 0) break;
    if (fds[0].revents & POLLIN) { int c = accept(ls, NULL, NULL); printf("accepted a client\n"); fflush(stdout); if (nf < 17) { fds[nf].fd = c; fds[nf].events = POLLIN; nf++; } }
    for (int i = 1; i < nf; i++) if (fds[i].revents & (POLLIN | POLLHUP | POLLERR)) { char buf[256]; int k = recv(fds[i].fd, buf, sizeof buf, 0); if (k <= 0) { close(fds[i].fd); fds[i] = fds[--nf]; i--; printf("client gone\n"); fflush(stdout); } else send(fds[i].fd, buf, k, 0); }
  }
  return 0;
}
