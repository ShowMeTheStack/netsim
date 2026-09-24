import { test, expect } from '@playwright/test';
test.use({ viewport: { width: 1600, height: 900 } });

// A paused command shows the "press run" cue and only completes once you Step/Turbo.
test('ping shows the paused cue and completes after Turbo; the cue then clears', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('labs').click();
  await page.getByTestId('launch-gs-first-ping').click();
  await expect(page.getByTestId('lab-drawer')).toBeVisible();
  await page.getByTestId('canvas').dblclick({ position: { x: 140, y: 300 } });
  await expect(page.getByTestId('node-popup')).toBeVisible();
  await page.getByTestId('tab-terminal').click();
  await page.getByTestId('terminal-in').fill('ping -c 4 192.168.1.20');
  await page.getByTestId('terminal-in').press('Enter');
  // paused: only the PING header, no replies yet, and BOTH cues appear
  await expect(page.getByTestId('terminal-out')).toContainText('PING 192.168.1.20');
  await expect(page.getByTestId('terminal-out')).not.toContainText('bytes from 192.168.1.20');
  await expect(page.getByTestId('run-hint')).toBeVisible();
  await expect(page.getByTestId('term-run-hint')).toBeVisible();
  // run it
  await page.getByTestId('btn-turbo').click();
  await expect(page.getByTestId('terminal-out')).toContainText('bytes from 192.168.1.20', { timeout: 15000 });
  await expect(page.getByTestId('terminal-out')).toContainText('4 received', { timeout: 15000 });
  // once idle, the cue is gone
  await expect(page.getByTestId('run-hint')).toBeHidden();
  await expect(page.getByTestId('term-run-hint')).toBeHidden();
});

// Stepping (not Turbo) also advances a paused command — the intended close-up workflow.
test('stepping advances a paused ping frame by frame', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('labs').click();
  await page.getByTestId('launch-gs-first-ping').click();
  await page.getByTestId('canvas').dblclick({ position: { x: 140, y: 300 } });
  await page.getByTestId('tab-terminal').click();
  await page.getByTestId('terminal-in').fill('ping -c 1 192.168.1.20'); await page.getByTestId('terminal-in').press('Enter');
  await expect(page.getByTestId('run-hint')).toBeVisible();
  // step packets until the reply arrives (bounded)
  for (let i = 0; i < 40 && !(await page.getByTestId('terminal-out').innerText()).includes('bytes from'); i++) {
    await page.getByTestId('btn-step-packet').click();
  }
  await expect(page.getByTestId('terminal-out')).toContainText('bytes from 192.168.1.20');
});

// Consistency: enabling a periodic protocol raises the same cue; Turbo converges it, then clears.
test('OSPF shows the run cue on load and Turbo converges it', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('labs').click();
  await page.getByTestId('launch-ospf-adjacency').click();
  await page.waitForFunction(() => (window as any).__netsim.get().st?.scenario?.id === 'ospf-adjacency');
  // OSPF is running but paused: the cue is up
  await expect(page.getByTestId('run-hint')).toBeVisible();
  await page.getByTestId('btn-turbo').click();
  // adjacency reaches full and routes install
  await expect.poll(() => page.evaluate(() => {
    const st = (window as any).__netsim.get().st;
    return Object.values(st.nodes).some((n: any) => n.routing && Object.values(n.routing.ospf?.neighbors ?? {}).some((nb: any) => nb.state === 'full'));
  }), { timeout: 20000 }).toBe(true);
  // Note: the cue's state after Turbo is phase-dependent for a periodic protocol (a Hello is
  // always within 10s and Turbo stops at an arbitrary point), so we don't assert it here.
});
