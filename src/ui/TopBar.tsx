import React, { useRef } from 'react';
import { useSim, pendingWhilePaused } from './store';
import { THEMES } from './themes';


const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 64];
export function TopBar() {
  const st = useSim(s => s.st); const send = useSim(s => s.send); const theme = useSim(s => s.theme); const setTheme = useSim(s => s.setTheme);
  const exportSession = useSim(s => s.exportSession); const importSession = useSim(s => s.importSession); const fileRef = useRef<HTMLInputElement>(null);
  const mode = st?.mode ?? 'paused'; const t = st ? (st.time / 1e6).toFixed(6) : '0.000000';
  const runHint = useSim(pendingWhilePaused);
  return (
    <div className="topbar">
      <span className="brand">NetSim</span>
      <button data-testid={mode === 'play' ? 'btn-pause' : 'btn-play'} className={mode === 'play' ? 'active' : ''} title="Run at speed" onClick={() => send({ type: mode === 'play' ? 'pause' : 'play' })}>{mode === 'play' ? '⏸ Pause' : '▶ Play'}</button>
      <button data-testid="btn-turbo" className={mode === 'turbo' ? 'active' : ''} title="Run as fast as possible until idle or breakpoint" onClick={() => send({ type: mode === 'turbo' ? 'pause' : 'turbo' })}>{mode === 'turbo' ? '⏸ Stop' : '⏩ Turbo'}</button>
      <button data-testid="btn-step-event" title="Advance one event" onClick={() => send({ type: 'stepEvent' })}>⏭ Event</button>
      <button data-testid="btn-step-packet" title="Advance to next packet milestone" onClick={() => send({ type: 'stepPacket' })}>⏭ Packet</button>
      <button data-testid="btn-restart" title="Cold restart: keep topology, reset time to 0" onClick={() => send({ type: 'restart' })}>↺ Restart</button>
      <label className="muted">speed <select data-testid="speed" value={st?.speed ?? 1} onChange={e => send({ type: 'setSpeed', speed: Number(e.target.value) })}>{SPEEDS.map(s => <option key={s} value={s}>{s}×</option>)}</select></label>
      <span className="time" data-testid="sim-time">t = {t} s</span>
      <span className="muted" data-testid="queued">{st?.queued ?? 0} queued</span>
      {runHint && <span className="run-hint" data-testid="run-hint">⏸ paused — press ▶ Play, ⏭ Step or ⏩ Turbo to run</span>}
      <span className="spacer" />
      <button data-testid="labs" onClick={() => useSim.getState().setLabLauncher(true)}>📚 Labs</button>
      <button data-testid="btn-new" onClick={() => { if (confirm('Start a new empty session? Unsaved work is lost.')) send({ type: 'newSession' }); }}>New</button>
      <button data-testid="btn-save" onClick={exportSession}>💾 Save</button>
      <button data-testid="btn-load" onClick={() => fileRef.current?.click()}>📂 Load</button>
      <input ref={fileRef} data-testid="file-input" type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={async e => { const f = e.target.files?.[0]; if (f) importSession(await f.text()); e.target.value = ''; }} />
      <select data-testid="theme" value={theme} onChange={e => setTheme(e.target.value)}>
        <optgroup label="Dark">{THEMES.filter(t => t.dark).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</optgroup>
        <optgroup label="Light">{THEMES.filter(t => !t.dark).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</optgroup>
      </select>
    </div>
  );
}
