#!/usr/bin/env node
// CrewDeck server — zero dependencies. `node crewdeck.mjs [--demo] [--port 7777] [--data ./data]`
import { createServer } from 'node:http';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import * as E from './lib/engine.mjs';
import { runAdapter } from './lib/runner.mjs';
import { demoState } from './lib/demo.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf('--' + n);
  return i >= 0 ? args[i + 1] ?? true : d;
};
const PORT = Number(flag('port', process.env.PORT || 7777));
const HOST = flag('host', process.env.HOST || '127.0.0.1');
const DATA = flag('data', process.env.CREWDECK_DATA || join(ROOT, 'data'));
const TOKEN = process.env.CREWDECK_TOKEN || '';
const FILE = join(DATA, 'crewdeck.json');
const TICK_MS = 3000;

let state = E.emptyState();
const running = new Set(); // runIds executing in this process

async function load() {
  await mkdir(DATA, { recursive: true });
  if (existsSync(FILE)) state = { ...E.emptyState(), ...JSON.parse(await readFile(FILE, 'utf8')) };
  else if (flag('demo', false)) state = demoState();
  // Runs that were in flight when the server stopped can't be resumed.
  for (const r of state.runs) if (r.status === 'running') E.completeRun(state, r.id, { ok: false, output: 'Server restarted during run.' });
}

let saveTimer = null;
function changed() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const tmp = FILE + '.tmp';
    await writeFile(tmp, JSON.stringify(state));
    await rename(tmp, FILE);
  }, 250);
  for (const res of clients) res.write(`event: change\ndata: ${Date.now()}\n\n`);
}

// ------------------------------------------------------------------ dispatcher
async function tick() {
  try {
    if (E.expireLocks(state).length) changed();
    if (E.tickRoutines(state).length) changed();
    for (const a of state.agents) {
      if (!['shell', 'http', 'sim'].includes(a.adapter.type)) continue;
      const t = E.nextTaskFor(state, a.id);
      if (t) dispatch(t.id, a.id);
    }
  } catch (e) {
    console.error('[tick]', e);
  }
}

function dispatch(taskId, agentId) {
  const a = E.getAgent(state, agentId);
  const { run, task, prompt } = E.claim(state, taskId, agentId);
  running.add(run.id);
  changed();
  runAdapter(a.adapter, prompt, { taskId, runId: run.id, title: task.title })
    .then((r) => E.completeRun(state, run.id, r))
    .catch((e) => E.completeRun(state, run.id, { ok: false, output: String(e) }))
    .finally(() => {
      running.delete(run.id);
      changed();
    });
  return run;
}

// ------------------------------------------------------------------ http
const clients = new Set();
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/lib/engine.mjs': 'lib/engine.mjs', '/lib/demo.mjs': 'lib/demo.mjs' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function authed(req) {
  if (!TOKEN) return true;
  const got = Buffer.from((req.headers.authorization || '').replace(/^Bearer /, ''));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
}

async function body(req) {
  let raw = '';
  for await (const c of req) {
    raw += c;
    if (raw.length > 2e6) throw Object.assign(new Error('body too large'), { status: 413 });
  }
  return raw ? JSON.parse(raw) : {};
}

const routes = [
  ['GET', /^\/api\/state$/, () => state],
  ['GET', /^\/api\/summary$/, () => E.summary(state)],
  ['PATCH', /^\/api\/company$/, (b) => Object.assign(state.company, { name: b.name ?? state.company.name, mission: b.mission ?? state.company.mission })],
  ['POST', /^\/api\/agents$/, (b) => E.createAgent(state, b)],
  ['PATCH', /^\/api\/agents\/([\w-]+)$/, (b, [id]) => E.updateAgent(state, id, b)],
  ['POST', /^\/api\/goals$/, (b) => E.createGoal(state, b)],
  ['POST', /^\/api\/tasks$/, (b) => E.createTask(state, b)],
  ['PATCH', /^\/api\/tasks\/([\w-]+)$/, (b, [id]) => E.updateTask(state, id, b)],
  ['POST', /^\/api\/tasks\/([\w-]+)\/comments$/, (b, [id]) => E.addComment(state, id, { author: b.author || 'human', text: b.text })],
  ['POST', /^\/api\/tasks\/([\w-]+)\/approve$/, (b, [id]) => E.approve(state, id, b)],
  ['POST', /^\/api\/tasks\/([\w-]+)\/reject$/, (b, [id]) => E.reject(state, id, b)],
  ['POST', /^\/api\/tasks\/([\w-]+)\/run$/, (b, [id]) => {
    const t = E.getTask(state, id);
    const a = E.getAgent(state, t.assignee);
    if (!['shell', 'http', 'sim'].includes(a.adapter.type)) throw new Error(`${a.name} uses the ${a.adapter.type} adapter — it picks up work itself`);
    return dispatch(id, a.id);
  }],
  ['POST', /^\/api\/routines$/, (b) => E.createRoutine(state, b)],
  ['PATCH', /^\/api\/routines\/([\w-]+)$/, (b, [id]) => {
    const r = state.routines.find((x) => x.id === id);
    if (!r) throw new Error('routine not found');
    for (const k of ['title', 'description', 'everyMinutes', 'enabled', 'requiresApproval']) if (k in b) r[k] = b[k];
    return r;
  }],
  // Remote agents (agent.mjs or your own bot): heartbeat claims work, complete reports it.
  ['POST', /^\/api\/agents\/([\w-]+)\/heartbeat$/, (b, [id]) => {
    const a = E.getAgent(state, id);
    a.lastHeartbeat = Date.now();
    const t = E.nextTaskFor(state, id);
    if (!t) return { idle: true, paused: a.paused, budget: E.budgetState(state, a) };
    const { run, task, prompt } = E.claim(state, t.id, id);
    return { run: { id: run.id }, task: { id: task.id, title: task.title }, prompt };
  }],
  ['POST', /^\/api\/runs\/([\w-]+)\/complete$/, (b, [id]) => E.completeRun(state, id, b)],
  ['POST', /^\/api\/demo$/, () => ((state = demoState()), { ok: true })],
  ['POST', /^\/api\/import$/, (b) => {
    if (!Array.isArray(b.tasks) || !Array.isArray(b.agents)) throw new Error('not a CrewDeck export');
    state = { ...E.emptyState(), ...b };
    return { ok: true };
  }],
];

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, obj, headers = {}) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(obj));
  };
  if (!url.pathname.startsWith('/api/')) {
    const f = STATIC[url.pathname];
    if (!f) return send(404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': TYPES[extname(f)] });
    return res.end(await readFile(join(ROOT, f)));
  }
  if (!authed(req)) return send(401, { error: 'unauthorized — set Authorization: Bearer $CREWDECK_TOKEN' });
  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname === '/api/export') return send(200, state, { 'Content-Disposition': 'attachment; filename="crewdeck-export.json"' });
  for (const [method, re, fn] of routes) {
    const m = url.pathname.match(re);
    if (!m || req.method !== method) continue;
    try {
      const out = await fn(method === 'GET' ? {} : await body(req), m.slice(1));
      if (method !== 'GET') changed();
      return send(200, out);
    } catch (e) {
      return send(e.status || 400, { error: e.message });
    }
  }
  send(404, { error: 'no such route' });
});

await load();
setInterval(tick, TICK_MS);
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 25000);
server.listen(PORT, HOST, () => {
  console.log(`\n  CrewDeck → http://${HOST}:${PORT}   data: ${FILE}${TOKEN ? '   (token auth on)' : ''}\n`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !TOKEN) console.warn('  ⚠  Listening beyond localhost without CREWDECK_TOKEN — anyone on the network can drive your agents.\n');
});
