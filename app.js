// CrewDeck UI — talks to crewdeck.mjs when available, otherwise runs a full in-browser demo
// on the same engine (simulated agents, saved to localStorage).
import * as E from './lib/engine.mjs';
import { demoState } from './lib/demo.mjs';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => '$' + (Number(n) || 0).toFixed(2);
const ago = (t) => {
  if (!t) return '—';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 0) return 'in ' + fmtDur(-s);
  return fmtDur(s) + ' ago';
};
const fmtDur = (s) => (s < 60 ? s + 's' : s < 3600 ? Math.round(s / 60) + 'm' : s < 86400 ? Math.round(s / 3600) + 'h' : Math.round(s / 86400) + 'd');
const COLORS = ['#6d5efc', '#1f9d6b', '#d98a00', '#2f7de1', '#c0399a', '#0f9fb0', '#8a6d3b', '#d64545'];
const color = (id) => COLORS[[...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
const initials = (n) => String(n || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const COLS = [['backlog', 'Backlog'], ['todo', 'To do'], ['in_progress', 'In progress'], ['review', 'Review'], ['done', 'Done'], ['failed', 'Failed']];

let S = E.emptyState();
let MODE = 'demo';
let TOKEN = '';
let tab = location.hash.slice(1) || 'board';
let openTask = null;

function toast(msg, err) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ------------------------------------------------------------------ backends
const LS = 'crewdeck:demo';
function saveDemo() {
  try {
    localStorage.setItem(LS, JSON.stringify(S));
  } catch {
    /* storage unavailable */
  }
}

async function http(method, path, body) {
  const r = await fetch('api/' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) {
    TOKEN = prompt('CrewDeck token (CREWDECK_TOKEN):') || '';
    try {
      localStorage.setItem('crewdeck:token', TOKEN);
    } catch {}
    throw new Error('unauthorized');
  }
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

const ACTIONS = {
  createTask: [(b) => ['POST', 'tasks', b], (b) => E.createTask(S, b)],
  updateTask: [(id, b) => ['PATCH', 'tasks/' + id, b], (id, b) => E.updateTask(S, id, b)],
  comment: [(id, text) => ['POST', `tasks/${id}/comments`, { text }], (id, text) => E.addComment(S, id, { author: 'human', text })],
  approve: [(id, note) => ['POST', `tasks/${id}/approve`, { note }], (id, note) => E.approve(S, id, { note })],
  reject: [(id, note) => ['POST', `tasks/${id}/reject`, { note }], (id, note) => E.reject(S, id, { note })],
  runNow: [(id) => ['POST', `tasks/${id}/run`, {}], (id) => demoDispatch(id)],
  createAgent: [(b) => ['POST', 'agents', b], (b) => E.createAgent(S, b)],
  updateAgent: [(id, b) => ['PATCH', 'agents/' + id, b], (id, b) => E.updateAgent(S, id, b)],
  createGoal: [(b) => ['POST', 'goals', b], (b) => E.createGoal(S, b)],
  createRoutine: [(b) => ['POST', 'routines', b], (b) => E.createRoutine(S, b)],
  updateRoutine: [(id, b) => ['PATCH', 'routines/' + id, b], (id, b) => Object.assign(S.routines.find((r) => r.id === id), b)],
  company: [(b) => ['PATCH', 'company', b], (b) => Object.assign(S.company, b)],
  demo: [() => ['POST', 'demo', {}], () => (S = demoState())],
  import: [(o) => ['POST', 'import', o], (o) => (S = { ...E.emptyState(), ...o })],
};

async function act(name, ...args) {
  try {
    const [remote, local] = ACTIONS[name];
    let out;
    if (MODE === 'server') {
      out = await http(...remote(...args));
      await refresh();
    } else {
      out = local(...args);
      saveDemo();
      render();
    }
    return out;
  } catch (e) {
    toast(e.message, true);
    throw e;
  }
}

async function refresh() {
  if (MODE !== 'server') return render();
  S = await http('GET', 'state');
  render();
}

// Browser-demo dispatcher: same engine rules, simulated agents.
const SIM_RESULTS = ['Drafted', 'Analysed', 'Implemented', 'Reviewed', 'Researched', 'Summarised'];
function demoDispatch(taskId) {
  const t = E.getTask(S, taskId);
  const a = E.getAgent(S, t.assignee);
  if (a.adapter.type !== 'sim') throw new Error(`In the browser demo only simulated agents run. Start \`node crewdeck.mjs\` for ${a.adapter.type} agents.`);
  const { run } = E.claim(S, taskId, a.id);
  setTimeout(() => {
    if (S.runs.find((r) => r.id === run.id)?.status !== 'running') return;
    const ok = Math.random() > (a.adapter.failRate ?? 0.1);
    const v = SIM_RESULTS[Math.floor(Math.random() * SIM_RESULTS.length)];
    E.completeRun(S, run.id, {
      ok,
      output: ok ? `${v} “${t.title}”.\n- Used goal context and prerequisite results\n- Checked the result against the task description\nSummary: ${v.toLowerCase()} — ready for the next step.` : 'Simulated failure: upstream tool timed out.',
      costUsd: +(0.02 + Math.random() * 0.25).toFixed(3),
    });
    saveDemo();
    render();
  }, 2000 + Math.random() * 4500);
  return run;
}
function demoTick() {
  let dirty = E.expireLocks(S).length + E.tickRoutines(S).length;
  for (const a of S.agents) {
    if (a.adapter.type !== 'sim') continue;
    const t = E.nextTaskFor(S, a.id);
    if (t) {
      demoDispatch(t.id);
      dirty++;
    }
  }
  if (dirty) {
    saveDemo();
    render();
  }
}

async function boot() {
  try {
    TOKEN = localStorage.getItem('crewdeck:token') || '';
  } catch {}
  try {
    const r = await fetch('api/summary', { headers: TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {} });
    if (r.ok || r.status === 401) MODE = 'server';
  } catch {
    /* static hosting → demo */
  }
  if (MODE === 'server') {
    await refresh().catch(() => {});
    const es = new EventSource('api/events');
    let t;
    es.addEventListener('change', () => {
      clearTimeout(t);
      t = setTimeout(refresh, 150);
    });
  } else {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(LS) || 'null');
    } catch {}
    S = saved || demoState();
    for (const r of S.runs) if (r.status === 'running') E.completeRun(S, r.id, { ok: false, output: 'Page reloaded during run.' });
    saveDemo();
    setInterval(demoTick, 2000);
  }
  setInterval(render, 15000); // keep relative times fresh
  render();
}

// ------------------------------------------------------------------ rendering
const agentName = (id) => S.agents.find((a) => a.id === id)?.name || 'Unassigned';
const avatar = (id) => (id ? `<span class="av" style="background:${color(id)}" title="${esc(agentName(id))}">${esc(initials(agentName(id)))}</span>` : '<span class="av" style="background:#aab" title="Unassigned">?</span>');

function render() {
  $('#companyName').textContent = S.company.name;
  const sm = E.summary(S);
  $('#stats').innerHTML = `<span><b>${sm.agents}</b> agents · <b>${sm.working}</b> working</span><span><b>${sm.tasks.todo + sm.tasks.in_progress}</b> open</span><span><b>${sm.awaitingReview}</b> awaiting review</span><span><b>${money(sm.spendMonth)}</b> this month</span>`;
  const m = $('#mode');
  m.textContent = MODE === 'server' ? '● live server' : '● browser demo';
  m.className = 'mode' + (MODE === 'server' ? '' : ' demo');
  m.title = MODE === 'server' ? 'Connected to crewdeck.mjs' : 'No server found — running a simulated company in your browser. Run `node crewdeck.mjs` for real agents.';
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  const v = $('#view');
  v.innerHTML = { board: viewBoard, org: viewOrg, goals: viewGoals, routines: viewRoutines, costs: viewCosts, activity: viewActivity }[tab]();
  bindView();
  if (openTask) renderDrawer();
}

function card(t) {
  const blocked = E.isBlocked(S, t);
  const goal = S.goals.find((g) => g.id === t.goalId);
  return `<div class="card" draggable="true" data-task="${t.id}">
    <div class="t">${esc(t.title)}</div>
    <div class="meta">${avatar(t.assignee)}
      ${t.priority !== 'normal' ? `<span class="chip ${t.priority}">${t.priority}</span>` : ''}
      ${blocked && !['done', 'failed'].includes(t.status) ? '<span class="chip block">blocked</span>' : ''}
      ${t.lock ? '<span class="chip lock"><span class="spin"></span> running</span>' : ''}
      ${t.requiresApproval ? '<span class="chip appr">approval</span>' : ''}
      ${t.costUsd ? `<span class="mono">${money(t.costUsd)}</span>` : ''}
      ${goal ? `<span title="${esc(goal.title)}">◎ ${esc(goal.title.slice(0, 22))}${goal.title.length > 22 ? '…' : ''}</span>` : ''}
    </div></div>`;
}

function viewBoard() {
  if (!S.tasks.length && !S.agents.length)
    return `<div class="empty"><h2>Your AI company is empty</h2><p>Hire agents, set goals and hand out tasks — or load a demo company to see CrewDeck in action.</p><button class="btn primary" data-act="demo">Load demo company</button></div>`;
  return `<div class="board">${COLS.map(([st, label]) => {
    const list = S.tasks.filter((t) => t.status === st).sort((a, b) => E.PRIORITY[a.priority] - E.PRIORITY[b.priority] || b.updatedAt - a.updatedAt);
    return `<section class="col" data-col="${st}"><h4>${label}<span>${list.length}</span></h4>${list.map(card).join('')}</section>`;
  }).join('')}</div>`;
}

function agentCard(a) {
  const used = E.spend(S, { agentId: a.id });
  const pct = a.monthlyBudgetUsd ? Math.min(100, (used / a.monthlyBudgetUsd) * 100) : 0;
  const b = E.budgetState(S, a);
  const st = a.paused ? 'paused' : b === 'exhausted' ? 'over' : a.status;
  const open = S.tasks.filter((t) => t.assignee === a.id && !['done', 'failed'].includes(t.status)).length;
  return `<div class="panel">
    <div class="row">${avatar(a.id)}<h3>${esc(a.name)}</h3><span class="dot ${st}"></span><span class="muted">${a.paused ? 'paused' : b === 'exhausted' ? 'budget exhausted' : a.status}</span></div>
    <div class="muted">${esc(a.role)} · <span class="mono">${esc(a.adapter.type)}</span>${a.adapter.command ? ` <span class="mono" title="${esc(a.adapter.command)}">${esc(a.adapter.command.slice(0, 32))}…</span>` : ''}</div>
    ${a.monthlyBudgetUsd ? `<div class="bar ${b === 'warning' ? 'warn' : b === 'exhausted' ? 'bad' : ''}"><i style="width:${pct}%"></i></div><div class="muted mono">${money(used)} / ${money(a.monthlyBudgetUsd)} this month</div>` : '<div class="muted">No budget limit</div>'}
    <div class="row" style="margin-top:8px"><span class="muted">${open} open task${open === 1 ? '' : 's'} · heartbeat ${ago(a.lastHeartbeat)}</span>
      <span style="margin-left:auto"></span>
      <button class="btn small" data-agent-edit="${a.id}">Edit</button>
      <button class="btn small ${a.paused ? 'ok' : 'bad'}" data-agent-pause="${a.id}">${a.paused ? 'Resume' : 'Pause'}</button></div>
    <div class="hint mono">id: ${a.id}</div>
  </div>`;
}

function viewOrg() {
  if (!S.agents.length) return '<div class="empty"><p>No agents yet.</p><button class="btn primary" data-open="agent">Hire your first agent</button></div>';
  const kids = (id) => S.agents.filter((a) => (a.reportsTo || null) === id);
  const tree = (id) => {
    const k = kids(id);
    return k.length ? `<ul>${k.map((a) => `<li>${agentCard(a)}${tree(a.id)}</li>`).join('')}</ul>` : '';
  };
  return `<div class="org">${tree(null)}</div>`;
}

function viewGoals() {
  if (!S.goals.length) return '<div class="empty"><p>Goals give agents the “why”. Every task linked to a goal carries its context into the prompt.</p><button class="btn primary" data-open="goal">Add a goal</button></div>';
  return `<div class="grid">${S.goals.map((g) => {
    const ts = S.tasks.filter((t) => t.goalId === g.id);
    const done = ts.filter((t) => t.status === 'done').length;
    return `<div class="panel"><h3>◎ ${esc(g.title)}</h3><p class="muted">${esc(g.description)}</p>
      <div class="bar"><i style="width:${ts.length ? (done / ts.length) * 100 : 0}%"></i></div>
      <div class="muted">${done}/${ts.length} tasks done · ${money(E.spend(S, { goalId: g.id }))} spent this month</div></div>`;
  }).join('')}</div>`;
}

function viewRoutines() {
  if (!S.routines.length) return '<div class="empty"><p>Routines create recurring tasks — daily triage, weekly reports, nightly checks.</p><button class="btn primary" data-open="routine">Add a routine</button></div>';
  return `<div class="panel"><table><tr><th>Routine</th><th>Agent</th><th>Every</th><th>Next</th><th></th></tr>${S.routines.map((r) => `<tr>
    <td><b>${esc(r.title)}</b>${r.requiresApproval ? ' <span class="chip appr">approval</span>' : ''}</td><td>${avatar(r.agentId)} ${esc(agentName(r.agentId))}</td>
    <td class="mono">${r.everyMinutes >= 1440 ? r.everyMinutes / 1440 + 'd' : r.everyMinutes >= 60 ? r.everyMinutes / 60 + 'h' : r.everyMinutes + 'm'}</td>
    <td class="muted">${r.enabled ? ago(r.nextAt) : 'disabled'}</td>
    <td><button class="btn small" data-routine-toggle="${r.id}">${r.enabled ? 'Disable' : 'Enable'}</button> <button class="btn small" data-routine-now="${r.id}">Run now</button></td></tr>`).join('')}</table></div>`;
}

function viewCosts() {
  const rows = S.agents.map((a) => ({ a, used: E.spend(S, { agentId: a.id }), runs: S.runs.filter((r) => r.agentId === a.id) })).sort((x, y) => y.used - x.used);
  const total = rows.reduce((s, r) => s + r.used, 0) || 1;
  const goals = S.goals.map((g) => ({ g, used: E.spend(S, { goalId: g.id }) }));
  const ok = S.runs.filter((r) => r.status === 'succeeded').length;
  const fin = S.runs.filter((r) => r.status !== 'running').length;
  return `<div class="grid" style="margin-bottom:12px">
      <div class="panel"><div class="muted">Spend this month</div><h3 style="font-size:26px">${money(E.spend(S))}</h3></div>
      <div class="panel"><div class="muted">Runs</div><h3 style="font-size:26px">${S.runs.length}</h3><div class="muted">${fin ? Math.round((ok / fin) * 100) : 0}% success</div></div>
      <div class="panel"><div class="muted">Avg cost / finished task</div><h3 style="font-size:26px">${money(E.spend(S) / Math.max(1, S.tasks.filter((t) => t.status === 'done').length))}</h3></div>
    </div>
    <div class="panel"><h3>By agent</h3><table><tr><th>Agent</th><th>Runs</th><th>Spend</th><th style="width:40%">Share</th><th>Budget</th></tr>
    ${rows.map(({ a, used, runs }) => `<tr><td>${avatar(a.id)} ${esc(a.name)}</td><td>${runs.length}</td><td class="mono">${money(used)}</td><td><div class="bar"><i style="width:${(used / total) * 100}%;background:${color(a.id)}"></i></div></td><td class="mono">${a.monthlyBudgetUsd ? money(a.monthlyBudgetUsd) : '∞'}</td></tr>`).join('')}</table></div>
    ${goals.length ? `<div class="panel" style="margin-top:12px"><h3>By goal</h3><table>${goals.map(({ g, used }) => `<tr><td>◎ ${esc(g.title)}</td><td class="mono">${money(used)}</td></tr>`).join('')}</table></div>` : ''}`;
}

function viewActivity() {
  return `<div class="panel"><ul class="feed">${S.activity.slice(0, 300).map((e) => `<li><span class="when">${ago(e.t)}</span><span class="tag">${esc(e.type)}</span><span ${e.taskId ? `data-task="${e.taskId}" style="cursor:pointer"` : ''}>${esc(e.text)}</span></li>`).join('') || '<li class="muted">Nothing yet.</li>'}</ul></div>`;
}

function renderDrawer() {
  const d = $('#drawer');
  const t = S.tasks.find((x) => x.id === openTask);
  if (!t) {
    d.hidden = true;
    openTask = null;
    return;
  }
  d.hidden = false;
  const runs = S.runs.filter((r) => r.taskId === t.id);
  const opts = (list, sel, none) => (none ? `<option value="">${none}</option>` : '') + list.map(([v, l]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const others = S.tasks.filter((x) => x.id !== t.id);
  d.innerHTML = `<button class="btn ghost close" data-close>✕</button>
    <div class="muted mono">${t.id} · ${t.source} · created ${ago(t.createdAt)}</div>
    <h2>${esc(t.title)}</h2>
    ${t.description ? `<p style="white-space:pre-wrap">${esc(t.description)}</p>` : ''}
    <div class="row">
      ${t.status === 'review' ? '<button class="btn ok" data-approve>✓ Approve</button><button class="btn" data-reject>↩ Request changes</button>' : ''}
      ${t.assignee && !t.lock && !E.isBlocked(S, t) && ['todo', 'failed', 'backlog'].includes(t.status) ? '<button class="btn primary" data-runnow>▶ Run now</button>' : ''}
      ${t.lock ? '<span class="chip lock"><span class="spin"></span> running — locked to one agent</span>' : ''}
      ${E.isBlocked(S, t) && !['done', 'failed'].includes(t.status) ? '<span class="chip block">blocked by prerequisites</span>' : ''}
    </div>
    <div class="two">
      <label class="field">Assignee<select data-f="assignee" ${t.lock ? 'disabled' : ''}>${opts(S.agents.map((a) => [a.id, `${a.name} — ${a.role}`]), t.assignee, 'Unassigned')}</select></label>
      <label class="field">Status<select data-f="status" ${t.lock ? 'disabled' : ''}>${opts(COLS, t.status)}</select></label>
      <label class="field">Priority<select data-f="priority">${opts(Object.keys(E.PRIORITY).map((p) => [p, p]), t.priority)}</select></label>
      <label class="field">Goal<select data-f="goalId">${opts(S.goals.map((g) => [g.id, g.title]), t.goalId, 'No goal')}</select></label>
    </div>
    <label class="field">Blocked by (prerequisites)<select data-f="blockedBy" multiple size="${Math.min(5, Math.max(2, others.length))}">${others.map((o) => `<option value="${o.id}" ${t.blockedBy.includes(o.id) ? 'selected' : ''}>${esc(o.title)} (${o.status})</option>`).join('')}</select></label>
    <label class="row"><input type="checkbox" data-f="requiresApproval" ${t.requiresApproval ? 'checked' : ''}> Require human approval before done</label>
    <p class="muted">Attempts ${t.attempts}/${t.maxAttempts} · cost ${money(t.costUsd)}</p>
    <details><summary>Prompt the agent will receive</summary><pre class="out">${esc(E.buildPrompt(S, t))}</pre></details>
    <h3>Discussion</h3>
    ${t.comments.map((c) => `<div class="comment"><b>${esc(c.author)}</b> <span class="muted">${ago(c.t)}</span><br>${esc(c.text)}</div>`).join('') || '<p class="muted">No comments yet.</p>'}
    <label class="field">Add a comment (agents see the latest comments)<textarea id="newComment" placeholder="Feedback, extra context, acceptance criteria…"></textarea></label>
    <button class="btn" data-comment>Comment</button>
    <h3>Runs</h3>
    ${runs.map((r) => `<details><summary>${r.status === 'running' ? '<span class="spin"></span>' : r.status === 'succeeded' ? '✓' : '✗'} ${esc(agentName(r.agentId))} · ${ago(r.startedAt)} · ${r.endedAt ? fmtDur(Math.round((r.endedAt - r.startedAt) / 1000)) : 'running'} · ${money(r.costUsd)}</summary><pre class="out">${esc(r.output || '(no output yet)')}</pre></details>`).join('') || '<p class="muted">Not run yet.</p>'}`;
  d.querySelector('[data-close]').onclick = () => {
    openTask = null;
    d.hidden = true;
  };
  d.querySelectorAll('[data-f]').forEach((el) =>
    el.addEventListener('change', () => {
      const f = el.dataset.f;
      const v = el.type === 'checkbox' ? el.checked : el.multiple ? [...el.selectedOptions].map((o) => o.value) : el.value || null;
      act('updateTask', t.id, { [f]: v }).catch(() => render());
    }),
  );
  d.querySelector('[data-comment]').onclick = () => {
    const v = $('#newComment').value.trim();
    if (v) act('comment', t.id, v);
  };
  d.querySelector('[data-approve]')?.addEventListener('click', () => act('approve', t.id, prompt('Approval note (optional):') || ''));
  d.querySelector('[data-reject]')?.addEventListener('click', () => {
    const n = prompt('What should change?');
    if (n) act('reject', t.id, n);
  });
  d.querySelector('[data-runnow]')?.addEventListener('click', async () => {
    if (t.status !== 'todo') await act('updateTask', t.id, { status: 'todo' });
    act('runNow', t.id);
  });
}

function bindView() {
  const v = $('#view');
  v.querySelectorAll('[data-task]').forEach((el) => el.addEventListener('click', () => {
    openTask = el.dataset.task;
    renderDrawer();
  }));
  v.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openForm(b.dataset.open)));
  v.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => menuAction(b.dataset.act)));
  v.querySelectorAll('[data-agent-pause]').forEach((b) => b.addEventListener('click', () => {
    const a = E.getAgent(S, b.dataset.agentPause);
    act('updateAgent', a.id, { paused: !a.paused });
  }));
  v.querySelectorAll('[data-agent-edit]').forEach((b) => b.addEventListener('click', () => openForm('agent', E.getAgent(S, b.dataset.agentEdit))));
  v.querySelectorAll('[data-routine-toggle]').forEach((b) => b.addEventListener('click', () => {
    const r = S.routines.find((x) => x.id === b.dataset.routineToggle);
    act('updateRoutine', r.id, { enabled: !r.enabled });
  }));
  v.querySelectorAll('[data-routine-now]').forEach((b) => b.addEventListener('click', () => act('updateRoutine', b.dataset.routineNow, { nextAt: 0, enabled: true }).then(() => toast('Routine queued — a task appears on the next tick'))));
  // drag & drop status changes
  v.querySelectorAll('.card').forEach((c) => c.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', c.dataset.task)));
  v.querySelectorAll('.col').forEach((col) => {
    col.addEventListener('dragover', (e) => {
      e.preventDefault();
      col.classList.add('drop');
    });
    col.addEventListener('dragleave', () => col.classList.remove('drop'));
    col.addEventListener('drop', (e) => {
      e.preventDefault();
      col.classList.remove('drop');
      const id = e.dataTransfer.getData('text/plain');
      if (id) act('updateTask', id, { status: col.dataset.col }).catch(() => {});
    });
  });
}

// ------------------------------------------------------------------ forms
function openForm(kind, existing) {
  const dlg = $('#dlg');
  const f = $('#dlgForm');
  const agentOpts = (sel, none = 'Unassigned') => `<option value="">${none}</option>` + S.agents.map((a) => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${esc(a.name)} — ${esc(a.role)}</option>`).join('');
  const goalOpts = () => '<option value="">No goal</option>' + S.goals.map((g) => `<option value="${g.id}">${esc(g.title)}</option>`).join('');
  const forms = {
    task: `<h3>New task</h3>
      <label class="field">Title<input name="title" required autofocus placeholder="e.g. Write the onboarding email sequence"></label>
      <label class="field">Description / acceptance criteria<textarea name="description"></textarea></label>
      <div class="two"><label class="field">Assignee<select name="assignee">${agentOpts()}</select></label>
      <label class="field">Priority<select name="priority"><option>normal</option><option>urgent</option><option>high</option><option>low</option></select></label></div>
      <label class="field">Goal<select name="goalId">${goalOpts()}</select></label>
      <label class="row"><input type="checkbox" name="requiresApproval"> Require approval before done</label>`,
    agent: `<h3>${existing ? 'Edit agent' : 'Hire an agent'}</h3>
      <div class="two"><label class="field">Name<input name="name" required value="${esc(existing?.name || '')}"></label>
      <label class="field">Role<input name="role" value="${esc(existing?.role || '')}" placeholder="Engineer, Researcher…"></label></div>
      <div class="two"><label class="field">Reports to<select name="reportsTo">${agentOpts(existing?.reportsTo, 'Nobody (top level)')}</select></label>
      <label class="field">Monthly budget (USD, 0 = none)<input name="monthlyBudgetUsd" type="number" step="0.5" min="0" value="${existing?.monthlyBudgetUsd ?? 20}"></label></div>
      <label class="field">Adapter<select name="type">
        ${[['shell', 'shell — run a CLI agent (Claude Code, Codex, Aider, any script)'], ['http', 'http — POST to a webhook / bot'], ['remote', 'remote — a worker heartbeats in (agent.mjs)'], ['sim', 'sim — simulated agent (demo)'], ['manual', 'manual — a human']].map(([v, l]) => `<option value="${v}" ${existing?.adapter.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="field">Command (shell) — <span class="mono">{prompt}</span> is replaced with the task prompt<input name="command" class="mono" value="${esc(existing?.adapter.command || '')}" placeholder="claude -p {prompt} --output-format json"></label>
      <label class="field">Working directory (shell) / URL (http)<input name="target" class="mono" value="${esc(existing?.adapter.cwd || existing?.adapter.url || '')}" placeholder="/path/to/repo  or  https://bot.example.com/run"></label>
      <p class="hint">Costs are read from Claude Code JSON (<span class="mono">total_cost_usd</span>) or a line like <span class="mono">COST_USD=0.12</span>. Remote workers: <span class="mono">node agent.mjs --agent &lt;id&gt; --cmd "codex exec {prompt}"</span>.</p>`,
    goal: `<h3>New goal</h3><label class="field">Title<input name="title" required></label><label class="field">Why it matters / context for agents<textarea name="description"></textarea></label>`,
    routine: `<h3>New routine</h3><label class="field">Title<input name="title" required placeholder="Daily issue triage"></label>
      <label class="field">Instructions<textarea name="description"></textarea></label>
      <div class="two"><label class="field">Agent<select name="agentId" required>${agentOpts(null, 'Choose…')}</select></label>
      <label class="field">Every (minutes)<input name="everyMinutes" type="number" min="1" value="1440"></label></div>
      <label class="field">Goal<select name="goalId">${goalOpts()}</select></label>
      <label class="row"><input type="checkbox" name="requiresApproval"> Require approval</label>`,
    company: `<h3>Company</h3><label class="field">Name<input name="name" value="${esc(S.company.name)}"></label><label class="field">Mission (every agent sees this)<textarea name="mission">${esc(S.company.mission)}</textarea></label>`,
  };
  f.innerHTML = forms[kind] + `<div class="dlg-actions"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">Save</button></div>`;
  dlg.showModal();
  f.onsubmit = async (e) => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    for (const k of Object.keys(d)) if (d[k] === '') d[k] = null;
    d.requiresApproval = !!f.requiresApproval?.checked;
    try {
      if (kind === 'task') await act('createTask', d);
      if (kind === 'goal') await act('createGoal', d);
      if (kind === 'company') await act('company', d);
      if (kind === 'routine') await act('createRoutine', { ...d, everyMinutes: Number(d.everyMinutes) });
      if (kind === 'agent') {
        const adapter = { type: d.type };
        if (d.command) adapter.command = d.command;
        if (d.target) adapter[d.type === 'http' ? 'url' : 'cwd'] = d.target;
        const body = { name: d.name, role: d.role || 'Generalist', reportsTo: d.reportsTo, monthlyBudgetUsd: Number(d.monthlyBudgetUsd) || 0, adapter };
        await (existing ? act('updateAgent', existing.id, body) : act('createAgent', body));
      }
      dlg.close();
    } catch {
      /* toast shown */
    }
  };
}

function menuAction(a) {
  $('#menu').hidden = true;
  if (a === 'company') return openForm('company');
  if (a === 'demo') {
    if (S.tasks.length && !confirm('Replace the current company with the demo?')) return;
    return act('demo');
  }
  if (a === 'export') {
    const blob = new Blob([JSON.stringify(S, null, 1)], { type: 'application/json' });
    const el = document.createElement('a');
    el.href = URL.createObjectURL(blob);
    el.download = `crewdeck-${new Date().toISOString().slice(0, 10)}.json`;
    el.click();
    return;
  }
  if (a === 'import') return $('#importFile').click();
}

document.addEventListener('click', (e) => {
  const o = e.target.closest('header [data-open]');
  if (o) openForm(o.dataset.open);
  const m = e.target.closest('#menu [data-act]');
  if (m) menuAction(m.dataset.act);
  if (e.target.closest('#menuBtn')) $('#menu').hidden = !$('#menu').hidden;
  else if (!e.target.closest('#menu')) $('#menu').hidden = true;
  const tb = e.target.closest('#tabs [data-tab]');
  if (tb) {
    tab = tb.dataset.tab;
    history.replaceState(null, '', '#' + tab);
    render();
  }
  if (e.target.closest('#companyName')) openForm('company');
});
$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    await act('import', JSON.parse(await file.text()));
    toast('Imported');
  } catch {
    toast('Not a valid CrewDeck export', true);
  }
  e.target.value = '';
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openTask) {
    openTask = null;
    $('#drawer').hidden = true;
  }
  if (e.key === 'n' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !$('#dlg').open) openForm('task');
});

boot();
