import React, { useEffect, useState } from 'react';
import { useSim } from './store';
import { compileFilter } from '@/filters/filter';
import { useDragOffset } from './useDrag';

export function LinkPopup({ id }: { id: number }) {
  const l = useSim(s => s.st?.links[id]); const nodes = useSim(s => s.st?.nodes ?? {}); const send = useSim(s => s.send); const close = () => useSim.getState().openLink(null); const drag = useDragOffset();
  const [f, setF] = useState({ bw: '100', bwRev: '100', delay: '1', jitter: '0', loss: '0', depth: '200', mtu: '1500' });
  const [im, setIm] = useState({ dir: 'both', dropNext: '0', filter: '', delayNext: '0', delayMs: '500', dupNext: '0', reorderNext: '0', corruptNext: '0' });
  useEffect(() => { if (l) { setF({ bw: String(l.bandwidthBps / 1e6), bwRev: String((l.bandwidthBpsRev || l.bandwidthBps) / 1e6), delay: String(l.delayUs / 1000), jitter: String(l.jitterUs / 1000), loss: String(l.lossPct), depth: String(l.queueDepth), mtu: String(l.mtu) }); setIm({ dir: l.impair.dir, dropNext: String(l.impair.dropNext), filter: l.impair.filter, delayNext: String(l.impair.delayNext), delayMs: String(l.impair.delayUs / 1000), dupNext: String(l.impair.dupNext), reorderNext: String(l.impair.reorderNext), corruptNext: String(l.impair.corruptNext) }); } }, [l?.id]);
  if (!l) return null; const a = nodes[l.a.node], b = nodes[l.b.node];
  const sniffer = Object.values(useSim.getState().st?.sniffers ?? {}).find(s => s.linkId === l.id);
  const apply = () => send({ type: 'setLink', id: l.id, props: { bandwidthBps: Number(f.bw) * 1e6, bandwidthBpsRev: Number(f.bwRev) * 1e6, delayUs: Number(f.delay) * 1000, jitterUs: Number(f.jitter) * 1000, lossPct: Number(f.loss), queueDepth: Number(f.depth), mtu: Number(f.mtu) } });
  const applyIm = () => send({ type: 'setImpair', id: l.id, impair: { dir: im.dir as 'ab' | 'ba' | 'both', dropNext: Number(im.dropNext) || 0, filter: im.filter.trim(), delayNext: Number(im.delayNext) || 0, delayUs: (Number(im.delayMs) || 0) * 1000, dupNext: Number(im.dupNext) || 0, reorderNext: Number(im.reorderNext) || 0, corruptNext: Number(im.corruptNext) || 0 } });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const setI = (k: keyof typeof im) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setIm({ ...im, [k]: e.target.value });
  const filterBad = im.filter.trim() && compileFilter(im.filter) instanceof Error;
  return (
    <div className="modal-backdrop" data-testid="popup-backdrop">
      <div className="modal" data-testid="link-popup" style={{ height: 600, ...drag.style }}>
        <div className="head" data-testid="popup-drag" onMouseDown={drag.onMouseDown}><span className="drag-grip" title="Drag to move">⋮⋮</span><h3>🔗 Link {l.id}: {a?.name} ↔ {b?.name}</h3><span style={{ flex: 1 }} /><button className="danger" onClick={() => { send({ type: 'removeLink', id: l.id }); close(); }}>Delete</button><button data-testid="popup-close" onClick={close}>✕</button></div>
        <div className="tabs" />
        <div className="body">
          <div className="form">
            <label>Bandwidth {a?.name}→{b?.name} (Mbps)</label><input data-testid="link-bw" value={f.bw} onChange={set('bw')} />
            <label>Bandwidth {b?.name}→{a?.name} (Mbps)</label><input data-testid="link-bw-rev" value={f.bwRev} onChange={set('bwRev')} />
            <label>Propagation delay (ms)</label><input data-testid="link-delay" value={f.delay} onChange={set('delay')} />
            <label>Jitter (ms)</label><input data-testid="link-jitter" value={f.jitter} onChange={set('jitter')} />
            <label>Random loss (%)</label><input data-testid="link-loss" value={f.loss} onChange={set('loss')} />
            <label>Queue depth (frames)</label><input data-testid="link-depth" value={f.depth} onChange={set('depth')} />
            <label>Link MTU (bytes)</label><input data-testid="link-mtu" value={f.mtu} onChange={set('mtu')} />
            <label /><div className="row"><button className="primary" data-testid="link-apply" onClick={apply}>Apply</button>
              {sniffer ? <button onClick={() => send({ type: 'removeSniffer', id: sniffer.id })}>Remove sniffer</button> : <button data-testid="link-add-sniffer" onClick={() => send({ type: 'addSniffer', link: l.id })}>🔍 Attach sniffer</button>}</div>
          </div>
          <div className="muted" style={{ marginTop: 10 }}>Stats: {a?.name}→{b?.name} sent {l.stats.abTx}, dropped {l.stats.abDrops} · {b?.name}→{a?.name} sent {l.stats.baTx}, dropped {l.stats.baDrops} · queued now {l.ab.queue.length}/{l.ba.queue.length}</div>
          <h4 style={{ margin: '14px 0 6px' }}>Manual impairments <span className="muted" style={{ fontWeight: 400 }}>(one-shot counters, applied to the next matching frames)</span></h4>
          <div className="form" data-testid="impair-form">
            <label>Direction</label><select data-testid="impair-dir" value={im.dir} onChange={setI('dir')}><option value="both">both</option><option value="ab">{a?.name} → {b?.name}</option><option value="ba">{b?.name} → {a?.name}</option></select>
            <label>Only frames matching</label><input data-testid="impair-filter" placeholder="e.g. tcp.len > 0   or   tcp.flags.ack == 1 and tcp.len == 0" value={im.filter} onChange={setI('filter')} className={filterBad ? 'invalid' : ''} />
            <label>Drop next N</label><input data-testid="impair-drop" value={im.dropNext} onChange={setI('dropNext')} style={{ width: 70 }} />
            <label>Duplicate next N</label><input data-testid="impair-dup" value={im.dupNext} onChange={setI('dupNext')} style={{ width: 70 }} />
            <label>Delay next N by (ms)</label><div className="row"><input data-testid="impair-delay" value={im.delayNext} onChange={setI('delayNext')} style={{ width: 70 }} /><input data-testid="impair-delay-ms" value={im.delayMs} onChange={setI('delayMs')} style={{ width: 80 }} /> ms</div>
            <label>Reorder next N</label><input data-testid="impair-reorder" value={im.reorderNext} onChange={setI('reorderNext')} style={{ width: 70 }} />
            <label>Corrupt next N</label><input data-testid="impair-corrupt" value={im.corruptNext} onChange={setI('corruptNext')} style={{ width: 70 }} />
            <label /><div className="row"><button className="primary" data-testid="impair-apply" disabled={!!filterBad} onClick={applyIm}>Apply impairments</button><span className="muted">remaining: drop {l.impair.dropNext}, dup {l.impair.dupNext}, delay {l.impair.delayNext}, reorder {l.impair.reorderNext}, corrupt {l.impair.corruptNext}</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}
