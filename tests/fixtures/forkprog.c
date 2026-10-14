#include <stdio.h>
#include <unistd.h>
int main(void) {
  printf("before fork\n");
  int pid = fork();
  if (pid == 0) printf("child running\n");
  else printf("parent sees child pid %d\n", pid);
  printf("both reach here\n");
  return 0;
}
