#include <stdio.h>
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
  if (connect(fd, (struct sockaddr *)&a, sizeof a) < 0) { printf("connect failed\n"); return 1; }
  printf("connected\n");
  const char *m = "hello from clang tcp\n";
  send(fd, m, strlen(m), 0);
  char buf[256];
  int n = recv(fd, buf, sizeof buf, 0);
  printf("reply: %.*s", n > 0 ? n : 0, buf);
  close(fd);
  return 0;
}
