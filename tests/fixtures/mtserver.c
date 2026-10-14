#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

void *serve(void *arg) {
  int c = (int)(long)arg;
  char buf[4096];
  ssize_t n;
  while ((n = recv(c, buf, sizeof buf, 0)) > 0)
    send(c, buf, n, 0);
  close(c);
  printf("worker: client gone\n"); fflush(stdout);
  return NULL;
}

int main(int argc, char **argv) {
  int port = argc > 1 ? atoi(argv[1]) : 7;
  int ls = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in addr; memset(&addr, 0, sizeof addr);
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_ANY);
  addr.sin_port = htons(port);
  bind(ls, (struct sockaddr *)&addr, sizeof addr);
  listen(ls, 16);
  printf("threaded server listening on :%d\n", port); fflush(stdout);
  for (;;) {
    int c = accept(ls, NULL, NULL);
    printf("accepted; spawning a worker\n"); fflush(stdout);
    pthread_t t;
    pthread_create(&t, NULL, serve, (void *)(long)c);
    pthread_detach(t);
  }
}
