import React, { useEffect, useMemo, useState } from 'react';
import { useSim } from './store';
import { u32ToIp } from '@/shared/bytes';
import { CPROGRAMS, C_API } from '@/shared/cprograms';
import type { CProc, HostState, Socket } from '@/engine/types';

// The Code workspace: edit a C socket program, compile it, run it on this host, and watch its
// output and socket state live. Run sends the source to the worker's compile() boundary, which
// returns either a running program or clang-shaped diagnostics (today a STUB: structural checks,
// then the reference build for the chosen program; the full in-browser C compiler swaps in behind
// the same boundary). Program output, fds and blocked state stream back inside node state.
export function CodeTab({ h }: { h: HostState }) {
  const [progName, setProgName] = useState(CPROGRAMS[0]!.name);
  const prog = CPROGRAMS.find(p => p.name === progName)!;
  const [args, setArgs] = useState(prog.defaultArgs);
  const [src, setSrc] = useState(prog.source);
  const [selPid, setSelPid] = useState<number | null>(null);
  const result = useSim(s => s.compileResults[h.id]);
  const clangStatus = useSim(s => s.clangStatus); const enableClang = useSim(s => s.enableClang);
  const [compiling, setCompiling] = useState(false);
  useEffect(() => { setCompiling(false); }, [result?.at]);

  const cprocs = useMemo(() => Object.values(h.procs).filter((p): p is CProc => p.kind === 'cprog'), [h.procs]);
  const sel = cprocs.find(p => p.pid === selPid) ?? cprocs[cprocs.length - 1] ?? null;
  useEffect(() => { if (result?.ok && result.pid !== undefined) setSelPid(result.pid); }, [result?.at]);

  const pick = (name: string) => { const p = CPROGRAMS.find(x => x.name === name)!; setProgName(name); setArgs(p.defaultArgs); setSrc(p.source); };
  const run = () => { if (prog.backend === 'clang') setCompiling(true); useSim.getState().compileRun(h.id, progName, src, args.split(/\s+/).filter(Boolean), prog.backend); };
  const stop = (pid: number) => useSim.getState().send({ type: 'runCmd', node: h.id, line: `kill ${pid}` });

  const groups = useMemo(() => {
    const m = new Map<string, typeof C_API>();
    for (const e of C_API) { (m.get(e.group) ?? m.set(e.group, []).get(e.group)!).push(e); }
    return [...m.entries()];
  }, []);

  return (
    <div className="code" data-testid="code-tab">
      <div className="code-controls">
        <label>program</label>
        <select data-testid="cprog-pick" value={progName} onChange={e => pick(e.target.value)}>
          {CPROGRAMS.map(p => <option key={p.name} value={p.name}>{p.title}</option>)}
        </select>
        <input data-testid="cprog-args" value={args} onChange={e => setArgs(e.target.value)} placeholder="args" style={{ width: 150 }} />
        {prog.backend === 'clang' && clangStatus !== 'ready' && <button data-testid="cprog-enable" onClick={enableClang} disabled={clangStatus === 'downloading'}>{clangStatus === 'downloading' ? '⬇ Downloading…' : clangStatus === 'error' ? '⚠ Retry download' : '⬇ Download C compiler'}</button>}
        <button className="primary" data-testid="cprog-run" onClick={run} disabled={compiling}>{compiling ? '⚙ Compiling…' : '⚙ Compile & Run'}</button>
      </div>
      <div className="code-blurb">
        {prog.blurb}.{' '}
        {prog.backend === 'clang'
          ? 'Real in-browser clang: full C (structs, pointers, libc). The first compile downloads the ~60 MB toolchain once (cached after); everything runs sandboxed, no real network.'
          : 'nsC fallback: a small C subset compiled in-app instantly, no download (no structs/pointers yet).'}{' '}
        Press ⚙ Compile &amp; Run, then ▶ / Step / Turbo.
      </div>

      <div className="code-editor">
        <textarea data-testid="cprog-source" value={src} onChange={e => setSrc(e.target.value)} spellCheck={false} />
        <div className="api-ref" data-testid="api-ref">
          {groups.map(([group, entries]) => (
            <div key={group}>
              <div className="api-group">{group}</div>
              {entries.map(e => (
                <div key={e.name} className="api-entry">
                  <code>{e.name}</code>
                  <div className="api-sig">{e.sig}</div>
                  <div className="api-desc">{e.desc}</div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      {result && (result.ok
        ? <div data-testid="cprog-diagnostics" className="code-diag ok">compiled ✓ — running {progName}{result.pid !== undefined ? `, pid ${result.pid}` : ''}</div>
        : <div data-testid="cprog-diagnostics" className="code-diag">
            {result.diagnostics.map((d, i) => <div key={i} className="danger">{d.severity}: line {d.line}:{d.col}: {d.message}</div>)}
          </div>)}

      <div className="row">
        <label style={{ color: 'var(--fg2)' }}>running</label>
        {cprocs.length === 0 && <span className="muted">none yet</span>}
        {cprocs.map(p => (
          <span key={p.pid} className="badge" data-testid="cprog-proc" onClick={() => setSelPid(p.pid)}
            style={{ cursor: 'pointer', outline: sel?.pid === p.pid ? '2px solid var(--accent)' : undefined }}>
            {p.pid} {p.name}{p.blocked ? ` · ${p.blocked.syscall}` : ''}
            <button className="danger" data-testid="cprog-stop" style={{ marginLeft: 6 }} onClick={ev => { ev.stopPropagation(); stop(p.pid); }}>✕</button>
          </span>
        ))}
      </div>

      <pre className="code-console" data-testid="cprog-console">
        {sel ? (sel.stdout.length ? sel.stdout.join('\n') : '(no output yet — press Play / Step / Turbo)') : '(no program selected)'}
      </pre>

      {sel && <Inspector h={h} p={sel} />}
    </div>
  );
}

// Shows why a program is where it is: its open fds mapped to live socket state, and what it blocks on.
function Inspector({ h, p }: { h: HostState; p: CProc }) {
  const fds = Object.entries(p.fds).map(([fd, id]) => ({ fd: Number(fd), sock: h.sockets[id as number] as Socket | undefined }));
  return (
    <div data-testid="cprog-inspector" style={{ marginTop: 8 }}>
      <label>inspector — pid {p.pid} {p.done ? '(exited)' : p.blocked ? `blocked in ${p.blocked.syscall}()` : 'runnable'}</label>
      <table className="simple"><thead><tr><th>fd</th><th>proto</th><th>local</th><th>remote / state</th></tr></thead>
        <tbody>
          {fds.length === 0 && <tr><td colSpan={4} className="muted">no open descriptors</td></tr>}
          {fds.map(({ fd, sock }) => (
            <tr key={fd}>
              <td>{fd}</td>
              <td>{sock ? sock.proto : '—'}</td>
              <td>{sock ? `${sock.localIp === null ? '0.0.0.0' : u32ToIp(sock.localIp)}:${sock.localPort}` : '—'}</td>
              <td>{sock ? (sock.proto === 'tcp' ? `${sock.remoteIp === null ? '*:*' : `${u32ToIp(sock.remoteIp)}:${sock.remotePort}`} · ${sock.state}` : 'datagram') : 'closed'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
