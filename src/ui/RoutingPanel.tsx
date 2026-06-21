// Routing configuration + live state for routers: RIP, OSPF, BGP and NAT.
import React, { useEffect, useState } from 'react';
import { useSim } from './store';
import { u32ToIp, maskToPrefix } from '@/shared/bytes';
import type { HostState } from '@/engine/types';

const netsToText = (nets: { net: number; mask: number }[]) => nets.map(n => `${u32ToIp(n.net)}/${maskToPrefix(n.mask)}`).join('\n');
export function RoutingTab({ h }: { h: HostState }) {
  const [sub, setSub] = useState('rip');
  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>{['rip', 'ospf', 'bgp'].map(x => <button key={x} data-testid={`rt-${x}`} className={sub === x ? 'active' : ''} onClick={() => setSub(x)}>{x.toUpperCase()}</button>)}</div>
      {sub === 'rip' && <Rip h={h} />}{sub === 'ospf' && <Ospf h={h} />}{sub === 'bgp' && <Bgp h={h} />}
    </div>
  );
}
function Rip({ h }: { h: HostState }) {
  const send = useSim(s => s.send); const cfg = h.routing.rip; const [nets, setNets] = useState(netsToText(cfg.networks)); useEffect(() => setNets(netsToText(cfg.networks)), [cfg.networks]);
  return (
    <div className="form" data-testid="rip-form">
      <label>RIP enabled</label><label className="row"><input type="checkbox" data-testid="rip-enabled" checked={cfg.enabled} onChange={e => send({ type: 'setRip', node: h.id, enabled: e.target.checked, networks: nets })} /> distance-vector (RIPv2)</label>
      <label>Networks</label><textarea data-testid="rip-networks" value={nets} onChange={e => setNets(e.target.value)} onBlur={() => send({ type: 'setRip', node: h.id, enabled: cfg.enabled, networks: nets })} placeholder="10.0.0.0/24" style={{ height: 60, fontFamily: 'var(--mono)' }} />
      <label>Learned routes</label><div>{cfg.routes.length ? <table className="simple"><thead><tr><th>Network</th><th>Via</th><th>Metric</th><th>State</th></tr></thead><tbody>{cfg.routes.map((r, i) => <tr key={i}><td>{u32ToIp(r.dst)}/{maskToPrefix(r.mask)}</td><td>{u32ToIp(r.gw)}</td><td>{r.metric === 16 ? '16 (unreachable)' : r.metric}</td><td>{r.gc !== null ? 'garbage' : 'active'}</td></tr>)}</tbody></table> : <span className="muted">none yet</span>}</div>
    </div>
  );
}
function Ospf({ h }: { h: HostState }) {
  const send = useSim(s => s.send); const cfg = h.routing.ospf; const [nets, setNets] = useState(netsToText(cfg.networks));
  const [costs, setCosts] = useState<Record<string, number>>(cfg.ifaceCosts); useEffect(() => { setNets(netsToText(cfg.networks)); setCosts(cfg.ifaceCosts); }, [cfg.networks, cfg.ifaceCosts]);
  const apply = (enabled = cfg.enabled) => send({ type: 'setOspf', node: h.id, enabled, networks: nets, costs });
  return (
    <div className="form" data-testid="ospf-form">
      <label>OSPF enabled</label><label className="row"><input type="checkbox" data-testid="ospf-enabled" checked={cfg.enabled} onChange={e => apply(e.target.checked)} /> link-state, single area · router-id {cfg.routerId ? u32ToIp(cfg.routerId) : '(auto)'}</label>
      <label>Networks</label><textarea data-testid="ospf-networks" value={nets} onChange={e => setNets(e.target.value)} onBlur={() => apply()} style={{ height: 60, fontFamily: 'var(--mono)' }} />
      <label>Interface costs</label><div>{h.ifaces.map(i => <div key={i.name} className="row"><span style={{ width: 60 }}>{i.name}</span><input type="number" data-testid={`ospf-cost-${i.name}`} value={costs[i.name] ?? 10} onChange={e => setCosts({ ...costs, [i.name]: Number(e.target.value) || 10 })} onBlur={() => apply()} style={{ width: 70 }} /></div>)}</div>
      <label>Neighbors</label><div>{Object.values(cfg.neighbors).length ? Object.values(cfg.neighbors).map(n => <div key={n.routerId} className="badge" style={{ marginRight: 4 }}>{u32ToIp(n.routerId)} ({n.state})</div>) : <span className="muted">none</span>}</div>
      <label>Link-state DB</label><div className="muted">{Object.values(cfg.lsdb).length} LSAs from {new Set(Object.values(cfg.lsdb).map(l => l.advRouter)).size} routers</div>
    </div>
  );
}
function Bgp({ h }: { h: HostState }) {
  const send = useSim(s => s.send); const cfg = h.routing.bgp; const [f, setF] = useState({ as: String(cfg.as || ''), routerId: cfg.routerId ? u32ToIp(cfg.routerId) : '', networks: netsToText(cfg.networks), rr: cfg.routeReflector });
  const [peerIp, setPeerIp] = useState(''); const [peerAs, setPeerAs] = useState('');
  useEffect(() => setF({ as: String(cfg.as || ''), routerId: cfg.routerId ? u32ToIp(cfg.routerId) : '', networks: netsToText(cfg.networks), rr: cfg.routeReflector }), [cfg.as, cfg.routerId, cfg.networks, cfg.routeReflector]);
  const apply = (enabled = cfg.enabled) => send({ type: 'setBgp', node: h.id, enabled, as: Number(f.as) || 0, routerId: f.routerId, networks: f.networks, routeReflector: f.rr });
  return (
    <div data-testid="bgp-form">
      <div className="form">
        <label>BGP enabled</label><label className="row"><input type="checkbox" data-testid="bgp-enabled" checked={cfg.enabled} onChange={e => apply(e.target.checked)} /> path-vector (BGP-4)</label>
        <label>Local AS</label><input data-testid="bgp-as" value={f.as} onChange={e => setF({ ...f, as: e.target.value })} onBlur={() => apply()} style={{ width: 90 }} />
        <label>Router ID</label><input data-testid="bgp-routerid" value={f.routerId} onChange={e => setF({ ...f, routerId: e.target.value })} onBlur={() => apply()} placeholder="auto" style={{ width: 130 }} />
        <label>Route reflector</label><label className="row"><input type="checkbox" data-testid="bgp-rr" checked={f.rr} onChange={e => { setF({ ...f, rr: e.target.checked }); }} onBlur={() => apply()} /> reflect iBGP routes</label>
        <label>Networks</label><textarea data-testid="bgp-networks" value={f.networks} onChange={e => setF({ ...f, networks: e.target.value })} onBlur={() => apply()} style={{ height: 44, fontFamily: 'var(--mono)' }} />
      </div>
      <h4 style={{ margin: '8px 0 4px' }}>Neighbors</h4>
      {cfg.neighbors.map(nb => <div key={nb.peerIp} className="row" style={{ padding: '2px 0' }}><span className="badge">{u32ToIp(nb.peerIp)} AS{nb.peerAs}</span><span className={nb.state === 'established' ? '' : 'muted'}>{nb.state}</span><button className="danger" onClick={() => send({ type: 'delBgpNeighbor', node: h.id, peerIp: u32ToIp(nb.peerIp) })}>✕</button></div>)}
      <div className="row" style={{ marginTop: 4 }}><input data-testid="bgp-peer-ip" placeholder="peer IP" value={peerIp} onChange={e => setPeerIp(e.target.value)} style={{ width: 130 }} /><input data-testid="bgp-peer-as" placeholder="peer AS" value={peerAs} onChange={e => setPeerAs(e.target.value)} style={{ width: 90 }} /><button data-testid="bgp-add-neighbor" onClick={() => { if (peerIp && peerAs) { send({ type: 'addBgpNeighbor', node: h.id, peerIp: peerIp.trim(), peerAs: Number(peerAs) }); setPeerIp(''); setPeerAs(''); } }}>Add neighbor</button></div>
      <h4 style={{ margin: '8px 0 4px' }}>BGP table (RIB)</h4>
      {cfg.rib.length ? <table className="simple" data-testid="bgp-rib"><thead><tr><th> </th><th>Network</th><th>Next hop</th><th>AS_PATH</th><th>LocPrf</th></tr></thead><tbody>{cfg.rib.map((r, i) => <tr key={i}><td>{r.best ? '>' : ''}</td><td>{u32ToIp(r.prefix)}/{r.len}</td><td>{u32ToIp(r.nextHop)}</td><td>{r.asPath.join(' ') || 'i'}</td><td>{r.localPref}</td></tr>)}</tbody></table> : <span className="muted">empty</span>}
    </div>
  );
}
export function NatTab({ h }: { h: HostState }) {
  const send = useSim(s => s.send); const nat = h.nat; const [f, setF] = useState({ enabled: nat.enabled, outside: nat.outsideIface, inside: nat.insideIfaces });
  const [pf, setPf] = useState({ proto: '6', outsidePort: '', insideIp: '', insidePort: '' });
  useEffect(() => setF({ enabled: nat.enabled, outside: nat.outsideIface, inside: nat.insideIfaces }), [nat.enabled, nat.outsideIface, nat.insideIfaces]);
  const apply = (enabled = f.enabled) => send({ type: 'setNat', node: h.id, enabled, outsideIface: f.outside, insideIfaces: f.inside });
  return (
    <div data-testid="nat-form">
      <div className="form">
        <label>NAT enabled</label><label className="row"><input type="checkbox" data-testid="nat-enabled" checked={f.enabled} onChange={e => apply(e.target.checked)} /> source NAT / PAT</label>
        <label>Outside interface</label><select data-testid="nat-outside" value={f.outside} onChange={e => { setF({ ...f, outside: e.target.value }); }} onBlur={() => apply()}><option value="">—</option>{h.ifaces.map(i => <option key={i.name} value={i.name}>{i.name}</option>)}</select>
        <label>Inside interfaces</label><div className="row">{h.ifaces.map(i => <label key={i.name} className="row"><input type="checkbox" data-testid={`nat-inside-${i.name}`} checked={f.inside.includes(i.name)} onChange={e => { const inside = e.target.checked ? [...f.inside, i.name] : f.inside.filter(x => x !== i.name); setF({ ...f, inside }); send({ type: 'setNat', node: h.id, enabled: f.enabled, outsideIface: f.outside, insideIfaces: inside }); }} /> {i.name}</label>)}</div>
      </div>
      <h4 style={{ margin: '8px 0 4px' }}>Port forwards</h4>
      {nat.portForwards.map((p, i) => <div key={i} className="row"><span className="badge">{p.proto === 6 ? 'TCP' : 'UDP'} :{p.outsidePort} → {u32ToIp(p.insideIp)}:{p.insidePort}</span><button className="danger" onClick={() => send({ type: 'delPortForward', node: h.id, index: i })}>✕</button></div>)}
      <div className="row" style={{ marginTop: 4 }}>
        <select value={pf.proto} onChange={e => setPf({ ...pf, proto: e.target.value })}><option value="6">TCP</option><option value="17">UDP</option></select>
        <input data-testid="pf-oport" placeholder="outside port" value={pf.outsidePort} onChange={e => setPf({ ...pf, outsidePort: e.target.value })} style={{ width: 100 }} />
        <input data-testid="pf-iip" placeholder="inside IP" value={pf.insideIp} onChange={e => setPf({ ...pf, insideIp: e.target.value })} style={{ width: 120 }} />
        <input data-testid="pf-iport" placeholder="inside port" value={pf.insidePort} onChange={e => setPf({ ...pf, insidePort: e.target.value })} style={{ width: 100 }} />
        <button data-testid="pf-add" onClick={() => { if (pf.outsidePort && pf.insideIp && pf.insidePort) { send({ type: 'addPortForward', node: h.id, proto: Number(pf.proto), outsidePort: Number(pf.outsidePort), insideIp: pf.insideIp, insidePort: Number(pf.insidePort) }); setPf({ proto: pf.proto, outsidePort: '', insideIp: '', insidePort: '' }); } }}>Add</button>
      </div>
      <div className="muted" style={{ marginTop: 8 }}>Active translations: {nat.table.length}</div>
      {nat.table.length > 0 && <table className="simple" data-testid="nat-table"><thead><tr><th>Proto</th><th>Inside</th><th>Outside port</th><th>Peer</th></tr></thead><tbody>{nat.table.slice(0, 20).map((e, i) => <tr key={i}><td>{e.proto === 6 ? 'TCP' : e.proto === 17 ? 'UDP' : 'ICMP'}</td><td>{u32ToIp(e.insideIp)}:{e.insidePort}</td><td>{e.outsidePort}</td><td>{u32ToIp(e.peerIp)}</td></tr>)}</tbody></table>}
    </div>
  );
}
