// Floating task card for the active scenario/lab, with live pass/fail checks.
import React, { useState } from 'react';
import { useSim } from './store';
export function ScenarioBanner() {
  const sc = useSim(s => s.st?.scenario ?? null); const [open, setOpen] = useState(true);
  if (!sc) return null; const done = sc.results.every(r => r.pass);
  return (
    <div data-testid="scenario-banner" style={{ position: 'absolute', left: 12, bottom: 12, width: 340, maxWidth: '46%', background: 'var(--bg2)', border: `1px solid ${done ? 'var(--ok)' : 'var(--border)'}`, borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,.25)', zIndex: 5, overflow: 'hidden' }}>
      <div className="row" style={{ padding: '8px 10px', background: done ? 'var(--ok)' : 'var(--bg3)', color: done ? '#fff' : 'var(--fg)', cursor: 'pointer' }} onClick={() => setOpen(!open)}>
        <b style={{ flex: 1 }}>{done ? '✓ ' : '📚 '}{sc.title}</b><span>{sc.results.filter(r => r.pass).length}/{sc.results.length}</span><span style={{ marginLeft: 6 }}>{open ? '▾' : '▸'}</span>
      </div>
      {open && <div style={{ padding: '8px 10px' }}>
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.45, marginBottom: 8 }}>{sc.description}</div>
        {sc.results.map(r => <div key={r.id} data-testid={`check-${r.id}`} className="row" style={{ padding: '2px 0', fontSize: 12 }}><span style={{ color: r.pass ? 'var(--ok)' : 'var(--fg2)', width: 16 }}>{r.pass ? '✓' : '○'}</span><span style={{ color: r.pass ? 'var(--fg)' : 'var(--fg2)' }}>{r.label}</span></div>)}
        {done && <div style={{ color: 'var(--ok)', fontWeight: 600, marginTop: 6 }}>Lab complete — well done!</div>}
      </div>}
    </div>
  );
}
