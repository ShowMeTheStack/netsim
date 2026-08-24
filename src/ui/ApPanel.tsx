// Access Point configuration: SSID, channel, range, RTS/CTS, associated clients, wired ports.
import React, { useEffect, useState } from 'react';
import { useSim } from './store';
import type { ApState } from '@/engine/types';
export function ApPopupBody({ ap }: { ap: ApState }) {
  const send = useSim(s => s.send); const nodes = useSim(s => s.st?.nodes ?? {}); const links = useSim(s => s.st?.links ?? {});
  const [f, setF] = useState({ ssid: ap.ssid, channel: String(ap.channel), range: String(ap.range), rtsCts: ap.rtsCts });
  useEffect(() => setF({ ssid: ap.ssid, channel: String(ap.channel), range: String(ap.range), rtsCts: ap.rtsCts }), [ap.ssid, ap.channel, ap.range, ap.rtsCts]);
  const apply = (rtsCts = f.rtsCts) => send({ type: 'setAp', node: ap.id, ssid: f.ssid, channel: Number(f.channel) || 6, range: Number(f.range) || 200, rtsCts });
  return (
    <div>
      <div className="form" data-testid="ap-form">
        <label>SSID</label><input data-testid="ap-ssid" value={f.ssid} onChange={e => setF({ ...f, ssid: e.target.value })} onBlur={() => apply()} />
        <label>Channel</label><input data-testid="ap-channel" type="number" value={f.channel} onChange={e => setF({ ...f, channel: e.target.value })} onBlur={() => apply()} style={{ width: 70 }} />
        <label>Range (px)</label><input data-testid="ap-range" type="number" value={f.range} onChange={e => setF({ ...f, range: e.target.value })} onBlur={() => apply()} style={{ width: 90 }} />
        <label>RTS/CTS</label><label className="row"><input type="checkbox" data-testid="ap-rtscts" checked={f.rtsCts} onChange={e => { setF({ ...f, rtsCts: e.target.checked }); apply(e.target.checked); }} /> reserve the medium (helps hidden nodes)</label>
      </div>
      <h4 style={{ margin: '10px 0 4px' }}>Associated clients ({ap.clients.length})</h4>
      {ap.clients.length ? <table className="simple" data-testid="ap-clients"><thead><tr><th>Station</th><th>MAC</th></tr></thead><tbody>{ap.clients.map(c => <tr key={c.mac}><td>{nodes[c.node]?.name ?? c.node}</td><td>{c.mac}</td></tr>)}</tbody></table> : <span className="muted">none — bring a wireless station into range with a matching SSID</span>}
      <h4 style={{ margin: '10px 0 4px' }}>Wired uplink ports</h4>
      <table className="simple"><thead><tr><th>Port</th><th>Peer</th></tr></thead><tbody>{ap.ports.map((p, i) => { const l = p.linkId !== null ? links[p.linkId] : null; const peer = l ? nodes[l.a.node === ap.id ? l.b.node : l.a.node] : null; return <tr key={i}><td>{p.name}</td><td>{peer?.name ?? '—'}</td></tr>; })}</tbody></table>
      <div className="muted" style={{ marginTop: 8 }}>Beacons {ap.counters.beacons} · assoc {ap.counters.assoc} · bridged {ap.counters.bridged} · collisions {ap.counters.collisions} · retries {ap.counters.retries}</div>
    </div>
  );
}
