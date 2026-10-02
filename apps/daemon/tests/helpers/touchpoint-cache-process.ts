/** Real child-process witness. Fault injection is confined to this OS process. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createTouchpointContentCache } from '../../src/routes/touchpoint-content-cache.js';

const dataDir = process.argv[2]!;
const cache = createTouchpointContentCache(dataDir);
const key = { scope: 'production:A', placementKey: 'opend.home.campaign-modal', locale: 'en-US' };
const alias = { ...key, locale: 'zh-TW' };
const account = { ...key, scope: 'production:B' };
const entry = 'export function mount() {}';
const digest = `sha256:${createHash('sha256').update(entry).digest('hex')}`;
const original = { writeFileSync: fs.writeFileSync, renameSync: fs.renameSync, rmSync: fs.rmSync };
function grant() {
  const now = Date.now();
  return {
    activityId: 'activity-1', deploymentId: 'deployment-1', touchpointDecisionId: 'decision-1',
    placementKey: key.placementKey, serverTime: new Date(now).toISOString(), startsAt: new Date(now - 60_000).toISOString(),
    endsAt: new Date(now + 3_600_000).toISOString(), authorizationExpiresAt: new Date(now + 60_000).toISOString(),
    content: { id: 'version-1', placementKey: key.placementKey, locale: key.locale,
      manifest: { resources: ['entry.js'], placements: [{ key: key.placementKey, entry: 'entry.js' }] },
      manifestHash: 'sha256:manifest', entryPath: 'entry.js', entryDigest: digest, entryModule: entry,
      resources: [{ path: 'entry.js', digest, bytes: Buffer.from(entry).toString('base64') }],
      runtime: { kind: 'web-component', apiVersion: 1 }, buildIdentity: { fingerprint: 'process-fixture' },
    },
  };
}
const refusal = () => { throw Object.assign(new Error('injected child-only storage failure'), { code: 'EACCES' }); };
process.on('message', (message: { command: string; status?: number; fault?: string }) => {
  if (message.command === 'seed') {
    for (const candidate of [key, alias, account]) {
      cache.held(candidate); const ticket = cache.ticket(candidate);
      cache.remember(candidate, grant(), ticket); cache.finishTicket(ticket);
    }
  } else if (message.command === 'refuse') {
    if (message.fault === 'rename') fs.renameSync = refusal;
    if (message.fault === 'delete') fs.rmSync = refusal;
    if (message.fault === 'all') { fs.writeFileSync = refusal; fs.renameSync = refusal; fs.rmSync = refusal; }
    if (message.status === 410) cache.forgetWithdrawn(key, { error: 'production_runtime_revoked', receipt: {
      activityId: 'activity-1', deploymentId: 'deployment-1', contentVersionId: 'version-1', touchpointDecisionId: 'decision-1',
    } });
    else if (message.status === 401 || message.status === 403) cache.refuseScope(key.scope);
    else cache.refuseReplay(key, 404);
  } else if (message.command === 'recover') {
    Object.assign(fs, original);
    cache.held(key); // Same recovery operation performed before a real proxy request's ticket.
  } else if (message.command === 'fresh') {
    cache.held(key); const ticket = cache.ticket(key);
    cache.remember(key, grant(), ticket); cache.finishTicket(ticket);
  }
  const replay = (candidate: typeof key) => cache.replayOffline(candidate, 'upstream_unreachable')?.deploymentId ?? null;
  process.send?.({ command: message.command, pid: process.pid, key: replay(key), alias: replay(alias), account: replay(account) });
});
process.send?.({ command: 'ready', pid: process.pid });
