// Generic dockable-layout primitives: resizable edge panes, retractable panels,
// and drag-to-resize splitters. When every panel in a pane is collapsed the pane
// recedes to a thin rail on its nearest edge showing the minimized panel titles.
import React from 'react';
import { useLayout, paneReceded, type Side } from './layout';

export interface PanelDef { id: string; title: string; node: React.ReactNode; right?: React.ReactNode; grow?: boolean; }

export function Splitter({ side }: { side: Side }) {
  const onDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY, start = useLayout.getState().size[side];
    const move = (ev: MouseEvent) => {
      const d = side === 'left' ? ev.clientX - startX : side === 'right' ? startX - ev.clientX : startY - ev.clientY;
      useLayout.getState().setSize(side, start + d);
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); document.body.style.cursor = ''; document.body.style.userSelect = ''; };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    document.body.style.cursor = side === 'bottom' ? 'row-resize' : 'col-resize'; document.body.style.userSelect = 'none';
  };
  return <div className={`splitter splitter-${side}`} data-testid={`splitter-${side}`} onMouseDown={onDown} title="Drag to resize" />;
}

export function Panel({ id, title, children, right, grow }: { id: string; title: string; children: React.ReactNode; right?: React.ReactNode; grow?: boolean }) {
  const collapsed = useLayout(s => !!s.collapsed[id]); const toggle = useLayout(s => s.togglePanel);
  return (
    <div className={`dpanel${collapsed ? ' collapsed' : ''}${grow && !collapsed ? ' grow' : ''}`} data-testid={`panel-${id}`}>
      <div className="dpanel-head" data-testid={`panel-head-${id}`} onClick={() => toggle(id)} title={collapsed ? 'Expand' : 'Collapse'}>
        <span className="chev">{collapsed ? '▸' : '▾'}</span><span className="dpanel-title">{title}</span>
        {right !== undefined && <span className="dpanel-extra" onClick={e => e.stopPropagation()}>{right}</span>}
      </div>
      {!collapsed && <div className="dpanel-body">{children}</div>}
    </div>
  );
}

export function Pane({ side, header, panels, className }: { side: Side; header?: React.ReactNode; panels: PanelDef[]; className?: string }) {
  const collapsed = useLayout(s => s.collapsed); const expand = useLayout(s => s.expandPanel);
  if (paneReceded(side, collapsed)) {
    return (
      <div className={`pane rail rail-${side} ${className ?? ''}`} data-testid={`pane-${side}`}>
        {panels.map(p => <button key={p.id} className="rail-tab" data-testid={`rail-${p.id}`} onClick={() => expand(p.id)} title={`Show ${p.title}`}>{p.title}</button>)}
      </div>
    );
  }
  return (
    <div className={`pane pane-${side} ${className ?? ''}`} data-testid={`pane-${side}`}>
      <Splitter side={side} />
      {header}
      <div className="pane-panels">
        {panels.map(p => <Panel key={p.id} id={p.id} title={p.title} right={p.right} grow={p.grow}>{p.node}</Panel>)}
      </div>
    </div>
  );
}
