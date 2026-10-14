#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
int main(int argc, char **argv) {
  int port = argc > 1 ? atoi(argv[1]) : 7;
  int ls = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in a; memset(&a, 0, sizeof a);
  a.sin_family = AF_INET; a.sin_addr.s_addr = htonl(INADDR_ANY); a.sin_port = htons(port);
  bind(ls, (struct sockaddr *)&a, sizeof a); listen(ls, 16);
  int ep = epoll_create1(0);
  struct epoll_event ev; ev.events = EPOLLIN; ev.data.fd = ls; epoll_ctl(ep, EPOLL_CTL_ADD, ls, &ev);
  printf("epoll server on :%d\n", port); fflush(stdout);
  struct epoll_event evs[16];
  for (;;) {
    int n = epoll_wait(ep, evs, 16, -1);
    if (n < 0) break;
    for (int i = 0; i < n; i++) {
      int fd = evs[i].data.fd;
      if (fd == ls) { int c = accept(ls, NULL, NULL); printf("accepted a client\n"); fflush(stdout); struct epoll_event ce; ce.events = EPOLLIN; ce.data.fd = c; epoll_ctl(ep, EPOLL_CTL_ADD, c, &ce); }
      else { char buf[256]; int k = recv(fd, buf, sizeof buf, 0); if (k <= 0) { epoll_ctl(ep, EPOLL_CTL_DEL, fd, NULL); close(fd); printf("client gone\n"); fflush(stdout); } else send(fd, buf, k, 0); }
    }
  }
  return 0;
}
