// The guided-lab drawer: theory, numbered steps with live check-off, an in-app notes field
// (saved per lab in localStorage), and reflection questions with revealable answers.
// The whole drawer floats over the canvas and is drag-to-move, resize-from-corner, and
// foldable to a compact tab so it never blocks the nodes underneath.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSim } from './store';
import { useLayout } from './layout';
import { ALL_LABS } from './labs';
import type { Lab, LabStep } from './labs/types';

function inline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = []; const re = /(\*\*[^*]+\*\*|`[^`]+`)/g; let last = 0; let m; let k = 0;
  while ((m = re.exec(text))) { if (m.index > last) out.push(text.slice(last, m.index)); const t = m[0]; if (t.startsWith('**')) out.push(<b key={k++}>{t.slice(2, -2)}</b>); else out.push(<code key={k++}>{t.slice(1, -1)}</code>); last = m.index + t.length; }
  if (last < text.length) out.push(text.slice(last)); return out;
}
function loadNotes(id: string): string { try { return localStorage.getItem(`netsim.lab.notes.${id}`) || ''; } catch { return ''; } }
function saveNotes(id: string, v: string) { try { localStorage.setItem(`netsim.lab.notes.${id}`, v); } catch { /* ignore */ } }
function loadDone(id: string): Record<number, boolean> { try { return JSON.parse(localStorage.getItem(`netsim.lab.done.${id}`) || '{}'); } catch { return {}; } }
function saveDone(id: string, v: Record<number, boolean>) { try { localStorage.setItem(`netsim.lab.done.${id}`, JSON.stringify(v)); } catch { /* ignore */ } }

export function LabDrawer() {
  const sc = useSim(s => s.st?.scenario ?? null); const open = useSim(s => s.labOpen); const setOpen = useSim(s => s.setLabOpen);
  const geo = useLayout(s => s.labGeo); const setGeo = useLayout(s => s.setLabGeo);
  const ref = useRef<HTMLDivElement>(null);
  const lab = useMemo<Lab | null>(() => sc?.id ? ALL_LABS.find(l => l.id === sc.id) ?? null : null, [sc?.id]);

  // Pointer-drag helper shared by the move handle and the resize corner. `mode` is
  // 'move' (pan x/y) or 'resize' (grow w/h). Seeds from the live element box so it
  // works even before the drawer has an explicit saved geometry.
  const startDrag = (mode: 'move' | 'resize') => (e: React.MouseEvent) => {
    if (mode === 'move' && (e.target as HTMLElement).closest('button,input,textarea,a')) return;
    e.preventDefault();
    const el = ref.current!; const parent = el.offsetParent as HTMLElement | null;
    const pw = parent?.clientWidth ?? window.innerWidth, ph = parent?.clientHeight ?? window.innerHeight;
    // First time it floats (no saved geometry), shrink from the full-height dock to a
    // movable card so there is room to drag it around and its resize corner stays on-screen.
    const floating = useLayout.getState().labGeo !== null;
    const w0 = floating ? el.offsetWidth : Math.min(el.offsetWidth, Math.round(pw * 0.7));
    const h0 = floating ? el.offsetHeight : Math.min(el.offsetHeight, Math.round(ph * 0.6));
    const start = { x: el.offsetLeft, y: el.offsetTop, w: w0, h: h0 };
    const sx = e.clientX, sy = e.clientY;
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (mode === 'move') {
        const x = Math.max(0, Math.min(start.x + dx, Math.max(0, pw - start.w)));
        const y = Math.max(0, Math.min(start.y + dy, Math.max(0, ph - start.h)));
        setGeo({ x, y, w: start.w, h: start.h });
      } else {
        const w = Math.max(260, Math.min(start.w + dx, pw - start.x)); const h = Math.max(160, Math.min(start.h + dy, ph - start.y));
        setGeo({ x: start.x, y: start.y, w, h });
      }
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); document.body.style.userSelect = ''; };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up); document.body.style.userSelect = 'none';
  };

  if (!sc || !lab) return null;
  const results = sc.results; const pass = (id: string) => results.find(r => r.id === id)?.pass ?? false;
  const passedCount = results.filter(r => r.pass).length; const allDone = results.length > 0 && passedCount === results.length;

  const tabStyle: React.CSSProperties = geo ? { left: geo.x, top: geo.y, right: 'auto' } : {};
  if (!open) return <button data-testid="lab-reopen" className="lab-tab" style={tabStyle} onClick={() => setOpen(true)}>📖 {lab.name} — {passedCount}/{results.length}{allDone ? ' ✓' : ''}</button>;

  const style: React.CSSProperties = geo ? { left: geo.x, top: geo.y, width: geo.w, height: geo.h, bottom: 'auto' } : {};
  return (
    <div className="lab-drawer" data-testid="lab-drawer" ref={ref} style={style}>
      <div className="lab-head" data-testid="lab-drag" onMouseDown={startDrag('move')} style={{ cursor: 'move' }}>
        <span className="lab-grip" title="Drag to move">⋮⋮</span>
        <div style={{ flex: 1 }}><div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.5px' }}>{lab.module} · {lab.difficulty} · ~{lab.minutes} min</div><b style={{ fontSize: 15 }}>{lab.name}</b></div>
        <span className={`badge ${allDone ? 'ok' : ''}`} style={allDone ? { background: 'var(--ok)', color: '#fff' } : {}}>{passedCount}/{results.length}{allDone ? ' ✓' : ''}</span>
        {geo && <button data-testid="lab-dock" title="Reset position" onClick={() => setGeo(null)}>⤢</button>}
        <button data-testid="lab-collapse" title="Fold to a tab" onClick={() => setOpen(false)}>✕</button>
      </div>
      <div className="lab-body">
        <Section title="Objectives"><ul className="lab-ul">{lab.objectives.map((o, i) => <li key={i}>{inline(o)}</li>)}</ul></Section>
        <Section title="Background"><div className="lab-theory">{lab.theory.map((p, i) => <p key={i}>{inline(p)}</p>)}</div></Section>
        <Section title="Steps" defaultOpen><Steps lab={lab} pass={pass} /></Section>
        {lab.questions && lab.questions.length > 0 && <Section title="Check your understanding"><Questions lab={lab} /></Section>}
        <Section title="Your notes" defaultOpen><Notes id={lab.id} steps={lab.steps} /></Section>
        {lab.wrap && <div className="lab-wrap">{allDone ? '✓ ' : ''}{inline(lab.wrap)}</div>}
      </div>
      <div className="lab-resize" data-testid="lab-resize" onMouseDown={startDrag('resize')} title="Drag to resize" />
    </div>
  );
}
function Section({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [o, setO] = useState(defaultOpen);
  return <div className="lab-section"><div className="lab-sec-title" onClick={() => setO(!o)}>{o ? '▾' : '▸'} {title}</div>{o && <div className="lab-sec-body">{children}</div>}</div>;
}
function Steps({ lab, pass }: { lab: Lab; pass: (id: string) => boolean }) {
  const [done, setDone] = useState<Record<number, boolean>>(() => loadDone(lab.id));
  useEffect(() => setDone(loadDone(lab.id)), [lab.id]);
  const toggle = (i: number) => { const d = { ...done, [i]: !done[i] }; setDone(d); saveDone(lab.id, d); };
  return <ol className="lab-steps" data-testid="lab-steps">{lab.steps.map((s, i) => { const auto = s.checkId ? pass(s.checkId) : false; const checked = auto || !!done[i];
    return <li key={i} className={`lab-step ${checked ? 'done' : ''}`} data-testid={`lab-step-${i}`}>
      <label className="lab-step-head"><input type="checkbox" checked={checked} disabled={auto} onChange={() => toggle(i)} data-testid={`lab-step-check-${i}`} /><b>{inline(s.title)}</b>{auto && <span className="badge ok" style={{ background: 'var(--ok)', color: '#fff', marginLeft: 6 }} data-testid={`lab-step-auto-${i}`}>auto ✓</span>}</label>
      <div className="lab-step-body">
        <div>{inline(s.do)}</div>
        {s.set && s.set.length > 0 && <div className="lab-set">{s.set.map((v, k) => <code key={k} className="lab-chip">{v}</code>)}</div>}
        {s.observe && <div className="lab-observe">👁 {inline(s.observe)}</div>}
        {s.note && <div className="lab-note">✎ {inline(s.note)}</div>}
      </div>
    </li>; })}</ol>;
}
function Questions({ lab }: { lab: Lab }) {
  const [show, setShow] = useState<Record<number, boolean>>({});
  return <div>{lab.questions!.map((q, i) => <div key={i} className="lab-q"><div>{i + 1}. {inline(q.q)}</div><button className="lab-reveal" onClick={() => setShow({ ...show, [i]: !show[i] })}>{show[i] ? 'Hide answer' : 'Show answer'}</button>{show[i] && <div className="lab-a">{inline(q.a)}</div>}</div>)}</div>;
}
function Notes({ id, steps }: { id: string; steps: LabStep[] }) {
  const [v, setV] = useState(() => loadNotes(id)); useEffect(() => setV(loadNotes(id)), [id]);
  const prompts = steps.filter(s => s.note).map(s => s.note!);
  const seed = () => { const text = prompts.map((p, i) => `${i + 1}. ${p}\n   → `).join('\n'); setV(v ? v : text); saveNotes(id, v || text); };
  return <div><div className="row" style={{ marginBottom: 4 }}><span className="muted">Saved in your browser for this lab.</span><button data-testid="lab-notes-template" onClick={seed}>Insert note prompts</button></div>
    <textarea data-testid="lab-notes" value={v} onChange={e => { setV(e.target.value); saveNotes(id, e.target.value); }} placeholder="Record your observations and answers here…" style={{ width: '100%', height: 160, fontFamily: 'var(--mono)', fontSize: 12 }} /></div>;
}
