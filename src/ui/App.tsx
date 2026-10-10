import React, { useEffect } from 'react';
import { useSim } from './store';
import { useLayout, paneReceded, RAIL } from './layout';
import { TopBar } from './TopBar';
import { Palette } from './Palette';
import { CanvasView } from './CanvasView';
import { SnifferPanel } from './SnifferPanel';
import { BottomPanel } from './BottomPanel';
import { NodePopup } from './NodePopup';
import { LinkPopup } from './LinkPopup';
import { LabLauncher } from './LabLauncher';
import { Tour } from './Tour';

export function App() {
  const error = useSim(s => s.error); const toast = useSim(s => s.toast); const dismiss = useSim(s => s.dismissError); const showToast = useSim(s => s.showToast);
  const popupNode = useSim(s => s.popupNode); const popupLink = useSim(s => s.popupLink);
  const size = useLayout(s => s.size); const collapsed = useLayout(s => s.collapsed);
  useEffect(() => { if (toast) { const h = setTimeout(() => showToast(null), 2500); return () => clearTimeout(h); } }, [toast, showToast]);
  const gridStyle = {
    '--col-left': (paneReceded('left', collapsed) ? RAIL : size.left) + 'px',
    '--col-right': (paneReceded('right', collapsed) ? RAIL : size.right) + 'px',
    '--row-bottom': (paneReceded('bottom', collapsed) ? RAIL : size.bottom) + 'px',
  } as React.CSSProperties;
  return (
    <div className="app" style={gridStyle}>
      <TopBar />
      <Palette />
      <CanvasView />
      <SnifferPanel />
      <BottomPanel />
      <LabLauncher />
      <Tour />
      {popupNode !== null && <NodePopup id={popupNode} />}
      {popupLink !== null && <LinkPopup id={popupLink} />}
      {error && <div className="error" data-testid="error" onClick={dismiss}>{error} (click to dismiss)</div>}
      {toast && <div className="toast" data-testid="toast">{toast}</div>}
    </div>
  );
}
