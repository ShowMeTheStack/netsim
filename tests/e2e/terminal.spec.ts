import { test, expect, Page } from '@playwright/test';
test.use({ viewport: { width: 1600, height: 900 } });

function collectErrors(page: Page) {
  const errs: string[] = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  return errs;
}
async function launch(page: Page, id: string) {
  await page.getByTestId('labs').click();
  await page.getByTestId('launch-' + id).click();
  await page.waitForFunction((w) => (window as any).__netsim.get().st?.scenario?.id === w, id, { timeout: 8000 });
  const c = page.getByTestId('lab-collapse');
  if (await c.isVisible().catch(() => false)) await c.click();
}
async function openNode(page: Page, crit: any) {
  const p = await page.evaluate((c) => {
    const st = (window as any).__netsim.get().st;
    const n = Object.values(st.nodes).find((x: any) => (!c.name || x.name === c.name) && (!c.type || x.type === c.type) && (!c.kind || x.kind === c.kind)) as any;
    return n ? { x: n.x, y: n.y } : null;
  }, crit);
  if (!p) throw new Error('node not found ' + JSON.stringify(crit));
  await page.getByTestId('canvas').dblclick({ position: p });
  await expect(page.getByTestId('node-popup')).toBeVisible();
}
async function term(page: Page, line: string) { await page.getByTestId('terminal-in').fill(line); await page.getByTestId('terminal-in').press('Enter'); }

test('terminal: informational + network commands all run and produce output', async ({ page }) => {
  const errs = collectErrors(page);
  await page.goto('/');
  await launch(page, 'http-anatomy');
  // start the web server on WebSrv
  await openNode(page, { name: 'WebSrv' });
  await page.getByTestId('tab-terminal').click();
  await term(page, 'httpd');
  await page.getByTestId('popup-close').click();
  // drive the Client
  await openNode(page, { name: 'Client' });
  await page.getByTestId('tab-terminal').click();
  const info = ['help', 'hostname', 'ifconfig', 'ip addr', 'ip route', 'route', 'arp -n', 'netstat', 'ss', 'ps', 'sysctl net.ipv4.ip_forward'];
  for (const c of info) await term(page, c);
  const out1 = await page.getByTestId('terminal-out').innerText();
  expect(out1, 'help must list ping').toContain('ping');
  expect(out1).toContain('eth0');
  expect(out1.toLowerCase()).not.toContain('command not found');
  expect(out1.toLowerCase()).not.toContain('not a function');
  // network commands, each followed by Turbo
  await term(page, 'ping -c 2 10.0.0.80'); await page.getByTestId('btn-turbo').click();
  await expect(page.getByTestId('terminal-out')).toContainText('bytes from 10.0.0.80', { timeout: 15000 });
  await term(page, 'traceroute 10.0.0.80'); await page.getByTestId('btn-turbo').click();
  await expect(page.getByTestId('terminal-out')).toContainText('10.0.0.80', { timeout: 15000 });
  await term(page, 'curl http://10.0.0.80/'); await page.getByTestId('btn-turbo').click();
  await expect(page.getByTestId('terminal-out')).toContainText(/200 OK|hello|<h/i, { timeout: 15000 });
  await term(page, 'nc -z 10.0.0.80 80'); await page.getByTestId('btn-turbo').click();
  await expect(page.getByTestId('terminal-out')).toContainText(/succeeded|open|connect/i, { timeout: 15000 });
  const out2 = (await page.getByTestId('terminal-out').innerText()).toLowerCase();
  expect(out2).not.toContain('command not found');
  expect(errs, errs.join('\n')).toEqual([]);
});

test('terminal: dig resolves a name against a DNS server', async ({ page }) => {
  const errs = collectErrors(page);
  await page.goto('/');
  await launch(page, 'dns-recursive');
  const drivers = await page.evaluate(() => {
    const st = (window as any).__netsim.get().st;
    return Object.values(st.nodes).filter((n: any) => n.kind === 'laptop' || n.kind === 'desktop').map((n: any) => n.name);
  });
  expect(drivers.length).toBeGreaterThan(0);
  await openNode(page, { name: drivers[0] });
  await page.getByTestId('tab-terminal').click();
  await term(page, 'dig www.example.com'); await page.getByTestId('btn-turbo').click();
  await expect(page.getByTestId('terminal-out')).toContainText(/ANSWER|A\s+\d+\.\d+\.\d+\.\d+|\d+\.\d+\.\d+\.\d+/i, { timeout: 15000 });
  expect(errs, errs.join('\n')).toEqual([]);
});

test('topbar + palette + session: place all devices, connect, sniff, save, theme, restart, new', async ({ page }) => {
  const errs = collectErrors(page);
  page.on('dialog', d => d.accept());
  await page.goto('/');
  const places = ['place-laptop', 'place-desktop', 'place-iot', 'place-server', 'place-switch', 'place-router', 'place-ap'];
  let x = 120;
  for (const p of places) { await page.getByTestId(p).click(); await page.getByTestId('canvas').click({ position: { x, y: 200 } }); x += 110; }
  await expect.poll(() => page.evaluate(() => Object.keys((window as any).__netsim.get().st.nodes).length)).toBe(7);
  // connect laptop(120,200) to switch(480,200)
  await page.getByTestId('tool-connect').click();
  await page.getByTestId('canvas').click({ position: { x: 120, y: 200 } });
  await page.getByTestId('canvas').click({ position: { x: 560, y: 200 } });
  await expect.poll(() => page.evaluate(() => Object.keys((window as any).__netsim.get().st.links).length)).toBeGreaterThan(0);
  // sniff that link
  await page.getByTestId('tool-sniff').click();
  await page.getByTestId('canvas').click({ position: { x: 200, y: 200 } });
  await expect.poll(() => page.evaluate(() => Object.keys((window as any).__netsim.get().st.sniffers).length)).toBeGreaterThan(0);
  // theme switch
  await page.getByTestId('theme').selectOption({ index: 3 });
  // step controls
  await page.getByTestId('btn-step-event').click();
  await page.getByTestId('btn-step-packet').click();
  await page.getByTestId('btn-restart').click();
  // save -> toast
  await page.getByTestId('btn-save').click();
  await expect(page.getByTestId('toast')).toBeVisible({ timeout: 8000 });
  // new -> clears (dialog auto-accepted)
  await page.getByTestId('btn-new').click();
  await expect.poll(() => page.evaluate(() => Object.keys((window as any).__netsim.get().st.nodes).length)).toBe(0);
  expect(errs, errs.join('\n')).toEqual([]);
});
