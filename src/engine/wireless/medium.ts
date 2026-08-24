// 802.11-style DCF over a shared RF medium. Models carrier sense, DIFS/SIFS, random backoff with
// a contention window, collisions (including hidden-node), exponential backoff on failure, ACKs,
// and optional RTS/CTS. Frames carried are Ethernet (the lesson is the MAC, not the 802.11 header).
// The AP bridges its wireless cell to its wired ports like a switch.
import { BROADCAST_MAC, bytesToMac, type Mac } from '@/shared/bytes';
import { decodeEthernet } from '../codecs/ethernet';
import { schedule, timer, rand, log, MS } from '../core';
import { hostRx } from '../devices/host';
import { switchRx } from '../devices/switch';
import { nicTx } from '../link';
import { isAp, isHost, type EngineState, type ApState, type HostState, type NodeState, type RfTransmission, type NodeId } from '../types';

const SLOT = 9, DIFS = 34, SIFS = 16, ACK_US = 30, PHY_RATE = 24e6; // µs and bits/s
const CW_MIN = 15, CW_MAX = 1023;
export function airTime(bytes: number) { return Math.max(SLOT, Math.round((bytes * 8 * 1e6) / PHY_RATE) + 20); }

function pos(n: NodeState) { return { x: n.x, y: n.y }; }
function dist(a: NodeState, b: NodeState) { return Math.hypot(a.x - b.x, a.y - b.y); }
function rangeOf(st: EngineState, node: NodeId, iface: number): { channel: number; range: number } | null {
  const n = st.nodes[node]; if (!n) return null;
  if (isAp(n)) return { channel: n.channel, range: n.range };
  if (isHost(n)) { const i = n.ifaces[iface]; return i?.wifi ? { channel: i.wifi.channel, range: i.wifi.range } : null; }
  return null;
}
/** Nodes whose radio would sense a transmission from (node,iface): within range and same channel. */
function inRange(st: EngineState, tx: RfTransmission, other: NodeState, otherIface: number): boolean {
  const r = rangeOf(st, other.id, otherIface); if (!r || r.channel !== tx.channel) return false;
  const src = st.nodes[tx.node]; if (!src) return false; return Math.hypot(src.x - other.x, src.y - other.y) <= tx.range;
}
/** True if the medium is busy as sensed by (node) on its channel at the current time. */
export function carrierBusy(st: EngineState, node: NodeId, iface: number): boolean {
  const r = rangeOf(st, node, iface); if (!r) return false; const me = st.nodes[node]!;
  const rs = radiosPeek(me, iface); if (rs && st.time < rs.navUntil) return true; // virtual carrier sense (NAV)
  for (const tx of st.rf.transmissions) { if (tx.node === node) continue; if (tx.channel !== r.channel) continue; const src = st.nodes[tx.node]; if (!src) continue; if (Math.hypot(src.x - me.x, src.y - me.y) <= tx.range && st.time < tx.end) return true; }
  return false;
}

// ---- transmit queue per wireless interface (stored on the host/ap) ----
interface RadioState { queue: { bytes: Uint8Array; dstMac: Mac; kind: 'data' | 'beacon' }[]; cw: number; backoff: number; deferring: boolean; awaitingAck: { srcMac: Mac; dstMac: Mac; gen: number } | null; gen: number; navUntil: number; rtsSent: boolean }
const radios = new WeakMap<object, Record<number, RadioState>>();
function radio(node: NodeState, iface: number): RadioState {
  let m = radios.get(node); if (!m) { m = {}; radios.set(node, m); } if (!m[iface]) m[iface] = { queue: [], cw: CW_MIN, backoff: -1, deferring: false, awaitingAck: null, gen: 0, navUntil: 0, rtsSent: false }; return m[iface]!;
}
// Radio transient state is rebuilt on demand; it is NOT part of the serialized snapshot (queues drain
// within microseconds of sim time). Pending airtime lives in the event queue (rfTxStart/rfTxEnd/rfAck).

export function apStart(st: EngineState, ap: ApState) { ap.counters.beacons++; sendBeacon(st, ap); }
function sendBeacon(st: EngineState, ap: ApState) {
  // Beacon announces the SSID so stations in range can associate. Sent as a broadcast air frame.
  rfEnqueue(st, ap.id, 0, buildMgmt(ap.mac, BROADCAST_MAC), BROADCAST_MAC, 'beacon');
  timer(st, ap.id, ap.beaconUs, `wifi:beacon`);
}
function buildMgmt(src: Mac, dst: Mac): Uint8Array { const b = new Uint8Array(64); const s = fromMac(src), d = fromMac(dst); b.set(d, 0); b.set(s, 6); b[12] = 0x88; b[13] = 0x8e; return b; }
function fromMac(m: Mac): Uint8Array { const o = new Uint8Array(6); m.split(':').forEach((h, i) => o[i] = parseInt(h, 16)); return o; }

/** A wireless NIC hands a frame to the air. */
export function rfSend(st: EngineState, node: NodeId, iface: number, bytes: Uint8Array): boolean {
  const r = rangeOf(st, node, iface); if (!r) return false;
  let dst: Mac = BROADCAST_MAC; try { dst = decodeEthernet(bytes).dst; } catch { /* keep bcast */ }
  rfEnqueue(st, node, iface, bytes, dst, 'data'); return true;
}
function rfEnqueue(st: EngineState, node: NodeId, iface: number, bytes: Uint8Array, dstMac: Mac, kind: 'data' | 'beacon') {
  const n = st.nodes[node]!; const rs = radio(n, iface); rs.queue.push({ bytes, dstMac, kind });
  if (rs.backoff < 0 && !rs.awaitingAck) startAccess(st, node, iface);
}
function startAccess(st: EngineState, node: NodeId, iface: number) {
  const n = st.nodes[node]!; const rs = radio(n, iface); if (!rs.queue.length || rs.awaitingAck) return;
  if (rs.backoff < 0) rs.backoff = Math.floor(rand(st) * (rs.cw + 1)); // slots
  scheduleAttempt(st, node, iface);
}
function scheduleAttempt(st: EngineState, node: NodeId, iface: number) {
  const n = st.nodes[node]!; const rs = radio(n, iface); rs.gen++;
  const wait = DIFS + rs.backoff * SLOT;
  timer(st, node, wait, `wifi:tx:${iface}`, rs.gen);
}
export function wifiTimer(st: EngineState, node: NodeId, tag: string, data: unknown) {
  const n = st.nodes[node]; if (!n) return; const [, what, ifaceS] = tag.split(':'); const iface = Number(ifaceS || 0);
  if (what === 'beacon') { if (isAp(n)) sendBeacon(st, n); return; }
  const rs = radio(n, iface);
  if (what === 'tx') { if ((data as number) !== rs.gen) return; attemptTx(st, node, iface); }
  else if (what === 'ackto') { if ((data as number) !== rs.gen) return; onAckTimeout(st, node, iface); }
}
function apFor(st: EngineState, n: NodeState, iface: number): ApState | null { if (isHost(n)) { const w = n.ifaces[iface]?.wifi; if (w && w.associated !== null) { const ap = st.nodes[w.associated]; return isAp(ap) ? ap : null; } } return null; }
function attemptTx(st: EngineState, node: NodeId, iface: number) {
  const n = st.nodes[node]!; const rs = radio(n, iface); const job = rs.queue[0]; if (!job) { rs.backoff = -1; return; }
  if (carrierBusy(st, node, iface)) { rs.deferring = true; return; } // freeze; resumes when medium clears (onTxEnd)
  rs.deferring = false; rs.backoff = -1;
  // RTS/CTS: when the associated AP requires it, reserve the medium with an RTS→CTS exchange first.
  const ap = apFor(st, n, iface);
  if (ap && ap.rtsCts && job.kind === 'data' && job.dstMac !== BROADCAST_MAC && !rs.rtsSent) { sendRts(st, node, iface, ap, job.bytes.length); return; }
  const r = rangeOf(st, node, iface)!; const dur = airTime(job.bytes.length);
  const srcMac = wifiMac(n, iface);
  const tx: RfTransmission = { id: st.rf.nextTxId++, node, iface, channel: r.channel, x: n.x, y: n.y, range: r.range, start: st.time, end: st.time + dur, bytes: job.bytes, kind: job.kind, dstMac: job.dstMac, srcMac, collidedAt: [] };
  st.rf.transmissions.push(tx); markCollisions(st, tx); if (job.kind !== 'beacon') st.lastActivityT = st.time;
  if (isAp(n)) n.counters.txData++;
  schedule(st, dur, { kind: 'timer', node, tag: `wifiend:${tx.id}`, data: iface } as never);
  if (job.dstMac !== BROADCAST_MAC && job.kind === 'data') { rs.awaitingAck = { srcMac, dstMac: job.dstMac, gen: rs.gen }; rs.gen++; timer(st, node, dur + SIFS + ACK_US + SLOT * 4, `wifi:ackto:${iface}`, rs.gen); }
  else { rs.queue.shift(); rs.cw = CW_MIN; capture(st, tx, false); if (rs.queue.length) startAccess(st, node, iface); }
}
function sendDataNow(st: EngineState, node: NodeId, iface: number, job: { bytes: Uint8Array; dstMac: Mac; kind: 'data' | 'beacon' }) {
  const n = st.nodes[node]!; const rs = radio(n, iface); const r = rangeOf(st, node, iface)!; const dur = airTime(job.bytes.length); const srcMac = wifiMac(n, iface);
  const tx: RfTransmission = { id: st.rf.nextTxId++, node, iface, channel: r.channel, x: n.x, y: n.y, range: r.range, start: st.time, end: st.time + dur, bytes: job.bytes, kind: 'data', dstMac: job.dstMac, srcMac, collidedAt: [] };
  st.rf.transmissions.push(tx); markCollisions(st, tx); st.lastActivityT = st.time; schedule(st, dur, { kind: 'timer', node, tag: `wifiend:${tx.id}`, data: iface } as never);
  rs.awaitingAck = { srcMac, dstMac: job.dstMac, gen: rs.gen }; rs.gen++; timer(st, node, dur + SIFS + ACK_US + SLOT * 4, `wifi:ackto:${iface}`, rs.gen);
}
function wifiMac(n: NodeState, iface: number): Mac { if (isAp(n)) return n.mac; if (isHost(n)) return n.ifaces[iface]!.mac; return '00:00:00:00:00:00'; }

export function onRfTxEnd(st: EngineState, txId: number, iface: number) {
  const idx = st.rf.transmissions.findIndex(t => t.id === txId); if (idx < 0) return; const tx = st.rf.transmissions[idx]!;
  st.rf.transmissions.splice(idx, 1);
  // Determine collisions: any other transmission overlapped in time AND both are in range of a common receiver.
  const collided = tx.collidedAt.length > 0;
  capture(st, tx, collided);
  // Deliver to every in-range receiver (unless this frame collided at that receiver).
  if (!collided && tx.kind !== 'ack') deliverAir(st, tx);
  else if (collided) { for (const rid of tx.collidedAt) { const rn = st.nodes[rid]; if (isAp(rn)) rn.counters.collisions++; } }
  // resume any nodes that were deferring and can now sense idle
  for (const nn of Object.values(st.nodes)) { const ifaces = isHost(nn) ? nn.ifaces.length : isAp(nn) ? 1 : 0; for (let i = 0; i < ifaces; i++) { const rs2 = radiosPeek(nn, i); if (rs2 && rs2.deferring && !carrierBusy(st, nn.id, i)) { rs2.deferring = false; startAccess(st, nn.id, i); } } }
}
function radiosPeek(n: NodeState, iface: number): RadioState | undefined { return radios.get(n)?.[iface]; }

/** Mark collisions when a new transmission starts overlapping an existing one at a shared receiver. */
export function markCollisions(st: EngineState, tx: RfTransmission) {
  for (const other of st.rf.transmissions) { if (other.id === tx.id || other.channel !== tx.channel) continue; if (other.end <= tx.start) continue;
    // find a receiver in range of both
    for (const rn of Object.values(st.nodes)) { const ifaces = isHost(rn) ? rn.ifaces.length : isAp(rn) ? 1 : 0; for (let i = 0; i < ifaces; i++) { if (inRange(st, tx, rn, i) && inRange(st, other, rn, i)) { if (!tx.collidedAt.includes(rn.id)) tx.collidedAt.push(rn.id); if (!other.collidedAt.includes(rn.id)) other.collidedAt.push(rn.id); } } }
  }
}
function deliverAir(st: EngineState, tx: RfTransmission) {
  const receivers: { node: NodeState; iface: number }[] = [];
  for (const rn of Object.values(st.nodes)) { const ifaces = isHost(rn) ? rn.ifaces.length : isAp(rn) ? 1 : 0; for (let i = 0; i < ifaces; i++) { if (rn.id === tx.node) continue; if (inRange(st, tx, rn, i) && !tx.collidedAt.includes(rn.id)) receivers.push({ node: rn, iface: i }); } }
  for (const { node: rn, iface } of receivers) rfReceive(st, rn, iface, tx);
}
function rfReceive(st: EngineState, rn: NodeState, iface: number, tx: RfTransmission) {
  let e; try { e = decodeEthernet(tx.bytes); } catch { return; }
  if (tx.kind === 'beacon') { if (isHost(rn)) stationHearBeacon(st, rn, iface, tx); return; }
  if (tx.kind === 'rts' || tx.kind === 'cts') {
    const rs = radio(rn, iface); const myMac = wifiMac(rn, iface);
    if (tx.kind === 'cts' && e.dst === myMac) { // our RTS was answered: send the data now
      rs.rtsSent = false; rs.navUntil = 0; const job = rs.queue[0]; if (job) { rs.gen++; sendDataNow(st, rn.id, iface, job); }
    } else { rs.navUntil = Math.max(rs.navUntil, st.time + reserveUs(1500)); } // others defer (NAV)
    return;
  }
  const myMac = wifiMac(rn, iface);
  // The AP is the air receiver for its whole cell, so it accepts every frame; a station accepts
  // frames addressed to it (or broadcast, or in promiscuous mode).
  const airReceiver = isAp(rn) || e.dst === myMac;
  const forMe = airReceiver || e.dst === BROADCAST_MAC || (isHost(rn) && !!rn.ifaces[iface]?.promisc);
  if (!forMe) return;
  // Link-layer ACK for unicast data, sent by the air receiver back to the air transmitter.
  if (tx.kind === 'data' && e.dst !== BROADCAST_MAC && airReceiver) sendAck(st, rn, iface, tx.srcMac);
  if (isAp(rn)) apReceive(st, rn, iface, tx.bytes, tx.node, e);
  else if (isHost(rn)) { if (e.dst === myMac || e.dst === BROADCAST_MAC || rn.ifaces[iface]?.promisc) hostRx(st, rn, iface, tx.bytes); }
}
function sendAck(st: EngineState, rn: NodeState, iface: number, toMac: Mac) {
  // ACK after SIFS. Modeled as a short air frame that also occupies the medium.
  const r = rangeOf(st, rn.id, iface); if (!r) return; const ackBytes = buildMgmt(wifiMac(rn, iface), toMac); ackBytes[12] = 0xac; ackBytes[13] = 0x00;
  timer(st, rn.id, SIFS, `wifiack:${iface}:${toMac}`, 0);
  scheduleAck(st, rn, iface, toMac, ackBytes, r);
}
function scheduleAck(st: EngineState, rn: NodeState, iface: number, toMac: Mac, ackBytes: Uint8Array, r: { channel: number; range: number }) {
  schedule(st, SIFS, { kind: 'timer', node: rn.id, tag: `wifiacktx:${iface}`, data: { toMac, ackBytes, channel: r.channel, range: r.range } } as never);
}
export function onWifiAckTx(st: EngineState, node: NodeId, iface: number, d: { toMac: Mac; ackBytes: Uint8Array; channel: number; range: number }) {
  const n = st.nodes[node]; if (!n) return; const dur = airTime(d.ackBytes.length);
  const tx: RfTransmission = { id: st.rf.nextTxId++, node, iface, channel: d.channel, x: n.x, y: n.y, range: d.range, start: st.time, end: st.time + dur, bytes: d.ackBytes, kind: 'ack', dstMac: d.toMac, srcMac: wifiMac(n, iface), collidedAt: [] };
  st.rf.transmissions.push(tx); markCollisions(st, tx); schedule(st, dur, { kind: 'timer', node, tag: `wifiend:${tx.id}`, data: iface } as never);
  // notify the awaiting sender
  for (const nn of Object.values(st.nodes)) { const ifaces = isHost(nn) ? nn.ifaces.length : isAp(nn) ? 1 : 0; for (let i = 0; i < ifaces; i++) { const rs = radiosPeek(nn, i); if (rs?.awaitingAck && rs.awaitingAck.srcMac === d.toMac && wifiMac(nn, i) === d.toMac) { onAckReceived(st, nn.id, i); } } }
}
function onAckReceived(st: EngineState, node: NodeId, iface: number) {
  const n = st.nodes[node]!; const rs = radio(n, iface); if (!rs.awaitingAck) return; rs.awaitingAck = null; rs.queue.shift(); rs.cw = CW_MIN; rs.gen++;
  if (rs.queue.length) startAccess(st, node, iface);
}
function onAckTimeout(st: EngineState, node: NodeId, iface: number) {
  const n = st.nodes[node]!; const rs = radio(n, iface); if (!rs.awaitingAck) return; rs.awaitingAck = null;
  const job = rs.queue[0]; if (!job) return;
  rs.cw = Math.min(CW_MAX, (rs.cw + 1) * 2 - 1); // exponential backoff
  if (isAp(n)) n.counters.retries++;
  log(st, `${nodeName(n)}: wireless frame to ${job.dstMac} unacked, retry (CW=${rs.cw})`);
  const retries = (rs as RadioState & { r?: number }); retries.r = (retries.r ?? 0) + 1;
  if ((retries.r ?? 0) > 7) { rs.queue.shift(); retries.r = 0; rs.cw = CW_MIN; log(st, `${nodeName(n)}: wireless frame dropped after 7 retries`); }
  rs.backoff = -1; rs.gen++; if (rs.queue.length) startAccess(st, node, iface);
}
function nodeName(n: NodeState) { return n.name; }

function reserveUs(dataLen: number) { return SIFS + airTime(60) + SIFS + airTime(dataLen) + SIFS + ACK_US; }
function sendRts(st: EngineState, node: NodeId, iface: number, ap: ApState, dataLen: number) {
  const n = st.nodes[node]!; const r = rangeOf(st, node, iface)!; const rts = buildMgmt(wifiMac(n, iface), ap.mac); rts[12] = 0xb4; rts[13] = 0x00;
  const dur = airTime(rts.length); const nav = reserveUs(dataLen);
  const tx: RfTransmission = { id: st.rf.nextTxId++, node, iface, channel: r.channel, x: n.x, y: n.y, range: r.range, start: st.time, end: st.time + dur, bytes: rts, kind: 'rts', dstMac: ap.mac, srcMac: wifiMac(n, iface), collidedAt: [] };
  st.rf.transmissions.push(tx); markCollisions(st, tx); const rs = radio(n, iface); rs.rtsSent = true; rs.navUntil = st.time + nav;
  schedule(st, dur, { kind: 'timer', node, tag: `wifiend:${tx.id}`, data: iface } as never);
  // AP replies CTS after SIFS
  schedule(st, dur + SIFS, { kind: 'timer', node: ap.id, tag: `wificts:0`, data: { toMac: wifiMac(n, iface), dataLen, channel: r.channel } } as never);
  // if no CTS heard, the station retries the whole thing
  rs.gen++; timer(st, node, dur + SIFS + airTime(60) + SLOT * 6, `wifi:tx:${iface}`, rs.gen); // fallback: proceed to data attempt
}
export function onWifiCts(st: EngineState, apId: NodeId, d: { toMac: Mac; dataLen: number; channel: number }) {
  const ap = st.nodes[apId]; if (!isAp(ap)) return; const cts = buildMgmt(ap.mac, d.toMac); cts[12] = 0xc4; cts[13] = 0x00; const dur = airTime(cts.length);
  const tx: RfTransmission = { id: st.rf.nextTxId++, node: apId, iface: 0, channel: d.channel, x: ap.x, y: ap.y, range: ap.range, start: st.time, end: st.time + dur, bytes: cts, kind: 'cts', dstMac: d.toMac, srcMac: ap.mac, collidedAt: [] };
  st.rf.transmissions.push(tx); markCollisions(st, tx); schedule(st, dur, { kind: 'timer', node: apId, tag: `wifiend:${tx.id}`, data: 0 } as never);
}
// ---- association ----
function stationHearBeacon(st: EngineState, h: HostState, iface: number, tx: RfTransmission) {
  const w = h.ifaces[iface]?.wifi; if (!w) return; const ap = st.nodes[tx.node]; if (!isAp(ap)) return;
  if (w.associated === ap.id) return;
  if (w.ssid && w.ssid !== ap.ssid) return; // SSID mismatch
  if (w.channel !== ap.channel) return;
  w.associated = ap.id; if (!w.ssid) w.ssid = ap.ssid;
  ap.clients.push({ mac: h.ifaces[iface]!.mac, node: h.id, iface, assocAt: st.time }); ap.counters.assoc++;
  log(st, `${h.name}: associated with AP "${ap.ssid}" (${ap.name}) on channel ${ap.channel}`);
}

// ---- AP bridging (wireless cell <-> wired ports), learning like a switch ----
function apReceive(st: EngineState, ap: ApState, iface: number, bytes: Uint8Array, fromNode: NodeId, e: ReturnType<typeof decodeEthernet>) {
  ap.counters.rxData++;
  ap.macTable[e.src] = { port: -1, wireless: true, node: fromNode, iface, expires: st.time + 300 * 1e6 };
  apForward(st, ap, bytes, e, { wireless: true, node: fromNode });
}
/** Called when a wired port receives a frame destined into/across the cell. */
export function apWiredRx(st: EngineState, ap: ApState, portIdx: number, bytes: Uint8Array) {
  const port = ap.ports[portIdx]; if (!port || !port.up) return; port.rxPackets++;
  let e; try { e = decodeEthernet(bytes); } catch { return; } if (!e.fcsOk) return;
  ap.macTable[e.src] = { port: portIdx, wireless: false, node: ap.id, iface: portIdx, expires: st.time + 300 * 1e6 };
  apForward(st, ap, bytes, e, { wireless: false, port: portIdx });
}
function apForward(st: EngineState, ap: ApState, bytes: Uint8Array, e: ReturnType<typeof decodeEthernet>, from: { wireless: boolean; node?: NodeId; port?: number }) {
  ap.counters.bridged++;
  const dst = ap.macTable[e.dst];
  const toWireless = (b: Uint8Array) => rfEnqueue(st, ap.id, 0, b, e.dst, 'data');
  const toWired = (portIdx: number, b: Uint8Array) => { const p = ap.ports[portIdx]; if (p && p.up && p.linkId !== null) { p.txPackets++; nicTx(st, ap.id, wiredIfaceIndex(ap, portIdx), b); } };
  if (e.dst !== BROADCAST_MAC && dst && dst.expires > st.time) {
    if (dst.wireless) { if (!(from.wireless)) toWireless(bytes); else if (dst.node !== from.node) toWireless(bytes); }
    else { if (from.wireless || from.port !== dst.port) toWired(dst.port, bytes); }
    return;
  }
  // unknown/broadcast: flood to the other domain(s)
  if (from.wireless) { for (let i = 0; i < ap.ports.length; i++) toWired(i, bytes); }
  else { toWireless(bytes); for (let i = 0; i < ap.ports.length; i++) if (i !== from.port) toWired(i, bytes); }
}
/** AP wired ports map to link ifaces via nicTx using a synthetic index space after the radio (0). */
function wiredIfaceIndex(ap: ApState, portIdx: number) { void ap; return portIdx; }

// ---- capture (air monitor) ----
function capture(st: EngineState, tx: RfTransmission, collision: boolean) {
  for (const m of Object.values(st.rf.monitors)) { if (m.channel !== tx.channel && m.channel !== 0) continue; m.frames.push({ n: m.nextN++, t: st.time, bytes: tx.bytes, from: tx.node, kind: tx.kind, collision, rssi: -40 }); m.total++; if (m.frames.length > 5000) m.frames.splice(0, m.frames.length - 5000); }
}
export { MS };
