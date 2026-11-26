# OpenChamber Command Code Usage

把 [Command Code](https://commandcode.ai)（GOAT / Pro / Max 等套餐）的额度显示在
OpenChamber 的原生用量面板里：用量页、顶栏、Work Status、手机端都会出现一张
「Command Code Usage」卡片，和内置的 Ollama / Claude / Codex 并排。

- 5 小时滚动窗口（服务端原始 used / cap / resetAt）
- 每周窗口（服务端原始数据）
- 本月额度（剩余额度 + 按套餐上限换算的百分比）
- 附一个扩展面板：查看当前用量、确认密钥来源、必要时覆盖密钥

## 密钥从哪来

通常**不需要在任何地方再填一次**。只要你在 OpenChamber 的
设置 → Providers 里添加过 CommandCode（Key 存在 OpenCode 凭据库里），扩展就能取到，
卡片自动出现。

解析顺序（前者优先）：

| 顺序 | 来源 | 说明 |
| --- | --- | --- |
| 1 | 宿主传入 | `quota.providers: ["commandcode"]` 让 OpenChamber 把 OpenCode 凭据随 `usage.read` 请求递进来，这是正常路径 |
| 2 | 扩展面板保存 | `credential.json`（`0600`），在扩展数据目录里；用于临时换号或 Providers 里没配时 |
| 3 | 环境变量 | `COMMAND_CODE_API_KEY` |
| 4 | auth 文件 | `~/.commandcode/auth.json`（`cmd login` 写入的文件） |
| 5 | OpenCode 凭据库只读 | 仅 `node:sqlite` 可用时；为面板自己的预览服务，宿主已断开或不传凭据时兜底 |

第 5 条是**只读**打开 `opencode.db` 取 `commandcode` 那一行，不写、不锁、不改。
它存在的原因：扩展面板通过 `serviceRequest` 调自己的服务，拿不到宿主在
`/quota` 里递的凭据，否则面板会一直显示「未配置」。

## 数据来源

`api.commandcode.ai` 的 `/alpha/*` 接口（未公开文档，字段做防御性解析）：

| 接口 | 用途 |
| --- | --- |
| `GET /alpha/whoami` | 校验密钥、账号名、orgId |
| `GET /alpha/billing/credits` | 5h / 周窗口 + 额度余额 |
| `GET /alpha/billing/subscriptions` | planId、账期结束时间 |

服务端只回「月度剩余额度」（`credits.monthlyCredits`），不回月度上限。
月度百分比用社区维护的套餐上限映射换算（GOAT = 70）；官方调整后可用环境变量
`COMMANDCODE_MONTHLY_CAP` 覆盖。5 小时和每周窗口始终是服务端原值，不受影响。

上限未知的套餐（映射表里没有的 planId）不会编造百分比，只显示一行剩余余额。

## 安装

```sh
npm install
npm run build
```

1. 打开 OpenChamber → 设置 → 扩展
2. 选择「从本地路径安装」，指向本目录
3. 安装后授权 `service` 能力（扩展需要它来访问本机服务）
4. 用量页出现「Command Code Usage」卡片，直接显示 5 小时 / 本周 / 本月

**升级注意**：清单里 `quota.providers` 变化会让 OpenChamber 把能力授权重置为
`granted: []`，卡片会短暂消失。回 设置 → 扩展 重新点一次授权即可，不需要重装。

## 开发

```sh
npm run check   # 语法检查 service
npm run build   # 打包 panel/main.ts → panel/main.js
npm test        # 契约测试（mock 服务端 + 真实 schema 校验）
```

- `service/main.js`：纯 Node ESM，无运行时依赖；实现 `POST /quota`
  （`usage.read` 契约）和面板用的 `/status`、`/usage`、`/credential`
- `panel/main.ts`：通过 `@openchamber/sdk` 的 `connectHost()` 调用自己的服务
- `test/contract.test.mjs`：用 `@openchamber/sdk/schemas` 的
  `quotaProviderSchemasV1` 校验真实返回体，覆盖宿主传凭据、兜底来源、
  未知套餐、拒绝密钥四种路径

## 已知限制

- `/alpha/*` 是未公开接口，Command Code 改字段时需要跟着调整解析
- 月度上限是映射估算值，不是服务端返回值
- OpenCode 凭据库兜底依赖 `opencode.db` 的表结构；结构变更时该兜底会静默失效
  （宿主传凭据的主路径不受影响）
- 只覆盖用量展示；不提供切换账号或多账号聚合
