import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 1600, height: 900 } });

// Resizable panes: drag a pane's splitter and its width changes.
test('panes are resizable via their splitters', async ({ page }) => {
  await page.goto('/');
  const pane = page.getByTestId('pane-left');
  const before = (await pane.boundingBox())!.width;
  const sp = page.getByTestId('splitter-left'); const box = (await sp.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const after = (await pane.boundingBox())!.width;
  expect(after).toBeGreaterThan(before + 60);
});

// Retractable panels: collapse every panel in a pane and it recedes to a rail;
// clicking a rail tab brings the panel (and the pane) back.
test('retracting all panels makes the pane recede to a rail, and it can be restored', async ({ page }) => {
  await page.goto('/');
  const pane = page.getByTestId('pane-left');
  const full = (await pane.boundingBox())!.width;
  await page.getByTestId('panel-head-tools').click();
  await page.getByTestId('panel-head-devices').click();
  await page.getByTestId('panel-head-help').click();
  await expect(page.getByTestId('rail-tools')).toBeVisible();
  const railed = (await pane.boundingBox())!.width;
  expect(railed).toBeLessThan(50);
  expect(railed).toBeLessThan(full);
  await page.getByTestId('rail-tools').click();
  await expect(page.getByTestId('panel-head-tools')).toBeVisible();
  await expect(page.getByTestId('tool-select')).toBeVisible();
});

// The lab guide floats over the canvas and can be dragged to any position.
test('the lab guide is draggable over the canvas', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('labs').click();
  await page.getByTestId('launch-gs-first-ping').click();
  const drawer = page.getByTestId('lab-drawer');
  await expect(drawer).toBeVisible();
  const start = (await drawer.boundingBox())!;
  const grip = page.getByTestId('lab-drag'); const gb = (await grip.boundingBox())!;
  await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
  await page.mouse.down();
  await page.mouse.move(gb.x + gb.width / 2 - 320, gb.y + 180, { steps: 10 });
  await page.mouse.up();
  const moved = (await drawer.boundingBox())!;
  expect(moved.x).toBeLessThan(start.x - 150);
  expect(moved.y).toBeGreaterThan(start.y + 90);
  // and resizable from the corner
  const rz = page.getByTestId('lab-resize'); const rb = (await rz.boundingBox())!;
  const w0 = moved.width;
  await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
  await page.mouse.down();
  await page.mouse.move(rb.x + 140, rb.y + 40, { steps: 8 });
  await page.mouse.up();
  const resized = (await drawer.boundingBox())!;
  expect(resized.width).toBeGreaterThan(w0 + 80);
});

// Node popups float over the workspace, can be dragged anywhere, and do not dim or
// block the rest of the app (so lab steps stay visible while a popup is open).
test('node popups are draggable and do not block the rest of the app', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('place-laptop').click();
  await page.getByTestId('canvas').click({ position: { x: 400, y: 300 } });
  await page.getByTestId('canvas').dblclick({ position: { x: 400, y: 300 } });
  const popup = page.getByTestId('node-popup');
  await expect(popup).toBeVisible();
  const before = (await popup.boundingBox())!;
  const grip = page.getByTestId('popup-drag'); const gb = (await grip.boundingBox())!;
  await page.mouse.move(gb.x + 20, gb.y + gb.height / 2);
  await page.mouse.down();
  await page.mouse.move(gb.x + 20 - 240, gb.y + gb.height / 2 + 150, { steps: 10 });
  await page.mouse.up();
  const after = (await popup.boundingBox())!;
  expect(Math.abs(after.x - before.x)).toBeGreaterThan(150);
  expect(after.y).toBeGreaterThan(before.y + 90);
  const pe = await page.evaluate(() => getComputedStyle(document.querySelector('.modal-backdrop')!).pointerEvents);
  expect(pe).toBe('none');
});
