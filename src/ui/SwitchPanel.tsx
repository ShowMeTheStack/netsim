// Switch VLAN configuration and the editable learning script.
import React, { useEffect, useState } from 'react';
import { useSim } from './store';
import { DEFAULT_SWITCH_SCRIPT } from '@/engine/devices/switch-script';
import type { SwitchState } from '@/engine/types';

export function VlanTab({ sw }: { sw: SwitchState }) {
  const send = useSim(s => s.send);
  const [enabled, setEnabled] = useState(sw.vlanEnabled);
  const [ports, setPorts] = useState(sw.ports.map(p => ({ mode: p.mode, vlan: p.vlan, trunkVlans: p.trunkVlans })));
  useEffect(() => { setEnabled(sw.vlanEnabled); setPorts(sw.ports.map(p => ({ mode: p.mode, vlan: p.vlan, trunkVlans: p.trunkVlans }))); }, [sw.vlanEnabled, sw.ports]);
  const apply = (en = enabled, pts = ports) => send({ type: 'setSwitchVlan', node: sw.id, enabled: en, ports: pts });
  return (
    <div data-testid="vlan-form">
      <label className="row" style={{ marginBottom: 8 }}><input type="checkbox" data-testid="vlan-enabled" checked={enabled} onChange={e => { setEnabled(e.target.checked); apply(e.target.checked); }} /> Enable 802.1Q VLANs</label>
      <table className="simple"><thead><tr><th>Port</th><th>Peer</th><th>Mode</th><th>Access VLAN</th><th>Trunk VLANs</th></tr></thead>
        <tbody>{sw.ports.map((p, i) => <tr key={i}><td>{p.name}</td><td>{p.linkId === null ? '—' : `link ${p.linkId}`}</td>
          <td><select data-testid={`vlan-mode-${i}`} value={ports[i]!.mode} disabled={!enabled} onChange={e => { const pts = ports.map((x, j) => j === i ? { ...x, mode: e.target.value as 'access' | 'trunk' } : x); setPorts(pts); apply(enabled, pts); }}><option value="access">access</option><option value="trunk">trunk</option></select></td>
          <td><input data-testid={`vlan-id-${i}`} type="number" value={ports[i]!.vlan} disabled={!enabled || ports[i]!.mode === 'trunk'} onChange={e => { const pts = ports.map((x, j) => j === i ? { ...x, vlan: Number(e.target.value) || 1 } : x); setPorts(pts); }} onBlur={() => apply()} style={{ width: 70 }} /></td>
          <td><input data-testid={`vlan-trunk-${i}`} value={ports[i]!.trunkVlans.join(',')} disabled={!enabled || ports[i]!.mode === 'access'} placeholder="all" onChange={e => { const pts = ports.map((x, j) => j === i ? { ...x, trunkVlans: e.target.value.split(',').map(v => Number(v.trim())).filter(Boolean) } : x); setPorts(pts); }} onBlur={() => apply()} style={{ width: 100 }} /></td></tr>)}</tbody></table>
    </div>
  );
}
export function ScriptTab({ sw }: { sw: SwitchState }) {
  const send = useSim(s => s.send); const [text, setText] = useState(sw.script ?? DEFAULT_SWITCH_SCRIPT); const enabled = sw.script !== null;
  useEffect(() => { if (sw.script !== null) setText(sw.script); }, [sw.script]);
  return (
    <div data-testid="script-form">
      <div className="muted" style={{ marginBottom: 6 }}>Replace the switch's learning logic with your own JavaScript. The <code>api</code> object exposes <code>src, dst, inPort, vlan, isBroadcast, learn(mac,port), lookup(mac), forward(port), flood(), drop(), log(msg)</code>. It runs sandboxed: no network, DOM or globals.</div>
      <label className="row" style={{ marginBottom: 6 }}><input type="checkbox" data-testid="script-enabled" checked={enabled} onChange={e => send({ type: 'setSwitchScript', node: sw.id, script: e.target.checked ? (sw.script ?? DEFAULT_SWITCH_SCRIPT) : null })} /> Use custom learning script (unchecked = built-in learn/flood)</label>
      <textarea data-testid="script-text" value={text} onChange={e => setText(e.target.value)} disabled={!enabled} style={{ width: '100%', height: 260, fontFamily: 'var(--mono)', fontSize: 12 }} />
      <div className="row" style={{ marginTop: 4 }}><button className="primary" data-testid="script-save" disabled={!enabled} onClick={() => send({ type: 'setSwitchScript', node: sw.id, script: text })}>Save & apply</button><button data-testid="script-reset" onClick={() => { setText(DEFAULT_SWITCH_SCRIPT); send({ type: 'setSwitchScript', node: sw.id, script: DEFAULT_SWITCH_SCRIPT }); }}>Reset to default</button></div>
    </div>
  );
}
