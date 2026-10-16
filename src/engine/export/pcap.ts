// PCAP export with a ground-truth label sidecar (E2).
//
// `framesToPcap` turns captured frames into a classic libpcap file (DLT_EN10MB, microsecond
// timestamps from the virtual clock) that Wireshark, tshark, and Scapy read directly.
// `framesToLabels` joins each frame against the engine's own provenance map to emit perfect labels:
// the class is whatever adversary agent put the frame on the wire, or "benign" when nothing tagged
// it. Labels are engine-emitted, never inferred, so label purity is 1.0 by construction.
import { flowKeyOf } from '../metrics';
import type { CapturedFrame, FrameOrigin } from '../types';

export interface PcapOpts { includeDropped?: boolean; baseEpochSec?: number; snaplen?: number }

/** Serialize frames to a classic little-endian libpcap file. Dropped frames are excluded by default
 *  so the capture reflects what actually crossed the wire. */
export function framesToPcap(frames: CapturedFrame[], opts: PcapOpts = {}): Uint8Array {
  const includeDropped = opts.includeDropped ?? false;
  const base = opts.baseEpochSec ?? 0;
  const snaplen = opts.snaplen ?? 65535;
  const sel = includeDropped ? frames : frames.filter(f => !f.drop);
  let size = 24; for (const f of sel) size += 16 + Math.min(f.bytes.length, snaplen);
  const buf = new Uint8Array(size); const dv = new DataView(buf.buffer);
  let o = 0;
  dv.setUint32(o, 0xa1b2c3d4, true); o += 4;   // magic: microsecond, little-endian
  dv.setUint16(o, 2, true); o += 2;             // version major
  dv.setUint16(o, 4, true); o += 2;             // version minor
  dv.setInt32(o, 0, true); o += 4;              // thiszone (GMT)
  dv.setUint32(o, 0, true); o += 4;             // sigfigs
  dv.setUint32(o, snaplen, true); o += 4;       // snaplen
  dv.setUint32(o, 1, true); o += 4;             // network: DLT_EN10MB (Ethernet)
  for (const f of sel) {
    const sec = base + Math.floor(f.t / 1e6);
    const usec = f.t % 1_000_000;
    const incl = Math.min(f.bytes.length, snaplen);
    dv.setUint32(o, sec, true); o += 4;
    dv.setUint32(o, usec, true); o += 4;
    dv.setUint32(o, incl, true); o += 4;         // included length
    dv.setUint32(o, f.bytes.length, true); o += 4; // original length
    buf.set(f.bytes.subarray(0, incl), o); o += incl;
  }
  return buf;
}

export interface LabelRow { n: number; frameId: number; t: number; src: string; dst: string; proto: string; sport: number; dport: number; len: number; class: string }
export interface LabelResult { frames: LabelRow[]; summary: { total: number; counts: Record<string, number> } }

/** Join captured frames against the provenance map to produce ground-truth labels. */
export function framesToLabels(frames: CapturedFrame[], origins: Record<number, FrameOrigin> = {}, opts: PcapOpts = {}): LabelResult {
  const includeDropped = opts.includeDropped ?? false;
  const rows: LabelRow[] = []; const counts: Record<string, number> = {};
  for (const f of frames) {
    if (!includeDropped && f.drop) continue;
    const k = flowKeyOf(f.bytes);
    const cls = origins[f.frameId]?.tag ?? 'benign';
    counts[cls] = (counts[cls] ?? 0) + 1;
    rows.push({ n: f.n, frameId: f.frameId, t: f.t, src: k?.src ?? '', dst: k?.dst ?? '', proto: k?.proto ?? '', sport: k?.sport ?? -1, dport: k?.dport ?? -1, len: f.bytes.length, class: cls });
  }
  return { frames: rows, summary: { total: rows.length, counts } };
}

/** CSV rendering of the label rows, header first. */
export function labelsToCsv(rows: LabelRow[]): string {
  const head = 'n,frameId,t,src,dst,proto,sport,dport,len,class';
  const lines = rows.map(r => `${r.n},${r.frameId},${r.t},${r.src},${r.dst},${r.proto},${r.sport},${r.dport},${r.len},${r.class}`);
  return [head, ...lines].join('\n') + '\n';
}
