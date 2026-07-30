// Services tab: DHCP server, DNS (recursion + authoritative zones), HTTP docroot, /etc/hosts.
import React, { useEffect, useState } from 'react';
import { useSim } from './store';
import { u32ToIp, maskToPrefix } from '@/shared/bytes';
import type { HostState } from '@/engine/types';

export function ServicesTab({ h }: { h: HostState }) {
  const [sub, setSub] = useState('dhcp');
  const subs = ['dhcp', 'dns', 'http', 'hosts'];
  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>{subs.map(x => <button key={x} data-testid={`svc-${x}`} className={sub === x ? 'active' : ''} onClick={() => setSub(x)}>{x === 'http' ? 'HTTP server' : x === 'dns' ? 'DNS server' : x === 'dhcp' ? 'DHCP server' : '/etc/hosts'}</button>)}</div>
      {sub === 'dhcp' && <Dhcp h={h} />}{sub === 'dns' && <Dns h={h} />}{sub === 'http' && <Http h={h} />}{sub === 'hosts' && <Hosts h={h} />}
    </div>
  );
}
function Dhcp({ h }: { h: HostState }) {
  const send = useSim(s => s.send); const d = h.dhcpServer;
  const [f, setF] = useState({ enabled: d.enabled, iface: d.iface, poolStart: d.poolStart ? u32ToIp(d.poolStart) : '', poolEnd: d.poolEnd ? u32ToIp(d.poolEnd) : '', prefix: String(d.mask ? maskToPrefix(d.mask) : 24), gateway: d.gateway ? u32ToIp(d.gateway) : '', dns: d.dns.map(u32ToIp).join(', ') });
  useEffect(() => setF({ enabled: d.enabled, iface: d.iface, poolStart: d.poolStart ? u32ToIp(d.poolStart) : '', poolEnd: d.poolEnd ? u32ToIp(d.poolEnd) : '', prefix: String(d.mask ? maskToPrefix(d.mask) : 24), gateway: d.gateway ? u32ToIp(d.gateway) : '', dns: d.dns.map(u32ToIp).join(', ') }), [d]);
  const apply = (enabled = f.enabled) => send({ type: 'setDhcpServer', node: h.id, cfg: { enabled, iface: f.iface, poolStart: f.poolStart, poolEnd: f.poolEnd, prefix: Number(f.prefix) || 24, gateway: f.gateway, dns: f.dns } });
  return (
    <div className="form" data-testid="dhcp-form">
      <label>Enabled</label><label className="row"><input type="checkbox" data-testid="dhcp-enabled" checked={f.enabled} onChange={e => { setF({ ...f, enabled: e.target.checked }); apply(e.target.checked); }} /> serve DHCP on this interface</label>
      <label>Interface</label><select data-testid="dhcp-iface" value={f.iface} onChange={e => setF({ ...f, iface: e.target.value })}>{h.ifaces.map(i => <option key={i.name} value={i.name}>{i.name}</option>)}</select>
      <label>Pool start</label><input data-testid="dhcp-start" value={f.poolStart} onChange={e => setF({ ...f, poolStart: e.target.value })} placeholder="10.0.0.100" />
      <label>Pool end</label><input data-testid="dhcp-end" value={f.poolEnd} onChange={e => setF({ ...f, poolEnd: e.target.value })} placeholder="10.0.0.150" />
      <label>Prefix length</label><input data-testid="dhcp-prefix" value={f.prefix} onChange={e => setF({ ...f, prefix: e.target.value })} style={{ width: 60 }} />
      <label>Gateway (opt)</label><input data-testid="dhcp-gw" value={f.gateway} onChange={e => setF({ ...f, gateway: e.target.value })} placeholder="10.0.0.1" />
      <label>DNS (opt)</label><input data-testid="dhcp-dns" value={f.dns} onChange={e => setF({ ...f, dns: e.target.value })} placeholder="10.0.0.53" />
      <label /><button className="primary" data-testid="dhcp-apply" onClick={() => apply()}>Apply</button>
      <label>Leases</label><div>{Object.values(d.leases).length ? <table className="simple"><thead><tr><th>MAC</th><th>IP</th></tr></thead><tbody>{Object.values(d.leases).map(l => <tr key={l.mac}><td>{l.mac}</td><td>{u32ToIp(l.ip)}</td></tr>)}</tbody></table> : <span className="muted">no leases yet</span>}</div>
    </div>
  );
}
function Dns({ h }: { h: HostState }) {
  const send = useSim(s => s.send); const [rec, setRec] = useState(h.dnsRecursion); const [roots, setRoots] = useState(h.dnsRoots.map(u32ToIp).join(', ')); const [fwd, setFwd] = useState(h.dnsForwarders.map(u32ToIp).join(', '));
  const [origin, setOrigin] = useState(''); const [zoneText, setZoneText] = useState(''); const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => { setRec(h.dnsRecursion); setRoots(h.dnsRoots.map(u32ToIp).join(', ')); setFwd(h.dnsForwarders.map(u32ToIp).join(', ')); }, [h.dnsRecursion, h.dnsRoots, h.dnsForwarders]);
  return (
    <div data-testid="dns-form">
      <div className="form">
        <label>Recursive resolver</label><label className="row"><input type="checkbox" data-testid="dns-recursion" checked={rec} onChange={e => { setRec(e.target.checked); send({ type: 'setDnsConfig', node: h.id, recursion: e.target.checked, roots, forwarders: fwd }); }} /> answer recursive queries (RD)</label>
        <label>Root servers</label><input data-testid="dns-roots" value={roots} onChange={e => setRoots(e.target.value)} onBlur={() => send({ type: 'setDnsConfig', node: h.id, recursion: rec, roots, forwarders: fwd })} placeholder="198.41.0.4" />
        <label>Forwarders (opt)</label><input data-testid="dns-forwarders" value={fwd} onChange={e => setFwd(e.target.value)} onBlur={() => send({ type: 'setDnsConfig', node: h.id, recursion: rec, roots, forwarders: fwd })} placeholder="empty = iterative from roots" />
      </div>
      <h4 style={{ margin: '10px 0 4px' }}>Authoritative zones</h4>
      {h.dnsZones.map(z => <div key={z.origin} className="row" style={{ padding: '2px 0' }}><span className="badge">{z.origin || '. (root)'}</span><span className="muted">{z.records.length} records</span><button onClick={() => { setEditing(z.origin); setOrigin(z.origin); setZoneText(z.text); }}>Edit</button><button className="danger" onClick={() => send({ type: 'delDnsZone', node: h.id, origin: z.origin })}>✕</button></div>)}
      <div style={{ marginTop: 8 }}>
        <div className="row"><input data-testid="zone-origin" placeholder="zone origin, e.g. example.com (empty = root)" value={origin} onChange={e => setOrigin(e.target.value)} style={{ width: 280 }} /></div>
        <textarea data-testid="zone-text" value={zoneText} onChange={e => setZoneText(e.target.value)} placeholder={"$TTL 300\n@ IN SOA ns.example.com. admin.example.com. 1 7200 3600 604800 300\n@ IN NS ns.example.com.\nns IN A 10.0.0.53\n@ IN A 93.184.216.34\nwww IN CNAME example.com."} style={{ width: '100%', height: 160, fontFamily: 'var(--mono)', fontSize: 12, marginTop: 4 }} />
        <button className="primary" data-testid="zone-save" onClick={() => { send({ type: 'setDnsZone', node: h.id, origin: origin.trim(), text: zoneText }); setEditing(null); }}>{editing !== null ? 'Save zone' : 'Add zone'}</button>
      </div>
    </div>
  );
}
function Http({ h }: { h: HostState }) {
  const send = useSim(s => s.send); const files = h.httpDocroot; const names = Object.keys(files);
  const [sel, setSel] = useState(names[0] ?? 'index.html'); const [text, setText] = useState(files[sel] ?? ''); const [newName, setNewName] = useState('');
  useEffect(() => { setText(files[sel] ?? ''); }, [sel, files]);
  const saveFile = (name: string, content: string) => send({ type: 'setHttpDocroot', node: h.id, files: { ...files, [name]: content } });
  const delFile = (name: string) => { const f = { ...files }; delete f[name]; send({ type: 'setHttpDocroot', node: h.id, files: f }); const rest = Object.keys(f); setSel(rest[0] ?? ''); };
  return (
    <div data-testid="http-form">
      <div className="muted" style={{ marginBottom: 6 }}>Document root ({names.length} files). Start the server with <code>httpd</code> in the terminal. index.html is served for <code>/</code>.</div>
      <div className="row" style={{ marginBottom: 6 }}>{names.map(n => <button key={n} data-testid={`docfile-${n}`} className={sel === n ? 'active' : ''} onClick={() => setSel(n)}>{n}</button>)}
        <input data-testid="docfile-new" placeholder="new file, e.g. about.html" value={newName} onChange={e => setNewName(e.target.value)} style={{ width: 160 }} /><button onClick={() => { if (newName.trim()) { saveFile(newName.trim(), ''); setSel(newName.trim()); setNewName(''); } }}>+ Add</button></div>
      {sel && <><textarea data-testid="docfile-text" value={text} onChange={e => setText(e.target.value)} style={{ width: '100%', height: 220, fontFamily: 'var(--mono)', fontSize: 12 }} />
        <div className="row" style={{ marginTop: 4 }}><button className="primary" data-testid="docfile-save" onClick={() => saveFile(sel, text)}>Save {sel}</button><button className="danger" onClick={() => delFile(sel)}>Delete {sel}</button></div></>}
    </div>
  );
}
function Hosts({ h }: { h: HostState }) {
  const send = useSim(s => s.send); const [text, setText] = useState(Object.entries(h.hosts).map(([n, ip]) => `${u32ToIp(ip)} ${n}`).join('\n'));
  useEffect(() => setText(Object.entries(h.hosts).map(([n, ip]) => `${u32ToIp(ip)} ${n}`).join('\n')), [h.hosts]);
  return (
    <div>
      <div className="muted" style={{ marginBottom: 6 }}>Static name-to-address entries checked before DNS. One per line: <code>10.0.0.5 server.local</code></div>
      <textarea data-testid="hosts-text" value={text} onChange={e => setText(e.target.value)} style={{ width: '100%', height: 160, fontFamily: 'var(--mono)', fontSize: 12 }} />
      <div className="row" style={{ marginTop: 4 }}><button className="primary" data-testid="hosts-save" onClick={() => send({ type: 'setHosts', node: h.id, text })}>Save</button>
        <span className="muted">DNS servers (resolv.conf): {h.dns.join(', ') || 'none'}</span></div>
    </div>
  );
}
