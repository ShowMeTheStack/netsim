import { E, ip, m, scene, type Lab } from './helpers';
import type { EngineState, ScenarioCheck } from '@/engine/types';
const MOD = 'HTTP';
function web(docHtml: string, extra: Record<string, string> = {}) { return (st: EngineState) => {
  const c = E.addHost(st, 'laptop', 180, 300, 'Client'); const sw = E.addSwitch(st, 380, 180, 8, 'Switch1'); const s = E.addHost(st, 'server', 580, 300, 'WebSrv');
  const l1 = E.connect(st, c.id, 0, sw.id, 0, { delayUs: 8000 })!; E.connect(st, s.id, 0, sw.id, 1, { delayUs: 8000 });
  E.setIfaceIp(st, c, 'eth0', ip('10.0.0.2'), m(24)); E.setIfaceIp(st, s, 'eth0', ip('10.0.0.80'), m(24));
  s.httpDocroot = { 'index.html': docHtml, ...extra };
  E.addSniffer(st, l1);
}; }
export const HTTP_LABS: Lab[] = [
  { id: 'http-anatomy', module: MOD, name: 'Anatomy of an HTTP request', difficulty: 'core', minutes: 14,
    objectives: ['See the request line, headers and response', 'Read status codes including 404'],
    theory: ['**HTTP** is a text protocol over TCP. A request has a **method** (GET, HEAD, POST…), a **target** path, and **headers**. The response has a **status code** (200 OK, 404 Not Found…), headers, and a body. It rides on a TCP connection, so a handshake precedes it.'],
    build: () => scene('http-anatomy', 'Anatomy of an HTTP request', 'Fetch a page and a missing page; read the requests and responses.', [{ id: 'ok', label: 'Client received 200 OK', kind: 'terminalContains', node: 'Client', text: '200 OK' }, { id: 'nf', label: 'Client received 404 Not Found', kind: 'terminalContains', node: 'Client', text: '404 Not Found' }, { id: 'http', label: 'HTTP traffic was captured', kind: 'sniffHas', expr: 'http' }], web('<html><body><h1>Hello</h1></body></html>')),
    checks: [{ id: 'ok', label: 'Client received 200 OK', kind: 'terminalContains', node: 'Client', text: '200 OK' }, { id: 'nf', label: 'Client received 404 Not Found', kind: 'terminalContains', node: 'Client', text: '404 Not Found' }, { id: 'http', label: 'HTTP traffic was captured', kind: 'sniffHas', expr: 'http' }],
    steps: [
      { title: 'Start the web server', do: 'On **WebSrv** start the HTTP server.', set: ['httpd'] },
      { title: 'Fetch the page', do: 'On **Client** fetch the root page (no recursion) and Turbo.', set: ['curl --no-recurse http://10.0.0.80/'], observe: 'A handshake, then a GET, then a 200 OK response.', checkId: 'ok' },
      { title: 'Read the exchange', do: 'In the sniffer, filter `http` and click the request and the response.', set: ['display filter: http'], observe: 'The request line `GET / HTTP/1.1`, Host header, then `HTTP/1.1 200 OK`.', checkId: 'http', note: 'Record the request line and the response’s Content-Type and Content-Length.' },
      { title: 'Trigger a 404', do: 'Fetch a path that does not exist and Turbo.', set: ['curl --no-recurse http://10.0.0.80/missing'], observe: 'A 404 Not Found response.', checkId: 'nf' },
    ],
    questions: [{ q: 'What must happen at the transport layer before any HTTP request is sent?', a: 'A TCP three-way handshake to the server’s port 80, establishing the reliable connection HTTP rides on.' }],
    wrap: 'HTTP is just readable text over a TCP pipe — method, headers, status, body.' },

  { id: 'http-persistent', module: MOD, name: 'Persistent vs non-persistent connections', difficulty: 'advanced', minutes: 16,
    objectives: ['Compare a fresh connection per object vs one reused connection', 'Count handshakes and understand the cost'],
    theory: ['A page pulls in sub-resources (CSS, images, scripts). **Non-persistent** HTTP/1.0 opens a new TCP connection for each object — a handshake per file. **Persistent** HTTP/1.1 keeps one connection open and reuses it, saving handshakes and round trips. **Pipelining** goes further, sending requests back to back.'],
    build: () => scene('http-persistent', 'Persistent vs non-persistent connections', 'Fetch a page with embedded objects two ways and count SYNs.', [{ id: 'fetched', label: 'The page and its resources were fetched', kind: 'terminalContains', node: 'Client', text: 'Fetched' }], web('<html><head><link rel="stylesheet" href="/a.css"></head><body><img src="/b.png"><script src="/c.js"></script></body></html>', { 'a.css': 'body{}', 'b.png': 'PNG'.repeat(400), 'c.js': 'x=1' })),
    checks: [{ id: 'fetched', label: 'The page and its resources were fetched', kind: 'terminalContains', node: 'Client', text: 'Fetched' }],
    steps: [
      { title: 'Start the server', do: 'On **WebSrv** run `httpd`. The index page references a CSS, an image and a script.', set: ['httpd'] },
      { title: 'Persistent fetch', do: 'On **Client** fetch the page (persistent is the default) and Turbo. Then open **Client → HTTP** to see the waterfall.', set: ['curl http://10.0.0.80/'], observe: 'One connection, four objects.', checkId: 'fetched', note: 'How many TCP SYNs appear in the sniffer? (Filter `tcp.flags.syn == 1`.)' },
      { title: 'Non-persistent fetch', do: 'Restart, then fetch again with **Turbo**, forcing HTTP/1.0 (a new connection per object).', set: ['curl -0 http://10.0.0.80/'], observe: 'Four separate connections — four handshakes.', note: 'Count the SYNs now. How many more round trips did non-persistent cost?' },
      { title: 'Compare timings', do: 'Compare the total fetch time reported in each mode.', note: 'Why is persistent faster even on a fast LAN, and much more so on a high-latency link?' },
    ],
    questions: [{ q: 'Why does reusing one connection matter more as latency grows?', a: 'Each new connection costs a full RTT for the handshake before any data. On a high-latency path those RTTs dominate, so avoiding a handshake per object saves the most time.' }],
    wrap: 'One connection, many objects — the core efficiency win of HTTP/1.1 (and, later, HTTP/2).' },

  { id: 'http-waterfall', module: MOD, name: 'The resource waterfall', difficulty: 'core', minutes: 12,
    objectives: ['Read a page-load waterfall', 'Connect embedded tags to extra requests'],
    theory: ['A browser first fetches the HTML, then parses it and requests each referenced object. The **waterfall** shows each request’s start and duration, revealing how a page assembles and where the time goes.'],
    build: () => scene('http-waterfall', 'The resource waterfall', 'Fetch a page and read its load waterfall.', [{ id: 'fetched', label: 'Multiple resources were fetched', kind: 'terminalContains', node: 'Client', text: 'resource' }], web('<html><head><link rel="stylesheet" href="/style.css"></head><body><h1>Shop</h1><img src="/logo.png"><img src="/banner.png"><script src="/app.js"></script></body></html>', { 'style.css': 'h1{color:teal}', 'logo.png': 'PNG'.repeat(300), 'banner.png': 'PNG'.repeat(800), 'app.js': 'console.log(1)' })),
    checks: [{ id: 'fetched', label: 'Multiple resources were fetched', kind: 'terminalContains', node: 'Client', text: 'resource' }],
    steps: [
      { title: 'Serve and fetch', do: 'On **WebSrv** run `httpd`; on **Client** fetch the page and Turbo.', set: ['httpd', 'curl http://10.0.0.80/'], checkId: 'fetched' },
      { title: 'Open the waterfall', do: 'Open **Client → HTTP**.', observe: 'One row per resource with status, bytes, timing and a timeline bar.', note: 'List the resources fetched and which was largest/slowest.' },
      { title: 'Relate to the HTML', do: 'Look back at the index page’s tags.', note: 'Which HTML tags caused which extra requests (link, img, script)?' },
    ],
    questions: [{ q: 'Why can’t the browser fetch the CSS and images at the same instant as the HTML?', a: 'It does not know they exist until it has received and parsed the HTML, so sub-resource requests necessarily follow the first response.' }],
    wrap: 'The waterfall turns “the page loaded” into a precise, per-object story.' },
];
