import { connectHost } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';

type WindowReport = { used: number; cap: number; resetAt: number | null };
type MonthlyReport = { remaining: number; cap: number | null; resetAt: number | null };

type UsageReport = {
  account: { name: string; userName: string };
  plan: { id: string | null; label: string | null; status: string | null; currentPeriodEnd: number | null };
  windows: { fiveHour: WindowReport | null; weekly: WindowReport | null; monthly: MonthlyReport | null };
  credits: { monthlyRemaining: number | null; purchased: number; free: number; belowThreshold: boolean; creditThreshold: number | null };
  fetchedAt: number;
};

type StatusPayload = { configured: boolean; hint: string | null; source: string | null };type UsagePayload = { ok: boolean; configured?: boolean; error?: string; report?: UsageReport; source?: string };

const host = connectHost();
const root = document.querySelector('#root');
if (!root) throw new Error('Missing #root');

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const money = (value: number): string => `$${value.toFixed(2)}`;

const resetText = (at: number | null): string => {
  if (!at) return '';
  const delta = at - Date.now();
  if (delta <= 0) return '即将重置';
  const minutes = Math.max(1, Math.round(delta / 60_000));
  if (minutes < 60) return `${minutes} 分钟后重置`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} 小时 ${minutes % 60} 分后重置`;
  return `${Math.floor(hours / 24)} 天后重置`;
};

const percentText = (value: number | null): string => (value === null ? '—' : `${Math.round(value)}%`);

const toneOf = (percent: number | null): string => {
  if (percent === null) return 'neutral';
  if (percent >= 80) return 'critical';
  if (percent >= 50) return 'warn';
  return 'safe';
};

const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const result = await host.serviceRequest({
    method: method as 'GET' | 'POST' | 'DELETE',
    path,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(result.body);
  } catch {
    parsed = null;
  }
  if (result.status < 200 || result.status >= 300) {
    const message = (parsed as { error?: string } | null)?.error ?? `HTTP ${result.status}`;
    throw new Error(message);
  }
  return parsed as T;
};

const shell = el('div', 'shell');
root.append(shell);

const header = el('header', 'header');
shell.append(header);

const title = el('div', 'title');
const titleText = el('span', 'title-text', 'Command Code');
const badge = el('span', 'badge', '未配置');
title.append(titleText, badge);
header.append(title);

const refreshButton = el('button', 'icon-button', '刷新');
refreshButton.type = 'button';
header.append(refreshButton);

const notice = el('p', 'notice');
notice.hidden = true;
shell.append(notice);

const body = el('div', 'body');
shell.append(body);

const windowsBox = el('div', 'windows');
body.append(windowsBox);

const footer = el('div', 'footer');
body.append(footer);

const settings = el('section', 'settings');
body.append(settings);

const settingsToggle = el('button', 'link-button', '用其他 API Key 覆盖');
settingsToggle.type = 'button';
settings.append(settingsToggle);

const settingsPanel = el('form', 'settings-panel');
settingsPanel.hidden = true;
settings.append(settingsPanel);

const hint = el('p', 'hint');
const input = el('input', 'input');
input.type = 'password';
input.autocomplete = 'off';
input.spellcheck = false;
input.placeholder = '粘贴 Command Code API Key';
const actions = el('div', 'actions');
const saveButton = el('button', 'button primary', '保存');
saveButton.type = 'submit';
const clearButton = el('button', 'button', '清除覆盖');
clearButton.type = 'button';
actions.append(saveButton, clearButton);
settingsPanel.append(hint, input, actions);

let status: StatusPayload = { configured: false, hint: null, source: null };
let busy = false;

const setNotice = (message: string, tone: 'error' | 'info' = 'info'): void => {
  notice.textContent = message;
  notice.dataset.tone = tone;
  notice.hidden = !message;
};

const renderWindows = (report: UsageReport): void => {
  windowsBox.replaceChildren();

  const rows: Array<{ label: string; percent: number | null; value: string; resetAt: number | null }> = [];
  if (report.windows.fiveHour) {
    const window = report.windows.fiveHour;
    rows.push({
      label: '5 小时',
      percent: window.cap > 0 ? Math.min(100, (window.used / window.cap) * 100) : null,
      value: window.cap > 0 ? `${money(window.used)} / ${money(window.cap)}` : money(window.used),
      resetAt: window.resetAt,
    });
  }
  if (report.windows.weekly) {
    const window = report.windows.weekly;
    rows.push({
      label: '本周',
      percent: window.cap > 0 ? Math.min(100, (window.used / window.cap) * 100) : null,
      value: window.cap > 0 ? `${money(window.used)} / ${money(window.cap)}` : money(window.used),
      resetAt: window.resetAt,
    });
  }
  if (report.windows.monthly) {
    const window = report.windows.monthly;
    const used = window.cap === null ? null : Math.max(0, window.cap - window.remaining);
    rows.push({
      label: '本月',
      percent: window.cap !== null && used !== null && window.cap > 0 ? Math.min(100, (used / window.cap) * 100) : null,
      value: window.cap === null ? `${money(window.remaining)} 剩余` : `${money(window.remaining)} / ${money(window.cap)}`,
      resetAt: window.resetAt,
    });
  }

  for (const row of rows) {
    const item = el('div', 'window');
    const head = el('div', 'window-head');
    head.append(el('span', 'window-label', row.label), el('span', 'window-percent', percentText(row.percent)));
    const track = el('div', 'track');
    const fill = el('div', 'fill');
    fill.dataset.tone = toneOf(row.percent);
    fill.style.width = `${row.percent === null ? 0 : Math.max(2, row.percent)}%`;
    track.append(fill);
    const meta = el('div', 'window-meta');
    meta.append(el('span', '', row.value), el('span', '', resetText(row.resetAt)));
    item.append(head, track, meta);
    windowsBox.append(item);
  }
};

const renderFooter = (report: UsageReport): void => {
  footer.replaceChildren();
  const credits = report.credits;
  if (credits.monthlyRemaining !== null) {
    const line = el('div', 'credit-line');
    line.append(el('span', 'credit-label', '剩余额度'), el('span', 'credit-value', money(credits.monthlyRemaining)));
    footer.append(line);
  }
  const extras: string[] = [];
  if (credits.purchased > 0) extras.push(`加购 ${money(credits.purchased)}`);
  if (credits.free > 0) extras.push(`赠送 ${money(credits.free)}`);
  if (extras.length > 0) footer.append(el('div', 'credit-extra', extras.join(' · ')));

  const metaParts: string[] = [];
  const account = report.account.name || report.account.userName;
  if (account) metaParts.push(account);
  metaParts.push(`更新于 ${new Date(report.fetchedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`);
  footer.append(el('div', 'updated', metaParts.join(' · ')));
};

const renderStatus = (): void => {
  const report = lastReport;
  if (report) {
    badge.textContent = report.plan.label ?? '已连接';
    badge.dataset.tone = 'ok';
    return;
  }
  badge.textContent = status.configured ? '已配置' : '未配置';
  badge.dataset.tone = status.configured ? 'ok' : 'idle';
};

let lastReport: UsageReport | null = null;

const SOURCE_LABEL: Record<string, string> = {
  host: 'Providers 页面（OpenCode 凭据库）',
  opencode: 'OpenCode 凭据库（只读）',
  stored: '扩展面板保存的覆盖密钥',
  env: '环境变量 COMMAND_CODE_API_KEY',
  'auth-file': '~/.commandcode/auth.json',
};

const renderAll = (): void => {
  if (lastReport) {
    renderWindows(lastReport);
    renderFooter(lastReport);
  } else {
    windowsBox.replaceChildren(el(
      'div',
      'empty',
      status.configured ? '正在读取用量…' : '在 设置 → Providers 里填入 Command Code API Key 后即可显示',
    ));
    footer.replaceChildren();
  }
  renderStatus();
  hint.textContent = status.configured
    ? `密钥来源：${SOURCE_LABEL[status.source ?? ''] ?? status.source ?? '未知'}${status.hint ? `（${status.hint}）` : ''}。这里的覆盖密钥优先级最高。`
    : '尚未找到密钥。可在此粘贴，或在 设置 → Providers 里添加 CommandCode。';
};

const loadStatus = async (): Promise<void> => {
  try {
    status = await request<StatusPayload>('GET', '/status');
  } catch (error) {
    setNotice(error instanceof Error ? error.message : String(error), 'error');
  }
};

const loadUsage = async (): Promise<void> => {
  if (busy) return;
  busy = true;
  refreshButton.disabled = true;
  try {
    const payload = await request<UsagePayload>('GET', '/usage');
    if (payload.ok && payload.report) {
      lastReport = payload.report;
      setNotice('');
    } else {
      lastReport = null;
      setNotice(payload.error ?? '暂时无法获取用量', payload.configured === false ? 'info' : 'error');
    }
    await loadStatus();
  } catch (error) {
    lastReport = null;
    const message = error instanceof Error ? error.message : String(error);
    setNotice(
      message.includes('NO_SERVICE') ? '扩展服务未授权：请在 设置 → 扩展 中授予 service 能力' : message,
      'error',
    );
  } finally {
    busy = false;
    refreshButton.disabled = false;
    renderAll();
  }
};

refreshButton.addEventListener('click', () => {
  void loadUsage();
});

settingsToggle.addEventListener('click', () => {
  settingsPanel.hidden = !settingsPanel.hidden;
  settingsToggle.textContent = settingsPanel.hidden ? '用其他 API Key 覆盖' : '收起';
  if (!settingsPanel.hidden) input.focus();
});

settingsPanel.addEventListener('submit', (event) => {
  event.preventDefault();
  const key = input.value.trim();
  if (!key) {
    setNotice('请先粘贴 API Key', 'error');
    return;
  }
  saveButton.disabled = true;
  void (async () => {
    try {
      await request('POST', '/credential', { key });
      input.value = '';
      settingsPanel.hidden = true;
      settingsToggle.textContent = '用其他 API Key 覆盖';
      setNotice('密钥已保存', 'info');
      await loadStatus();
      await loadUsage();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      saveButton.disabled = false;
    }
  })();
});

clearButton.addEventListener('click', () => {
  void (async () => {
    try {
      await request('DELETE', '/credential');
      lastReport = null;
      await loadStatus();
      renderAll();
      setNotice('已清除覆盖密钥，改回 OpenChamber 保存的凭据', 'info');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error), 'error');
    }
  })();
});

const start = (): void => {
  renderAll();
  void (async () => {
    await loadStatus();
    renderAll();
    await loadUsage();
  })();
  setInterval(() => {
    if (document.visibilityState === 'visible') void loadUsage();
  }, 60_000);
};

host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  start();
});
