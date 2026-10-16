// Learning-process trace recorder (E6).
//
// An opt-in, anonymized, local-first log of learner actions for education research: commands
// issued, breakpoints set and hit, inspector opens, and lab-check pass/fail transitions, each with
// a millisecond offset from the session start. Nothing is sent anywhere; the learner exports a JSON
// file explicitly. Disabled by default, so when tracing is off every hook below is a no-op and the
// tool behaves exactly as before. No names, no free text, only identifiers and command verbs, so
// there is no PII.
import type { Cmd } from '@/shared/protocol';

export interface TraceEvent { t: number; kind: string; data?: Record<string, unknown> }

/** Whitelist safe fields from a command so free text (hostnames, zone files, HTTP bodies) never
 *  enters the trace. For runCmd only the verb is kept, not the full line. */
export function summarizeCmd(c: Cmd): Record<string, unknown> {
  const out: Record<string, unknown> = { type: c.type };
  const anyc = c as unknown as Record<string, unknown>;
  if (typeof anyc.node === 'number') out.node = anyc.node;
  if (typeof anyc.id === 'number') out.id = anyc.id;
  if (typeof anyc.link === 'number') out.link = anyc.link;
  if (c.type === 'runCmd') out.verb = c.line.trim().split(/\s+/)[0] ?? '';
  if (c.type === 'addNode') out.nodeType = c.nodeType;
  if (c.type === 'addBreakpoint') out.expr = c.expr;
  if (c.type === 'compileRun') out.backend = c.backend;
  return out;
}

class TraceRecorder {
  private events: TraceEvent[] = [];
  private on = false;
  private startWall = 0;
  private sessionId = Math.random().toString(36).slice(2, 10);

  enabled(): boolean { return this.on; }
  count(): number { return this.events.length; }

  enable(): void { if (this.on) return; this.on = true; this.startWall = Date.now(); this.events = []; this.record('session.start'); }
  disable(): void { if (!this.on) return; this.record('session.end'); this.on = false; }

  record(kind: string, data?: Record<string, unknown>): void {
    if (!this.on) return;
    this.events.push({ t: Date.now() - this.startWall, kind, data });
    if (this.events.length > 200000) this.events.splice(0, this.events.length - 200000);
  }
  cmd(c: Cmd): void { this.record('cmd', summarizeCmd(c)); }
  clear(): void { this.events = []; }

  export(): string {
    return JSON.stringify({ format: 'netsim-trace', version: 1, sessionId: this.sessionId, createdAt: new Date().toISOString(), events: this.events.slice() }, null, 1);
  }
}

/** The single, module-scoped recorder. */
export const trace = new TraceRecorder();
