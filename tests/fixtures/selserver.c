#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
int main(int argc, char **argv) {
  int port = argc > 1 ? atoi(argv[1]) : 7;
  int ls = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in a; memset(&a, 0, sizeof a);
  a.sin_family = AF_INET; a.sin_addr.s_addr = htonl(INADDR_ANY); a.sin_port = htons(port);
  bind(ls, (struct sockaddr *)&a, sizeof a); listen(ls, 16);
  printf("select server on :%d\n", port); fflush(stdout);
  int cl[16]; int nc = 0;
  for (;;) {
    fd_set r; FD_ZERO(&r); FD_SET(ls, &r); int mx = ls;
    for (int i = 0; i < nc; i++) { FD_SET(cl[i], &r); if (cl[i] > mx) mx = cl[i]; }
    int n = select(mx + 1, &r, NULL, NULL, NULL);
    if (n < 0) break;
    if (FD_ISSET(ls, &r)) { int c = accept(ls, NULL, NULL); printf("accepted a client\n"); fflush(stdout); if (nc < 16) cl[nc++] = c; }
    for (int i = 0; i < nc; i++) { int c = cl[i]; if (FD_ISSET(c, &r)) { char buf[256]; int k = recv(c, buf, sizeof buf, 0); if (k <= 0) { close(c); cl[i] = cl[--nc]; i--; printf("client gone\n"); fflush(stdout); } else send(c, buf, k, 0); } }
  }
  return 0;
}
