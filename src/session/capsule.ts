// Reproducibility capsule (E1).
//
// A capsule turns a run into a self-contained, bit-reproducible artifact: a setup (seed or an
// initial session), an ordered list of operations (commands and clock advances), and the SHA-256
// hash of the final engine state. Replaying the capsule on a fresh engine must reach a
// byte-identical state, which `replayCapsule` verifies against the stored hash. This is the engine
// side of the "executable, reproducible paper" idea and the ground truth for the determinism claim.
//
// The hash is taken over a canonical serialization of EngineState (object keys sorted, Uint8Array
// tagged), so two structurally identical states hash identically regardless of key insertion order.
import * as E from './../engine/engine';
import { applyCmd } from './../engine/commands';
import { parseSession } from './session';
import { toBase64 } from '@/shared/bytes';
import type { EngineState } from '@/engine/types';
import type { Cmd } from '@/shared/protocol';

export type CapsuleSetup = { k: 'seed'; seed: number } | { k: 'session'; json: string };
export type CapsuleOp =
  | { k: 'cmd'; cmd: Cmd }
  | { k: 'adv'; untilT: number; maxEvents: number; stopOnPacket?: boolean; quiescentGapUs?: number };
export interface Capsule {
  format: 'netsim-capsule'; version: 1; createdAt: string; engineVersion: number;
  setup: CapsuleSetup; ops: CapsuleOp[]; finalHash: string;
}

/** Canonical, deterministic serialization of any engine value for hashing. */
function canon(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (v instanceof Uint8Array) return '"u8:' + toBase64(v) + '"';
  const t = typeof v;
  if (t === 'number' || t === 'boolean' || t === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (t === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}';
  }
  return 'null';
}

/** SHA-256 (hex) over the canonical serialization of the whole engine state. */
export async function hashState(st: EngineState): Promise<string> {
  const data = new TextEncoder().encode(canon(st));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Build a fresh engine state from a capsule setup. */
export function engineFromSetup(setup: CapsuleSetup): EngineState {
  if (setup.k === 'seed') return E.createState(setup.seed);
  const f = parseSession(setup.json); E.ensureServices(f.state); return f.state;
}

/** Apply one capsule op, returning the (possibly replaced) state. */
export function applyOp(st: EngineState, op: CapsuleOp): EngineState {
  if (op.k === 'cmd') { const r = applyCmd(st, op.cmd); return r.newState ?? st; }
  E.advance(st, op.untilT, op.maxEvents, op.stopOnPacket ?? false, op.quiescentGapUs ?? Infinity);
  return st;
}

/** Replay a capsule on a fresh engine and verify it reaches the recorded final state. */
export async function replayCapsule(cap: Capsule): Promise<{ ok: boolean; gotHash: string; wantHash: string; state: EngineState }> {
  let st = engineFromSetup(cap.setup);
  for (const op of cap.ops) st = applyOp(st, op);
  const gotHash = await hashState(st);
  return { ok: gotHash === cap.finalHash, gotHash, wantHash: cap.finalHash, state: st };
}

/** Drive a run while recording every command and advance, then emit a self-consistent capsule.
 *  This is the convenient path for experiments and for the worker's own journaling. */
export class CapsuleRecorder {
  st: EngineState;
  ops: CapsuleOp[] = [];
  private setup: CapsuleSetup;
  constructor(setup: CapsuleSetup) { this.setup = setup; this.st = engineFromSetup(setup); }
  static fromSeed(seed: number) { return new CapsuleRecorder({ k: 'seed', seed }); }

  cmd(c: Cmd) { const r = applyCmd(this.st, c); if (r.newState) this.st = r.newState; this.ops.push({ k: 'cmd', cmd: c }); return r; }
  advance(untilT: number, maxEvents = 10_000_000, stopOnPacket = false, quiescentGapUs = Infinity) {
    const r = E.advance(this.st, untilT, maxEvents, stopOnPacket, quiescentGapUs);
    this.ops.push({ k: 'adv', untilT, maxEvents, stopOnPacket, quiescentGapUs });
    return r;
  }
  /** Advance by a relative number of microseconds from the current time. */
  advanceBy(deltaUs: number, maxEvents = 10_000_000) { return this.advance(this.st.time + deltaUs, maxEvents); }

  async capsule(): Promise<Capsule> {
    return { format: 'netsim-capsule', version: 1, createdAt: new Date().toISOString(), engineVersion: this.st.version, setup: this.setup, ops: this.ops.slice(), finalHash: await hashState(this.st) };
  }
}
