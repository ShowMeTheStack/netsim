import React, { useState } from 'react';
import { useSim } from './store';

// A small, dismissible welcome tour. Shows once on first run (persisted in localStorage) and can be
// reopened from the top bar. The final step introduces the opt-in C socket-programming feature.
interface Step { art: string; title: string; text: string; list?: string[]; cta?: string }
const STEPS: Step[] = [
  { art: '🖧', title: 'Welcome to NetSim', text: 'Build an IPv4 network on the canvas and watch real protocols run, packet by packet.',
    list: ['Drag devices from the left palette', 'Connect them with the link tool', 'Double-click any device to configure it'] },
  { art: '⏱️', title: 'Drive the clock', text: 'Nothing runs until you say so. The clock is virtual, so you can slow time right down.',
    list: ['▶ Play or ⏩ Turbo to run', 'Step one event, packet, or syscall at a time'] },
  { art: '🔍', title: 'Read the wire', text: 'Add a sniffer to a link, then click any captured frame to see every byte decoded, just like Wireshark. Display filters narrow it down.' },
  { art: '📚', title: 'Guided labs', text: 'Press 📚 Labs for 80+ guided exercises — link layer, routing, transport, DNS, wireless, security, and C socket programming — each with steps and auto-checked goals.' },
  { art: '💻', title: 'Write C socket programs', text: 'Open any host, go to the Code tab, and write real C against the sockets API — compiled to WebAssembly and run on the simulated network. Fully sandboxed: no real ports, nothing leaves your machine.',
    list: ['Real clang: full C — structs, pointers, libc, fork, signals, pthreads, and select / poll / epoll', 'Or the instant "(nsC)" subset — no download', 'The first real-C compile fetches the ~60 MB toolchain once, then it is cached'],
    cta: 'Start building' },
];

export function Tour() {
  const open = useSim(s => s.tourOpen); const setOpen = useSim(s => s.setTourOpen);
  const [i, setI] = useState(0);
  if (!open) return null;
  const step = STEPS[i]!; const last = i === STEPS.length - 1;
  const close = () => { setOpen(false); setI(0); };
  return (
    <div className="modal-backdrop" data-testid="tour-backdrop" style={{ zIndex: 60, background: 'rgba(0,0,0,.35)', pointerEvents: 'auto' }}>
      <div className="modal tour" data-testid="tour" role="dialog">
        <div className="head"><h3 style={{ margin: 0 }}>NetSim</h3><span className="spacer" style={{ flex: 1 }} /><button data-testid="tour-skip" onClick={close}>Skip</button></div>
        <div className="body">
          <div className="tour-art">{step.art}</div>
          <h3 className="tour-title">{step.title}</h3>
          <p className="tour-text">{step.text}</p>
          {step.list && <ul className="tour-list">{step.list.map((li, k) => <li key={k}>{li}</li>)}</ul>}
          <div className="tour-foot">
            <div className="tour-dots">{STEPS.map((_, k) => <span key={k} className={`tour-dot${k === i ? ' on' : ''}`} />)}</div>
            <span className="spacer" style={{ flex: 1 }} />
            {i > 0 && <button data-testid="tour-back" onClick={() => setI(i - 1)}>Back</button>}
            {!last && <button className="primary" data-testid="tour-next" onClick={() => setI(i + 1)}>Next</button>}
            {last && <button className="primary" data-testid="tour-done" onClick={close}>{step.cta ?? 'Done'}</button>}
          </div>
        </div>
      </div>
    </div>
  );
}
