// Link model: per-direction drop-tail queue, serialization delay, propagation delay, loss, manual impairments.
import { schedule, milestone, capture, rand, annotateCapture, log } from './core';
import { decodeFrame } from './codecs/decode';
import { compileFilter, evalFilter } from '@/filters/filter';
import type { EngineState, LinkState, LinkDirName, NodeId, SimEvent, QueuedFrame } from './types';

export function linkFor(st: EngineState, node: NodeId, ifaceIdx: number): { link: LinkState; dir: LinkDirName; peer: NodeId } | null {
  for (const l of Object.values(st.links)) {
    if (l.a.node === node && l.a.iface === ifaceIdx) return { link: l, dir: 'ab', peer: l.b.node };
    if (l.b.node === node && l.b.iface === ifaceIdx) return { link: l, dir: 'ba', peer: l.a.node };
  }
  return null;
}
export function bandwidthFor(link: LinkState, dir: LinkDirName) { return dir === 'ab' ? link.bandwidthBps : (link.bandwidthBpsRev || link.bandwidthBps); }
export function txTimeUs(link: LinkState, dir: LinkDirName, bytes: number) { return (bytes * 8 * 1e6) / bandwidthFor(link, dir); }

function impairApplies(link: LinkState, dir: LinkDirName, bytes: Uint8Array): boolean {
  const im = link.impair; if (im.dir !== 'both' && im.dir !== dir) return false;
  if (im.filter) { const ast = compileFilter(im.filter); if (ast instanceof Error) return false; return evalFilter(ast, decodeFrame(bytes)); }
  return true;
}

/** A NIC hands a fully encoded frame to its link. Returns false if there is no link. */
export function nicTx(st: EngineState, node: NodeId, ifaceIdx: number, bytes: Uint8Array): boolean {
  const lf = linkFor(st, node, ifaceIdx); if (!lf) return false;
  const { link, dir, peer } = lf; const d = link[dir]; const im = link.impair;
  const frameId = st.nextFrameId++;
  // manual impairments (evaluated at enqueue time)
  if ((im.dropNext > 0 || im.dupNext > 0 || im.delayNext > 0 || im.reorderNext > 0 || im.corruptNext > 0) && impairApplies(link, dir, bytes)) {
    if (im.dropNext > 0) { im.dropNext--; link.stats[dir === 'ab' ? 'abDrops' : 'baDrops']++; capture(st, link.id, { t: st.time, dir, bytes, from: node, to: peer, frameId, drop: 'manual drop' }); milestone(st, 'drop', link.id, frameId, node, bytes, 'manual drop'); log(st, `link ${link.id}: manually dropped frame ${frameId}`); return true; }
    if (im.corruptNext > 0) { im.corruptNext--; bytes = bytes.slice(); bytes[Math.min(bytes.length - 5, 30)] ^= 0xff; log(st, `link ${link.id}: corrupted a byte of frame ${frameId}`); }
    if (im.dupNext > 0) { im.dupNext--; log(st, `link ${link.id}: duplicating frame ${frameId}`); enqueue(st, link, dir, { bytes, frameId: st.nextFrameId++, enqueuedAt: st.time, fromNode: node, toNode: peer }, 0); }
    if (im.reorderNext > 0 && !d.held) { im.reorderNext--; d.held = { bytes, frameId, enqueuedAt: st.time, fromNode: node, toNode: peer }; log(st, `link ${link.id}: holding frame ${frameId} to reorder`); milestone(st, 'tx', link.id, frameId, node, bytes); return true; }
    if (im.delayNext > 0) { im.delayNext--; log(st, `link ${link.id}: delaying frame ${frameId} by ${im.delayUs / 1000}ms`); milestone(st, 'tx', link.id, frameId, node, bytes); schedule(st, im.delayUs, { kind: 'linkEnqueue', link: link.id, dir, frame: { bytes, frameId, enqueuedAt: st.time, fromNode: node, toNode: peer } }); return true; }
  }
  const qf: QueuedFrame = { bytes, frameId, enqueuedAt: st.time, fromNode: node, toNode: peer };
  milestone(st, 'tx', link.id, frameId, node, bytes);
  enqueue(st, link, dir, qf, 0);
  if (d.held) { const held = d.held; d.held = null; enqueue(st, link, dir, held, 0); }
  return true;
}
function enqueue(st: EngineState, link: LinkState, dir: LinkDirName, qf: QueuedFrame, _delay: number) {
  const d = link[dir];
  if (d.queue.length >= link.queueDepth) {
    link.stats[dir === 'ab' ? 'abDrops' : 'baDrops']++;
    capture(st, link.id, { t: st.time, dir, bytes: qf.bytes, from: qf.fromNode, to: qf.toNode, frameId: qf.frameId, drop: 'queue full' });
    milestone(st, 'drop', link.id, qf.frameId, qf.fromNode, qf.bytes, 'queue full');
    return;
  }
  d.queue.push(qf);
  if (!d.busy) { d.busy = true; schedule(st, 0, { kind: 'linkTxStart', link: link.id, dir }); }
}

export function onLinkEnqueue(st: EngineState, ev: Extract<SimEvent, { kind: 'linkEnqueue' }>) { const link = st.links[ev.link]; if (link) enqueue(st, link, ev.dir, ev.frame, 0); }

export function onLinkTxStart(st: EngineState, ev: Extract<SimEvent, { kind: 'linkTxStart' }>) {
  const link = st.links[ev.link]; if (!link) return; const d = link[ev.dir];
  const q = d.queue.shift(); if (!q) { d.busy = false; return; }
  d.busy = true;
  const tx = txTimeUs(link, ev.dir, q.bytes.length);
  let delay = link.delayUs; if (link.jitterUs > 0) delay += rand(st) * link.jitterUs;
  link.stats[ev.dir === 'ab' ? 'abTx' : 'baTx']++;
  capture(st, link.id, { t: st.time, dir: ev.dir, bytes: q.bytes, from: q.fromNode, to: q.toNode, frameId: q.frameId });
  schedule(st, tx + delay, { kind: 'linkDeliver', link: link.id, dir: ev.dir, frameId: q.frameId, bytes: q.bytes, from: q.fromNode, to: q.toNode, txStart: st.time });
  schedule(st, tx, { kind: 'linkTxStart', link: link.id, dir: ev.dir });
}

/** Returns the receiving node+iface if the frame survives the wire, else null. */
export function onLinkDeliver(st: EngineState, ev: Extract<SimEvent, { kind: 'linkDeliver' }>): { node: NodeId; iface: number } | null {
  const link = st.links[ev.link]; if (!link) return null;
  const end = ev.dir === 'ab' ? link.b : link.a;
  if (link.lossPct > 0 && rand(st) * 100 < link.lossPct) {
    annotateCapture(st, link.id, ev.frameId, 'lost on wire');
    milestone(st, 'drop', link.id, ev.frameId, end.node, ev.bytes, 'random loss');
    log(st, `link ${link.id}: frame ${ev.frameId} lost on the wire`);
    return null;
  }
  milestone(st, 'rx', link.id, ev.frameId, end.node, ev.bytes);
  return { node: end.node, iface: end.iface };
}
