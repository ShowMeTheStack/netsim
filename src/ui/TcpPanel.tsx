// Sockets tab: netstat-like table plus per-connection charts (cwnd/ssthresh/rwnd, RTT/RTO, time-sequence).
import React, { useEffect, useRef, useState } from 'react';
import { u32ToIp } from '@/shared/bytes';
import type { HostState, TcpSocket, Socket } from '@/engine/types';

const fmtK = (b: number) => b >= 1e6 ? `${(b / 1e6).toFixed(2)} MB` : b >= 1e3 ? `${(b / 1e3).toFixed(1)} KB` : `${b} B`;
export function SocketsTab({ h }: { h: HostState }) {
  const socks: Socket[] = [...Object.values(h.sockets), ...[...h.tcpHistory].reverse()]; const [sel, setSel] = useState<number | null>(null);
  const cur = (sel !== null ? socks.find(s => s.id === sel) : socks.find(s => s.proto === 'tcp' && s.state !== 'LISTEN')) as Socket | undefined;
  return (
    <div>
      <table className="simple" data-testid="sockets-table"><thead><tr><th>Proto</th><th>Local</th><th>Remote</th><th>State</th><th>PID</th><th>cwnd</th><th>ssthresh</th><th>RTO</th><th>retx</th></tr></thead>
        <tbody>{socks.length ? socks.map(s => <tr key={s.id} onClick={() => setSel(s.id)} style={{ cursor: 'pointer', outline: cur?.id === s.id ? '2px solid var(--accent)' : undefined }}>
          <td>{s.proto}{s.proto === 'tcp' && s.state === 'CLOSED' ? <span className="muted"> (history)</span> : ''}</td><td>{s.localIp === null ? '0.0.0.0' : u32ToIp(s.localIp)}:{s.localPort}</td><td>{s.remoteIp === null ? '*:*' : `${u32ToIp(s.remoteIp)}:${s.remotePort}`}</td><td>{s.proto === 'tcp' ? s.state : '—'}</td><td>{s.owner}</td>
          <td>{s.proto === 'tcp' ? s.cwnd : ''}</td><td>{s.proto === 'tcp' ? (s.ssthresh > 1e9 ? '∞' : s.ssthresh) : ''}</td><td>{s.proto === 'tcp' ? `${(s.rto / 1000).toFixed(0)}ms` : ''}</td><td>{s.proto === 'tcp' ? s.stats.retx : ''}</td></tr>) : <tr><td colSpan={9} className="muted">No sockets. Run iperf, nc or traceroute from the terminal.</td></tr>}</tbody></table>
      {cur?.proto === 'tcp' && <TcpDetail s={cur} />}
    </div>
  );
}
function TcpDetail({ s }: { s: TcpSocket }) {
  return (
    <div style={{ marginTop: 10 }} data-testid="tcp-detail">
      <div className="row" style={{ gap: 14, flexWrap: 'wrap', fontFamily: 'var(--mono)', fontSize: 12 }}>
        <span><b>{s.cc.toUpperCase()}</b> {s.state}</span><span>cwnd <b>{s.cwnd}</b> ({(s.cwnd / Math.max(1, s.mss)).toFixed(1)} MSS)</span><span>ssthresh <b>{s.ssthresh > 1e9 ? '∞' : s.ssthresh}</b></span><span>rwnd <b>{s.sndWnd}</b></span>
        <span>in flight <b>{Math.max(0, s.sndNxt - s.sndUna)}</b></span><span>SRTT <b>{(s.srtt / 1000).toFixed(2)}ms</b></span><span>RTO <b>{(s.rto / 1000).toFixed(0)}ms</b>{s.rtoBackoff > 1 ? ` ×${s.rtoBackoff}` : ''}</span>
        <span>MSS {Math.min(s.mss, s.peerMss)}</span><span>WS {s.wscale}/{s.peerWscale}</span><span>SACK {s.sackOk && s.peerSackOk ? 'on' : 'off'}</span>
        <span>sent {fmtK(s.stats.txBytes)} in {s.stats.txSegs} segs</span><span>rcvd {fmtK(s.stats.rxBytes)}</span><span>retx <b>{s.stats.retx}</b></span><span>RTOs <b>{s.stats.rtoCount}</b></span><span>fast retx <b>{s.stats.fastRetx}</b></span><span>dup ACKs {s.stats.dupAcksRx}</span><span>OOO {s.stats.oooSegs}</span><span>zero-win probes {s.stats.zeroWnd}</span>
      </div>
      <Chart title="Congestion window" testid="chart-cwnd" s={s} kind="cwnd" />
      <Chart title="RTT and RTO" testid="chart-rtt" s={s} kind="rtt" />
      <Chart title="Time-sequence (sent data, ACKs, retransmissions)" testid="chart-seq" s={s} kind="seq" />
      <details style={{ marginTop: 8 }}><summary className="muted">Connection log ({s.log.length})</summary><pre className="log" data-testid="tcp-log" style={{ maxHeight: 200, overflow: 'auto' }}>{s.log.join('\n')}</pre></details>
    </div>
  );
}
function Chart({ title, s, kind, testid }: { title: string; s: TcpSocket; kind: 'cwnd' | 'rtt' | 'seq'; testid: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current!; const dpr = window.devicePixelRatio || 1; const W = cv.clientWidth, H = cv.clientHeight; cv.width = W * dpr; cv.height = H * dpr;
    const g = cv.getContext('2d')!; g.setTransform(dpr, 0, 0, dpr, 0, 0); const css = getComputedStyle(document.documentElement); const v = (k: string) => css.getPropertyValue(k).trim();
    g.fillStyle = v('--bg'); g.fillRect(0, 0, W, H); const L = 56, R = 8, T = 8, B = 20; const pw = W - L - R, ph = H - T - B;
    const tr = s.trace; if (!tr.length) { g.fillStyle = v('--fg2'); g.font = '11px sans-serif'; g.fillText('no samples yet', L, H / 2); return; }
    const t0 = tr[0]!.t, t1 = Math.max(tr[tr.length - 1]!.t, t0 + 1); const X = (t: number) => L + ((t - t0) / (t1 - t0)) * pw;
    const axis = (ymax: number, unit: string) => { g.strokeStyle = v('--border'); g.fillStyle = v('--fg2'); g.font = '10px sans-serif'; g.textAlign = 'right'; for (let i = 0; i <= 4; i++) { const y = T + ph - (i / 4) * ph; g.beginPath(); g.moveTo(L, y); g.lineTo(W - R, y); g.stroke(); g.fillText(fmtAxis((i / 4) * ymax, unit), L - 4, y + 3); } g.textAlign = 'center'; for (let i = 0; i <= 4; i++) { const x = L + (i / 4) * pw; g.fillText(`${(((t0 + (i / 4) * (t1 - t0)) / 1e6)).toFixed(2)}s`, x, H - 6); } };
    const line = (pts: [number, number][], color: string, dash: number[] = [], w = 1.5) => { g.strokeStyle = color; g.lineWidth = w; g.setLineDash(dash); g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.stroke(); g.setLineDash([]); };
    if (kind === 'cwnd') {
      const ymax = Math.max(s.mss * 2, ...tr.map(p => Math.max(p.cwnd, p.ssthresh < 1e9 ? p.ssthresh : 0, p.rwnd))) * 1.05; const Y = (b: number) => T + ph - (Math.min(b, ymax) / ymax) * ph; axis(ymax, 'B');
      line(tr.map(p => [X(p.t), Y(p.rwnd)]), v('--fg2'), [2, 3], 1); line(tr.filter(p => p.ssthresh < 1e9).map(p => [X(p.t), Y(p.ssthresh)]), v('--warn'), [5, 3], 1.2); line(tr.map(p => [X(p.t), Y(p.cwnd)]), v('--accent'), [], 2);
      let lastLabelX = -100; for (const p of tr) if (p.ev && ['FRX', 'RTO', 'REC', 'PACK', 'ZWP'].includes(p.ev)) { g.fillStyle = p.ev === 'RTO' ? v('--danger') : p.ev === 'FRX' ? v('--warn') : v('--ok'); g.beginPath(); g.arc(X(p.t), Y(p.cwnd), p.ev === 'PACK' ? 2 : 3.5, 0, Math.PI * 2); g.fill(); if (p.ev !== 'PACK' && p.ev !== 'REC' && X(p.t) - lastLabelX > 22) { g.font = '9px sans-serif'; g.textAlign = 'center'; g.fillText(p.ev, X(p.t), Y(p.cwnd) - 6); lastLabelX = X(p.t); } }
      legend(g, W, [['cwnd', v('--accent')], ['ssthresh', v('--warn')], ['rwnd', v('--fg2')]]);
    } else if (kind === 'rtt') {
      const ymax = Math.max(1000, ...tr.map(p => Math.max(p.srtt, p.rto))) * 1.05; const Y = (us: number) => T + ph - (Math.min(us, ymax) / ymax) * ph; axis(ymax / 1000, 'ms');
      line(tr.map(p => [X(p.t), Y(p.rto)]), v('--warn'), [5, 3], 1.2); line(tr.filter(p => p.srtt > 0).map(p => [X(p.t), Y(p.srtt)]), v('--ok'), [], 2);
      legend(g, W, [['SRTT', v('--ok')], ['RTO', v('--warn')]]);
    } else {
      const ev = s.seqTrace; if (!ev.length) return; const base = s.iss; const ymax = Math.max(1, ...ev.map(e => e.seq + e.len - base)) * 1.02; const Y = (q: number) => T + ph - (Math.min(q, ymax) / ymax) * ph; axis(ymax, 'B');
      const acks = ev.filter(e => e.kind === 'ack'); line(acks.map(e => [X(e.t), Y(e.seq - base)]), v('--ok'), [], 1.2);
      for (const e of ev) { if (e.kind === 'data') { g.fillStyle = v('--accent'); g.fillRect(X(e.t) - 1, Y(e.seq + e.len - base), 2, Math.max(1, Y(e.seq - base) - Y(e.seq + e.len - base))); } else if (e.kind === 'retx') { g.fillStyle = v('--danger'); g.beginPath(); g.arc(X(e.t), Y(e.seq - base), 3, 0, Math.PI * 2); g.fill(); } else if (e.kind === 'sack') { g.fillStyle = v('--warn'); g.fillRect(X(e.t) - 1, Y(e.seq + e.len - base), 2, Math.max(1, Y(e.seq - base) - Y(e.seq + e.len - base))); } }
      legend(g, W, [['data', v('--accent')], ['ACK', v('--ok')], ['retransmit', v('--danger')], ['SACKed', v('--warn')]]);
    }
  });
  return <div style={{ marginTop: 10 }}><div className="muted" style={{ fontSize: 11, marginBottom: 2 }}>{title}</div><canvas ref={ref} data-testid={testid} style={{ width: '100%', height: 150, display: 'block', border: '1px solid var(--border)', borderRadius: 6 }} /></div>;
}
function fmtAxis(vv: number, unit: string) { if (unit === 'ms') return `${vv.toFixed(vv < 10 ? 1 : 0)}ms`; return vv >= 1e6 ? `${(vv / 1e6).toFixed(1)}M` : vv >= 1e3 ? `${(vv / 1e3).toFixed(0)}K` : `${Math.round(vv)}`; }
function legend(g: CanvasRenderingContext2D, W: number, items: [string, string][]) { g.font = '10px sans-serif'; g.textAlign = 'left'; let x = W - 8 - items.reduce((a, [n]) => a + g.measureText(n).width + 18, 0); for (const [n, c] of items) { g.fillStyle = c; g.fillRect(x, 10, 10, 3); g.fillStyle = c; g.fillText(n, x + 13, 14); x += g.measureText(n).width + 18; } }
