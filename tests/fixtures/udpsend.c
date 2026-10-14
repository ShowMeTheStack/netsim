#include <stdio.h>
#include <string.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <arpa/inet.h>
#include <unistd.h>

int main(void) {
  int fd = socket(AF_INET, SOCK_DGRAM, 0);
  struct sockaddr_in a;
  memset(&a, 0, sizeof a);
  a.sin_family = AF_INET;
  a.sin_port = htons(7);
  inet_pton(AF_INET, "10.0.0.1", &a.sin_addr);
  const char *msg = "hello from real clang\n";
  sendto(fd, msg, strlen(msg), 0, (struct sockaddr *)&a, sizeof a);
  printf("sent %d bytes\n", (int)strlen(msg));
  close(fd);
  return 0;
}
