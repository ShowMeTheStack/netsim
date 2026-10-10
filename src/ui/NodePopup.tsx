import React, { useEffect, useRef, useState } from 'react';
import { useSim, pendingWhilePaused } from './store';
import { u32ToIp, maskToPrefix, isValidIp } from '@/shared/bytes';
import { isHost, type HostState, type SwitchState, type CcName } from '@/engine/types';
import { SocketsTab } from './TcpPanel';
import { CodeTab } from './CodeTab';
import { ServicesTab } from './Services';
import { HttpWaterfall } from './HttpPanel';
import { RoutingTab, NatTab } from './RoutingPanel';
import { VlanTab, ScriptTab } from './SwitchPanel';
import { ApPopupBody } from './ApPanel';
import { isAp } from '@/engine/types';
import { useDragOffset } from './useDrag';

export function NodePopup({ id }: { id: number }) {
  const n = useSim(s => s.st?.nodes[id]); const tab = useSim(s => s.popupTab); const setTab = useSim(s => s.setPopupTab); const close = () => useSim.getState().openNode(null);
  const send = useSim(s => s.send); const drag = useDragOffset();
  if (!n) return null;
  const tabs = isAp(n) ? ['wireless'] : isHost(n) ? (n.type === 'router' ? ['config', 'terminal', 'routing', 'nat', 'services', 'sockets', 'code', 'arp', 'routes', 'stats'] : ['config', 'terminal', 'services', 'sockets', 'code', 'http', 'arp', 'routes', 'stats']) : ['ports', 'vlans', 'script', 'mac', 'stats'];
  const cur = tabs.includes(tab) ? tab : tabs[0]!;
  return (
    <div className="modal-backdrop" data-testid="popup-backdrop">
      <div className="modal" data-testid="node-popup" role="dialog" style={drag.style}>
        <div className="head" data-testid="popup-drag" onMouseDown={drag.onMouseDown}><span className="drag-grip" title="Drag to move">⋮⋮</span><h3>{n.type === 'switch' ? '🔀' : n.type === 'router' ? '📡' : n.type === 'ap' ? '📶' : '💻'} <EditableName id={n.id} name={n.name} /></h3><span className="badge">{isAp(n) ? 'access point' : isHost(n) ? n.kind : 'switch'}</span><span className="spacer" style={{ flex: 1 }} /><button className="danger" data-testid="popup-delete" onClick={() => { send({ type: 'removeNode', id: n.id }); close(); }}>Delete</button><button data-testid="popup-close" onClick={close}>✕</button></div>
        <div className="tabs">{tabs.map(t => <button key={t} data-testid={`tab-${t}`} className={cur === t ? 'active' : ''} onClick={() => setTab(t)}>{t[0]!.toUpperCase() + t.slice(1)}</button>)}</div>
        <div className="body">
          {isAp(n) && cur === 'wireless' && <ApPopupBody ap={n} />}
          {isHost(n) && cur === 'config' && <HostConfig h={n} />}
          {isHost(n) && cur === 'terminal' && <Terminal h={n} />}
          {isHost(n) && cur === 'routing' && <RoutingTab h={n} />}
          {isHost(n) && cur === 'nat' && <NatTab h={n} />}
          {isHost(n) && cur === 'services' && <ServicesTab h={n} />}
          {isHost(n) && cur === 'sockets' && <SocketsTab h={n} />}
          {isHost(n) && cur === 'code' && <CodeTab h={n} />}
          {isHost(n) && cur === 'http' && <HttpWaterfall h={n} />}
          {isHost(n) && cur === 'arp' && <ArpTab h={n} />}
          {isHost(n) && cur === 'routes' && <RoutesTab h={n} />}
          {isHost(n) && cur === 'stats' && <HostStats h={n} />}
          {n.type === 'switch' && cur === 'ports' && <SwitchPorts sw={n} />}
          {n.type === 'switch' && cur === 'vlans' && <VlanTab sw={n} />}
          {n.type === 'switch' && cur === 'script' && <ScriptTab sw={n} />}
          {n.type === 'switch' && cur === 'mac' && <MacTab sw={n} />}
          {n.type === 'switch' && cur === 'stats' && <pre className="log">{JSON.stringify(n.counters, null, 2)}</pre>}
        </div>
      </div>
    </div>
  );
}
function EditableName({ id, name }: { id: number; name: string }) {
  const [v, setV] = useState(name); useEffect(() => setV(name), [name]);
  return <input data-testid="node-name" value={v} onChange={e => setV(e.target.value)} onBlur={() => { if (v.trim() && v !== name) useSim.getState().send({ type: 'renameNode', id, name: v.trim() }); }} style={{ fontSize: 15, fontWeight: 600, width: 200 }} />;
}
function HostConfig({ h }: { h: HostState }) {
  const send = useSim(s => s.send);
  const gw = h.routes.find(r => r.kind === 'default'); const [gwv, setGw] = useState(gw ? u32ToIp(gw.gw!) : ''); useEffect(() => setGw(gw ? u32ToIp(gw.gw!) : ''), [gw?.gw]);
  return (
    <div>
      {h.ifaces.map(i => <IfaceRow key={i.name} h={h} name={i.name} />)}
      <div className="form" style={{ marginTop: 12 }}>
        <label>Default gateway</label>
        <div className="row"><input data-testid="gw" value={gwv} onChange={e => setGw(e.target.value)} placeholder="e.g. 10.0.0.254" className={gwv && !isValidIp(gwv) ? 'invalid' : ''} />
          <button data-testid="gw-apply" onClick={() => send({ type: 'setGateway', node: h.id, gw: gwv.trim() ? gwv.trim() : null })}>Apply</button></div>
        <label>DNS servers</label><DnsServers h={h} />
        <label>IP forwarding</label><label className="row"><input type="checkbox" data-testid="forwarding" checked={h.forwarding} onChange={e => send({ type: 'setForwarding', node: h.id, on: e.target.checked })} /> act as a router (net.ipv4.ip_forward)</label>
      </div>
      <TcpSettings h={h} />
    </div>
  );
}
function DnsServers({ h }: { h: HostState }) {
  const send = useSim(s => s.send); const [v, setV] = useState(h.dns.join(', ')); useEffect(() => setV(h.dns.join(', ')), [h.dns.join(',')]);
  return <div className="row"><input data-testid="resolv" value={v} onChange={e => setV(e.target.value)} placeholder="e.g. 10.0.0.53" style={{ width: 200 }} /><button data-testid="resolv-apply" onClick={() => send({ type: 'setResolv', node: h.id, dns: v })}>Apply</button></div>;
}
function TcpSettings({ h }: { h: HostState }) {
  const send = useSim(s => s.send); const t = h.tcp; const set = (tcp: Partial<HostState['tcp']>) => send({ type: 'setHostTcp', node: h.id, tcp });
  return (
    <div className="form" style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }} data-testid="tcp-settings">
      <label>TCP congestion control</label><select data-testid="tcp-cc" value={t.cc} onChange={e => set({ cc: e.target.value as CcName })}><option value="tahoe">Tahoe</option><option value="reno">Reno</option><option value="newreno">NewReno</option><option value="cubic">CUBIC</option></select>
      <label>Initial cwnd (segments)</label><input data-testid="tcp-initcwnd" type="number" min={1} max={100} value={t.initCwndSegs} onChange={e => set({ initCwndSegs: Math.max(1, Number(e.target.value) || 1) })} style={{ width: 80 }} />
      <label>Receive buffer (bytes)</label><input type="number" min={1024} value={t.rcvBufCap} onChange={e => set({ rcvBufCap: Math.max(1024, Number(e.target.value) || 65536) })} style={{ width: 120 }} />
      <label>Options</label><div className="row">
        <label className="row"><input type="checkbox" checked={t.sack} onChange={e => set({ sack: e.target.checked })} /> SACK</label>
        <label className="row"><input type="checkbox" checked={t.wscale} onChange={e => set({ wscale: e.target.checked })} /> window scaling</label>
        <label className="row"><input type="checkbox" checked={t.delayedAck} onChange={e => set({ delayedAck: e.target.checked })} /> delayed ACK</label>
        <label className="row"><input type="checkbox" checked={t.nagle} onChange={e => set({ nagle: e.target.checked })} /> Nagle</label></div>
      <label>Min RTO / MSL (ms)</label><div className="row"><input type="number" value={t.minRtoUs / 1000} onChange={e => set({ minRtoUs: Math.max(10, Number(e.target.value) || 200) * 1000 })} style={{ width: 80 }} /><input type="number" value={t.mslUs / 1000} onChange={e => set({ mslUs: Math.max(100, Number(e.target.value) || 30000) * 1000 })} style={{ width: 90 }} /></div>
      <label /><span className="muted">Settings apply to new connections. Same as <code>sysctl</code> in the terminal.</span>
    </div>
  );
}
function IfaceRow({ h, name }: { h: HostState; name: string }) {
  const i = h.ifaces.find(x => x.name === name)!; const send = useSim(s => s.send);
  const [ip, setIp] = useState(i.ip === null ? '' : u32ToIp(i.ip)); const [prefix, setPrefix] = useState(String(maskToPrefix(i.mask))); const [mtu, setMtu] = useState(String(i.mtu));
  useEffect(() => { setIp(i.ip === null ? '' : u32ToIp(i.ip)); setPrefix(String(maskToPrefix(i.mask))); setMtu(String(i.mtu)); }, [i.ip, i.mask, i.mtu]);
  const okIp = ip === '' || isValidIp(ip); const okPre = /^\d+$/.test(prefix) && Number(prefix) >= 0 && Number(prefix) <= 32;
  return (
    <div className="form" style={{ marginBottom: 10, paddingBottom: 10, borderBottom: '1px solid var(--border)' }} data-testid={`iface-${name}`}>
      <label>Interface</label><div className="row"><b>{name}</b> <span className="badge">{i.mac}</span> <span className="badge">{i.linkId === null ? 'not connected' : `link ${i.linkId}`}</span>
        <label className="row"><input type="checkbox" checked={i.up} onChange={e => send({ type: 'setIface', node: h.id, iface: name, ip: i.ip === null ? null : u32ToIp(i.ip), prefix: maskToPrefix(i.mask), up: e.target.checked })} /> up</label></div>
      <label>IPv4 address</label><div className="row"><input data-testid={`ip-${name}`} value={ip} onChange={e => setIp(e.target.value)} placeholder="static IP, e.g. 10.0.0.1" className={okIp ? '' : 'invalid'} style={{ width: 160 }} /> / <input data-testid={`prefix-${name}`} value={prefix} onChange={e => setPrefix(e.target.value)} style={{ width: 50 }} className={okPre ? '' : 'invalid'} />
        <button data-testid={`apply-${name}`} className="primary" disabled={!okIp || !okPre} onClick={() => send({ type: 'setIface', node: h.id, iface: name, ip: ip.trim() || null, prefix: Number(prefix), mtu: Number(mtu) || 1500 })}>Apply</button></div>
      <label>MTU</label><input value={mtu} onChange={e => setMtu(e.target.value)} style={{ width: 80 }} />
      <label>Wireless</label><WifiConfig h={h} iface={name} />
      <label>DHCP</label><span className="muted">use <code>dhclient</code> in the terminal</span>
    </div>
  );
}
function WifiConfig({ h, iface }: { h: HostState; iface: string }) {
  const send = useSim(s => s.send); const i = h.ifaces.find(x => x.name === iface)!; const on = !!i.wifi;
  const [ssid, setSsid] = useState(i.wifi?.ssid ?? ''); const [ch, setCh] = useState(String(i.wifi?.channel ?? 6)); const [range, setRange] = useState(String(i.wifi?.range ?? 200));
  useEffect(() => { setSsid(i.wifi?.ssid ?? ''); setCh(String(i.wifi?.channel ?? 6)); setRange(String(i.wifi?.range ?? 200)); }, [i.wifi?.ssid, i.wifi?.channel, i.wifi?.range]);
  const apply = (o = on) => send({ type: 'setWireless', node: h.id, iface, on: o, ssid, channel: Number(ch) || 6, range: Number(range) || 200 });
  return <div><label className="row"><input type="checkbox" data-testid={`wifi-${iface}`} checked={on} onChange={e => apply(e.target.checked)} /> Wi-Fi station {i.wifi ? (i.wifi.associated !== null ? '(associated)' : '(scanning…)') : ''}</label>
    {on && <div className="row" style={{ marginTop: 4 }}>SSID <input data-testid={`wifi-ssid-${iface}`} value={ssid} onChange={e => setSsid(e.target.value)} onBlur={() => apply()} placeholder="any" style={{ width: 90 }} /> ch <input data-testid={`wifi-ch-${iface}`} value={ch} onChange={e => setCh(e.target.value)} onBlur={() => apply()} style={{ width: 50 }} /> range <input value={range} onChange={e => setRange(e.target.value)} onBlur={() => apply()} style={{ width: 60 }} /></div>}</div>;
}
function Terminal({ h }: { h: HostState }) {
  const send = useSim(s => s.send); const [line, setLine] = useState(''); const out = useRef<HTMLDivElement>(null); const hist = useRef<string[]>([]); const hi = useRef(-1);
  const runHint = useSim(pendingWhilePaused);
  useEffect(() => { const el = out.current; if (el) el.scrollTop = el.scrollHeight; }, [h.terminal.length]);
  const submit = () => { const l = line; setLine(''); if (l.trim()) { hist.current.push(l); hi.current = hist.current.length; } send({ type: 'runCmd', node: h.id, line: l }); };
  return (
    <div className="terminal">
      <div ref={out} className="out" data-testid="terminal-out">{h.terminal.join('\n')}</div>
      {runHint && <div className="term-hint" data-testid="term-run-hint">⏸ simulation paused — press ▶ Play, ⏭ Step or ⏩ Turbo in the top bar to run it</div>}
      <div className="in"><span style={{ fontFamily: 'var(--mono)' }}>{h.hostname}$</span>
        <input data-testid="terminal-in" autoFocus value={line} onChange={e => setLine(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submit(); else if (e.key === 'ArrowUp') { hi.current = Math.max(0, hi.current - 1); setLine(hist.current[hi.current] ?? ''); } else if (e.key === 'ArrowDown') { hi.current = Math.min(hist.current.length, hi.current + 1); setLine(hist.current[hi.current] ?? ''); } }} placeholder="type a command, e.g. ping 10.0.0.2" />
        <button onClick={submit}>Run</button></div>
    </div>
  );
}
function ArpTab({ h }: { h: HostState }) {
  const t = useSim(s => s.st?.time ?? 0); const rows = Object.entries(h.arp).filter(([, e]) => e.static || e.expires > t);
  return <table className="simple" data-testid="arp-table"><thead><tr><th>IP</th><th>MAC</th><th>Type</th><th>Expires</th></tr></thead><tbody>{rows.length ? rows.map(([ip, e]) => <tr key={ip}><td>{ip}</td><td>{e.mac}</td><td>{e.static ? 'static' : 'dynamic'}</td><td>{e.static ? '—' : `${((e.expires - t) / 1e6).toFixed(1)}s`}</td></tr>) : <tr><td colSpan={4} className="muted">ARP cache is empty</td></tr>}</tbody></table>;
}
function RoutesTab({ h }: { h: HostState }) {
  const send = useSim(s => s.send); const [cidr, setCidr] = useState(''); const [gw, setGw] = useState('');
  return <div>
    <table className="simple" data-testid="routes-table"><thead><tr><th>Destination</th><th>Mask</th><th>Gateway</th><th>Interface</th><th>Metric</th><th>Kind</th><th /></tr></thead><tbody>{h.routes.map((r, i) => <tr key={i}><td>{u32ToIp(r.dst)}</td><td>/{maskToPrefix(r.mask)}</td><td>{r.gw === null ? '—' : u32ToIp(r.gw)}</td><td>{r.iface}</td><td>{r.metric}</td><td>{r.kind}</td><td>{r.kind !== 'connected' && <button className="danger" onClick={() => send({ type: 'delRoute', node: h.id, index: i })}>✕</button>}</td></tr>)}</tbody></table>
    <div className="row" style={{ marginTop: 10 }}><span className="muted">Add static route:</span><input data-testid="route-cidr" placeholder="10.0.2.0/24" value={cidr} onChange={e => setCidr(e.target.value)} style={{ width: 150 }} /><span>via</span><input data-testid="route-gw" placeholder="10.0.12.2" value={gw} onChange={e => setGw(e.target.value)} className={gw && !isValidIp(gw) ? 'invalid' : ''} style={{ width: 130 }} /><button data-testid="route-add" className="primary" disabled={!cidr.trim() || !isValidIp(gw)} onClick={() => { send({ type: 'addRoute', node: h.id, cidr: cidr.trim(), gw: gw.trim() }); setCidr(''); setGw(''); }}>Add</button></div>
  </div>;
}
function HostStats({ h }: { h: HostState }) {
  return <div><table className="simple"><thead><tr><th>Interface</th><th>RX pkts</th><th>RX bytes</th><th>RX drops</th><th>TX pkts</th><th>TX bytes</th><th>TX drops</th></tr></thead><tbody>{h.ifaces.map(i => <tr key={i.name}><td>{i.name}</td><td>{i.rxPackets}</td><td>{i.rxBytes}</td><td>{i.rxDrops}</td><td>{i.txPackets}</td><td>{i.txBytes}</td><td>{i.txDrops}</td></tr>)}</tbody></table>
    <pre className="log" style={{ marginTop: 10 }}>{JSON.stringify(h.counters, null, 2)}</pre></div>;
}
function SwitchPorts({ sw }: { sw: SwitchState }) {
  const links = useSim(s => s.st?.links ?? {}); const nodes = useSim(s => s.st?.nodes ?? {});
  return <table className="simple" data-testid="ports-table"><thead><tr><th>Port</th><th>MAC</th><th>Status</th><th>Peer</th><th>RX</th><th>TX</th><th>Drops</th></tr></thead><tbody>{sw.ports.map((p, i) => { const l = p.linkId !== null ? links[p.linkId] : null; const peer = l ? nodes[l.a.node === sw.id ? l.b.node : l.a.node] : null; return <tr key={i}><td>{p.name}</td><td>{p.mac}</td><td>{p.linkId === null ? 'down (no link)' : p.up ? 'up' : 'admin down'}</td><td>{peer?.name ?? '—'}</td><td>{p.rxPackets}</td><td>{p.txPackets}</td><td>{p.rxDrops}</td></tr>; })}</tbody></table>;
}
function MacTab({ sw }: { sw: SwitchState }) {
  const t = useSim(s => s.st?.time ?? 0); const rows = Object.entries(sw.macTable);
  return <table className="simple" data-testid="mac-table"><thead><tr><th>MAC address</th><th>Port</th><th>Ages out in</th></tr></thead><tbody>{rows.length ? rows.map(([m, e]) => <tr key={m}><td>{m}</td><td>{sw.ports[e.port]?.name}</td><td>{((e.expires - t) / 1e6).toFixed(0)}s</td></tr>) : <tr><td colSpan={3} className="muted">No addresses learned yet</td></tr>}</tbody></table>;
}
