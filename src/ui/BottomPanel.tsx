import React, { useState } from 'react';
import { useSim } from './store';
import { decodeCached } from './SnifferPanel';
import { compileFilter } from '@/filters/filter';
import type { Milestone } from '@/engine/types';
import { Pane, type PanelDef } from './Dock';

const QUICK: { label: string; expr: string; ms: Milestone[] }[] = [
  { label: 'Any ARP', expr: 'arp', ms: ['tx'] }, { label: 'ARP reply', expr: 'arp.opcode == 2', ms: ['tx'] }, { label: 'Any ICMP', expr: 'icmp', ms: ['tx'] },
  { label: 'Echo reply', expr: 'icmp.type == 0', ms: ['tx'] }, { label: 'Bad checksum', expr: 'eth.fcs_ok == false or ipv4.checksum_ok == false', ms: ['rx'] }, { label: 'Any drop', expr: 'eth', ms: ['drop'] },
];

function Console() {
  const tab = useSim(s => s.bottomTab); const setTab = useSim(s => s.setBottomTab); const log = useSim(s => s.st?.log ?? []); const bps = useSim(s => s.st?.breakpoints ?? []); const hit = useSim(s => s.st?.lastHit ?? null);
  const send = useSim(s => s.send); const nodes = useSim(s => s.st?.nodes ?? {});
  const [expr, setExpr] = useState(''); const [ms, setMs] = useState<Milestone[]>(['tx']); const ast = compileFilter(expr);
  const toggleMs = (m: Milestone) => setMs(ms.includes(m) ? ms.filter(x => x !== m) : [...ms, m]);
  return (
    <div className="console">
      <div className="tabs"><button data-testid="tab-log" className={tab === 'log' ? 'active' : ''} onClick={() => setTab('log')}>Event log</button><button data-testid="tab-breakpoints" className={tab === 'breakpoints' ? 'active' : ''} onClick={() => setTab('breakpoints')}>Breakpoints ({bps.length})</button>{hit && <span className="badge" style={{ marginLeft: 8, background: 'var(--warn)', color: '#000' }}>⏸ breakpoint hit</span>}</div>
      {tab === 'log' ? <div className="panel-body log" data-testid="event-log">{log.length ? log.map((l, i) => <div key={i}><span className="t">{(l.t / 1e6).toFixed(6)}</span>{l.text}</div>) : <span className="muted">Engine events appear here.</span>}</div> :
        <div className="panel-body" data-testid="breakpoints-panel">
          {hit && <div className="hit" data-testid="bp-hit">Breakpoint #{hit.breakpointId} hit at t={(hit.t / 1e6).toFixed(6)}s on {hit.milestone.toUpperCase()} at {nodes[hit.nodeId]?.name ?? hit.nodeId}: {decodeCached(hit.bytes).proto} — {decodeCached(hit.bytes).info}{hit.reason ? ` (${hit.reason})` : ''}. Use Play/Turbo to continue or step.</div>}
          <div className="row" style={{ marginBottom: 6 }}>
            <input data-testid="bp-expr" style={{ width: 340, fontFamily: 'var(--mono)' }} placeholder="condition, e.g. tcp.flags.syn == 1 or icmp.type == 0" value={expr} onChange={e => setExpr(e.target.value)} className={ast instanceof Error ? 'invalid' : ''} />
            {(['tx', 'rx', 'drop'] as Milestone[]).map(m => <label key={m} className="row"><input type="checkbox" checked={ms.includes(m)} onChange={() => toggleMs(m)} /> {m}</label>)}
            <button data-testid="bp-add" className="primary" disabled={!expr.trim() || ast instanceof Error || !ms.length} onClick={() => { send({ type: 'addBreakpoint', expr: expr.trim(), milestones: ms }); setExpr(''); }}>Add breakpoint</button>
            <span className="muted">quick:</span>{QUICK.map(q => <button key={q.label} data-testid={`bp-quick-${q.label.replace(/\s+/g, '-').toLowerCase()}`} onClick={() => send({ type: 'addBreakpoint', expr: q.expr, milestones: q.ms, label: q.label })}>{q.label}</button>)}
          </div>
          {bps.map(b => <div key={b.id} className="bp-row" data-testid="bp-row"><input type="checkbox" checked={b.enabled} onChange={e => send({ type: 'toggleBreakpoint', id: b.id, enabled: e.target.checked })} /><span className="badge">#{b.id}</span><span>{b.label ? `${b.label}: ` : ''}{b.expr}</span><span className="muted">on {b.milestones.join(', ')}</span><button className="danger" onClick={() => send({ type: 'removeBreakpoint', id: b.id })}>✕</button></div>)}
          {!bps.length && <div className="muted">No breakpoints. Add a condition; the simulation pauses when a packet matches it.</div>}
        </div>}
    </div>
  );
}

export function BottomPanel() {
  const bps = useSim(s => s.st?.breakpoints.length ?? 0);
  const panels: PanelDef[] = [{ id: 'console', title: `Console — event log & breakpoints (${bps})`, grow: true, node: <Console /> }];
  return <Pane side="bottom" className="bottom" panels={panels} />;
}
