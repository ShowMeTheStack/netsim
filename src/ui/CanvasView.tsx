import React, { useEffect, useRef } from 'react';
import { useSim } from './store';
import { LabDrawer } from './LabDrawer';
import { u32ToIp } from '@/shared/bytes';
import { freePort } from '@/engine/engine';
import { isHost, isAp, type NodeState, type LinkState } from '@/engine/types';
import type { UiState } from '@/shared/protocol';

const NW = 64, NH = 44;
function nodeRect(n: NodeState) { return { x: n.x - NW / 2, y: n.y - NH / 2, w: NW, h: NH }; }
function hitNode(st: UiState, x: number, y: number): NodeState | null { const ns = Object.values(st.nodes); for (let i = ns.length - 1; i >= 0; i--) { const r = nodeRect(ns[i]!); if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return ns[i]!; } return null; }
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) { const dx = bx - ax, dy = by - ay; const l2 = dx * dx + dy * dy || 1; let t = ((px - ax) * dx + (py - ay) * dy) / l2; t = Math.max(0, Math.min(1, t)); const cx = ax + t * dx, cy = ay + t * dy; return Math.hypot(px - cx, py - cy); }
function hitLink(st: UiState, x: number, y: number): LinkState | null { for (const l of Object.values(st.links)) { const a = st.nodes[l.a.node], b = st.nodes[l.b.node]; if (!a || !b) continue; if (segDist(x, y, a.x, a.y, b.x, b.y) < 7) return l; } return null; }
function ipOf(n: NodeState): string { if (!isHost(n)) return ''; const ips = n.ifaces.filter(i => i.ip !== null).map(i => u32ToIp(i.ip!)); return ips.length ? (ips.length > 1 ? `${ips[0]} +${ips.length - 1}` : ips[0]!) : 'no IP'; }
const PROTO_COLOR: Record<string, string> = { ARP: '#d9a400', ICMP: '#a855f7', IPV4: '#3b82f6', TCP: '#22c55e', UDP: '#84cc16', DNS: '#06b6d4', HTTP: '#ef4444', ETH: '#8a94a1', RARP: '#d9a400' };

export function CanvasView() {
  const ref = useRef<HTMLCanvasElement>(null); const drag = useRef<{ id: number; dx: number; dy: number; moved: boolean } | null>(null);
  const tool = useSim(s => s.tool);
  useEffect(() => {
    const cv = ref.current!; let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const s = useSim.getState(); const st = s.st; const dpr = window.devicePixelRatio || 1;
      const W = cv.clientWidth, H = cv.clientHeight; if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
      const g = cv.getContext('2d')!; g.setTransform(dpr, 0, 0, dpr, 0, 0); const css = getComputedStyle(document.documentElement); const v = (k: string) => css.getPropertyValue(k).trim();
      g.fillStyle = v('--canvas'); g.fillRect(0, 0, W, H);
      g.strokeStyle = v('--grid'); g.lineWidth = 1; g.beginPath(); for (let x = 0; x < W; x += 24) { g.moveTo(x + .5, 0); g.lineTo(x + .5, H); } for (let y = 0; y < H; y += 24) { g.moveTo(0, y + .5); g.lineTo(W, y + .5); } g.stroke();
      if (!st) return;
      // wireless: AP range circles
      for (const n of Object.values(st.nodes)) if (isAp(n)) { g.strokeStyle = v('--accent'); g.globalAlpha = 0.18; g.setLineDash([6, 6]); g.beginPath(); g.arc(n.x, n.y, n.range, 0, Math.PI * 2); g.stroke(); g.setLineDash([]); g.globalAlpha = 0.05; g.fillStyle = v('--accent'); g.fill(); g.globalAlpha = 1; }
      // association lines (station <-> AP)
      for (const n of Object.values(st.nodes)) if (isHost(n)) for (const i of n.ifaces) if (i.wifi && i.wifi.associated !== null) { const ap = st.nodes[i.wifi.associated]; if (ap) { g.strokeStyle = v('--ok'); g.globalAlpha = 0.5; g.setLineDash([2, 4]); g.lineWidth = 1.5; g.beginPath(); g.moveTo(n.x, n.y); g.lineTo(ap.x, ap.y); g.stroke(); g.setLineDash([]); g.globalAlpha = 1; } }
      // in-flight air transmissions: expanding ring from the transmitter
      for (const tx of st.rf.transmissions) { const src = st.nodes[tx.node]; if (!src) continue; const p = tx.end > tx.start ? Math.max(0, Math.min(1, (st.time - tx.start) / (tx.end - tx.start))) : 1; g.strokeStyle = tx.collidedAt.length ? v('--danger') : tx.kind === 'data' ? v('--accent') : v('--warn'); g.globalAlpha = 0.6 * (1 - p) + 0.2; g.lineWidth = 2; g.beginPath(); g.arc(src.x, src.y, 12 + p * (tx.range * 0.5), 0, Math.PI * 2); g.stroke(); g.globalAlpha = 1; }
      // links
      for (const l of Object.values(st.links)) {
        const a = st.nodes[l.a.node], b = st.nodes[l.b.node]; if (!a || !b) continue;
        g.strokeStyle = s.selectedLink === l.id ? v('--select') : v('--link'); g.lineWidth = s.selectedLink === l.id ? 3 : 2; g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
        const hasSniffer = Object.values(st.sniffers).some(x => x.linkId === l.id); const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        if (hasSniffer) { g.fillStyle = v('--warn'); g.beginPath(); g.arc(mx, my, 8, 0, Math.PI * 2); g.fill(); g.fillStyle = '#000'; g.font = '11px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('🔍', mx, my + 1); }
        const qa = l.ab.queue.length + l.ba.queue.length; if (qa) { g.fillStyle = v('--fg2'); g.font = '10px sans-serif'; g.textAlign = 'center'; g.fillText(`q=${qa}`, mx, my - 14); }
      }
      // flights
      for (const f of st.flights) {
        const l = st.links[f.linkId]; if (!l) continue; const a = st.nodes[l.a.node], b = st.nodes[l.b.node]; if (!a || !b) continue;
        const from = f.dir === 'ab' ? a : b, to = f.dir === 'ab' ? b : a; const p = f.end > f.start ? Math.max(0, Math.min(1, (st.time - f.start) / (f.end - f.start))) : 1;
        const x = from.x + (to.x - from.x) * p, y = from.y + (to.y - from.y) * p;
        g.fillStyle = PROTO_COLOR[f.proto] ?? '#fff'; g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.fill(); g.strokeStyle = '#000'; g.lineWidth = 1; g.stroke();
        g.fillStyle = v('--fg'); g.font = '10px sans-serif'; g.textAlign = 'center'; g.fillText(f.proto, x, y - 10);
      }
      // connect preview
      if (s.connectFrom !== null && st.nodes[s.connectFrom]) { const n = st.nodes[s.connectFrom]!; g.strokeStyle = v('--accent'); g.setLineDash([4, 4]); g.beginPath(); g.arc(n.x, n.y, 36, 0, Math.PI * 2); g.stroke(); g.setLineDash([]); }
      // nodes
      for (const n of Object.values(st.nodes)) {
        const r = nodeRect(n); const sel = s.selectedNode === n.id;
        g.fillStyle = v('--node'); g.strokeStyle = sel ? v('--select') : v('--node-border'); g.lineWidth = sel ? 3 : 1.5;
        g.beginPath(); g.roundRect(r.x, r.y, r.w, r.h, 8); g.fill(); g.stroke();
        g.font = '20px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = v('--fg');
        const glyph = n.type === 'switch' ? '🔀' : n.type === 'router' ? '📡' : n.type === 'ap' ? '📶' : n.kind === 'laptop' ? '💻' : n.kind === 'desktop' ? '🖥' : n.kind === 'iot' ? '📟' : '🗄';
        g.fillText(glyph, n.x, n.y + 1);
        g.font = 'bold 11px sans-serif'; g.fillText(n.name, n.x, r.y + r.h + 10); g.font = '10px monospace'; g.fillStyle = v('--fg2'); g.fillText(n.type === 'switch' ? `${n.ports.filter(p => p.linkId !== null).length}/${n.ports.length} ports` : ipOf(n), n.x, r.y + r.h + 22);
        if (isHost(n) && Object.keys(n.procs).length) { g.fillStyle = v('--ok'); g.beginPath(); g.arc(r.x + r.w - 6, r.y + 6, 4, 0, Math.PI * 2); g.fill(); }
      }
    };
    draw(); return () => cancelAnimationFrame(raf);
  }, []);

  const pos = (e: React.MouseEvent) => { const r = ref.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const onDown = (e: React.MouseEvent) => {
    const s = useSim.getState(); const st = s.st; if (!st) return; const { x, y } = pos(e);
    if (s.tool.kind === 'place') { s.send({ type: 'addNode', nodeType: s.tool.nodeType, kind: s.tool.hostKind, x: Math.round(x), y: Math.round(y) }); s.setTool({ kind: 'select' }); return; }
    const n = hitNode(st, x, y);
    if (s.tool.kind === 'connect') {
      if (!n) { s.setTool({ kind: 'select' }); return; }
      if (s.connectFrom === null) { useSim.setState({ connectFrom: n.id }); return; }
      const from = st.nodes[s.connectFrom]; if (from && from.id !== n.id) { const pa = freePort(from), pb = freePort(n); if (pa < 0 || pb < 0) useSim.setState({ error: 'No free port on one of the nodes' }); else s.send({ type: 'connect', a: from.id, aIface: pa, b: n.id, bIface: pb }); }
      useSim.setState({ connectFrom: null }); return;
    }
    if (s.tool.kind === 'sniff') { const l = hitLink(st, x, y); if (l) { s.send({ type: 'addSniffer', link: l.id }); s.select(null, l.id); s.setTool({ kind: 'select' }); } return; }
    if (n) { s.select(n.id); drag.current = { id: n.id, dx: n.x - x, dy: n.y - y, moved: false }; return; }
    const l = hitLink(st, x, y); s.select(null, l ? l.id : null);
  };
  const onMove = (e: React.MouseEvent) => { const d = drag.current; if (!d) return; const { x, y } = pos(e); const s = useSim.getState(); const n = s.st?.nodes[d.id]; if (!n) return; d.moved = true; n.x = x + d.dx; n.y = y + d.dy; };
  const onUp = () => { const d = drag.current; drag.current = null; if (!d || !d.moved) return; const s = useSim.getState(); const n = s.st?.nodes[d.id]; if (n) s.send({ type: 'moveNode', id: d.id, x: Math.round(n.x), y: Math.round(n.y) }); };
  const onDbl = (e: React.MouseEvent) => { const s = useSim.getState(); const st = s.st; if (!st) return; const { x, y } = pos(e); const n = hitNode(st, x, y); if (n) { s.openNode(n.id); return; } const l = hitLink(st, x, y); if (l) s.openLink(l.id); };
  const onKey = (e: React.KeyboardEvent) => { const s = useSim.getState(); if (e.key === 'Delete' || e.key === 'Backspace') { if (s.selectedNode !== null) s.send({ type: 'removeNode', id: s.selectedNode }); else if (s.selectedLink !== null) s.send({ type: 'removeLink', id: s.selectedLink }); } if (e.key === 'Escape') s.setTool({ kind: 'select' }); };
  const cursor = tool.kind === 'place' ? 'copy' : tool.kind === 'connect' || tool.kind === 'sniff' ? 'crosshair' : 'default';
  const hint = tool.kind === 'place' ? 'Click on the canvas to place the device' : tool.kind === 'connect' ? 'Click the first node, then the second node' : tool.kind === 'sniff' ? 'Click a link to attach a sniffer' : '';
  return (
    <div className="canvas-wrap" tabIndex={0} onKeyDown={onKey}>
      <canvas ref={ref} data-testid="canvas" style={{ cursor }} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp} onDoubleClick={onDbl} />
      {hint && <div className="hint" data-testid="canvas-hint">{hint}</div>}
      <LabDrawer />
    </div>
  );
}
