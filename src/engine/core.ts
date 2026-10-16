// Scheduling, logging, milestones and breakpoint evaluation. Imported by devices and links.
import { heapPush } from './heap';
import { nextFloat } from './rng';
import { decodeFrame } from './codecs/decode';
import { compileFilter, evalFilter } from '@/filters/filter';
import type { EngineState, SimEvent, SimEventBody, Milestone, LinkId, NodeId, CapturedFrame } from './types';

export const US = 1, MS = 1000, SEC = 1_000_000;

// ---------- E2 provenance: ground-truth labels for transmitted frames ----------
/** Record the origin of a just-minted frame, but only while a tx tag is active. Normal traffic has
 *  no tag, so it stays unlabeled and defaults to "benign" in the sidecar. */
export function tagFrame(st: EngineState, frameId: number, node: NodeId, pid?: number) {
  if (st.txTag == null) return;
  (st.frameOrigins ??= {})[frameId] = { tag: st.txTag, node, ...(pid !== undefined ? { pid } : {}) };
}
/** Run `fn` with a transmission label active, so every frame it causes to be sent is labeled. */
export function withTxTag<T>(st: EngineState, tag: string | null, fn: () => T): T {
  const prev = st.txTag ?? null; st.txTag = tag;
  try { return fn(); } finally { st.txTag = prev; }
}

export function schedule(st: EngineState, delayUs: number, ev: SimEventBody): void {
  const t = st.time + Math.max(0, Math.round(delayUs));
  heapPush(st.events, { ...(ev as SimEvent), t, seq: st.seq++ });
}
export function timer(st: EngineState, node: NodeId, delayUs: number, tag: string, data?: unknown) { schedule(st, delayUs, { kind: 'timer', node, tag, data }); }
export function rand(st: EngineState) { return nextFloat(st.rng); }
export function log(st: EngineState, text: string) { st.log.push({ t: st.time, text }); if (st.log.length > 2000) st.log.splice(0, st.log.length - 2000); }
export function fmtTime(us: number): string { return (us / 1e6).toFixed(6) + 's'; }

/** Record a packet milestone and evaluate breakpoints against it. */
export function milestone(st: EngineState, m: Milestone, linkId: LinkId, frameId: number, nodeId: NodeId, bytes: Uint8Array, reason?: string) {
  st.recentMilestones.push({ milestone: m, linkId, frameId, t: st.time, nodeId, reason }); st.lastActivityT = st.time;
  if (st.lastHit) return;
  let decoded: ReturnType<typeof decodeFrame> | null = null;
  for (const bp of st.breakpoints) {
    if (!bp.enabled || !bp.milestones.includes(m)) continue;
    const ast = compileFilter(bp.expr); if (ast instanceof Error) continue;
    if (!decoded) decoded = decodeFrame(bytes);
    if (evalFilter(ast, decoded)) { st.lastHit = { breakpointId: bp.id, milestone: m, linkId, frameId, nodeId, t: st.time, bytes, reason }; return; }
  }
}

/** Sniffer capture on a link. Applies the sniffer's capture filter. */
export function capture(st: EngineState, linkId: LinkId, frame: Omit<CapturedFrame, 'n'>) {
  for (const sn of Object.values(st.sniffers)) {
    if (sn.linkId !== linkId) continue;
    if (sn.captureFilter) { const ast = compileFilter(sn.captureFilter); if (!(ast instanceof Error) && !evalFilter(ast, decodeFrame(frame.bytes))) continue; }
    sn.frames.push({ ...frame, n: sn.nextN++ }); sn.total++;
    if (sn.frames.length > sn.maxFrames) sn.frames.splice(0, sn.frames.length - sn.maxFrames);
  }
}
export function annotateCapture(st: EngineState, linkId: LinkId, frameId: number, drop: string) {
  for (const sn of Object.values(st.sniffers)) if (sn.linkId === linkId) { for (let i = sn.frames.length - 1; i >= 0; i--) { const fr = sn.frames[i]!; if (fr.frameId === frameId) { fr.drop = drop; break; } } }
}
