import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT ?? 0);
const TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
if (!PORT || !TOKEN) {
  console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  process.exit(1);
}

const API_BASE = (process.env.COMMANDCODE_API_BASE ?? 'https://api.commandcode.ai').replace(/\/+$/, '');
const DATA_DIR = process.env.OPENCHAMBER_SERVICE_DATA_DIR
  ?? path.join(os.homedir(), '.config', 'openchamber', 'commandcode-usage');
const CREDENTIAL_PATH = path.join(DATA_DIR, 'credential.json');

const FIVE_HOURS = 5 * 3600;
const ONE_WEEK = 7 * 24 * 3600;
const REQUEST_TIMEOUT_MS = 15_000;
const CACHE_MS = 30_000;
const ERROR_MAX = 2000;
const BODY_MAX = 16 * 1024;

// Command Code meters a plan in "credits". The server reports the monthly
// balance against a fixed cap per plan (GOAT: 70) and never reports a model,
// while the docs price each model's monthly allowance separately: the same 70
// credits buy $100 on DeepSeek V4.1 Flash and $70 on GLM-5.2. Percentages are
// identical either way, so the plan counter stays the source of truth for the
// bar and the model only scales the money shown next to it.
const PLANS = new Map([
  ['individual-go', { name: 'Go', baseCredits: 10 }],
  ['individual-goat', { name: 'GOAT', baseCredits: 70 }],
  ['individual-pro', { name: 'Pro', baseCredits: 30 }],
  ['individual-pro-v1', { name: 'Pro', baseCredits: 80 }],
  ['individual-provider', { name: 'Provider', baseCredits: 15 }],
  ['individual-max', { name: 'Max', baseCredits: 150 }],
  ['individual-ultra', { name: 'Ultra', baseCredits: 300 }],
  ['teams-pro', { name: 'Teams Pro', baseCredits: 40 }],
]);
const PLAN_PREFIXES = [...PLANS.keys()].sort((a, b) => b.length - a.length);

// Monthly allowance in dollars for a GOAT subscription, per the model table on
// commandcode.ai/docs/plans/goat. A model missing here keeps the plan credits
// as dollars, which is the conservative reading.
const MODELS = new Map([
  ['deepseek-v4.1-flash', { name: 'DeepSeek V4.1 Flash', monthlyUsd: 100 }],
  ['glm-5.3-flash', { name: 'GLM-5.3 Flash', monthlyUsd: 100 }],
  ['ling-3.1-flash', { name: 'Ling 3.1 Flash', monthlyUsd: 100 }],
  ['glm-5.2', { name: 'GLM-5.2', monthlyUsd: 70 }],
  ['tencent-hy3', { name: 'Tencent Hy3', monthlyUsd: 70 }],
  ['qwen-3.8-27b', { name: 'Qwen 3.8 27B', monthlyUsd: 70 }],
]);
const DEFAULT_MODEL = 'deepseek-v4.1-flash';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const str = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

const toEpochMs = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value < 1e12 ? value * 1000 : value);
  }
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
};

const planOf = (planId) => {
  const normalized = String(planId ?? '').toLowerCase().replace(/_/g, '-');
  const prefix = PLAN_PREFIXES.find((candidate) => normalized.startsWith(candidate));
  return prefix ? PLANS.get(prefix) : null;
};

const planBaseCredits = (planId) => {
  const override = num(Number(process.env.COMMANDCODE_MONTHLY_CAP));
  if (override !== null && override > 0) return override;
  return planOf(planId)?.baseCredits ?? null;
};

const planLabelOf = (planId) => planOf(planId)?.name ?? str(planId) ?? null;

// The model only decides how many dollars one credit is worth. It is a local
// preference (the server never reports it), so it lives next to the credential.
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');

const readSettings = () => {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    return { model: str(parsed?.model) };
  } catch {
    return { model: null };
  }
};

const writeSettings = (next) => {
  ensureDataDir();
  const temporary = `${SETTINGS_PATH}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, SETTINGS_PATH);
};

const normalizeModelKey = (value) => {
  const requested = String(str(value) ?? '').toLowerCase().replace(/[\s_]+/g, '-');
  if (!requested) return null;
  for (const key of MODELS.keys()) {
    if (requested === key || requested.includes(key)) return key;
  }
  return requested === 'default' ? DEFAULT_MODEL : null;
};

const pricingModel = () => {
  const key = normalizeModelKey(readSettings().model ?? process.env.COMMANDCODE_MODEL) ?? DEFAULT_MODEL;
  const known = MODELS.get(key);
  return { key, label: known?.name ?? key, monthlyUsd: known?.monthlyUsd ?? null };
};

// Credits are the plan's internal unit; the same credit is worth more on a
// model whose monthly allowance is larger. Returns dollars per credit.
const compactMoney = (value) => {
  const rounded = Math.round(value * 100) / 100;
  return `$${Number.isInteger(rounded) ? rounded : rounded.toFixed(2)}`;
};

// ---------------------------------------------------------------- credentials

const ensureDataDir = () => {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
};

const readStoredKey = () => {
  try {
    const parsed = JSON.parse(fs.readFileSync(CREDENTIAL_PATH, 'utf8'));
    return str(parsed?.key);
  } catch {
    return null;
  }
};

const writeStoredKey = (key) => {
  ensureDataDir();
  const temporary = `${CREDENTIAL_PATH}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ key, savedAt: Date.now() }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, CREDENTIAL_PATH);
  try {
    fs.chmodSync(CREDENTIAL_PATH, 0o600);
  } catch {
    // best effort: the file was already created with 0600
  }
};

const clearStoredKey = () => {
  try {
    fs.rmSync(CREDENTIAL_PATH, { force: true });
  } catch {
    // nothing to remove
  }
};

const KEY_FIELD = /^(api[_-]?key|key|token|access[_-]?token|secret)$/i;

// OpenChamber hands the stored provider credential to the quota call, so the
// usual path never touches this. It exists for the extension panel, which has
// no access to that credential, and is read-only: OpenCode owns the file.
const OPENCODE_CREDENTIAL_TTL_MS = 60_000;
let opencodeKeyCache = { at: 0, key: null };

const opencodeDbCandidates = () => {
  const dataHome = str(process.env.XDG_DATA_HOME) ?? path.join(os.homedir(), '.local', 'share');
  const explicit = str(process.env.OPENCODE_DB_PATH);
  return explicit ? [explicit] : [path.join(dataHome, 'opencode', 'opencode.db')];
};

const readOpencodeCredentialKey = async () => {
  if (Date.now() - opencodeKeyCache.at < OPENCODE_CREDENTIAL_TTL_MS) return opencodeKeyCache.key;

  let key = null;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    for (const candidate of opencodeDbCandidates()) {
      if (!fs.existsSync(candidate)) continue;
      let db = null;
      try {
        db = new DatabaseSync(candidate, { readOnly: true });
        const row = db.prepare(
          'select value from credential where integration_id = ? and active = 1 order by time_updated desc limit 1',
        ).get('commandcode');
        if (row?.value) {
          const parsed = JSON.parse(row.value);
          key = str(parsed?.key) ?? str(parsed?.access);
        }
      } catch {
        // locked, moved, or a schema this build does not know: try the next file
      } finally {
        try {
          db?.close();
        } catch {
          // already closed
        }
      }
      if (key) break;
    }
  } catch {
    // node:sqlite is unavailable (older Node), the read-only fallback is skipped
  }

  opencodeKeyCache = { at: Date.now(), key };
  return key;
};

const findKeyDeep = (value, depth = 0) => {
  if (depth > 4 || value === null || typeof value !== 'object') return null;
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value);
  for (const [name, entry] of entries) {
    if (KEY_FIELD.test(name) && typeof entry === 'string' && entry.trim()) return entry.trim();
  }
  for (const [, entry] of entries) {
    const found = findKeyDeep(entry, depth + 1);
    if (found) return found;
  }
  return null;
};

const readAuthFileKey = () => {
  const candidates = [
    path.join(os.homedir(), '.commandcode', 'auth.json'),
    path.join(os.homedir(), '.config', 'commandcode', 'auth.json'),
  ];
  for (const candidate of candidates) {
    try {
      const found = findKeyDeep(JSON.parse(fs.readFileSync(candidate, 'utf8')));
      if (found) return found;
    } catch {
      // missing or unreadable: try the next location
    }
  }
  return null;
};

const resolveKey = async (supplied) => {
  if (str(supplied)) return { key: str(supplied), source: 'host' };
  const stored = readStoredKey();
  if (stored) return { key: stored, source: 'stored' };
  const fromEnv = str(process.env.COMMAND_CODE_API_KEY);
  if (fromEnv) return { key: fromEnv, source: 'env' };
  const fromFile = readAuthFileKey();
  if (fromFile) return { key: fromFile, source: 'auth-file' };
  const fromOpencode = await readOpencodeCredentialKey();
  if (fromOpencode) return { key: fromOpencode, source: 'opencode' };
  return { key: null, source: null };
};

// ---------------------------------------------------------------------- api

class ApiError extends Error {
  constructor(message, { status = 0, kind = 'http' } = {}) {
    super(message.slice(0, ERROR_MAX));
    this.status = status;
    this.kind = kind;
  }
}

const apiGet = async (pathname, key) => {
  let response;
  try {
    response = await fetch(`${API_BASE}${pathname}`, {
      headers: {
        authorization: `Bearer ${key}`,
        accept: 'application/json',
        'user-agent': 'openchamber-commandcode-usage/1.0',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? '请求超时' : (error?.message ?? '网络错误');
    throw new ApiError(`无法连接 commandcode.ai：${reason}`, { kind: 'network' });
  }
  if (response.status === 401 || response.status === 403) {
    throw new ApiError(`密钥被拒绝（HTTP ${response.status}）`, { status: response.status, kind: 'auth' });
  }
  if (!response.ok) {
    throw new ApiError(`commandcode.ai 返回 HTTP ${response.status}`, { status: response.status, kind: 'http' });
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError('commandcode.ai 返回了非 JSON 内容', { status: 502, kind: 'format' });
  }
};

// ------------------------------------------------------------------ normalize

const pickWindow = (limits, names) => {
  if (!isRecord(limits)) return null;
  for (const name of names) {
    if (isRecord(limits[name])) return limits[name];
  }
  return null;
};

const normalizeWindow = (raw) => {
  if (!isRecord(raw)) return null;
  const used = num(raw.used) ?? num(raw.usage) ?? num(raw.usedCredits) ?? num(raw.used_credits);
  const cap = num(raw.cap) ?? num(raw.limit) ?? num(raw.capCredits) ?? num(raw.cap_credits);
  return {
    used: used ?? 0,
    cap: cap ?? 0,
    exceeded: raw.exceeded === true || (used !== null && cap !== null && cap > 0 && used >= cap),
    resetAt: toEpochMs(raw.resetAt ?? raw.reset_at ?? raw.resetsAt ?? raw.reset_at_ms),
  };
};

const percentOf = (used, cap) => {
  if (cap === null || cap <= 0) return null;
  return Math.max(0, Math.min(100, (used / cap) * 100));
};

const buildReport = (key) => {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return Promise.resolve(cached.report);
  const pending = fetchReport(key).then((report) => {
    cache.set(key, { at: Date.now(), report });
    return report;
  }).catch((error) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, { at: Date.now(), report: pending });
  return pending;
};

const cache = new Map();

const fetchReport = async (key) => {
  const who = await apiGet('/alpha/whoami', key);
  const user = isRecord(who?.user) ? who.user : (isRecord(who?.data?.user) ? who.data.user : null);
  const org = isRecord(who?.org) ? who.org : null;
  const orgId = str(org?.id);

  const [creditsResult, subscriptionResult] = await Promise.allSettled([
    apiGet('/alpha/billing/credits', key),
    apiGet(orgId ? `/alpha/billing/subscriptions?orgId=${encodeURIComponent(orgId)}` : '/alpha/billing/subscriptions', key),
  ]);

  if (creditsResult.status === 'rejected' && subscriptionResult.status === 'rejected') {
    throw creditsResult.reason;
  }

  const creditsPayload = creditsResult.status === 'fulfilled' ? creditsResult.value : null;
  const subscriptionPayload = subscriptionResult.status === 'fulfilled' ? subscriptionResult.value : null;

  const credits = isRecord(creditsPayload?.credits)
    ? creditsPayload.credits
    : (isRecord(creditsPayload?.data?.credits) ? creditsPayload.data.credits : null);
  const limits = isRecord(creditsPayload?.windowLimits)
    ? creditsPayload.windowLimits
    : (isRecord(creditsPayload?.data?.windowLimits) ? creditsPayload.data.windowLimits : null);

  const subscription = isRecord(subscriptionPayload?.data)
    ? subscriptionPayload.data
    : (isRecord(subscriptionPayload?.subscription) ? subscriptionPayload.subscription : null);

  const planId = str(subscription?.planId) ?? str(subscription?.plan_id)
    ?? str(credits?.planId) ?? str(credits?.plan_id);
  const periodEnd = toEpochMs(subscription?.currentPeriodEnd ?? subscription?.current_period_end);

  const fiveHour = normalizeWindow(pickWindow(limits, ['fiveHour', 'five_hour', 'rolling5h', '5h']));
  const weekly = normalizeWindow(pickWindow(limits, ['weekly', 'week']));

  const monthlyRemaining = num(credits?.monthlyCredits) ?? num(credits?.monthly_credits);
  const purchased = num(credits?.purchasedCredits) ?? num(credits?.purchased_credits) ?? 0;
  const free = num(credits?.freeCredits) ?? num(credits?.free_credits) ?? 0;

  return {
    account: {
      name: str(user?.name) ?? '',
      userName: str(user?.userName) ?? str(user?.username) ?? '',
    },
    plan: {
      id: planId,
      label: planLabelOf(planId),
      status: str(subscription?.status),
      currentPeriodEnd: periodEnd,
      baseCredits: planBaseCredits(planId),
    },
    windows: {
      fiveHour,
      weekly,
      monthly: monthlyRemaining === null ? null : {
        remaining: monthlyRemaining,
        cap: planBaseCredits(planId),
        resetAt: periodEnd,
      },
    },
    credits: {
      monthlyRemaining,
      purchased,
      free,
      belowThreshold: credits?.belowThreshold === true,
      creditThreshold: num(credits?.creditThreshold),
    },
    fetchedAt: Date.now(),
  };
};

// -------------------------------------------------------------- quota windows

// Command Code meters in credits and the server never reports which model was
// used, so the model is a local preference that only rescales money, never the
// percentage. Read here (at output time) rather than inside the cached fetch, so
// switching models takes effect on the next read instead of after the cache.
const perCredit = (report) => {
  const base = report.plan.baseCredits;
  const allowance = pricingModel().monthlyUsd;
  if (!base || !allowance) return 1;
  return allowance / base;
};

// A window keeps one figure. Percentage windows emit no valueLabel, because the
// native card prints valueLabel instead of the percentage and that left the
// card showing "$3.28 / $14.00" where "23%" belongs. Money detail lives in the
// extension panel; the month keeps its label because its dollars are the point.
const percentWindow = (window, windowSeconds, usedPercent) => ({
  usedPercent,
  windowSeconds,
  resetAt: window.resetAt,
});

const toQuotaUsage = (report) => {
  const windows = {};
  const scale = perCredit(report);

  if (report.windows.fiveHour) {
    const window = report.windows.fiveHour;
    windows['5h'] = percentWindow(window, FIVE_HOURS, percentOf(window.used, window.cap));
  }
  if (report.windows.weekly) {
    const window = report.windows.weekly;
    windows.weekly = percentWindow(window, ONE_WEEK, percentOf(window.used, window.cap));
  }

  const monthly = report.windows.monthly;
  const remaining = report.credits.monthlyRemaining;

  // The server reports what is left of the monthly allowance, never how much
  // was spent. With a known base both numbers are the same fact, so the month
  // is one window; its dollars follow the model's own allowance. Without a
  // base there is no percentage to draw and a plain balance row is the only
  // thing left, which also covers accounts that report a balance but no plan.
  if (monthly && monthly.cap !== null) {
    const spentCredits = Math.max(0, monthly.cap - monthly.remaining);
    windows.monthly = {
      usedPercent: percentOf(spentCredits, monthly.cap),
      resetAt: monthly.resetAt,
    };
  } else if (remaining !== null) {
    windows.credits_balance = {
      usedPercent: null,
      valueLabel: compactMoney(remaining * scale),
    };
  }

  return { windows };
};

const usageData = (report) => ({
  ok: true,
  configured: true,
  planLabel: report.plan.label ?? undefined,
  usage: toQuotaUsage(report),
});

// The panel shows the same windows but keeps the dollars, which the native card
// now drops in favour of the percentage. Building the rows here keeps the
// scaling rule in one place.
const panelData = (report) => {
  const scale = perCredit(report);
  const rows = [];

  const spend = (label, window, resetAt) => {
    if (!window) return;
    rows.push({
      label,
      percent: percentOf(window.used, window.cap),
      value: window.cap > 0
        ? `${compactMoney(window.used)} / ${compactMoney(window.cap)}`
        : compactMoney(window.used),
      resetAt,
    });
  };

  spend('5 小时', report.windows.fiveHour, report.windows.fiveHour?.resetAt ?? null);
  spend('本周', report.windows.weekly, report.windows.weekly?.resetAt ?? null);

  const monthly = report.windows.monthly;
  if (monthly && monthly.cap !== null) {
    const spentCredits = Math.max(0, monthly.cap - monthly.remaining);
    rows.push({
      label: '本月',
      percent: percentOf(spentCredits, monthly.cap),
      value: `${compactMoney(spentCredits * scale)} / ${compactMoney(monthly.cap * scale)}`,
      resetAt: monthly.resetAt,
    });
  } else if (report.credits.monthlyRemaining !== null) {
    rows.push({
      label: '本月',
      percent: null,
      value: compactMoney(report.credits.monthlyRemaining * scale),
      resetAt: report.plan.currentPeriodEnd,
    });
  }

  const remaining = report.credits.monthlyRemaining;
  return {
    rows,
    remaining: remaining === null ? null : compactMoney(remaining * scale),
    purchased: report.credits.purchased > 0 ? compactMoney(report.credits.purchased * scale) : null,
    free: report.credits.free > 0 ? compactMoney(report.credits.free * scale) : null,
    account: report.account.name || report.account.userName || null,
    planLabel: report.plan.label,
    fetchedAt: report.fetchedAt,
  };
};

const failureData = (configured, error) => ({
  ok: false,
  configured,
  error: error.slice(0, ERROR_MAX),
  usage: null,
});

// ------------------------------------------------------------------- plumbing

const send = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
};

const readBody = (request) => new Promise((resolve, reject) => {
  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
    if (body.length > BODY_MAX) {
      reject(new ApiError('请求体过大', { status: 413 }));
      request.destroy();
    }
  });
  request.on('end', () => resolve(body));
  request.on('error', reject);
});

const parseJson = (body) => {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
};

const maskKey = (key) => (key && key.length > 8 ? `…${key.slice(-4)}` : '已配置');

const handleUsage = async (response) => {
  const { key, source } = await resolveKey(null);
  if (!key) {
    send(response, 200, { ok: true, configured: false, error: '尚未找到 API Key', usage: null });
    return;
  }
  try {
    const report = await buildReport(key);
    send(response, 200, { ok: true, panel: panelData(report), source });
  } catch (error) {
    const message = error instanceof ApiError ? error.message : String(error?.message ?? error);
    send(response, 200, { ok: false, configured: true, error: message, source });
  }
};

const handleQuota = async (response, body) => {
  const request = parseJson(body);
  const supplied = isRecord(request?.input?.credentials?.commandcode)
    ? request.input.credentials.commandcode
    : null;
  const suppliedKey = isRecord(supplied) ? (str(supplied.key) ?? str(supplied.access)) : null;

  const { key } = await resolveKey(suppliedKey);
  if (!key) {
    send(response, 200, { ok: true, data: failureData(false, '尚未填写 API Key：打开 Command Code Usage 面板粘贴密钥') });
    return;
  }
  try {
    const report = await buildReport(key);
    send(response, 200, { ok: true, data: usageData(report) });
  } catch (error) {
    const message = error instanceof ApiError ? error.message : String(error?.message ?? error);
    const configured = !(error instanceof ApiError) || error.kind !== 'auth';
    send(response, 200, { ok: true, data: failureData(configured, message) });
  }
};

const handleCredentialSave = async (response, body) => {
  const parsed = parseJson(body);
  const key = str(parsed?.key);
  if (!key) {
    send(response, 400, { ok: false, error: '请填写 API Key' });
    return;
  }
  try {
    const who = await apiGet('/alpha/whoami', key);
    const user = isRecord(who?.user) ? who.user : null;
    writeStoredKey(key);
    cache.delete(key);
    send(response, 200, {
      ok: true,
      hint: maskKey(key),
      account: str(user?.name) ?? str(user?.userName) ?? '',
    });
  } catch (error) {
    const message = error instanceof ApiError ? error.message : String(error?.message ?? error);
    send(response, error instanceof ApiError && error.kind === 'auth' ? 401 : 502, { ok: false, error: message });
  }
};

const server = http.createServer(async (request, response) => {
  if (request.headers.authorization !== `Bearer ${TOKEN}`) {
    send(response, 401, { ok: false, error: 'unauthorized' });
    return;
  }

  const url = new URL(request.url ?? '/', 'http://127.0.0.1');

  if (url.pathname === '/health') {
    send(response, 200, { ok: true });
    return;
  }

  if (url.pathname === '/status' && request.method === 'GET') {
    const { key, source } = await resolveKey(null);
    const model = pricingModel();
    send(response, 200, {
      ok: true,
      configured: Boolean(key),
      hint: key ? maskKey(key) : null,
      source,
      model: { key: model.key, label: model.label, monthlyUsd: model.monthlyUsd },
      models: [...MODELS.entries()].map(([key, entry]) => ({ key, label: entry.name, monthlyUsd: entry.monthlyUsd })),
    });
    return;
  }

  if (url.pathname === '/settings' && request.method === 'POST') {
    void readBody(request).then((body) => {
      const parsed = parseJson(body);
      const requested = str(parsed?.model);
      if (!requested) {
        send(response, 400, { ok: false, error: '请选择一个模型' });
        return;
      }
      const key = normalizeModelKey(requested);
      const known = key ? MODELS.get(key) : null;
      if (!known) {
        send(response, 400, { ok: false, error: '未知模型' });
        return;
      }
      writeSettings({ model: key });
      const model = pricingModel();
      send(response, 200, { ok: true, model: { key: model.key, label: model.label, monthlyUsd: model.monthlyUsd } });
    }).catch(() => {
      send(response, 400, { ok: false, error: '无法读取请求体' });
    });
    return;
  }

  if (url.pathname === '/usage' && request.method === 'GET') {
    void handleUsage(response);
    return;
  }

  if (url.pathname === '/credential' && request.method === 'POST') {
    void readBody(request).then((body) => handleCredentialSave(response, body)).catch(() => {
      send(response, 400, { ok: false, error: '无法读取请求体' });
    });
    return;
  }

  if (url.pathname === '/credential' && request.method === 'DELETE') {
    clearStoredKey();
    send(response, 200, { ok: true });
    return;
  }

  if (url.pathname === '/quota' && request.method === 'POST') {
    void readBody(request).then((body) => handleQuota(response, body)).catch(() => {
      send(response, 400, { ok: false, error: { message: '无法读取请求体' } });
    });
    return;
  }

  send(response, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, '127.0.0.1');
