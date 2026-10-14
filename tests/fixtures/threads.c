#include <stdio.h>
#include <pthread.h>
int sched_yield(void);

pthread_mutex_t mtx = PTHREAD_MUTEX_INITIALIZER;
int counter = 0;

void *worker(void *arg) {
  long id = (long)arg;
  for (int i = 0; i < 3; i++) {
    pthread_mutex_lock(&mtx);
    counter++;
    int snap = counter;
    pthread_mutex_unlock(&mtx);
    printf("worker %ld inc -> %d\n", id, snap); fflush(stdout);
    sched_yield();
  }
  return (void *)(id * 10);
}

int main(void) {
  pthread_t t1, t2;
  printf("main: spawning two threads\n"); fflush(stdout);
  pthread_create(&t1, NULL, worker, (void *)1);
  pthread_create(&t2, NULL, worker, (void *)2);
  void *r1 = 0, *r2 = 0;
  pthread_join(t1, &r1);
  pthread_join(t2, &r2);
  printf("main: joined counter=%d r1=%ld r2=%ld\n", counter, (long)r1, (long)r2); fflush(stdout);
  return 0;
}
