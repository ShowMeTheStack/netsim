import { test, expect, Page } from '@playwright/test';
test.use({ viewport: { width: 1600, height: 900 } });

// Heavy end-to-end proof: a full-C program is compiled by REAL clang IN THE BROWSER (the opt-in
// toolchain is downloaded from the same-origin /csys/ served out of dist) and run on the sim. Slow
// (loads ~75MB + runs clang + binaryen in a headless worker), so it gets a generous timeout and
// runs as its own spec. Requires public/csys/ to be present at build time (tools/fetch-csys.sh).
async function launch(page: Page, id: string) {
  await page.getByTestId('labs').click();
  await page.getByTestId('launch-' + id).click();
  await page.waitForFunction((w) => (window as any).__netsim.get().st?.scenario?.id === w, id, { timeout: 8000 });
}
async function openNode(page: Page, name: string) {
  const c = page.getByTestId('lab-collapse'); if (await c.isVisible().catch(() => false)) await c.click();
  const pos = await page.evaluate((nm) => { const st = (window as any).__netsim.get().st; const n: any = Object.values(st.nodes).find((x: any) => x.name === nm); return n ? { x: n.x, y: n.y } : null; }, name);
  if (!pos) throw new Error('node not found: ' + name);
  await page.getByTestId('canvas').dblclick({ position: pos });
  await expect(page.getByTestId('node-popup')).toBeVisible();
}

test('real clang compiles a full-C program in the browser and it runs on the sim', async ({ page }) => {
  test.setTimeout(240000);
  // Skip gracefully if the toolchain was not built into dist.
  const res = await page.request.get('/csys/clang.wasm').catch(() => null);
  test.skip(!res || !res.ok(), 'C toolchain not served (run tools/fetch-csys.sh before building)');

  await page.goto('/');
  await launch(page, 'gs-first-ping');            // PC-A 192.168.1.10, PC-B 192.168.1.20

  // Server: run the reference echo server on PC-A via its terminal (instant, no toolchain).
  await openNode(page, 'PC-A');
  await page.getByTestId('tab-terminal').click();
  await page.getByTestId('terminal-in').fill('crun echo-server 7');
  await page.getByTestId('terminal-in').press('Enter');
  await page.getByTestId('popup-close').click();

  // Client: compile the real-clang TCP echo client on PC-B, pointed at the server.
  await openNode(page, 'PC-B');
  await page.getByTestId('tab-code').click();
  await page.getByTestId('cprog-pick').selectOption('echo-client');
  await page.getByTestId('cprog-args').fill('192.168.1.10 7 greetings');
  await page.getByTestId('cprog-enable').click();                 // download the ~60MB toolchain
  await expect(page.getByTestId('cprog-enable')).toBeHidden({ timeout: 180000 });  // 'ready'
  await page.getByTestId('cprog-run').click();                    // real clang compiles in-browser
  await expect(page.getByTestId('cprog-diagnostics')).toContainText('compiled', { timeout: 180000 });

  // Drive it: connect() does the real handshake, recv() gets the echo. The client prints to the
  // host terminal (persists after the program exits), so assert there.
  await page.getByTestId('btn-turbo').click();
  await page.getByTestId('tab-terminal').click();
  await expect(page.getByTestId('terminal-out')).toContainText('connected to 192.168.1.10:7', { timeout: 30000 });
  await expect(page.getByTestId('terminal-out')).toContainText('reply: greetings');

  // Same page, toolchain already cached: the pthreads demo compiles and runs multi-threaded C too
  // (#include <pthread.h>, pthread_create/join, a mutex-guarded counter).
  await page.getByTestId('tab-code').click();
  await page.getByTestId('cprog-pick').selectOption('threads-demo');
  await page.getByTestId('cprog-run').click();
  await expect(page.getByTestId('cprog-diagnostics')).toContainText('compiled', { timeout: 60000 });
  await page.getByTestId('btn-turbo').click();
  await page.getByTestId('tab-terminal').click();
  await expect(page.getByTestId('terminal-out')).toContainText('joined: counter=6', { timeout: 30000 });
});
