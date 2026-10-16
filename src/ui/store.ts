import { create } from 'zustand';
import type { Cmd, Msg, UiState } from '@/shared/protocol';
import type { CapturedFrame, NodeId, LinkId, SnifferId, HostKind } from '@/engine/types';
import type { CDiagnostic } from '@/shared/cprograms';
import { THEMES, applyTheme } from './themes';
import { trace } from './trace';

export interface CompileResult { ok: boolean; diagnostics: CDiagnostic[]; pid?: number; at: number }

export type Tool = { kind: 'select' } | { kind: 'connect' } | { kind: 'sniff' } | { kind: 'place'; nodeType: 'host' | 'switch' | 'router' | 'ap'; hostKind?: HostKind };

interface Store {
  st: UiState | null; ready: boolean; error: string | null; captures: Record<SnifferId, CapturedFrame[]>;
  tool: Tool; selectedNode: NodeId | null; selectedLink: LinkId | null; connectFrom: NodeId | null;
  popupNode: NodeId | null; popupLink: LinkId | null; popupTab: string;
  activeSniffer: SnifferId | null; selectedFrame: { sid: SnifferId; n: number } | null; displayFilters: Record<SnifferId, string>; activeAir: number | null; setActiveAir: (id: number | null) => void;
  hoverRange: { start: number; end: number } | null; theme: string; bottomTab: 'log' | 'breakpoints'; toast: string | null; labOpen: boolean; setLabOpen: (o: boolean) => void; labLauncher: boolean; setLabLauncher: (o: boolean) => void;
  compileResults: Record<NodeId, CompileResult>; compileRun: (node: NodeId, name: string, source: string, argv: string[], backend: 'clang' | 'nsc' | 'stub') => void;
  tourOpen: boolean; setTourOpen: (o: boolean) => void;
  clangStatus: 'idle' | 'downloading' | 'ready' | 'error'; enableClang: () => void;
  send: (c: Cmd) => void; setTool: (t: Tool) => void; select: (n: NodeId | null, l?: LinkId | null) => void;
  openNode: (id: NodeId | null, tab?: string) => void; openLink: (id: LinkId | null) => void; setPopupTab: (t: string) => void;
  setActiveSniffer: (id: SnifferId | null) => void; selectFrame: (f: { sid: SnifferId; n: number } | null) => void; setDisplayFilter: (sid: SnifferId, expr: string) => void;
  setHoverRange: (r: { start: number; end: number } | null) => void; setTheme: (id: string) => void; setBottomTab: (t: 'log' | 'breakpoints') => void;
  exportSession: () => void; importSession: (json: string) => void; loadScenario: (json: string) => void; showToast: (t: string | null) => void; dismissError: () => void;
  exportCapsule: () => void; exportPcap: (sid: SnifferId, withLabels?: boolean) => void;
  tracing: boolean; setTracing: (on: boolean) => void; exportTrace: () => void;
}

let worker: Worker | null = null;
function getWorker(): Worker {
  if (!worker) worker = new Worker(new URL('../engine/worker.ts', import.meta.url), { type: 'module' });
  return worker;
}

export const useSim = create<Store>((set, get) => ({
  st: null, ready: false, error: null, captures: {},
  tool: { kind: 'select' }, selectedNode: null, selectedLink: null, connectFrom: null,
  popupNode: null, popupLink: null, popupTab: 'config',
  activeSniffer: null, selectedFrame: null, displayFilters: {}, hoverRange: null, activeAir: null,
  theme: (() => { try { return localStorage.getItem('netsim.theme') || THEMES[0]!.id; } catch { return THEMES[0]!.id; } })(),
  bottomTab: 'log', toast: null, labOpen: true, labLauncher: false,
  compileResults: {},
  compileRun: (node, name, source, argv, backend) => getWorker().postMessage({ type: 'compileRun', node, name, source, argv, backend } satisfies Cmd),
  tourOpen: (() => { try { return localStorage.getItem('netsim.tourSeen') !== '1'; } catch { return false; } })(),
  setTourOpen: (o) => { if (!o) { try { localStorage.setItem('netsim.tourSeen', '1'); } catch { /* ignore */ } } set({ tourOpen: o }); },
  clangStatus: 'idle',
  // Pre-fetch the ~60MB C toolchain so it is in the browser cache before the first clang compile.
  // Same-origin; nothing is exposed. The worker reads the same cached files.
  enableClang: () => {
    if (get().clangStatus === 'downloading' || get().clangStatus === 'ready') return;
    set({ clangStatus: 'downloading' });
    Promise.all(['clang.wasm', 'lld.wasm', 'sysroot.tar', 'memfs.wasm'].map(f => fetch(`/csys/${f}`).then(r => { if (!r.ok) throw new Error(f); return r.arrayBuffer(); })))
      .then(() => set({ clangStatus: 'ready' }))
      .catch(() => set({ clangStatus: 'error' }));
  },
  send: (c) => { trace.cmd(c); getWorker().postMessage(c); },
  setTool: (tool) => set({ tool, connectFrom: null }),
  select: (n, l = null) => set({ selectedNode: n, selectedLink: l }),
  openNode: (id, tab) => set({ popupNode: id, popupLink: null, popupTab: tab ?? (id === get().popupNode ? get().popupTab : 'config') }),
  openLink: (id) => set({ popupLink: id, popupNode: null }),
  setPopupTab: (popupTab) => set({ popupTab }),
  setActiveSniffer: (activeSniffer) => set({ activeSniffer, selectedFrame: null, hoverRange: null, activeAir: null }),
  setActiveAir: (activeAir) => set({ activeAir, activeSniffer: null, selectedFrame: null }),
  selectFrame: (selectedFrame) => set({ selectedFrame, hoverRange: null }),
  setDisplayFilter: (sid, expr) => set(s => ({ displayFilters: { ...s.displayFilters, [sid]: expr } })),
  setHoverRange: (hoverRange) => set({ hoverRange }),
  setTheme: (id) => { applyTheme(id); try { localStorage.setItem('netsim.theme', id); } catch { /* ignore */ } set({ theme: id }); },
  setBottomTab: (bottomTab) => set({ bottomTab }),
  setLabOpen: (labOpen) => set({ labOpen }),
  setLabLauncher: (labLauncher) => set({ labLauncher }),
  exportSession: () => get().send({ type: 'exportSession', theme: get().theme }),
  loadScenario: (json: string) => get().send({ type: 'loadScenario', json }),
  importSession: (json) => get().send({ type: 'importSession', json }),
  exportCapsule: () => get().send({ type: 'exportCapsule' }),
  exportPcap: (sid, withLabels = false) => get().send({ type: 'exportPcap', snifferId: sid, withLabels }),
  tracing: false,
  setTracing: (on) => { if (on) trace.enable(); else trace.disable(); set({ tracing: on }); },
  exportTrace: () => { downloadText(`netsim-trace-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, trace.export()); get().showToast(`Trace exported (${trace.count()} events)`); },
  showToast: (toast) => set({ toast }),
  dismissError: () => set({ error: null }),
}));

// True when the simulation is paused and something will happen promptly if it runs. Drives the
// "press Play / Step / Turbo to run" cue in the top bar and the terminal, so a paused sim never
// looks broken. The 2s sim-time horizon means the cue appears right after you start something
// (a ping, a curl, enabling OSPF) and clears once it has run and the network settles.
export const pendingWhilePaused = (s: Store): boolean => {
  const st = s.st;
  return !!st && st.mode === 'paused' && st.nextEventUs != null && (st.nextEventUs - st.time) <= 2_000_000;
};

export function initWorker() {
  const w = getWorker();
  w.onmessage = (ev: MessageEvent<Msg>) => {
    const m = ev.data; const s = useSim.getState();
    switch (m.type) {
      case 'ready': useSim.setState({ ready: true }); break;
      case 'state': {
        const patch: Partial<Store> = { st: m.st };
        // Keep selection consistent with the topology.
        if (s.selectedNode !== null && !m.st.nodes[s.selectedNode]) patch.selectedNode = null;
        if (s.selectedLink !== null && !m.st.links[s.selectedLink]) patch.selectedLink = null;
        if (s.popupNode !== null && !m.st.nodes[s.popupNode]) patch.popupNode = null;
        if (s.popupLink !== null && !m.st.links[s.popupLink]) patch.popupLink = null;
        const sids = Object.keys(m.st.sniffers).map(Number);
        if (s.activeSniffer === null && sids.length) patch.activeSniffer = sids[0]!;
        if (s.activeSniffer !== null && !m.st.sniffers[s.activeSniffer]) patch.activeSniffer = sids[0] ?? null;
        if (m.st.lastHit && (!s.st?.lastHit || s.st.lastHit.t !== m.st.lastHit.t || s.st.lastHit.frameId !== m.st.lastHit.frameId)) { patch.bottomTab = 'breakpoints'; trace.record('breakpoint.hit', { milestone: m.st.lastHit.milestone, frameId: m.st.lastHit.frameId, t: m.st.lastHit.t }); }
        if (trace.enabled() && m.st.scenario && s.st?.scenario) { const prev = new Map(s.st.scenario.results.map(r => [r.id, r.pass])); for (const r of m.st.scenario.results) if (prev.get(r.id) !== r.pass) trace.record('lab.check', { id: r.id, pass: r.pass }); }
        useSim.setState(patch); break;
      }
      case 'capture': {
        const cur = m.reset ? [] : (s.captures[m.snifferId] ?? []);
        const next = m.frames.length ? cur.concat(m.frames) : cur;
        const capped = next.length > 5000 ? next.slice(next.length - 5000) : next;
        useSim.setState({ captures: { ...s.captures, [m.snifferId]: capped } }); break;
      }
      case 'session': downloadText(`netsim-session-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, m.json); useSim.getState().showToast('Session saved'); break;
      case 'capsule': downloadText(`netsim-capsule-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, m.json); useSim.getState().showToast('Reproducibility capsule saved'); break;
      case 'capsuleResult': useSim.getState().showToast(m.ok ? 'Capsule verified: byte-identical replay' : `Capsule replay MISMATCH (${m.gotHash.slice(0, 8)} != ${m.wantHash.slice(0, 8)})`); break;
      case 'pcap': { const ts = new Date().toISOString().replace(/[:.]/g, '-'); downloadBytes(`netsim-capture-${ts}.pcap`, m.pcap); if (m.labels) downloadText(`netsim-labels-${ts}.csv`, m.labels); useSim.getState().showToast('PCAP exported'); break; }
      case 'imported': useSim.setState({ captures: {}, selectedFrame: null, selectedNode: null, selectedLink: null, popupNode: null, popupLink: null, labOpen: true }); if (m.theme) useSim.getState().setTheme(m.theme); useSim.getState().showToast('Session loaded'); break;
      case 'error': useSim.setState({ error: m.message }); break;
      case 'compile': useSim.setState({ compileResults: { ...s.compileResults, [m.node]: { ok: m.ok, diagnostics: m.diagnostics, pid: m.pid, at: Date.now() } } }); break;
    }
  };
  w.postMessage({ type: 'requestState' } satisfies Cmd);
  applyTheme(useSim.getState().theme);
}

export function downloadText(name: string, text: string) {
  const blob = new Blob([text], { type: 'application/json' }); const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.setAttribute('data-testid', 'download-link'); document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}
export function downloadBytes(name: string, bytes: Uint8Array, mime = 'application/vnd.tcpdump.pcap') {
  const blob = new Blob([bytes as BlobPart], { type: mime }); const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.setAttribute('data-testid', 'download-link'); document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}
