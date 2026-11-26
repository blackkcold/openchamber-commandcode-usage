import assert from 'node:assert/strict';
import http from 'node:http';

import { quotaProviderSchemasV1 } from '@openchamber/sdk/schemas';

const API_PORT = 18091;
const SERVICE_PORT = 18092;
const TOKEN = 'contract-test-token';
const NOW = Date.now();
const DATA_DIR = new URL('./.tmp-data', import.meta.url).pathname;

const mock = http.createServer((request, response) => {
  const authorization = request.headers.authorization ?? '';
  const send = (status, body) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  if (!authorization || authorization.includes('badkey')) return send(401, { error: 'unauthorized' });
  const path = (request.url ?? '').split('?')[0];
  if (path === '/alpha/whoami') return send(200, { user: { id: 'u_1', name: 'Tester', userName: 'tester' } });
  if (path === '/alpha/billing/credits') {
    return send(200, {
      credits: { monthlyCredits: 18.5, purchasedCredits: 0, freeCredits: 2, planId: 'individual-goat' },
      windowLimits: {
        limited: false,
        exceeded: null,
        fiveHour: { used: 1.23, cap: 5, exceeded: false, resetAt: NOW + 3_600_000 },
        weekly: { used: 12.5, cap: 40, exceeded: false, resetAt: NOW + 3 * 86_400_000 },
      },
    });
  }
  if (path === '/alpha/billing/subscriptions') {
    return send(200, {
      success: true,
      data: { planId: 'individual-goat', status: 'active', currentPeriodEnd: NOW + 12 * 86_400_000 },
    });
  }
  send(404, { error: 'not found' });
});

await new Promise((resolve) => mock.listen(API_PORT, '127.0.0.1', resolve));

process.env.OPENCHAMBER_SERVICE_PORT = String(SERVICE_PORT);
process.env.OPENCHAMBER_SERVICE_TOKEN = TOKEN;
process.env.OPENCHAMBER_SERVICE_DATA_DIR = DATA_DIR;
process.env.COMMANDCODE_API_BASE = `http://127.0.0.1:${API_PORT}`;
process.env.COMMAND_CODE_API_KEY = '';

await import('../service/main.js');

const call = async (method, path, body) => {
  const response = await fetch(`http://127.0.0.1:${SERVICE_PORT}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
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

  const rejected = await call('POST', '/credential', { key: 'badkey-0000' });
  assert.equal(rejected.status, 401, 'a rejected key must not be stored');

  const saved = await call('POST', '/credential', { key: 'sk-contract-test-1234' });
  assert.equal(saved.status, 200);

  const status = await call('GET', '/status');
  assert.equal(status.body.configured, true);

  const usage = await call('GET', '/usage');
  assert.equal(usage.body.ok, true);
  assert.equal(usage.body.report.plan.label, 'GOAT');

  const quota = await call('POST', '/quota', {
    v: 1,
    requestId: 'contract-1',
    method: 'usage.read',
    provider: 'ext-commandcode-usage',
    input: { credentials: {} },
  });
  assert.equal(quota.status, 200);

  const envelope = quotaProviderSchemasV1.envelope.safeParse(quota.body);
  assert.equal(envelope.success, true, `envelope rejected: ${JSON.stringify(envelope.error?.issues)}`);
  const data = quotaProviderSchemasV1.data['usage.read'].safeParse(envelope.data.data);
  assert.equal(data.success, true, `usage.read rejected: ${JSON.stringify(data.error?.issues)}`);

  const windows = data.data.usage.windows;
  assert.equal(data.data.configured, true);
  assert.equal(data.data.planLabel, 'GOAT');
  assert.equal(windows['5h'].usedPercent, 24.6);
  assert.equal(windows.weekly.usedPercent, 31.25);
  assert.equal(windows.credits_balance.valueLabel, '$18.50');
  assert.ok(windows.monthly.usedPercent > 70 && windows.monthly.usedPercent < 75);

  const cleared = await call('DELETE', '/credential');
  assert.equal(cleared.status, 200);
  const empty = await call('POST', '/quota', {
    v: 1, requestId: 'contract-2', method: 'usage.read', provider: 'ext-commandcode-usage', input: { credentials: {} },
  });
  assert.equal(empty.body.data.configured, false);

  console.log('contract test passed');
} finally {
  mock.close();
  process.exit(0);
}
