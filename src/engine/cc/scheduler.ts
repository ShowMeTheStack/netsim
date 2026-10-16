// Controlled-scheduler oracle for the C runtime (E3).
//
// The clang runtime runs green fibers (pthreads) one at a time and picks the next runnable fiber in
// round-robin order. That pick is the single scheduling choice point that decides thread
// interleaving. This module lets a research harness replace that choice with an oracle so it can
// explore interleavings systematically and replay any one of them exactly, while packet events stay
// on the same deterministic virtual clock.
//
// SAFETY: when no scheduler is installed (the default, `null`), the runtime uses its original
// round-robin and behaves bit-identically to before. The oracle is opt-in and headless only.

export interface SchedulerChoice {
  pid: number;          // the process making the choice
  step: number;         // monotonic decision index within that process
  runnable: number[];   // fiber ids eligible to run (state 'new' or 'ready'), in fiber order
}
export interface Scheduler {
  /** Pick which runnable fiber id advances next. Must return one of `choice.runnable`. */
  choose(choice: SchedulerChoice): number;
}

let active: Scheduler | null = null;
/** Install (or clear with null) the global scheduler oracle. Headless search use only. */
export function setScheduler(s: Scheduler | null): void { active = s; }
export function getScheduler(): Scheduler | null { return active; }
/** Run `fn` with an oracle installed, restoring the previous one afterward. */
export function withScheduler<T>(s: Scheduler, fn: () => T): T {
  const prev = active; active = s;
  try { return fn(); } finally { active = prev; }
}

/** Randomized interleaving explorer (seeded, so a run is reproducible from its seed and its recorded
 *  decisions). Records every decision so a failing schedule can be replayed. */
export class RandomScheduler implements Scheduler {
  private s: number;
  readonly decisions: { pid: number; step: number; chosen: number; options: number[] }[] = [];
  constructor(seed: number) { this.s = (seed >>> 0) || 0x9e3779b9; }
  private next(): number { let x = this.s; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.s = x >>> 0; return this.s / 4294967296; }
  choose(ch: SchedulerChoice): number {
    const i = Math.min(ch.runnable.length - 1, Math.floor(this.next() * ch.runnable.length));
    const chosen = ch.runnable[i]!;
    this.decisions.push({ pid: ch.pid, step: ch.step, chosen, options: ch.runnable.slice() });
    return chosen;
  }
  /** The chosen-fiber sequence, for building a ReplayScheduler. */
  schedule(): number[] { return this.decisions.map(d => d.chosen); }
}

/** Replays a recorded decision sequence exactly; once exhausted (or if a recorded choice is no longer
 *  runnable) it falls back to the first runnable fiber, deterministically. */
export class ReplayScheduler implements Scheduler {
  private i = 0;
  constructor(private readonly decisions: number[]) {}
  choose(ch: SchedulerChoice): number {
    const d = this.decisions[this.i++];
    return d !== undefined && ch.runnable.includes(d) ? d : ch.runnable[0]!;
  }
}
