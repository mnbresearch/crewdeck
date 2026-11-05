// Seed a demo company (simulated agents) — used by `--demo`, the UI button and the browser demo.
import { emptyState, createAgent, createGoal, createTask, createRoutine } from './engine.mjs';

export function demoState() {
  const s = emptyState();
  s.company = { name: 'Abrobot Labs', mission: 'Ship a delightful open-source product every month.' };
  const ceo = createAgent(s, { name: 'Atlas', role: 'CEO · planning & delegation', adapter: { type: 'sim' }, monthlyBudgetUsd: 30 });
  const eng = createAgent(s, { name: 'Forge', role: 'Engineer', reportsTo: ceo.id, adapter: { type: 'sim' }, monthlyBudgetUsd: 25, skills: ['typescript', 'tests'] });
  const res = createAgent(s, { name: 'Scout', role: 'Researcher', reportsTo: ceo.id, adapter: { type: 'sim' }, monthlyBudgetUsd: 10, skills: ['web research'] });
  const mkt = createAgent(s, { name: 'Echo', role: 'Growth & content', reportsTo: ceo.id, adapter: { type: 'sim' }, monthlyBudgetUsd: 8 });
  createAgent(s, { name: 'You', role: 'Founder (human)', adapter: { type: 'manual' }, monthlyBudgetUsd: 0 });

  const g = createGoal(s, { title: 'Launch v1 of the status-page product', description: 'Public launch with docs, a landing page and 3 design partners by month end.' });
  const g2 = createGoal(s, { title: 'Grow to 1,000 GitHub stars', description: 'Content, community and integrations.' });

  const t1 = createTask(s, { title: 'Research the top 5 competitors and pricing', assignee: res.id, goalId: g.id, priority: 'high' });
  const t2 = createTask(s, { title: 'Write the v1 technical spec', assignee: ceo.id, goalId: g.id, blockedBy: [t1.id], requiresApproval: true });
  const t3 = createTask(s, { title: 'Implement the uptime checker module', assignee: eng.id, goalId: g.id, blockedBy: [t2.id] });
  createTask(s, { title: 'Add unit tests for the checker', assignee: eng.id, goalId: g.id, blockedBy: [t3.id] });
  createTask(s, { title: 'Draft launch blog post + X thread', assignee: mkt.id, goalId: g2.id, blockedBy: [t2.id], requiresApproval: true });
  createTask(s, { title: 'List 20 communities to share the launch', assignee: res.id, goalId: g2.id, priority: 'low' });
  createTask(s, { title: 'Decide pricing tiers', goalId: g.id });
  createRoutine(s, { title: 'Daily GitHub issues triage', agentId: eng.id, goalId: g2.id, everyMinutes: 1440 });
  createRoutine(s, { title: 'Weekly metrics digest', agentId: mkt.id, everyMinutes: 10080 });
  return s;
}
