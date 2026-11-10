// CrewDeck engine — pure, isomorphic state machine (runs in Node and in the browser demo).
// All mutations go through these functions so the server, the remote-agent API and the
// browser demo share exactly the same rules for locks, dependencies, budgets and approvals.

export const STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'done', 'failed'];
export const PRIORITY = { urgent: 0, high: 1, normal: 2, low: 3 };
export const LOCK_MS = 30 * 60 * 1000;

export function emptyState() {
  return { version: 1, seq: 0, company: { name: 'My AI Company', mission: '' }, agents: [], tasks: [], goals: [], routines: [], runs: [], activity: [] };
}

const id = (s, p) => `${p}_${(++s.seq).toString(36)}`;
const now = () => Date.now();

export function log(s, type, text, ref = {}) {
  s.activity.unshift({ id: id(s, 'ev'), t: now(), type, text, ...ref });
  if (s.activity.length > 1000) s.activity.length = 1000;
}

// ------------------------------------------------------------------ agents
export function createAgent(s, a) {
  if (!a?.name) throw new Error('agent name required');
  const agent = {
    id: id(s, 'ag'),
    name: String(a.name).slice(0, 60),
    role: a.role || 'Generalist',
    reportsTo: a.reportsTo || null,
    adapter: { type: 'manual', ...(a.adapter || {}) }, // manual | shell | http | remote | sim
    monthlyBudgetUsd: Number(a.monthlyBudgetUsd ?? 20),
    skills: a.skills || [],
    paused: !!a.paused,
    status: 'idle',
    lastHeartbeat: null,
    createdAt: now(),
  };
  if (agent.reportsTo && !s.agents.some((x) => x.id === agent.reportsTo)) agent.reportsTo = null;
  s.agents.push(agent);
  log(s, 'agent', `Hired ${agent.name} (${agent.role})`, { agentId: agent.id });
  return agent;
}

export function updateAgent(s, agentId, patch) {
  const a = getAgent(s, agentId);
  const allowed = ['name', 'role', 'reportsTo', 'adapter', 'monthlyBudgetUsd', 'skills', 'paused'];
  for (const k of allowed) if (k in patch) a[k] = patch[k];
  if (a.reportsTo === a.id || wouldCycle(s, a.id, a.reportsTo)) a.reportsTo = null;
  if ('paused' in patch) log(s, 'governance', `${a.name} ${a.paused ? 'paused' : 'resumed'}`, { agentId: a.id });
  return a;
}

function wouldCycle(s, agentId, managerId) {
  let cur = managerId;
  for (let i = 0; cur && i < 100; i++) {
    if (cur === agentId) return true;
    cur = s.agents.find((x) => x.id === cur)?.reportsTo;
  }
  return false;
}

export function getAgent(s, agentId) {
  const a = s.agents.find((x) => x.id === agentId);
  if (!a) throw new Error('agent not found: ' + agentId);
  return a;
}

export function monthKey(t) {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function spend(s, { agentId, goalId, at = now() } = {}) {
  const m = monthKey(at);
  return s.runs
    .filter((r) => monthKey(r.startedAt) === m && (!agentId || r.agentId === agentId) && (!goalId || s.tasks.find((t) => t.id === r.taskId)?.goalId === goalId))
    .reduce((sum, r) => sum + (r.costUsd || 0), 0);
}

/** 'ok' | 'warning' (≥80 %) | 'exhausted' (≥100 %) */
export function budgetState(s, agent, at = now()) {
  if (!agent.monthlyBudgetUsd) return 'ok';
  const used = spend(s, { agentId: agent.id, at });
  if (used >= agent.monthlyBudgetUsd) return 'exhausted';
  if (used >= agent.monthlyBudgetUsd * 0.8) return 'warning';
  return 'ok';
}

// ------------------------------------------------------------------ goals & tasks
export function createGoal(s, g) {
  if (!g?.title) throw new Error('goal title required');
  const goal = { id: id(s, 'gl'), title: g.title, description: g.description || '', createdAt: now() };
  s.goals.push(goal);
  log(s, 'goal', `New goal: ${goal.title}`, { goalId: goal.id });
  return goal;
}

export function createTask(s, t) {
  if (!t?.title) throw new Error('task title required');
  const task = {
    id: id(s, 'tk'),
    title: String(t.title).slice(0, 200),
    description: t.description || '',
    goalId: t.goalId || null,
    assignee: t.assignee || null,
    status: t.status && STATUSES.includes(t.status) ? t.status : t.assignee ? 'todo' : 'backlog',
    priority: PRIORITY[t.priority] != null ? t.priority : 'normal',
    blockedBy: (t.blockedBy || []).filter((b) => s.tasks.some((x) => x.id === b)),
    requiresApproval: !!t.requiresApproval,
    lock: null,
    comments: [],
    costUsd: 0,
    attempts: 0,
    maxAttempts: t.maxAttempts ?? 2,
    createdAt: now(),
    updatedAt: now(),
    source: t.source || 'human',
  };
  if (task.assignee) getAgent(s, task.assignee);
  s.tasks.push(task);
  log(s, 'task', `Created “${task.title}”${task.assignee ? ` → ${getAgent(s, task.assignee).name}` : ''}`, { taskId: task.id });
  return task;
}

export function getTask(s, taskId) {
  const t = s.tasks.find((x) => x.id === taskId);
  if (!t) throw new Error('task not found: ' + taskId);
  return t;
}

export function updateTask(s, taskId, patch) {
  const t = getTask(s, taskId);
  if (t.lock && ('assignee' in patch || 'status' in patch) && patch.force !== true) throw new Error('task is locked by a running agent');
  for (const k of ['title', 'description', 'goalId', 'priority', 'requiresApproval', 'maxAttempts']) if (k in patch) t[k] = patch[k];
  if ('blockedBy' in patch) {
    const next = (patch.blockedBy || []).filter((b) => b !== t.id && s.tasks.some((x) => x.id === b));
    if (next.some((b) => dependsOn(s, b, t.id))) throw new Error('dependency cycle');
    t.blockedBy = next;
  }
  if ('assignee' in patch) {
    if (patch.assignee) getAgent(s, patch.assignee);
    t.assignee = patch.assignee || null;
    if (t.status === 'backlog' && t.assignee) t.status = 'todo';
    log(s, 'task', `“${t.title}” assigned to ${t.assignee ? getAgent(s, t.assignee).name : 'nobody'}`, { taskId: t.id });
  }
  if ('status' in patch && STATUSES.includes(patch.status)) {
    t.status = patch.status;
    if (patch.force) t.lock = null;
    log(s, 'task', `“${t.title}” → ${t.status}`, { taskId: t.id });
  }
  t.updatedAt = now();
  return t;
}

function dependsOn(s, taskId, targetId, seen = new Set()) {
  if (taskId === targetId) return true;
  if (seen.has(taskId)) return false;
  seen.add(taskId);
  const t = s.tasks.find((x) => x.id === taskId);
  return !!t && t.blockedBy.some((b) => dependsOn(s, b, targetId, seen));
}

export function addComment(s, taskId, { author = 'human', text }) {
  if (!text) throw new Error('comment text required');
  const t = getTask(s, taskId);
  const c = { id: id(s, 'cm'), author, text: String(text).slice(0, 20000), t: now() };
  t.comments.push(c);
  t.updatedAt = now();
  return c;
}

export function isBlocked(s, t) {
  return t.blockedBy.some((b) => s.tasks.find((x) => x.id === b)?.status !== 'done');
}

// ------------------------------------------------------------------ dispatch, locks, runs
/** Highest-priority runnable task for an agent, or null (respects pause, budget, blockers, locks). */
export function nextTaskFor(s, agentId, at = now()) {
  const a = getAgent(s, agentId);
  if (a.paused || budgetState(s, a, at) === 'exhausted') return null;
  if (s.runs.some((r) => r.agentId === agentId && r.status === 'running')) return null; // one task at a time per agent
  const cands = s.tasks.filter((t) => t.assignee === agentId && t.status === 'todo' && !t.lock && !isBlocked(s, t));
  cands.sort((x, y) => PRIORITY[x.priority] - PRIORITY[y.priority] || x.createdAt - y.createdAt);
  return cands[0] || null;
}

export function claim(s, taskId, agentId, at = now()) {
  const t = getTask(s, taskId);
  const a = getAgent(s, agentId);
  if (t.assignee !== agentId) throw new Error('task is not assigned to this agent');
  if (t.lock && t.lock.expiresAt > at) throw new Error('task already locked');
  if (t.status !== 'todo') throw new Error('task is not ready');
  if (s.runs.some((r) => r.agentId === agentId && r.status === 'running')) throw new Error('agent already running a task');
  if (isBlocked(s, t)) throw new Error('task is blocked');
  if (a.paused) throw new Error('agent is paused');
  if (budgetState(s, a, at) === 'exhausted') throw new Error('agent budget exhausted');
  const run = { id: id(s, 'rn'), taskId, agentId, startedAt: at, endedAt: null, status: 'running', output: '', costUsd: 0 };
  s.runs.unshift(run);
  if (s.runs.length > 5000) s.runs.length = 5000;
  t.lock = { runId: run.id, agentId, expiresAt: at + LOCK_MS };
  t.status = 'in_progress';
  t.attempts += 1;
  t.updatedAt = at;
  a.status = 'working';
  a.lastHeartbeat = at;
  log(s, 'run', `${a.name} started “${t.title}”`, { taskId, agentId, runId: run.id });
  return { run, task: t, prompt: buildPrompt(s, t) };
}

export function completeRun(s, runId, { ok = true, output = '', costUsd = 0 } = {}, at = now()) {
  const run = s.runs.find((r) => r.id === runId);
  if (!run) throw new Error('run not found');
  if (run.status !== 'running') throw new Error('run already finished');
  const t = getTask(s, run.taskId);
  const a = getAgent(s, run.agentId);
  run.endedAt = at;
  run.status = ok ? 'succeeded' : 'failed';
  run.output = String(output).slice(-20000);
  run.costUsd = Math.max(0, Number(costUsd) || 0);
  t.costUsd += run.costUsd;
  t.lock = null;
  a.status = 'idle';
  a.lastHeartbeat = at;
  if (output) addComment(s, t.id, { author: a.name, text: run.output.slice(-4000) });
  if (ok) {
    t.status = t.requiresApproval ? 'review' : 'done';
    log(s, 'run', `${a.name} finished “${t.title}” ($${run.costUsd.toFixed(2)})${t.requiresApproval ? ' — awaiting approval' : ''}`, { taskId: t.id, agentId: a.id, runId });
  } else {
    t.status = t.attempts >= t.maxAttempts ? 'failed' : 'todo';
    log(s, 'run', `${a.name} failed “${t.title}” (attempt ${t.attempts}/${t.maxAttempts})`, { taskId: t.id, agentId: a.id, runId });
  }
  const b = budgetState(s, a, at);
  if (b !== 'ok') log(s, 'budget', `${a.name} budget ${b === 'exhausted' ? 'EXHAUSTED — dispatch stopped' : 'above 80 %'}: $${spend(s, { agentId: a.id, at }).toFixed(2)} / $${a.monthlyBudgetUsd}`, { agentId: a.id });
  t.updatedAt = at;
  return run;
}

export function expireLocks(s, at = now()) {
  const expired = [];
  for (const t of s.tasks) {
    if (t.lock && t.lock.expiresAt <= at) {
      const run = s.runs.find((r) => r.id === t.lock.runId);
      if (run && run.status === 'running') completeRun(s, run.id, { ok: false, output: 'Run timed out (lock expired).' }, at);
      else t.lock = null;
      expired.push(t.id);
    }
  }
  return expired;
}

export function approve(s, taskId, { by = 'human', note } = {}) {
  const t = getTask(s, taskId);
  if (t.status !== 'review') throw new Error('task is not awaiting review');
  t.status = 'done';
  if (note) addComment(s, t.id, { author: by, text: '✅ Approved: ' + note });
  log(s, 'governance', `Approved “${t.title}”`, { taskId: t.id });
  return t;
}

export function reject(s, taskId, { by = 'human', note = 'Please revise.' } = {}) {
  const t = getTask(s, taskId);
  if (t.status !== 'review') throw new Error('task is not awaiting review');
  t.status = 'todo';
  t.attempts = 0;
  addComment(s, t.id, { author: by, text: '↩︎ Changes requested: ' + note });
  log(s, 'governance', `Requested changes on “${t.title}”`, { taskId: t.id });
  return t;
}

/** The context an agent receives: company mission → goal → task → blockers' results → discussion. */
export function buildPrompt(s, t) {
  const goal = s.goals.find((g) => g.id === t.goalId);
  const parts = [];
  parts.push(`You are an agent at ${s.company.name}.${s.company.mission ? ' Mission: ' + s.company.mission : ''}`);
  const a = t.assignee && s.agents.find((x) => x.id === t.assignee);
  if (a) parts.push(`Your role: ${a.role}.`);
  if (goal) parts.push(`\nGOAL: ${goal.title}\n${goal.description}`.trimEnd());
  parts.push(`\nTASK: ${t.title}\n${t.description}`.trimEnd());
  const deps = t.blockedBy.map((b) => s.tasks.find((x) => x.id === b)).filter(Boolean);
  if (deps.length) {
    parts.push('\nCOMPLETED PREREQUISITES:');
    for (const d of deps) parts.push(`- ${d.title}: ${(d.comments.at(-1)?.text || '').slice(0, 1500)}`);
  }
  if (t.comments.length) {
    parts.push('\nDISCUSSION:');
    for (const c of t.comments.slice(-8)) parts.push(`[${c.author}] ${c.text.slice(0, 2000)}`);
  }
  parts.push('\nDo the task. Reply with the result and a one-line summary at the end.');
  return parts.join('\n');
}

// ------------------------------------------------------------------ routines
export function createRoutine(s, r) {
  if (!r?.title || !r.agentId) throw new Error('routine title and agentId required');
  getAgent(s, r.agentId);
  const routine = {
    id: id(s, 'rt'),
    title: r.title,
    description: r.description || '',
    agentId: r.agentId,
    goalId: r.goalId || null,
    everyMinutes: Math.max(1, Number(r.everyMinutes) || 60),
    requiresApproval: !!r.requiresApproval,
    enabled: r.enabled !== false,
    nextAt: now() + Math.max(1, Number(r.everyMinutes) || 60) * 60000,
  };
  s.routines.push(routine);
  log(s, 'routine', `Routine “${routine.title}” every ${routine.everyMinutes} min → ${getAgent(s, r.agentId).name}`, { routineId: routine.id });
  return routine;
}

export function tickRoutines(s, at = now()) {
  const created = [];
  for (const r of s.routines) {
    if (!r.enabled || r.nextAt > at) continue;
    // Don't pile up: skip if the previous instance is still open.
    const open = s.tasks.some((t) => t.routineId === r.id && !['done', 'failed'].includes(t.status));
    r.nextAt = at + r.everyMinutes * 60000;
    if (open) continue;
    const t = createTask(s, { title: `${r.title} · ${new Date(at).toISOString().slice(0, 16).replace('T', ' ')}`, description: r.description, assignee: r.agentId, goalId: r.goalId, requiresApproval: r.requiresApproval, source: 'routine' });
    t.routineId = r.id;
    created.push(t);
  }
  return created;
}

/** Parse cost from agent output: Claude Code JSON (total_cost_usd), `COST_USD=0.12`, or `cost: $0.12`. */
export function parseCost(output) {
  const s = String(output || '');
  const m = s.match(/"total_cost_usd"\s*:\s*([\d.]+)/) || s.match(/COST_USD\s*=\s*([\d.]+)/i) || s.match(/cost[:=]\s*\$?([\d.]+)/i);
  return m ? Number(m[1]) : 0;
}

/** Pull a readable result out of Claude Code `--output-format json`, otherwise return trimmed text. */
export function parseOutput(output) {
  const s = String(output || '').trim();
  try {
    const j = JSON.parse(s);
    if (j && typeof j.result === 'string') return j.result;
  } catch {
    /* plain text */
  }
  return s;
}

export function summary(s, at = now()) {
  const by = (st) => s.tasks.filter((t) => t.status === st).length;
  return {
    tasks: Object.fromEntries(STATUSES.map((st) => [st, by(st)])),
    agents: s.agents.length,
    working: s.agents.filter((a) => a.status === 'working').length,
    spendMonth: spend(s, { at }),
    awaitingReview: by('review'),
  };
}
