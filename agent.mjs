#!/usr/bin/env node
// Remote CrewDeck worker: run on any machine, it heartbeats, claims tasks and runs a CLI agent.
//   CREWDECK_URL=http://localhost:7777 node agent.mjs --agent ag_3 --cmd 'claude -p {prompt} --output-format json'
//   node agent.mjs --agent ag_4 --cmd 'codex exec {prompt}' --every 20
import { runShell } from './lib/runner.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf('--' + n);
  return i >= 0 ? args[i + 1] : d;
};
const BASE = (flag('url', process.env.CREWDECK_URL) || 'http://127.0.0.1:7777').replace(/\/$/, '');
const AGENT = flag('agent', process.env.CREWDECK_AGENT);
const CMD = flag('cmd', process.env.CREWDECK_CMD);
const EVERY = Number(flag('every', 15)) * 1000;
const TOKEN = process.env.CREWDECK_TOKEN;
if (!AGENT || !CMD) {
  console.error('usage: node agent.mjs --agent <agentId> --cmd "<command with {prompt}>" [--url http://host:7777] [--every 15]');
  process.exit(1);
}
const headers = { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) };
const post = async (path, body) => {
  const r = await fetch(BASE + path, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
};

async function loop() {
  try {
    const hb = await post(`/api/agents/${AGENT}/heartbeat`);
    if (hb.idle) {
      if (hb.paused || hb.budget === 'exhausted') console.log(`[${new Date().toISOString()}] idle (${hb.paused ? 'paused' : 'budget exhausted'})`);
    } else {
      console.log(`[${new Date().toISOString()}] ▶ ${hb.task.title}`);
      const result = await runShell({ command: CMD, timeoutSec: Number(flag('timeout', 1800)) }, hb.prompt, { taskId: hb.task.id, runId: hb.run.id });
      await post(`/api/runs/${hb.run.id}/complete`, result);
      console.log(`  ${result.ok ? '✓' : '✗'} $${result.costUsd.toFixed(3)}`);
      return setTimeout(loop, 500); // look for more work right away
    }
  } catch (e) {
    console.error('heartbeat failed:', e.message);
  }
  setTimeout(loop, EVERY);
}
console.log(`CrewDeck worker ${AGENT} → ${BASE}  cmd: ${CMD}`);
loop();
