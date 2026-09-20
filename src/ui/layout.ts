// Dockable-layout state: pane sizes, per-panel collapse, and the floating lab
// guide's geometry. All persisted to localStorage so the workspace survives reloads.
import { create } from 'zustand';

export type Side = 'left' | 'right' | 'bottom';

// The panels that live in each edge pane, in stacking order. A pane "recedes" to a
// thin rail on its edge when every one of its panels is collapsed.
export const PANE_PANELS: Record<Side, string[]> = {
  left: ['tools', 'devices', 'help'],
  right: ['packets', 'inspector'],
  bottom: ['console'],
};

const DEFAULT_SIZE: Record<Side, number> = { left: 180, right: 520, bottom: 200 };
const MIN_SIZE: Record<Side, number> = { left: 120, right: 260, bottom: 90 };
export const RAIL = 30; // width/height of a receded pane's rail

export type Geo = { x: number; y: number; w: number; h: number } | null;

interface Layout {
  size: Record<Side, number>;
  collapsed: Record<string, boolean>;
  labGeo: Geo;
  setSize: (s: Side, n: number) => void;
  togglePanel: (id: string) => void;
  expandPanel: (id: string) => void;
  setLabGeo: (g: Geo) => void;
}

const KEY = 'netsim.layout.v1';
function load(): Pick<Layout, 'size' | 'collapsed' | 'labGeo'> {
  const base = { size: { ...DEFAULT_SIZE }, collapsed: {} as Record<string, boolean>, labGeo: null as Geo };
  try {
    const raw = localStorage.getItem(KEY); if (!raw) return base;
    const p = JSON.parse(raw);
    return {
      size: { ...DEFAULT_SIZE, ...(p.size || {}) },
      collapsed: { ...(p.collapsed || {}) },
      labGeo: p.labGeo ?? null,
    };
  } catch { return base; }
}
function persist(s: Pick<Layout, 'size' | 'collapsed' | 'labGeo'>) {
  try { localStorage.setItem(KEY, JSON.stringify({ size: s.size, collapsed: s.collapsed, labGeo: s.labGeo })); } catch { /* ignore */ }
}

export const useLayout = create<Layout>((set, get) => ({
  ...load(),
  setSize: (side, n) => {
    const max = (side === 'bottom' ? window.innerHeight : window.innerWidth) - 200;
    const clamped = Math.max(MIN_SIZE[side], Math.min(n, Math.max(MIN_SIZE[side], max)));
    const size = { ...get().size, [side]: clamped }; set({ size }); persist({ ...get(), size });
  },
  togglePanel: (id) => { const collapsed = { ...get().collapsed, [id]: !get().collapsed[id] }; set({ collapsed }); persist({ ...get(), collapsed }); },
  expandPanel: (id) => { const collapsed = { ...get().collapsed, [id]: false }; set({ collapsed }); persist({ ...get(), collapsed }); },
  setLabGeo: (labGeo) => { set({ labGeo }); persist({ ...get(), labGeo }); },
}));

// A pane is receded when all of its panels are collapsed.
export function paneReceded(side: Side, collapsed: Record<string, boolean>): boolean {
  return PANE_PANELS[side].every(id => !!collapsed[id]);
}
