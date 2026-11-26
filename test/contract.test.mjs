import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { DatabaseSync } from 'node:sqlite';
import { quotaProviderSchemasV1 } from '@openchamber/sdk/schemas';

const API_PORT = 18091;
const SERVICE_PORT = 18092;
const TOKEN = 'contract-test-token';
const NOW = Date.now();
const DATA_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '.tmp-data');
const DB_PATH = path.join(path.dirname(new URL(import.meta.url).pathname), '.tmp-opencode.db');

const FALLBACK_KEY = 'sk-opencode-fallback-9999';
const HOST_KEY = 'sk-host-supplied-1234';

// The mock mirrors the real payload shapes: 5h / weekly caps in dollars, a
// remaining monthly balance, and a plan id the extension maps to a cap.
const mock = http.createServer((request, response) => {
  const authorization = request.headers.authorization ?? '';
  const key = authorization.replace(/^Bearer\s+/i, '');
  const send = (status, body) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  if (!key || key.includes('badkey')) return send(401, { error: 'unauthorized' });

  // An unknown plan has no known monthly cap, which is the branch that falls
  // back to a plain balance row.
  const unknownPlan = key.includes('noplan');
  const planId = unknownPlan ? 'enterprise-unknown' : 'individual-goat';

  const requestPath = (request.url ?? '').split('?')[0];
  if (requestPath === '/alpha/whoami') {
    return send(200, { user: { id: 'u_1', name: 'Tester', userName: 'tester' }, org: null });
  }
  if (requestPath === '/alpha/billing/credits') {
    return send(200, {
      credits: { monthlyCredits: 18.5, purchasedCredits: 0, freeCredits: 2, belowThreshold: false, creditThreshold: 1 },
      windowLimits: {
        limited: true,
        exceeded: null,
        fiveHour: { used: 1.23, cap: 14, exceeded: false, resetAt: NOW + 3_600_000 },
        weekly: { used: 12.5, cap: 40, exceeded: false, resetAt: NOW + 3 * 86_400_000 },
      },
    });
  }
  if (requestPath === '/alpha/billing/subscriptions') {
    return send(200, {
      success: true,
      data: { planId, status: 'active', currentPeriodEnd: NOW + 12 * 86_400_000 },
    });
  }
  send(404, { error: 'not found' });
});

const seedOpencodeDb = () => {
  fs.rmSync(DB_PATH, { force: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('create table credential (id text primary key, integration_id text, label text, value text, connector_id text, method_id text, active integer, time_created integer, time_updated integer)');
  db.prepare('insert into credential (id, integration_id, label, value, active, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?)')
    .run('cred_1', 'commandcode', 'CommandCode', JSON.stringify({ type: 'key', key: FALLBACK_KEY }), 1, NOW, NOW);
  db.close();
};

fs.rmSync(DATA_DIR, { recursive: true, force: true });
seedOpencodeDb();
await new Promise((resolve) => mock.listen(API_PORT, '127.0.0.1', resolve));

process.env.OPENCHAMBER_SERVICE_PORT = String(SERVICE_PORT);
process.env.OPENCHAMBER_SERVICE_TOKEN = TOKEN;
process.env.OPENCHAMBER_SERVICE_DATA_DIR = DATA_DIR;
process.env.OPENCODE_DB_PATH = DB_PATH;
process.env.COMMANDCODE_API_BASE = `http://127.0.0.1:${API_PORT}`;
process.env.COMMAND_CODE_API_KEY = '';
delete process.env.COMMANDCODE_MONTHLY_CAP;

await import('../service/main.js');

const call = async (method, requestPath, body) => {
  const response = await fetch(`http://127.0.0.1:${SERVICE_PORT}${requestPath}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

const readQuota = async (credentials, requestId) => {
  const answer = await call('POST', '/quota', {
    v: 1,
    requestId,
    method: 'usage.read',
    provider: 'ext-commandcode-usage',
    input: { credentials },
  });
  assert.equal(answer.status, 200, `quota answered HTTP ${answer.status}`);
  const envelope = quotaProviderSchemasV1.envelope.safeParse(answer.body);
  assert.equal(envelope.success, true, `envelope rejected: ${JSON.stringify(envelope.error?.issues)}`);
  const data = quotaProviderSchemasV1.data['usage.read'].safeParse(envelope.data.data);
  assert.equal(data.success, true, `usage.read rejected: ${JSON.stringify(data.error?.issues)}`);
  return data.data;
};

const waitForHealth = async () => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${SERVICE_PORT}/health`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('service did not become healthy');
};

try {
  await waitForHealth();

  // 1. No stored override, no env key: the read-only OpenCode credential is
  //    what the extension panel shows.
  const fallbackStatus = await call('GET', '/status');
  assert.equal(fallbackStatus.body.configured, true, 'the OpenCode credential must be found');
  assert.equal(fallbackStatus.body.source, 'opencode', `unexpected source: ${fallbackStatus.body.source}`);

  // 2. The host path: OpenChamber passes the provider credential in the request.
  const fromHost = await readQuota({ commandcode: { type: 'api', key: HOST_KEY } }, 'contract-host');
  assert.equal(fromHost.ok, true);
  assert.equal(fromHost.configured, true);
  assert.equal(fromHost.planLabel, 'GOAT', 'the plan label comes from the subscription plan id');
  assert.deepEqual(Object.keys(fromHost.usage.windows).sort(), ['5h', 'monthly', 'weekly']);

  const windows = fromHost.usage.windows;
  assert.equal(windows['5h'].usedPercent.toFixed(4), '8.7857');
  assert.equal(windows['5h'].valueLabel, '$1.23 / $14.00');
  assert.equal(windows['5h'].windowSeconds, 18_000);
  assert.deepEqual(windows['5h'].value, { kind: 'spend', spent: 1.23, limit: 14 });

  assert.equal(windows.weekly.usedPercent, 31.25);
  assert.equal(windows.weekly.valueLabel, '$12.50 / $40.00');
  assert.equal(windows.weekly.windowSeconds, 604_800);

  // 3. The month is a single window with a known cap: 70 - 18.5 spent.
  assert.equal(windows.monthly.valueLabel, '$18.50 / $70.00');
  assert.equal(windows.monthly.value.limit, 70);
  assert.equal(windows.monthly.value.spent.toFixed(4), '51.5000');
  assert.equal(windows.monthly.usedPercent.toFixed(4), '73.5714');
  assert.equal(windows.monthly.resetAt, NOW + 12 * 86_400_000);

  // 4. Empty credentials fall back to the stored sources instead of failing.
  const withoutHost = await readQuota({}, 'contract-fallback');
  assert.equal(withoutHost.configured, true);
  assert.equal(withoutHost.planLabel, 'GOAT');

  // 5. An unknown plan keeps the balance row and drops the invented percentage.
  const unknownPlan = await readQuota({ commandcode: { type: 'api', key: 'sk-noplan-0001' } }, 'contract-noplan');
  assert.deepEqual(Object.keys(unknownPlan.usage.windows).sort(), ['5h', 'credits_balance', 'weekly']);
  assert.equal(unknownPlan.usage.windows.credits_balance.valueLabel, '$18.50');
  assert.equal(unknownPlan.usage.windows.credits_balance.usedPercent, null);
  assert.equal(unknownPlan.planLabel, 'enterprise-unknown', 'an unknown plan id falls back to itself as the label');

  // 6. A rejected key never overwrites a working one.
  const rejected = await call('POST', '/credential', { key: 'badkey-0000' });
  assert.equal(rejected.status, 401);
  const afterReject = await call('GET', '/status');
  assert.equal(afterReject.body.source, 'opencode', 'a rejected key must not be stored');

  // 7. A saved override wins over every other source.
  const saved = await call('POST', '/credential', { key: 'sk-panel-override-7777' });
  assert.equal(saved.status, 200);
  const overrideStatus = await call('GET', '/status');
  assert.equal(overrideStatus.body.source, 'stored');
  assert.equal(overrideStatus.body.hint, '…7777');

  const cleared = await call('DELETE', '/credential');
  assert.equal(cleared.status, 200);
  const backToFallback = await call('GET', '/status');
  assert.equal(backToFallback.body.source, 'opencode');

  console.log('contract test passed');
} finally {
  mock.close();
  fs.rmSync(DB_PATH, { force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  process.exit(0);
}
