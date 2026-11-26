import { connectHost } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';

type PanelRow = { label: string; percent: number | null; value: string; resetAt: number | null };
type PanelUsage = {
  rows: PanelRow[];
  remaining: string | null;
  purchased: string | null;
  free: string | null;
  account: string | null;
  planLabel: string | null;
  fetchedAt: number;
};
type ModelOption = { key: string; label: string; monthlyUsd: number };
type StatusPayload = {
  configured: boolean;
  hint: string | null;
  source: string | null;
  model: ModelOption | null;
  models: ModelOption[];
};
type UsagePayload = { ok: boolean; configured?: boolean; error?: string; panel?: PanelUsage; source?: string };

const host = connectHost();
const root = document.querySelector('#root');
if (!root) throw new Error('Missing #root');

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const resetText = (at: number | null): string => {
  if (!at) return '';
  const delta = at - Date.now();
  if (delta <= 0) return '即将重置';
  const minutes = Math.max(1, Math.round(delta / 60_000));
  if (minutes < 60) return `${minutes} 分钟后`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} 小时后`;
  return `${Math.floor(hours / 24)} 天后`;
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

// ------------------------------------------------------------------ structure

const shell = el('div', 'shell');
root.append(shell);

const header = el('header', 'header');
shell.append(header);

const title = el('div', 'title');
const badge = el('span', 'badge', '—');
title.append(el('span', 'title-text', 'Command Code'), badge);
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

const controls = el('section', 'controls');
body.append(controls);

const modelField = el('label', 'field');
modelField.append(el('span', 'field-label', '计价模型'));
const modelSelect = el('select', 'select');
modelField.append(modelSelect);
controls.append(modelField);

const keyToggle = el('button', 'link-button', '覆盖 API Key');
keyToggle.type = 'button';
controls.append(keyToggle);

const keyPanel = el('form', 'key-panel');
keyPanel.hidden = true;
controls.append(keyPanel);

const keyHint = el('p', 'hint');
const keyInput = el('input', 'input');
keyInput.type = 'password';
keyInput.autocomplete = 'off';
keyInput.spellcheck = false;
keyInput.placeholder = '粘贴 API Key';
const keyActions = el('div', 'actions');
const saveButton = el('button', 'button primary', '保存');
saveButton.type = 'submit';
const clearButton = el('button', 'button', '清除');
clearButton.type = 'button';
keyActions.append(saveButton, clearButton);
keyPanel.append(keyHint, keyInput, keyActions);

// ---------------------------------------------------------------------- state

let status: StatusPayload = { configured: false, hint: null, source: null, model: null, models: [] };
let panel: PanelUsage | null = null;
let busy = false;

const SOURCE_SHORT: Record<string, string> = {
  host: 'OpenChamber 凭据',
  opencode: 'OpenCode 凭据',
  stored: '面板覆盖',
  env: '环境变量',
  'auth-file': 'auth.json',
};

const setNotice = (message: string, tone: 'error' | 'info' = 'info'): void => {
  notice.textContent = message;
  notice.dataset.tone = tone;
  notice.hidden = !message;
};

// -------------------------------------------------------------------- render

const renderWindows = (data: PanelUsage): void => {
  windowsBox.replaceChildren();
  for (const row of data.rows) {
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

const renderFooter = (data: PanelUsage): void => {
  footer.replaceChildren();
  if (data.remaining) {
    const line = el('div', 'credit-line');
    line.append(el('span', 'credit-label', '剩余'), el('span', 'credit-value', data.remaining));
    footer.append(line);
  }

  const extras = [data.purchased && `加购 ${data.purchased}`, data.free && `赠送 ${data.free}`].filter(Boolean);
  if (extras.length > 0) footer.append(el('div', 'credit-extra', extras.join(' · ')));

  const meta = [data.account, `更新 ${new Date(data.fetchedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`]
    .filter(Boolean);
  footer.append(el('div', 'updated', meta.join(' · ')));
};

const renderBadge = (): void => {
  if (panel?.planLabel) {
    badge.textContent = panel.planLabel;
    badge.dataset.tone = 'ok';
    return;
  }
  badge.textContent = status.configured ? '就绪' : '未配置';
  badge.dataset.tone = status.configured ? 'ok' : 'idle';
};

const renderModels = (): void => {
  const options = status.models.length > 0
    ? status.models
    : (status.model ? [status.model] : []);
  modelSelect.replaceChildren();
  for (const option of options) {
    const node = el('option', undefined, `${option.label} · $${option.monthlyUsd}`);
    node.value = option.key;
    if (option.key === status.model?.key) node.selected = true;
    modelSelect.append(node);
  }
  modelSelect.disabled = options.length === 0;
  modelField.hidden = options.length === 0;
};

const renderAll = (): void => {
  if (panel) {
    renderWindows(panel);
    renderFooter(panel);
  } else {
    windowsBox.replaceChildren(el('div', 'empty', status.configured ? '读取中…' : '先在 Providers 页填 Command Code API Key'));
    footer.replaceChildren();
  }
  renderBadge();
  renderModels();
  keyHint.textContent = status.configured
    ? `密钥：${SOURCE_SHORT[status.source ?? ''] ?? status.source ?? '未知'}${status.hint ? ` ${status.hint}` : ''}`
    : '未找到密钥';
};

// --------------------------------------------------------------------- loads

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
    if (payload.ok && payload.panel) {
      panel = payload.panel;
      setNotice('');
    } else {
      panel = null;
      setNotice(payload.error ?? '暂时取不到用量', payload.configured === false ? 'info' : 'error');
    }
    await loadStatus();
  } catch (error) {
    panel = null;
    const message = error instanceof Error ? error.message : String(error);
    setNotice(message.includes('NO_SERVICE') ? '服务未授权：设置 → 扩展 里授予 service' : message, 'error');
  } finally {
    busy = false;
    refreshButton.disabled = false;
    renderAll();
  }
};

// -------------------------------------------------------------------- actions

refreshButton.addEventListener('click', () => {
  void loadUsage();
});

modelSelect.addEventListener('change', () => {
  const selected = modelSelect.value;
  if (!selected) return;
  modelSelect.disabled = true;
  void (async () => {
    try {
      await request('POST', '/settings', { model: selected });
      await loadUsage();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error), 'error');
      renderAll();
    }
  })();
});

keyToggle.addEventListener('click', () => {
  keyPanel.hidden = !keyPanel.hidden;
  keyToggle.textContent = keyPanel.hidden ? '覆盖 API Key' : '收起';
  if (!keyPanel.hidden) keyInput.focus();
});

keyPanel.addEventListener('submit', (event) => {
  event.preventDefault();
  const key = keyInput.value.trim();
  if (!key) {
    setNotice('请粘贴 API Key', 'error');
    return;
  }
  saveButton.disabled = true;
  void (async () => {
    try {
      await request('POST', '/credential', { key });
      keyInput.value = '';
      keyPanel.hidden = true;
      keyToggle.textContent = '覆盖 API Key';
      setNotice('已保存');
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
      panel = null;
      await loadUsage();
      setNotice('已清除覆盖');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error), 'error');
    }
  })();
});

// ---------------------------------------------------------------------- start

host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  renderAll();
  void (async () => {
    await loadStatus();
    renderAll();
    await loadUsage();
  })();
  setInterval(() => {
    if (document.visibilityState === 'visible') void loadUsage();
  }, 60_000);
});
