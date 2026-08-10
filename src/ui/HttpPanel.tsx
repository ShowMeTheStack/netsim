// HTTP tab: request waterfall for client fetches (one row per resource, timed).
import React from 'react';
import type { HostState, HttpProc } from '@/engine/types';

export function HttpWaterfall({ h }: { h: HostState }) {
  const clients = Object.values(h.procs).filter((p): p is HttpProc => p.kind === 'http' && p.role === 'client');
  const servers = Object.values(h.procs).filter((p): p is HttpProc => p.kind === 'http' && p.role === 'server');
  if (!clients.length && !servers.length) return <div className="muted" data-testid="http-empty">No active HTTP transfers. Run <code>curl URL</code> from the terminal, or <code>httpd</code> to serve.</div>;
  return (
    <div data-testid="http-panel">
      {servers.map(p => <div key={p.pid} className="badge" style={{ marginRight: 6 }}>server :{p.port} — {Object.keys(p.conns).length} open connection(s)</div>)}
      {clients.map(p => <Waterfall key={p.pid} p={p} />)}
    </div>
  );
}
function Waterfall({ p }: { p: HttpProc }) {
  if (!p.fetched.length) return <div className="muted">fetching {p.host}...</div>;
  const t0 = Math.min(...p.fetched.map(f => f.start)); const end = Math.max(...p.fetched.map(f => f.start + f.ms * 1000)); const span = Math.max(1, end - t0);
  return (
    <div style={{ marginTop: 8 }}>
      <div className="muted" style={{ marginBottom: 4 }}>{p.host} — {p.mode}{p.pipeline ? ', pipelined' : ''} — {p.fetched.length} resource(s)</div>
      <table className="simple" data-testid="waterfall"><thead><tr><th>Resource</th><th>Status</th><th>Bytes</th><th>Time</th><th style={{ width: '45%' }}>Timeline</th></tr></thead>
        <tbody>{p.fetched.map((f, i) => { const left = ((f.start - t0) / span) * 100; const w = Math.max(1, ((f.ms * 1000) / span) * 100); return <tr key={i}><td>{f.path}</td><td style={{ color: f.status >= 400 ? 'var(--danger)' : 'var(--ok)' }}>{f.status}</td><td>{f.bytes}</td><td>{f.ms.toFixed(1)} ms</td><td><div style={{ position: 'relative', height: 12, background: 'var(--bg3)', borderRadius: 3 }}><div style={{ position: 'absolute', left: `${left}%`, width: `${w}%`, top: 0, bottom: 0, background: 'var(--accent)', borderRadius: 3 }} /></div></td></tr>; })}</tbody></table>
    </div>
  );
}
