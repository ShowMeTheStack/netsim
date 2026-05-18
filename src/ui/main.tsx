import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initWorker, useSim } from './store';
import { ALL_LABS, MODULES } from './labs';
import './styles.css';

initWorker();
// Read-only debug hook for automated tests. Exposes no mutation of engine state.
(window as unknown as { __netsim: unknown }).__netsim = { get: () => useSim.getState() };
// Read-only test hook: the lab catalog and their builders, for automated validation.
(window as unknown as { __labs: unknown }).__labs = { ids: ALL_LABS.map(l => l.id), modules: MODULES.map(m => m.name), build: (id: string) => ALL_LABS.find(l => l.id === id)?.build() };
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
