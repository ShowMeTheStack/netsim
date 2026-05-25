import React, { useMemo, useState } from 'react';
import { useSim } from './store';
import { decodeFrame } from '@/engine/codecs/decode';
import { compileFilter, evalFilter } from '@/filters/filter';
import type { CapturedFrame } from '@/engine/types';
import type { DecodedFrame, Field, Layer } from '@/engine/codecs/types';
import { PhysicalView } from './PhysicalView';
import { Pane, type PanelDef } from './Dock';

const decodeCache = new WeakMap<Uint8Array, DecodedFrame>();
export function decodeCached(b: Uint8Array): DecodedFrame { let d = decodeCache.get(b); if (!d) { d = decodeFrame(b); decodeCache.set(b, d); } return d; }
const EMPTY: CapturedFrame[] = [];

export function SnifferPanel() {
  const sniffers = useSim(s => s.st?.sniffers ?? {}); const links = useSim(s => s.st?.links ?? {}); const nodes = useSim(s => s.st?.nodes ?? {});
  const monitors = useSim(s => s.st?.rf.monitors ?? {}); const activeAir = useSim(s => s.activeAir); const setActiveAir = useSim(s => s.setActiveAir);
  const active = useSim(s => s.activeSniffer); const setActive = useSim(s => s.setActiveSniffer); const send = useSim(s => s.send);
  const frames = useSim(s => (active !== null ? s.captures[active] : undefined) ?? EMPTY);
  const filterText = useSim(s => (active !== null ? s.displayFilters[active] : '') ?? ''); const setFilter = useSim(s => s.setDisplayFilter);
  const selected = useSim(s => s.selectedFrame); const selectFrame = useSim(s => s.selectFrame);
  const [airSel, setAirSel] = useState<number | null>(null); const [hideBeacons, setHideBeacons] = useState(true);

  const ast = useMemo(() => compileFilter(filterText), [filterText]);
  const shown = useMemo(() => { if (ast instanceof Error || !ast) return frames; return frames.filter(f => evalFilter(ast, decodeCached(f.bytes))); }, [frames, ast]);
  const sel = selected && selected.sid === active ? frames.find(f => f.n === selected.n) : undefined;
  const label = (sid: number) => { const s = sniffers[sid]; const l = s ? links[s.linkId] : undefined; if (!l) return `sniffer ${sid}`; return `${nodes[l.a.node]?.name ?? '?'} ↔ ${nodes[l.b.node]?.name ?? '?'}`; };
  const air = activeAir !== null ? monitors[activeAir] : undefined;
  const airShown = air ? air.frames.filter(f => !hideBeacons || f.kind !== 'beacon') : [];
  const airSelFrame = air ? air.frames.find(f => f.n === airSel) : undefined;

  const header = (
    <div className="pane-header">
      <div className="sniffer-tabs">
        <b>Sniffers</b>
        {Object.values(sniffers).map(s => <button key={s.id} data-testid={`sniffer-tab-${s.id}`} className={active === s.id ? 'active' : ''} onClick={() => setActive(s.id)}>🔍 {label(s.id)} <span className="badge">{s.total}</span></button>)}
        {Object.values(monitors).map(m => <button key={`air${m.id}`} data-testid={`air-tab-${m.id}`} className={activeAir === m.id ? 'active' : ''} onClick={() => setActiveAir(m.id)}>📡 air ch{m.channel} <span className="badge">{m.total}</span></button>)}
        {!Object.keys(sniffers).length && !Object.keys(monitors).length && <span className="muted">none — sniff a link, or add an air monitor →</span>}
        <button data-testid="add-air" onClick={() => send({ type: 'addAirMonitor', channel: 6 })}>+ Air monitor</button>
        {active !== null && <><button onClick={() => send({ type: 'clearCapture', id: active })}>Clear</button><button className="danger" onClick={() => send({ type: 'removeSniffer', id: active })}>Remove</button></>}
        {activeAir !== null && <button className="danger" onClick={() => { send({ type: 'removeAirMonitor', id: activeAir }); setActiveAir(null); }}>Remove air</button>}
      </div>
      {activeAir === null ?
        <div className="row" style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>
          <input data-testid="display-filter" style={{ flex: 1, fontFamily: 'var(--mono)' }} placeholder="display filter, e.g. icmp or arp.opcode == 2 or ipv4.addr == 10.0.0.0/24" value={filterText} onChange={e => active !== null && setFilter(active, e.target.value)} className={ast instanceof Error ? 'invalid' : ''} disabled={active === null} />
          <span className="muted" data-testid="pk-count">{shown.length}/{frames.length}</span>
        </div> :
        <div className="row" style={{ padding: '4px 8px', borderBottom: '1px solid var(--border)' }}>
          <label className="row"><input type="checkbox" data-testid="air-hide-beacons" checked={hideBeacons} onChange={e => setHideBeacons(e.target.checked)} /> hide beacons</label>
          <span className="muted">{airShown.length} shown / {air?.total ?? 0} total</span>
        </div>}
    </div>
  );

  const packets = activeAir !== null ? (
    <div className="panel-body" style={{ padding: 0 }}>
      <table className="pk" data-testid="air-list"><thead><tr><th>No.</th><th>Time</th><th>Transmitter</th><th>Type</th><th>Len</th><th>Info</th></tr></thead>
        <tbody>{airShown.slice(-1500).map(f => { const d = decodeCached(f.bytes); return <tr key={f.n} data-testid="air-row" className={`${f.collision ? 'dropped' : ''} ${airSel === f.n ? 'sel' : ''}`} onClick={() => setAirSel(f.n)}><td>{f.n}</td><td>{(f.t / 1e6).toFixed(6)}</td><td>{nodes[f.from]?.name ?? f.from}</td><td>{f.kind.toUpperCase()}{f.collision ? ' ✻collision' : ''}</td><td>{d.length}</td><td>{f.kind === 'data' ? d.info : f.kind}</td></tr>; })}</tbody></table>
    </div>
  ) : (
    <div className="panel-body" style={{ padding: 0 }}>
      <table className="pk" data-testid="packet-list"><thead><tr><th>No.</th><th>Time</th><th>Source</th><th>Destination</th><th>Proto</th><th>Len</th><th>Info</th></tr></thead>
        <tbody>{shown.slice(-2000).map(f => { const d = decodeCached(f.bytes); return <tr key={f.n} data-testid="pk-row" className={`proto-${d.proto} ${sel?.n === f.n ? 'sel' : ''} ${f.drop ? 'dropped' : ''}`} onClick={() => selectFrame({ sid: active!, n: f.n })}><td>{f.n}</td><td>{(f.t / 1e6).toFixed(6)}</td><td>{d.src}</td><td>{d.dst}</td><td>{d.proto}</td><td>{d.length}</td><td>{f.drop ? `[${f.drop}] ` : ''}{d.info}</td></tr>; })}</tbody></table>
    </div>
  );

  const inspector = activeAir !== null ?
    <div className="panel-body">{airSelFrame ? <PacketDetails f={{ n: airSelFrame.n, t: airSelFrame.t, dir: 'ab', bytes: airSelFrame.bytes, from: airSelFrame.from, to: airSelFrame.from, frameId: airSelFrame.n }} /> : <div className="muted">Select an air frame to inspect it. Collisions are highlighted.</div>}</div> :
    <div className="panel-body">{sel ? <PacketDetails f={sel} /> : <div className="muted">Select a packet to inspect its layers and bytes.</div>}</div>;

  const panels: PanelDef[] = [
    { id: 'packets', title: 'Packets', grow: true, node: packets },
    { id: 'inspector', title: 'Inspector', node: inspector },
  ];
  return <Pane side="right" className="right" header={header} panels={panels} />;
}

function PacketDetails({ f }: { f: CapturedFrame }) {
  const d = decodeCached(f.bytes); const hover = useSim(s => s.hoverRange); const setHover = useSim(s => s.setHoverRange);
  const nodes = useSim(s => s.st?.nodes ?? {});
  return (
    <div data-testid="packet-details">
      <div className="details">
        <div className="layer l-frame"><div className="hdr">Frame {f.n}: {d.length} bytes on wire, {nodes[f.from]?.name ?? f.from} → {nodes[f.to]?.name ?? f.to} at t={(f.t / 1e6).toFixed(6)}s{f.drop ? ` — DROPPED: ${f.drop}` : ''}</div></div>
        {d.layers.map((l, i) => <LayerView key={i} l={l} setHover={setHover} />)}
      </div>
      <HexDump b={f.bytes} hl={hover} />
      <PhysToggle bytes={f.bytes} />
    </div>
  );
}
function PhysToggle({ bytes }: { bytes: Uint8Array }) {
  const [open, setOpen] = useState(false);
  return <div style={{ marginTop: 6 }}><button data-testid="phys-toggle" onClick={() => setOpen(!open)}>{open ? '▾' : '▸'} Physical layer (signal encoding)</button>{open && <PhysicalView bytes={bytes} />}</div>;
}
function LayerView({ l, setHover }: { l: Layer; setHover: (r: { start: number; end: number } | null) => void }) {
  const [open, setOpen] = useState(true);
  return <div className={`layer l-${l.proto}`} data-testid={`layer-${l.proto}`}><div className="hdr" onClick={() => setOpen(!open)} onMouseEnter={() => setHover({ start: l.start, end: l.end })} onMouseLeave={() => setHover(null)}>{open ? '▾' : '▸'} {l.name}: {l.summary}</div>
    {open && l.fields.map((x, i) => <FieldView key={i} x={x} setHover={setHover} />)}{open && l.warnings.map((w, i) => <div key={i} className="field warn">⚠ {w}</div>)}</div>;
}
function FieldView({ x, setHover, depth = 0 }: { x: Field; setHover: (r: { start: number; end: number } | null) => void; depth?: number }) {
  return <><div className="field" style={{ paddingLeft: 14 + depth * 14 }} onMouseEnter={() => setHover({ start: x.start, end: x.end })} onMouseLeave={() => setHover(null)}><span className="k">{x.name}:</span> {x.display ?? String(x.value)}</div>{x.children?.map((c, i) => <FieldView key={i} x={c} setHover={setHover} depth={depth + 1} />)}</>;
}
function HexDump({ b, hl }: { b: Uint8Array; hl: { start: number; end: number } | null }) {
  const rows: React.ReactNode[] = [];
  for (let off = 0; off < b.length; off += 16) {
    const cells: React.ReactNode[] = []; const ascii: React.ReactNode[] = [];
    for (let i = off; i < Math.min(off + 16, b.length); i++) { const inHl = hl && i >= hl.start && i < hl.end; const h = b[i]!.toString(16).padStart(2, '0'); const c = b[i]! >= 32 && b[i]! < 127 ? String.fromCharCode(b[i]!) : '.'; cells.push(<span key={i} className={inHl ? 'hl' : ''}>{h}</span>, i - off === 7 ? '  ' : ' '); ascii.push(<span key={i} className={inHl ? 'hl' : ''}>{c}</span>); }
    rows.push(<div key={off}><span className="off">{off.toString(16).padStart(4, '0')}</span>  {cells}{' '.repeat(Math.max(0, (16 - (Math.min(off + 16, b.length) - off)) * 3))} {ascii}</div>);
  }
  return <div className="hex" data-testid="hexdump" style={{ marginTop: 8 }}>{rows}</div>;
}
