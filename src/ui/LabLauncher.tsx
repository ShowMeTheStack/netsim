// Browse all labs grouped by module and launch one.
import React from 'react';
import { useSim } from './store';
import { ALL_LABS, MODULES } from './labs';
export function LabLauncher() {
  const open = useSim(s => s.labLauncher); const setOpen = useSim(s => s.setLabLauncher); const loadScenario = useSim(s => s.loadScenario);
  if (!open) return null;
  return (
    <div className="lab-launcher" data-testid="lab-launcher" onMouseDown={e => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className="box">
        <div className="lab-head"><b style={{ flex: 1 }}>📚 Lab library — {ALL_LABS.length} guided labs</b><span className="muted" style={{ marginRight: 8 }}>theory + step-by-step + checks</span><button onClick={() => setOpen(false)}>✕</button></div>
        <div className="lab-cat">
          {MODULES.map(mod => { const labs = ALL_LABS.filter(l => l.module === mod.name); if (!labs.length) return null; return (
            <div key={mod.id}><h4>{mod.name} — <span style={{ textTransform: 'none', fontWeight: 400 }}>{mod.blurb}</span></h4>
              {labs.map((l, i) => <div key={l.id} className="lab-card" data-testid={`launch-${l.id}`} onClick={() => { loadScenario(l.build()); setOpen(false); }}>
                <span className="meta">{i + 1}.</span><span className="n">{l.name}</span><span className="meta">{l.difficulty} · ~{l.minutes}m · {l.checks.length} checks</span></div>)}
            </div>); })}
        </div>
      </div>
    </div>
  );
}
