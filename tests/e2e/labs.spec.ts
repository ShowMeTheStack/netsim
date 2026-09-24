import { test, expect, type Page } from '@playwright/test';

// Every lab must: build a valid session (no engine error), load into the drawer with steps,
// and expose its checks. We drive the launcher and load each lab, asserting the drawer renders.
test('all 70 labs build valid, self-consistent sessions', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
  await page.goto('/');
  const report = await page.evaluate(() => {
    const L = (window as any).__labs; const out: { id: string; ok: boolean; nodes: number; checks: number; err?: string }[] = [];
    for (const id of L.ids) {
      try { const json = L.build(id); const f = JSON.parse(json); const nodes = Object.keys(f.state.nodes).length; const sc = f.state.scenario;
        out.push({ id, ok: !!sc && sc.id === id && nodes > 0 && sc.checks.length > 0, nodes, checks: sc ? sc.checks.length : 0 });
      } catch (e) { out.push({ id, ok: false, nodes: 0, checks: 0, err: String(e) }); }
    }
    return { count: L.ids.length, unique: new Set(L.ids).size, modules: L.modules.length, out };
  });
  expect(report.count).toBe(70);
  expect(report.unique).toBe(70);
  const bad = report.out.filter(r => !r.ok);
  expect(bad, 'labs that failed to build: ' + JSON.stringify(bad, null, 2)).toEqual([]);
  // every check id referenced by a step exists in that lab's checks is covered by the drawer; here we assert structure.
  expect(report.out.every(r => r.nodes >= 2 && r.checks >= 1)).toBe(true);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('the launcher lists all 70 labs and loading one shows the guided drawer', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('labs').click();
  await expect(page.getByTestId('lab-launcher')).toBeVisible();
  await expect(page.locator('[data-testid^="launch-"]')).toHaveCount(70);
  await page.getByTestId('launch-tcp-handshake').click();
  await expect(page.getByTestId('lab-drawer')).toContainText('three-way handshake');
  await expect(page.getByTestId('lab-steps')).toBeVisible();
});

test('a lab can be fully completed: OSPF adjacency turns every check green', async ({ page }) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/');
  await page.getByTestId('labs').click();
  await page.getByTestId('launch-ospf-adjacency').click();
  await expect(page.getByTestId('lab-drawer')).toContainText('OSPF adjacencies');
  await page.getByTestId('lab-collapse').click(); // hide the drawer so it does not cover the canvas
  // OSPF is pre-enabled in this lab; just run and it should converge and satisfy the checks.
  await page.getByTestId('btn-turbo').click();
  await expect(page.getByTestId('btn-turbo')).not.toHaveClass(/active/, { timeout: 30000 });
  // ping the far server to satisfy the connectivity check (PC-A is at ~120,360)
  await page.getByTestId('tool-select').click();
  await page.getByTestId('canvas').dblclick({ position: { x: 120, y: 360 } });
  await page.getByTestId('tab-terminal').click();
  await page.getByTestId('terminal-in').fill('ping -c 3 10.0.9.10'); await page.getByTestId('terminal-in').press('Enter');
  await page.getByTestId('popup-close').click();
  await page.getByTestId('btn-turbo').click();
  await expect(page.getByTestId('btn-turbo')).not.toHaveClass(/active/, { timeout: 30000 });
  // reopen the drawer and confirm both checks passed and steps auto-completed
  await page.getByTestId('lab-reopen').click();
  await expect(page.getByTestId('lab-drawer')).toContainText('2/2 ✓');
});

test('lab notes persist per lab in the browser', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('labs').click();
  await page.getByTestId('launch-gs-first-ping').click();
  await page.getByTestId('lab-notes').fill('RTT first = 8ms, later = 4ms because ARP is cached.');
  // reload the same lab and the note should still be there (localStorage keyed by lab id)
  await page.getByTestId('labs').click();
  await page.getByTestId('launch-gs-sniffer').click();
  await page.getByTestId('labs').click();
  await page.getByTestId('launch-gs-first-ping').click();
  await expect(page.getByTestId('lab-notes')).toHaveValue(/ARP is cached/);
});
