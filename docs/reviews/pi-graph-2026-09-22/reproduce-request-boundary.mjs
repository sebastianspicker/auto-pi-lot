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
const { AttemptGate } = await fromDist('domain/agents/attempt-gate.js');
const { installRequestBoundary } = await fromDist('adapters/pi/request-boundary.js');

const root = await mkdtemp(join(tmpdir(), 'pi-boundary-predispatch-'));
const store = new Store(join(root, 'state.sqlite'));
const route = {
  provider: 'openai-codex', model: 'gpt-5.6-luna', api: 'openai-codex-responses',
  endpoint: 'https://chatgpt.com/backend-api', thinkingLevel: 'low',
  credentialSource: {kind: 'pi', authPath: '/operator/auth.json'}, contextWindow: 65536,
};
const model = {
  provider: route.provider, id: route.model, api: route.api, baseUrl: route.endpoint,
  maxTokens: 2048, contextWindow: 65536,
  cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
};
const deadline = Date.now() + 60000;
try {
  await store.ready;
  await store.openRunAccount('run', {
    mode: 'subscription', route, maxTurns: 10, maxCostUsd: null,
    verificationTurns: 1, verificationCostUsd: 0, deadline,
  });
  await store.prepareAttempt('attempt', {runId: 'run', role: 'scout'});
  await store.startAttempt('attempt');
  let calls = 0;
  const request = {
    attemptId: 'attempt', role: 'scout', route,
    limits: {allowanceMode: 'subscription', maxTurns: 1, maxWallTimeMs: 5000, maxToolCalls: 2, maxOutputTokens: 1},
    context: {}, tools: {},
    accounting: {
      admit: (admission) => store.admitModelCall('attempt', {maxTurns: 1, deadline}, admission),
      dispatch: (id) => store.dispatchModelCall(id),
      manifest: async () => { throw new Error('injected manifest persistence failure before dispatch'); },
      uncertain: (id) => store.uncertainModelCall(id),
    },
  };
  const session = {agent: {streamFunction: async (_model, _context, options) => {
    calls++;
    await options.onPayload({model: route.model, input: [{role: 'user', content: 'detached input'}]}, model);
    throw new Error('Should not reach provider');
  }}};
  installRequestBoundary(session, request, new AttemptGate(request.limits));
  try {
    await session.agent.streamFunction(model, {messages: [{role: 'user', content: 'inspect'}]}, {maxTokens: 1});
  } catch (error) { console.log('boundary rejected', error.message); }
  console.log('stream calls', calls);
  console.log('persisted call', await store.db.get('SELECT state,admission FROM pg_model_calls WHERE attempt_id=?', ['attempt']));
  console.log('last event', (await store.listEvents('run')).at(-1)?.type);
  console.log('account uncertain', (await store.runAccountSnapshot('run')).uncertain);
} finally {
  await store.close();
  await rm(root, {recursive: true, force: true});
}
