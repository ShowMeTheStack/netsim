#include <stdio.h>
#include <signal.h>
#include <errno.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
volatile sig_atomic_t fired = 0;
void on_alarm(int sig) { fired = sig; printf("  handler: SIGALRM (%d)\n", sig); fflush(stdout); }
int main(void) {
  signal(SIGALRM, on_alarm);
  int ls = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in a; memset(&a, 0, sizeof a);
  a.sin_family = AF_INET; a.sin_addr.s_addr = htonl(INADDR_ANY); a.sin_port = htons(7);
  bind(ls, (struct sockaddr *)&a, sizeof a); listen(ls, 16);
  alarm(2);
  printf("blocking in accept()...\n"); fflush(stdout);
  int c = accept(ls, NULL, NULL);
  if (c < 0 && errno == EINTR) printf("accept() interrupted by signal (EINTR); fired=%d\n", fired);
  else printf("accept() returned %d\n", c);
  fflush(stdout);
  return 0;
}
