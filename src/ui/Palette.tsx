import React from 'react';
import { useSim, type Tool } from './store';
import { Pane, type PanelDef } from './Dock';

const items: { label: string; tool: Tool; id: string }[] = [
  { id: 'laptop', label: '💻 Laptop', tool: { kind: 'place', nodeType: 'host', hostKind: 'laptop' } },
  { id: 'desktop', label: '🖥 Desktop', tool: { kind: 'place', nodeType: 'host', hostKind: 'desktop' } },
  { id: 'iot', label: '📟 IoT device', tool: { kind: 'place', nodeType: 'host', hostKind: 'iot' } },
  { id: 'server', label: '🗄 Server', tool: { kind: 'place', nodeType: 'host', hostKind: 'server' } },
  { id: 'switch', label: '🔀 Switch', tool: { kind: 'place', nodeType: 'switch' } },
  { id: 'router', label: '📡 Router', tool: { kind: 'place', nodeType: 'router' } },
  { id: 'ap', label: '📶 Access Point', tool: { kind: 'place', nodeType: 'ap' } },
];
function sameTool(a: Tool, b: Tool) { return JSON.stringify(a) === JSON.stringify(b); }

export function Palette() {
  const tool = useSim(s => s.tool); const setTool = useSim(s => s.setTool);
  const panels: PanelDef[] = [
    { id: 'tools', title: 'Tools', node: (
      <div className="pal-list">
        <button data-testid="tool-select" className={tool.kind === 'select' ? 'active' : ''} onClick={() => setTool({ kind: 'select' })}>↖ Select / move</button>
        <button data-testid="tool-connect" className={tool.kind === 'connect' ? 'active' : ''} onClick={() => setTool({ kind: 'connect' })}>🔗 Connect</button>
        <button data-testid="tool-sniff" className={tool.kind === 'sniff' ? 'active' : ''} onClick={() => setTool({ kind: 'sniff' })}>🔍 Sniffer</button>
      </div>) },
    { id: 'devices', title: 'Devices', node: (
      <div className="pal-list">
        {items.map(it => <button key={it.id} data-testid={`place-${it.id}`} className={sameTool(tool, it.tool) ? 'active' : ''} onClick={() => setTool(it.tool)}>{it.label}</button>)}
      </div>) },
    { id: 'help', title: 'Help', node: (
      <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.4 }}>
        Pick a device, click the canvas to place it. Connect: click two nodes. Sniffer: click a link. Double-click a node or link to configure. Delete key removes the selection.
        <br /><br />Drag a pane's edge to resize it. Click a panel title to retract it; retract every panel and the pane folds to the edge.
      </div>) },
  ];
  return <Pane side="left" className="palette" panels={panels} />;
}
