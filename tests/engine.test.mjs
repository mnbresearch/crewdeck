import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../lib/engine.mjs';
import { demoState } from '../lib/demo.mjs';
import { runShell, shQuote } from '../lib/runner.mjs';

const setup = () => {
  const s = E.emptyState();
  const a = E.createAgent(s, { name: 'Forge', role: 'Engineer', adapter: { type: 'sim' }, monthlyBudgetUsd: 1 });
  return { s, a };
};

test('dispatch respects priority, blockers and one-task-per-agent', () => {
  const { s, a } = setup();
  const t1 = E.createTask(s, { title: 'low', assignee: a.id, priority: 'low' });
  const t2 = E.createTask(s, { title: 'urgent', assignee: a.id, priority: 'urgent', blockedBy: [t1.id] });
  const t3 = E.createTask(s, { title: 'high', assignee: a.id, priority: 'high' });
  assert.equal(E.nextTaskFor(s, a.id).id, t3.id); // t2 is blocked
  const { run } = E.claim(s, t3.id, a.id);
  assert.equal(E.nextTaskFor(s, a.id), null); // agent busy
  assert.throws(() => E.claim(s, t3.id, a.id), /locked/);
  E.completeRun(s, run.id, { ok: true, output: 'ok', costUsd: 0.1 });
  assert.equal(E.getTask(s, t3.id).status, 'done');
  assert.equal(E.nextTaskFor(s, a.id).id, t1.id);
  assert.ok(E.isBlocked(s, t2));
});

test('manual claim cannot start a second concurrent task for the same agent', () => {
  const { s, a } = setup();
  const first = E.createTask(s, { title: 'first', assignee: a.id });
  const second = E.createTask(s, { title: 'second', assignee: a.id });
  const { run } = E.claim(s, first.id, a.id);
  assert.throws(() => E.claim(s, second.id, a.id), /agent already running a task/);
  assert.equal(second.status, 'todo');
  assert.equal(second.lock, null);
  E.completeRun(s, run.id, { ok: true });
  assert.doesNotThrow(() => E.claim(s, second.id, a.id));
});

test('manual claim cannot rerun completed or awaiting-approval work', () => {
  const { s, a } = setup();
  const complete = E.createTask(s, { title: 'complete', assignee: a.id });
  const approved = E.createTask(s, { title: 'review', assignee: a.id, requiresApproval: true });
  const r1 = E.claim(s, complete.id, a.id).run;
  E.completeRun(s, r1.id, { ok: true });
  const r2 = E.claim(s, approved.id, a.id).run;
  E.completeRun(s, r2.id, { ok: true });
  assert.throws(() => E.claim(s, complete.id, a.id), /task is not ready/);
  assert.throws(() => E.claim(s, approved.id, a.id), /task is not ready/);
  assert.equal(complete.status, 'done');
  assert.equal(approved.status, 'review');
});

test('budget hard stop pauses dispatch', () => {
  const { s, a } = setup();
  const t = E.createTask(s, { title: 'expensive', assignee: a.id });
  E.createTask(s, { title: 'next', assignee: a.id });
  const { run } = E.claim(s, t.id, a.id);
  E.completeRun(s, run.id, { ok: true, costUsd: 1.5 });
  assert.equal(E.budgetState(s, a), 'exhausted');
  assert.equal(E.nextTaskFor(s, a.id), null);
  assert.ok(s.activity.some((e) => e.type === 'budget'));
});

test('approval flow and retries', () => {
  const { s, a } = setup();
  const t = E.createTask(s, { title: 'needs review', assignee: a.id, requiresApproval: true, maxAttempts: 2 });
  let { run } = E.claim(s, t.id, a.id);
  E.completeRun(s, run.id, { ok: false, output: 'boom' });
  assert.equal(t.status, 'todo');
  ({ run } = E.claim(s, t.id, a.id));
  E.completeRun(s, run.id, { ok: true, output: 'draft' });
  assert.equal(t.status, 'review');
  E.reject(s, t.id, { note: 'more detail' });
  assert.equal(t.status, 'todo');
  assert.match(E.buildPrompt(s, t), /more detail/);
  ({ run } = E.claim(s, t.id, a.id));
  E.completeRun(s, run.id, { ok: true, output: 'v2' });
  E.approve(s, t.id);
  assert.equal(t.status, 'done');
});

test('second failure marks task failed; lock expiry fails run', () => {
  const { s, a } = setup();
  const t = E.createTask(s, { title: 'flaky', assignee: a.id, maxAttempts: 1 });
  E.claim(s, t.id, a.id, 1000);
  E.expireLocks(s, 1000 + E.LOCK_MS + 1);
  assert.equal(t.status, 'failed');
  assert.equal(t.lock, null);
});

test('dependency cycles and org cycles are rejected', () => {
  const { s, a } = setup();
  const t1 = E.createTask(s, { title: 'a' });
  const t2 = E.createTask(s, { title: 'b', blockedBy: [t1.id] });
  assert.throws(() => E.updateTask(s, t1.id, { blockedBy: [t2.id] }), /cycle/);
  const b = E.createAgent(s, { name: 'B', reportsTo: a.id });
  E.updateAgent(s, a.id, { reportsTo: b.id });
  assert.equal(a.reportsTo, null);
});

test('routines create one open task at a time', () => {
  const { s, a } = setup();
  const r = E.createRoutine(s, { title: 'triage', agentId: a.id, everyMinutes: 1 });
  assert.equal(E.tickRoutines(s, r.nextAt).length, 1);
  assert.equal(E.tickRoutines(s, r.nextAt + 60001).length, 0); // previous still open
});

test('prompt carries mission, goal, prerequisites and discussion', () => {
  const s = demoState();
  const spec = s.tasks.find((t) => t.title.includes('spec'));
  const res = E.getTask(s, spec.blockedBy[0]);
  res.status = 'done';
  E.addComment(s, res.id, { author: 'Scout', text: 'Competitor X charges $29' });
  const p = E.buildPrompt(s, spec);
  assert.match(p, /Mission: Ship/);
  assert.match(p, /GOAL: Launch v1/);
  assert.match(p, /Competitor X charges \$29/);
});

test('cost + output parsing', () => {
  assert.equal(E.parseCost('{"type":"result","result":"hi","total_cost_usd":0.0421}'), 0.0421);
  assert.equal(E.parseCost('done\nCOST_USD=1.5'), 1.5);
  assert.equal(E.parseOutput('{"result":"hello"}'), 'hello');
});

test('shell adapter quotes prompts safely and reports exit status', async () => {
  const evil = `it's $(touch /tmp/pwned) "quoted"`;
  const r = await runShell({ command: 'printf %s {prompt}; echo; echo COST_USD=0.25' }, evil);
  assert.equal(r.ok, true);
  assert.match(r.output, /\$\(touch \/tmp\/pwned\)/);
  assert.equal(r.costUsd, 0.25);
  const f = await runShell({ command: 'exit 3' }, 'x');
  assert.equal(f.ok, false);
  assert.equal(shQuote("a'b"), `'a'\\''b'`);
});
