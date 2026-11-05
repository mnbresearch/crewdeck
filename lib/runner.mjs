// Agent adapters (Node only). Each returns { ok, output, costUsd }.
import { spawn } from 'node:child_process';
import { parseCost, parseOutput } from './engine.mjs';

export const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** shell: run any CLI agent. `{prompt}` is replaced with the shell-quoted prompt; it is also on stdin and in $CREWDECK_PROMPT. */
export function runShell(adapter, prompt, ctx = {}) {
  const tpl = adapter.command || 'echo {prompt}';
  const cmd = tpl.includes('{prompt}') ? tpl.replaceAll('{prompt}', shQuote(prompt)) : tpl;
  const timeoutMs = (Number(adapter.timeoutSec) || 900) * 1000;
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', cmd], {
      cwd: adapter.cwd || process.cwd(),
      env: { ...process.env, CREWDECK_PROMPT: prompt, CREWDECK_TASK_ID: ctx.taskId || '', CREWDECK_RUN_ID: ctx.runId || '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    const add = (d) => {
      out += d;
      if (out.length > 200000) out = out.slice(-100000);
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    child.stdin.on('error', () => {}); // agent may exit without reading stdin
    child.stdin.end(tpl.includes('{prompt}') ? '' : prompt);
    const timer = setTimeout(() => {
      add(`\n[crewdeck] timed out after ${timeoutMs / 1000}s`);
      child.kill('SIGTERM');
    }, timeoutMs);
    child.on('error', (e) => add(`\n[crewdeck] ${e.message}`));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: parseOutput(out) + (code ? `\n[exit ${code}]` : ''), costUsd: parseCost(out) });
    });
  });
}

/** http: POST the task to a webhook/bot; expects JSON { ok?, output, costUsd? } back. */
export async function runHttp(adapter, prompt, ctx = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), (Number(adapter.timeoutSec) || 300) * 1000);
  try {
    const res = await fetch(adapter.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(adapter.headers || {}) },
      body: JSON.stringify({ prompt, taskId: ctx.taskId, runId: ctx.runId, title: ctx.title }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let j = null;
    try {
      j = JSON.parse(text);
    } catch {
      /* plain */
    }
    return { ok: res.ok && j?.ok !== false, output: j?.output ?? text, costUsd: Number(j?.costUsd) || parseCost(text) };
  } catch (e) {
    return { ok: false, output: `[crewdeck] http adapter: ${e.message}`, costUsd: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/** sim: a simulated agent for demos and tests. */
export function runSim(adapter, prompt, ctx = {}) {
  const ms = 1500 + Math.random() * 4000;
  const fail = Math.random() < (adapter.failRate ?? 0.1);
  return new Promise((r) =>
    setTimeout(
      () =>
        r({
          ok: !fail,
          output: fail ? 'Simulated failure: upstream tool timed out.' : simulatedResult(ctx.title || 'task'),
          costUsd: +(0.02 + Math.random() * 0.25).toFixed(3),
        }),
      ms,
    ),
  );
}

export function simulatedResult(title) {
  const verbs = ['Drafted', 'Analysed', 'Implemented', 'Reviewed', 'Researched', 'Summarised'];
  const v = verbs[Math.floor(Math.random() * verbs.length)];
  return `${v} “${title}”.\n- Gathered context from goal and prerequisites\n- Produced deliverable and checked it against acceptance criteria\nSummary: ${v.toLowerCase()} and ready for the next step.`;
}

export function runAdapter(adapter, prompt, ctx) {
  if (adapter.type === 'shell') return runShell(adapter, prompt, ctx);
  if (adapter.type === 'http') return runHttp(adapter, prompt, ctx);
  if (adapter.type === 'sim') return runSim(adapter, prompt, ctx);
  return Promise.resolve({ ok: false, output: `adapter ${adapter.type} is not auto-dispatched`, costUsd: 0 });
}
