import { test, expect, Page } from '@playwright/test';
test.use({ viewport: { width: 1600, height: 900 } });

async function launch(page: Page, id: string) {
  await page.getByTestId('labs').click();
  await page.getByTestId('launch-' + id).click();
  await expect(page.getByTestId('lab-drawer')).toBeVisible();
  await page.waitForFunction((w) => (window as any).__netsim.get().st?.scenario?.id === w, id, { timeout: 8000 });
}
async function openNode(page: Page, name: string) {
  const c = page.getByTestId('lab-collapse'); if (await c.isVisible().catch(() => false)) await c.click();
  const pos = await page.evaluate((nm) => { const st = (window as any).__netsim.get().st; const n: any = Object.values(st.nodes).find((x: any) => x.name === nm); return n ? { x: n.x, y: n.y } : null; }, name);
  if (!pos) throw new Error('node not found: ' + name);
  await page.getByTestId('canvas').dblclick({ position: pos });
  await expect(page.getByTestId('node-popup')).toBeVisible();
}

test('Code workspace: pick a program, read its C + API, run it on a host', async ({ page }) => {
  const errs: string[] = [];
  page.on('pageerror', e => errs.push('PAGEERROR ' + e.message));

  await page.goto('/');
  await launch(page, 'gs-first-ping');   // has hosts PC-A / PC-B
  await openNode(page, 'PC-A');

  await page.getByTestId('tab-code').click();
  await expect(page.getByTestId('code-tab')).toBeVisible();

  // The default program is the real-clang TCP client (full C); API reference shows side by side,
  // and the opt-in C-compiler download button is offered (clang isn't fetched until used).
  await expect(page.getByTestId('cprog-source')).toContainText('socket(AF_INET, SOCK_STREAM');
  await expect(page.getByTestId('api-ref')).toContainText('recvfrom');
  await expect(page.getByTestId('cprog-enable')).toBeVisible();

  // Use the no-download nsC fallback for the fast interactive compile check.
  await page.getByTestId('cprog-pick').selectOption('tcp-client-nsc');
  await page.getByTestId('cprog-source').fill('int main(void) {\n  int x = ;\n}');
  await page.getByTestId('cprog-run').click();
  await expect(page.getByTestId('cprog-diagnostics')).toContainText('error');
  await expect(page.getByTestId('cprog-proc')).toHaveCount(0);

  // Fix it (reselect) and compile+run: it compiles in-app and a proc appears.
  await page.getByTestId('cprog-pick').selectOption('tcp-client-nsc');
  await page.getByTestId('cprog-run').click();
  await expect(page.getByTestId('cprog-diagnostics')).toContainText('compiled');
  await expect(page.getByTestId('cprog-proc')).toContainText('tcp-client-nsc');

  expect(errs).toEqual([]);
});
