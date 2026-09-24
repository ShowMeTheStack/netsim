import { test, expect, Page } from '@playwright/test';
test.use({ viewport: { width: 1600, height: 900 } });

type Crit = { name?: string; type?: string; kind?: string; forwarding?: boolean };
function collectErrors(page: Page) {
  const errs: string[] = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  return errs;
}
async function launch(page: Page, id: string) {
  await page.getByTestId('labs').click();
  await page.getByTestId('launch-' + id).click();
  await expect(page.getByTestId('lab-drawer')).toBeVisible();
  await page.waitForFunction((wanted) => (window as any).__netsim.get().st?.scenario?.id === wanted, id, { timeout: 8000 });
}
async function enable(page: Page, tid: string) {
  const cb = page.getByTestId(tid);
  if (!(await cb.isChecked())) await cb.click();
  await expect(cb).toBeChecked();
}
async function foldGuide(page: Page) {
  const c = page.getByTestId('lab-collapse');
  if (await c.isVisible().catch(() => false)) await c.click();
}
async function nodePos(page: Page, crit: Crit) {
  return page.evaluate((c) => {
    const st = (window as any).__netsim.get().st; if (!st) return null;
    const n = Object.values(st.nodes).find((x: any) => {
      if (c.name && x.name !== c.name) return false;
      if (c.type && x.type !== c.type) return false;
      if (c.kind && x.kind !== c.kind) return false;
      if (c.forwarding !== undefined && !!x.forwarding !== c.forwarding) return false;
      return true;
    }) as any;
    return n ? { x: n.x, y: n.y, name: n.name } : null;
  }, crit);
}
async function openNode(page: Page, crit: Crit) {
  await foldGuide(page);
  const p = await nodePos(page, crit);
  if (!p) throw new Error('node not found: ' + JSON.stringify(crit));
  await page.getByTestId('canvas').dblclick({ position: { x: p.x, y: p.y } });
  await expect(page.getByTestId('node-popup')).toBeVisible();
  return p;
}
async function linkMid(page: Page) {
  return page.evaluate(() => {
    const st = (window as any).__netsim.get().st; const l = Object.values(st.links)[0] as any; if (!l) return null;
    const a = st.nodes[l.a.node], b = st.nodes[l.b.node];
    return { x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2) };
  });
}

// ---------------------------------------------------------------------------
test('every one of the 70 labs loads, renders nodes, and throws no console errors', async ({ page }) => {
  const errs = collectErrors(page);
  await page.goto('/');
  const ids: string[] = await page.evaluate(() => (window as any).__labs.ids);
  expect(ids.length).toBe(70);
  const bad: any[] = [];
  for (const id of ids) {
    await page.getByTestId('labs').click();
    await page.getByTestId('launch-' + id).click();
    const info = await page.waitForFunction((wanted) => {
      const st = (window as any).__netsim.get().st;
      if (!st || !st.scenario || st.scenario.id !== wanted) return false;
      return { nodes: Object.keys(st.nodes).length, links: Object.keys(st.links).length };
    }, id, { timeout: 8000 }).then(h => h.jsonValue()).catch(() => null);
    if (!info || (info as any).nodes === 0) bad.push({ id, info });
  }
  expect(bad, 'labs that did not load with nodes: ' + JSON.stringify(bad)).toEqual([]);
  expect(errs, 'console errors:\n' + errs.join('\n')).toEqual([]);
});

// ---------------------------------------------------------------------------
test('router popup: every tab and control (config, terminal, routing, nat, services, sockets, arp, routes, stats)', async ({ page }) => {
  const errs = collectErrors(page);
  await page.goto('/');
  await launch(page, 'static-2router');
  await openNode(page, { name: 'R1' });

  // config
  await page.getByTestId('tab-config').click();
  await expect(page.getByTestId('ip-eth0')).toBeVisible();
  await page.getByTestId('gw').fill('10.0.1.1'); await page.getByTestId('gw-apply').click();
  await page.getByTestId('resolv').fill('10.0.1.10'); await page.getByTestId('resolv-apply').click();
  await page.getByTestId('forwarding').click(); await page.getByTestId('forwarding').click();
  await page.getByTestId('tcp-cc').selectOption('cubic');
  await page.getByTestId('tcp-initcwnd').fill('4');

  // terminal
  await page.getByTestId('tab-terminal').click();
  await page.getByTestId('terminal-in').fill('ip addr'); await page.getByTestId('terminal-in').press('Enter');
  await page.getByTestId('terminal-in').fill('ping -c 1 10.0.1.10'); await page.getByTestId('terminal-in').press('Enter');
  await page.getByTestId('btn-turbo').click();
  await expect(page.getByTestId('terminal-out')).toContainText('bytes from 10.0.1.10', { timeout: 15000 });

  // routing: RIP, OSPF, BGP
  await page.getByTestId('tab-routing').click();
  await page.getByTestId('rt-rip').click();
  await enable(page, 'rip-enabled'); await page.getByTestId('rip-networks').fill('10.0.1.0/24'); await page.getByTestId('rip-networks').blur();
  await page.getByTestId('rt-ospf').click();
  await enable(page, 'ospf-enabled'); await page.getByTestId('ospf-networks').fill('10.0.1.0/24'); await page.getByTestId('ospf-networks').blur();
  await page.getByTestId('rt-bgp').click();
  await enable(page, 'bgp-enabled');
  await page.getByTestId('bgp-as').fill('65001'); await page.getByTestId('bgp-routerid').fill('1.1.1.1');
  await page.getByTestId('bgp-networks').fill('10.0.1.0/24');
  await page.getByTestId('bgp-peer-ip').fill('10.0.12.2'); await page.getByTestId('bgp-peer-as').fill('65002');
  await page.getByTestId('bgp-add-neighbor').click();
  await expect(page.getByTestId('bgp-form')).toContainText('65002');

  // nat
  await page.getByTestId('tab-nat').click();
  await enable(page, 'nat-enabled');
  await page.getByTestId('nat-outside').selectOption({ index: 1 }).catch(() => {});
  await page.getByTestId('pf-iip').fill('10.0.1.10'); await page.getByTestId('pf-iport').fill('80'); await page.getByTestId('pf-oport').fill('8080');
  await page.getByTestId('pf-add').click();

  // services: DHCP + DNS zone + HTTP + docroot
  await page.getByTestId('tab-services').click();
  await enable(page, 'dhcp-enabled');
  await page.getByTestId('dhcp-start').fill('10.0.1.100'); await page.getByTestId('dhcp-end').fill('10.0.1.200');
  await page.getByTestId('dhcp-apply').click();
  await page.getByTestId('svc-dns').click();
  await page.getByTestId('zone-origin').fill('lab.'); await page.getByTestId('zone-text').fill('www 3600 A 10.0.1.10'); await page.getByTestId('zone-save').click();

  // sockets, arp, routes, stats
  await page.getByTestId('tab-sockets').click(); await expect(page.getByTestId('sockets-table')).toBeVisible();
  await page.getByTestId('tab-arp').click(); await expect(page.getByTestId('arp-table')).toBeVisible();
  await page.getByTestId('tab-routes').click();
  await page.getByTestId('route-cidr').fill('10.9.9.0/24'); await page.getByTestId('route-gw').fill('10.0.1.10'); await page.getByTestId('route-add').click();
  await expect(page.getByTestId('routes-table')).toContainText('10.9.9.0');
  await page.getByTestId('tab-stats').click();

  expect(errs, 'console errors:\n' + errs.join('\n')).toEqual([]);
});

// ---------------------------------------------------------------------------
test('server/host popup: services start, HTTP waterfall, DNS zone, docroot editing', async ({ page }) => {
  const errs = collectErrors(page);
  await page.goto('/');
  await launch(page, 'http-anatomy');
  await openNode(page, { kind: 'server' });

  // config + terminal (start the web server)
  await page.getByTestId('tab-config').click(); await expect(page.getByTestId('ip-eth0')).toBeVisible();
  await page.getByTestId('tab-terminal').click();
  await page.getByTestId('terminal-in').fill('httpd'); await page.getByTestId('terminal-in').press('Enter');

  // services > HTTP docroot: edit index.html and add a new file
  await page.getByTestId('tab-services').click();
  await page.getByTestId('svc-http').click();
  const idx = page.getByTestId('docfile-index.html');
  if (await idx.isVisible().catch(() => false)) await idx.click();
  await page.getByTestId('docfile-text').fill('<h1>hello netsim</h1>');
  await page.getByTestId('docfile-save').click();
  await page.getByTestId('docfile-new').fill('about.html');
  await page.getByRole('button', { name: '+ Add' }).click();
  await expect(page.getByTestId('docfile-about.html')).toBeVisible();
  await page.getByTestId('docfile-text').fill('<p>about</p>'); await page.getByTestId('docfile-save').click();

  // services > DNS authoritative zone
  await page.getByTestId('svc-dns').click();
  await page.getByTestId('dns-recursion').click();
  await page.getByTestId('zone-origin').fill('example.com'); await page.getByTestId('zone-text').fill('www 3600 A 10.0.0.10'); await page.getByTestId('zone-save').click();

  // services > /etc/hosts
  await page.getByTestId('svc-hosts').click();
  await page.getByTestId('hosts-text').fill('10.0.0.9 srv.local'); await page.getByTestId('hosts-save').click();

  // sockets, http waterfall, arp, routes, stats tabs render
  await page.getByTestId('tab-sockets').click(); await expect(page.getByTestId('sockets-table')).toBeVisible();
  await page.getByTestId('tab-http').click(); await expect(page.getByTestId('http-panel')).toBeVisible();
  await page.getByTestId('tab-arp').click(); await expect(page.getByTestId('arp-table')).toBeVisible();
  await page.getByTestId('tab-routes').click(); await expect(page.getByTestId('routes-table')).toBeVisible();
  await page.getByTestId('tab-stats').click();
  await page.getByTestId('popup-close').click();
  expect(errs, 'console errors:\n' + errs.join('\n')).toEqual([]);
});
// ---------------------------------------------------------------------------
test('switch popup: ports, VLANs (access + trunk), editable script, MAC table, stats', async ({ page }) => {
  const errs = collectErrors(page);
  await page.goto('/');
  await launch(page, 'vlan-access');
  await openNode(page, { type: 'switch' });
  await page.getByTestId('tab-ports').click(); await expect(page.getByTestId('ports-table')).toBeVisible();
  await page.getByTestId('tab-vlans').click();
  await enable(page, 'vlan-enabled');
  await page.getByTestId('vlan-mode-0').selectOption('access');
  await page.getByTestId('vlan-id-0').fill('10'); await page.getByTestId('vlan-id-0').blur();
  await page.getByTestId('vlan-mode-1').selectOption('trunk');
  await page.getByTestId('vlan-trunk-1').fill('10,20'); await page.getByTestId('vlan-trunk-1').blur();
  await page.getByTestId('tab-script').click();
  await enable(page, 'script-enabled');
  await page.getByTestId('script-text').fill('api.learn(api.src, api.inPort); if (api.isBroadcast) api.flood(); else { const p = api.lookup(api.dst); if (p===null) api.flood(); else api.forward(p); }');
  await page.getByTestId('script-save').click();
  await page.getByTestId('script-reset').click();
  await page.getByTestId('tab-mac').click(); await expect(page.getByTestId('mac-table')).toBeVisible();
  await page.getByTestId('tab-stats').click();
  expect(errs, 'console errors:\n' + errs.join('\n')).toEqual([]);
});

// ---------------------------------------------------------------------------
test('access point popup + link popup: wireless config and all link settings/impairments', async ({ page }) => {
  const errs = collectErrors(page);
  await page.goto('/');
  await launch(page, 'wifi-assoc');
  // AP
  await openNode(page, { type: 'ap' });
  await expect(page.getByTestId('ap-form')).toBeVisible();
  await page.getByTestId('ap-ssid').fill('netlab'); await page.getByTestId('ap-ssid').blur();
  await page.getByTestId('ap-channel').fill('11'); await page.getByTestId('ap-channel').blur();
  await page.getByTestId('ap-range').fill('280'); await page.getByTestId('ap-range').blur();
  await page.getByTestId('ap-rtscts').click();
  await page.getByTestId('popup-close').click();
  // Link popup
  const mid = await linkMid(page);
  if (mid) {
    await page.getByTestId('canvas').dblclick({ position: mid });
    await expect(page.getByTestId('link-popup')).toBeVisible();
    await page.getByTestId('link-bw').fill('50'); await page.getByTestId('link-delay').fill('5');
    await page.getByTestId('link-loss').fill('2'); await page.getByTestId('link-apply').click();
    await page.getByTestId('impair-drop').fill('1'); await page.getByTestId('impair-dup').fill('1');
    await page.getByTestId('impair-apply').click();
    await page.getByTestId('link-add-sniffer').click().catch(() => {});
    await page.getByTestId('popup-close').click();
  }
  expect(errs, 'console errors:\n' + errs.join('\n')).toEqual([]);
});
