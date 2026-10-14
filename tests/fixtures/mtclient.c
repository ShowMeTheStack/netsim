#include <stdio.h>
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
  if (connect(fd, (struct sockaddr *)&a, sizeof a) < 0) { printf("thread %ld connect failed\n", id); fflush(stdout); return (void *)1; }
  char msg[64]; int ml = snprintf(msg, sizeof msg, "hi from thread %ld\n", id);
  send(fd, msg, ml, 0);
  char buf[128]; int n = recv(fd, buf, sizeof buf, 0);
  printf("thread %ld got: %.*s", id, n > 0 ? n : 0, buf); fflush(stdout);
  close(fd);
  return (void *)(id * 100);
}

int main(void) {
  pthread_t t1, t2;
  pthread_create(&t1, NULL, worker, (void *)1);
  pthread_create(&t2, NULL, worker, (void *)2);
  void *r1 = 0, *r2 = 0;
  pthread_join(t1, &r1);
  pthread_join(t2, &r2);
  printf("main joined r1=%ld r2=%ld\n", (long)r1, (long)r2); fflush(stdout);
  return 0;
}
