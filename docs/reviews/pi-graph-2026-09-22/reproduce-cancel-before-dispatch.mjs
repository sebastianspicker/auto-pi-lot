// Offline reproduction for the 2026-09-22 pi-graph review.
// Usage: Node 24 <this script> <built pi-graph checkout>
// Uses an isolated temporary database; no provider requests or original-state writes.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
if (!process.argv[2]) throw new Error('Supply the path to a built pi-graph checkout');
const fromDist = (path) => import(pathToFileURL(resolve(process.argv[2], 'dist', path)).href);

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { Store } = await fromDist('adapters/sqlite/store.js');
const { openRunAccount, runAccountSnapshot } = await fromDist('adapters/sqlite/run-account.js');
const { admitModelCall, uncertainModelCall, settleModelCall } = await fromDist('adapters/sqlite/model-calls.js');

const root = await mkdtemp(join(tmpdir(), 'pi-graph-predispatch-'));
const store = new Store(join(root, 'state.sqlite'));
const deadline = Date.now() + 60000;
const allowance = { maxTurns: 8, maxCostUsd: null, verificationTurns: 1, verificationCostUsd: 0, deadline };
const request = { requestDigest: 'a'.repeat(64), routeDigest: 'b'.repeat(64), visibleBytes: 10, estimatedTokens: 10, method: 'conservative-bytes', segment: 0 };
try {
  await store.ready;
  await openRunAccount(store.db, 'run', allowance);
  await store.prepareAttempt('first', {runId: 'run', role: 'implementer'});
  await store.prepareAttempt('second', {runId: 'run', role: 'implementer'});
  const callId = await admitModelCall(store.db, 'first', {maxTurns: 3, deadline}, request);
  console.log('after admit', await store.db.get('SELECT state,admission FROM pg_model_calls WHERE id=?', [callId]));
  await uncertainModelCall(store.db, callId);
  console.log('after predispatch cancellation', await store.db.get('SELECT state,admission FROM pg_model_calls WHERE id=?', [callId]));
  console.log('account', await runAccountSnapshot(store.db, 'run'));
  console.log('last event', (await store.listEvents('run')).at(-1)?.type);
  for (const [label, action] of [
    ['new request', () => admitModelCall(store.db, 'second', {maxTurns: 3, deadline}, request)],
    ['direct settlement', () => settleModelCall(store.db, callId, {id: `${callId}:usage`, attemptId: 'first', kind: 'model', source: 'model', currency: 'USD', quality: 'estimated', data: {turns: 0, costUsd: 0}})],
    ['reconciliation', async () => {
      const decision = {schemaVersion: 1, kind: 'operator-charge', routeDigest: request.routeDigest, costUsd: 0, reason: 'Known to have stopped before dispatch'};
      const preview = await store.reconciliationPreview('run', callId, decision);
      console.log('preview', {state: preview.state, dispatched: preview.dispatched});
      return store.applyReconciliation('run', callId, decision, preview.digest);
    }],
  ]) {
    try { console.log(label, 'result', await action()); }
    catch (error) { console.log(label, 'rejected', error.message); }
  }
  console.log('final state', await store.db.get('SELECT state FROM pg_model_calls WHERE id=?', [callId]));
} finally {
  await store.close();
  await rm(root, {recursive: true, force: true});
}
