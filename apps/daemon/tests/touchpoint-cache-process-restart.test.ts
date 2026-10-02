// Real SIGKILL and fresh process, rather than a second instance in one VM.
import { fork, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function recordEvidence(value: object) {
  console.info(JSON.stringify(value));
  const log = process.env.CMS_CACHE_PROCESS_RECEIPTS;
  if (log) appendFileSync(log, `${JSON.stringify(value)}\n`);
}

type Receipt = { command: string; pid: number; key: string | null; alias: string | null; account: string | null };
const fixture = fileURLToPath(new URL('./helpers/touchpoint-cache-process.ts', import.meta.url));
async function start(dataDir: string) {
  const child = fork(fixture, [dataDir], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  const waitMessage = () => new Promise<Receipt>((resolve, reject) => {
    const onExit = (code: number | null, signal: string | null) => reject(new Error(`child exited ${code}/${signal}: ${stderr}`));
    child.once('exit', onExit);
    child.once('message', result => { child.off('exit', onExit); resolve(result as Receipt); });
  });
  await waitMessage();
  return { child, send: async (message: object) => { const pending = waitMessage(); child.send(message); return pending; } };
}
async function terminate(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  child.kill('SIGKILL');
  const result = await exited;
  expect(result).toEqual({ code: null, signal: 'SIGKILL' });
  return { pid: child.pid, ...result };
}

describe('touchpoint authority across OS process death', () => {
  it.each([401, 403, 404, 410])('persists %s through successful/fallback refusal and process restart', async status => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'touchpoint-process-'));
    const children: ChildProcess[] = [];
    try {
      const first = await start(dataDir); children.push(first.child);
      expect((await first.send({ command: 'seed' })).key).toBe('deployment-1');
      const refused = await first.send({ command: 'refuse', status, fault: status === 410 ? 'delete' : 'rename' });
      expect(refused.key).toBeNull();
      // A global write fault can prevent unrelated clock high-water persistence too;
      // account isolation is checked after the storage fault dies with this process.
      const exit = await terminate(first.child);
      const second = await start(dataDir); children.push(second.child);
      const restarted = await second.send({ command: 'probe' });
      expect(restarted.pid).not.toBe(refused.pid);
      expect(restarted.key).toBeNull(); expect(restarted.account).toBe('deployment-1');
      expect(restarted.alias).toBe(status === 404 ? 'deployment-1' : null);
      expect((await second.send({ command: 'fresh' })).key).toBe('deployment-1');
      recordEvidence({ case: `persist-${status}`, refused, exit, restarted });
    } finally { for (const child of children.reverse()) await terminate(child); rmSync(dataDir, { recursive: true, force: true }); }
  });
  it.each([401, 410])('persists recovered %s before death across all affected locales', async status => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'touchpoint-process-'));
    const children: ChildProcess[] = [];
    try {
      const first = await start(dataDir); children.push(first.child);
      await first.send({ command: 'seed' });
      expect((await first.send({ command: 'refuse', status, fault: 'all' })).key).toBeNull();
      const recovered = await first.send({ command: 'recover' });
      expect(recovered.key).toBeNull(); expect(recovered.alias).toBeNull();
      const exit = await terminate(first.child);
      const second = await start(dataDir); children.push(second.child);
      const restarted = await second.send({ command: 'probe' });
      expect(restarted.key).toBeNull(); expect(restarted.alias).toBeNull(); expect(restarted.account).toBe('deployment-1');
      recordEvidence({ case: `recovered-${status}`, recovered, exit, restarted });
    } finally { for (const child of children.reverse()) await terminate(child); rmSync(dataDir, { recursive: true, force: true }); }
  });
  it('documents lost withdrawal when every persistence path fails and the process dies before storage recovery', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'touchpoint-process-'));
    const children: ChildProcess[] = [];
    try {
      const first = await start(dataDir); children.push(first.child);
      await first.send({ command: 'seed' });
      const refused = await first.send({ command: 'refuse', status: 410, fault: 'all' });
      expect(refused.key).toBeNull(); expect(refused.alias).toBeNull();
      const exit = await terminate(first.child);
      // Injection dies with the OS process: disk is writable again, but no refusal was persisted.
      const second = await start(dataDir); children.push(second.child);
      const restarted = await second.send({ command: 'probe' });
      expect(restarted.key).toBe('deployment-1'); expect(restarted.alias).toBe('deployment-1');
      recordEvidence({ case: 'known-unpersisted-death-limit', refused, exit, restarted });
    } finally { for (const child of children.reverse()) await terminate(child); rmSync(dataDir, { recursive: true, force: true }); }
  });
});
