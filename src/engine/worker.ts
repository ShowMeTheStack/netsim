// Engine worker: owns the EngineState, runs playback, answers UI commands.
/// <reference lib="webworker" />
import * as E from './engine';
import { isHost } from './types';
import { applyCmd } from './commands';
import { DEFAULT_SWITCH_SCRIPT } from './devices/switch-script';
void DEFAULT_SWITCH_SCRIPT;
import { startClangProgram, registerClangProgram } from './apps/clangrun';
import { serializeSession } from '@/session/session';
import { hashState, replayCapsule } from '@/session/capsule';
import type { Capsule } from '@/session/capsule';
import { framesToPcap, framesToLabels, labelsToCsv } from './export/pcap';
import type { Cmd, Msg, RunMode, UiState } from '@/shared/protocol';
import type { EngineState, SnifferId } from './types';

let st: EngineState = E.createState(1);
let mode: RunMode = 'paused'; let speed = 1; let lastWall = 0; let tickHandle: ReturnType<typeof setInterval> | null = null; let turboDeadline = 0;
const sent: Record<SnifferId, number> = {}; // last capture n sent per sniffer
let stateDirty = true; let lastPost = 0;

const post = (m: Msg) => (self as unknown as Worker).postMessage(m);

function view(): UiState {
  const sniffers: UiState['sniffers'] = {}; for (const s of Object.values(st.sniffers)) sniffers[s.id] = { id: s.id, linkId: s.linkId, total: s.total, captureFilter: s.captureFilter };
  return { time: st.time, seq: st.seq, seed: st.seed, mode, speed, queued: st.events.length, nextEventUs: E.nextEventTime(st), nodes: st.nodes, links: st.links, sniffers, breakpoints: st.breakpoints, lastHit: st.lastHit, flights: E.flights(st), log: st.log.slice(-200), rf: { transmissions: st.rf.transmissions, monitors: rfMonitors() }, scenario: st.scenario ? { id: st.scenario.id, title: st.scenario.title, description: st.scenario.description, results: st.scenario.checks.map(c => ({ id: c.id, label: c.label, pass: E.evalCheck(st, c) })) } : null };
}
function rfMonitors() { const out: Record<number, { id: number; channel: number; total: number; frames: import('./types').WifiCapture[] }> = {}; for (const m of Object.values(st.rf.monitors)) out[m.id] = { id: m.id, channel: m.channel, total: m.total, frames: m.frames.slice(-300) }; return out;
}
function postState(force = false) {
  const now = performance.now(); if (!force && now - lastPost < 33) { stateDirty = true; return; }
  lastPost = now; stateDirty = false; post({ type: 'state', st: view() }); postCaptures();
}
function postCaptures() {
  for (const s of Object.values(st.sniffers)) {
    const from = sent[s.id] ?? 0; const fresh = s.frames.filter(f => f.n > from);
    if (fresh.length) { post({ type: 'capture', snifferId: s.id, frames: fresh }); sent[s.id] = fresh[fresh.length - 1]!.n; }
    else if (from > 0 && s.nextN === 1) { sent[s.id] = 0; post({ type: 'capture', snifferId: s.id, frames: [], reset: true }); }
  }
  for (const id of Object.keys(sent)) if (!st.sniffers[Number(id)]) delete sent[Number(id)];
}
function setMode(m: RunMode) {
  mode = m; if (tickHandle) { clearInterval(tickHandle); tickHandle = null; }
  if (m === 'play') { lastWall = performance.now(); tickHandle = setInterval(tickPlay, 16); }
  else if (m === 'turbo') { turboDeadline = st.time + TURBO_MAX_ADVANCE; tickHandle = setInterval(tickTurbo, 0); }
  postState(true);
}
function afterRun(r: E.RunResult) {
  E.housekeeping(st);
  if (r.hit) { setMode('paused'); return; }
  if (mode === 'turbo' && r.idle) setMode('paused');
}
function tickPlay() {
  const now = performance.now(); const dt = Math.min(250, now - lastWall); lastWall = now;
  const r = E.advance(st, st.time + dt * 1000 * speed, 50_000); afterRun(r); postState();
}
// Turbo runs as fast as possible but pauses at a quiescent point: when the next pending event
// is more than TURBO_QUIESCENT_US of simulated idle away (e.g. a periodic DHCP-renew / TIME_WAIT
// timer), so a periodic protocol does not make turbo spin forever. Closely spaced activity
// (ping intervals, retransmits) keeps it running.
const TURBO_QUIESCENT_US = 60_000_000;   // stop at long idle gaps (e.g. DHCP renew at 1800s)
const TURBO_MAX_ADVANCE = 300_000_000;   // and never advance more than 300s of sim time per run,
                                         // so periodic protocols (OSPF hello 10s, RIP 30s) still terminate a turbo run
function tickTurbo() {
  const r = E.advance(st, turboDeadline, 200_000, false, TURBO_QUIESCENT_US); afterRun(r); postState();
  if (mode !== 'turbo') return;
  const nt = E.nextEventTime(st);
  if (nt === null || nt - Math.max(st.lastActivityT, 0) > TURBO_QUIESCENT_US || st.time >= turboDeadline) setMode('paused');
}

function handle(c: Cmd) {
  // Worker-only cases: run control, cold restart bookkeeping, the async clang compile path, and the
  // sniffer capture-reset posting (which also touches the per-sniffer `sent` map). Everything else is
  // a pure state mutation routed through the shared applyCmd, so headless replay and sweeps match.
  switch (c.type) {
    case 'play': st.lastHit = null; setMode('play'); return;
    case 'turbo': st.lastHit = null; setMode('turbo'); return;
    case 'pause': setMode('paused'); return;
    case 'stepEvent': setMode('paused'); afterRun(E.stepEvent(st)); postState(true); return;
    case 'stepPacket': setMode('paused'); afterRun(E.stepPacket(st)); postState(true); return;
    case 'stepSyscall': setMode('paused'); afterRun(E.stepSyscall(st)); postState(true); return;
    case 'setSpeed': speed = c.speed; postState(true); return;
    case 'restart': setMode('paused'); E.coldRestart(st); for (const k of Object.keys(sent)) sent[Number(k)] = 0; for (const s of Object.values(st.sniffers)) post({ type: 'capture', snifferId: s.id, frames: [], reset: true }); postState(true); return;
    case 'removeSniffer': delete st.sniffers[c.id]; delete sent[c.id]; post({ type: 'capture', snifferId: c.id, frames: [], reset: true }); postState(true); return;
    case 'clearCapture': { const s = st.sniffers[c.id]; if (s) { s.frames = []; s.nextN = 1; s.total = 0; sent[c.id] = 0; post({ type: 'capture', snifferId: c.id, frames: [], reset: true }); } postState(true); return; }
    case 'requestState': postState(true); return;
    case 'exportCapsule': { void (async () => { const cap: Capsule = { format: 'netsim-capsule', version: 1, createdAt: new Date().toISOString(), engineVersion: st.version, setup: { k: 'session', json: serializeSession(st) }, ops: [], finalHash: await hashState(st) }; post({ type: 'capsule', json: JSON.stringify(cap) }); })(); return; }
    case 'replayCapsule': { void (async () => { try { const r = await replayCapsule(JSON.parse(c.json) as Capsule); post({ type: 'capsuleResult', ok: r.ok, gotHash: r.gotHash, wantHash: r.wantHash }); } catch (e) { post({ type: 'error', message: (e as Error).message }); } })(); return; }
    case 'exportPcap': { const sn = st.sniffers[c.snifferId]; if (sn) { const pcap = framesToPcap(sn.frames, { includeDropped: c.includeDropped }); const labels = c.withLabels ? labelsToCsv(framesToLabels(sn.frames, st.frameOrigins ?? {}, { includeDropped: c.includeDropped }).frames) : undefined; post({ type: 'pcap', snifferId: c.snifferId, pcap, labels }); } return; }
    case 'compileRun': if (c.backend === 'clang') { const n = st.nodes[c.node]; if (isHost(n)) void compileRunClang(c.node, c.name, c.source, c.argv); postState(true); return; } break;
  }
  const r = applyCmd(st, c);
  if (r.session !== undefined) { post({ type: 'session', json: r.session }); return; }
  if (r.error) post({ type: 'error', message: r.error });
  if (r.compile) post({ type: 'compile', ...r.compile });
  if (r.newState) { setMode('paused'); st = r.newState; for (const k of Object.keys(sent)) delete sent[Number(k)]; }
  if (r.captureReset) for (const s of Object.values(st.sniffers)) post({ type: 'capture', snifferId: s.id, frames: [], reset: true });
  if (r.imported) post({ type: 'imported', theme: r.imported.theme });
  postState(true);
}
// Compile real C with the in-browser clang toolchain (lazy-loaded; assets fetched same-origin from
// /csys/ = the opt-in C download) and run it. Async and fire-and-forth; results come back as a
// 'compile' message. The heavy modules (clang ~31MB, binaryen) load only when C is actually used.
async function compileRunClang(node: number, name: string, source: string, argv: string[]) {
  const n = st.nodes[node]; if (!isHost(n)) return;
  const err = (message: string) => post({ type: 'compile', node, ok: false, diagnostics: [{ line: 1, col: 1, message, severity: 'error' }] });
  try {
    const { clangCompile, finalizeWasm } = await import('./cc/clang');
    // binaryen is served from /csys/ (part of the opt-in C download) and loaded at runtime so Vite
    // never bundles its multi-MB minified source (which crashes the bundler's token scanner). The
    // specifier is computed so the bundler cannot try to resolve it at build time.
    const binaryenUrl = '/csys/' + 'binaryen.mjs';
    const bmod = await import(/* @vite-ignore */ binaryenUrl);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const binaryen = (bmod as { default: any }).default;
    const r = await clangCompile(source, {
      readBuffer: async (f: string) => { const res = await fetch(`/csys/${f}`); if (!res.ok) throw new Error(`fetch /csys/${f}: ${res.status}`); return new Uint8Array(await res.arrayBuffer()); },
      asyncify: (wasm: Uint8Array) => finalizeWasm(binaryen, wasm),
    });
    if (!r.ok) { post({ type: 'compile', node, ok: false, diagnostics: r.diagnostics }); return; }
    registerClangProgram(name, r.wasm);   // make it exec()-able by name
    const p = startClangProgram(st, n, r.wasm, name, argv);
    if (typeof p === 'string') { err(p); return; }
    post({ type: 'compile', node, ok: true, pid: p.pid, diagnostics: [] }); postState(true);
  } catch (e) { err(`C toolchain failed to load: ${(e as Error).message}`); }
}
self.onmessage = (ev: MessageEvent<Cmd>) => { try { handle(ev.data); } catch (e) { post({ type: 'error', message: (e as Error).message }); postState(true); } };
setInterval(() => { if (stateDirty) postState(true); }, 50);
post({ type: 'ready' }); postState(true);
