# OpenChamber Command Code Usage

把 [Command Code](https://commandcode.ai)（GOAT / Pro / Max 等套餐）的额度显示在
OpenChamber 的原生用量面板里：用量页、顶栏、Work Status、手机端都会出现一张
「Command Code Usage」卡片，和内置的 Ollama / Claude / Codex 并排。

- 5 小时滚动窗口（服务端原始 used / cap / resetAt）
- 每周窗口（服务端原始数据）
- 本月额度（剩余额度 + 按套餐上限估算的百分比）
- 剩余 / 加购 / 赠送额度
- 扩展自带一个面板，用来填写和更换 API Key，并查看当前用量

## 数据来源

`api.commandcode.ai` 的 `/alpha/*` 接口（未公开文档，字段做防御性解析）：

| 接口 | 用途 |
| --- | --- |
| `GET /alpha/whoami` | 校验密钥、账号名、orgId |
| `GET /alpha/billing/credits` | 5h / 周窗口 + 额度余额 |
| `GET /alpha/billing/subscriptions` | planId、账期结束时间 |

月度百分比用社区维护的套餐上限映射估算（GOAT = 70 credits）；如果官方额度调整，
可以用环境变量 `COMMANDCODE_MONTHLY_CAP` 覆盖，或直接忽略该行——5 小时和每周
两个窗口始终来自服务端，不受影响。

## 安装

```sh
npm install
npm run build
```

1. 打开 OpenChamber → 设置 → 扩展
2. 选择「从本地路径安装」，指向本目录
3. 安装后授权 `service` 能力（扩展需要它来访问本机服务）
4. 打开「Command Code Usage」面板，粘贴 API Key（在 commandcode.ai 的 settings 页面获取）
5. 用量页出现「Command Code Usage」卡片

密钥只保存在本机扩展数据目录（`credential.json`，权限 `0600`），不会写进
OpenCode 配置，也不会发往 commandcode.ai 以外的地址。

也支持不填密钥的两种来源：环境变量 `COMMAND_CODE_API_KEY`，或
`~/.commandcode/auth.json`（`cmd login` 写入的文件）。

## 开发

```sh
npm run check   # 语法检查 service
npm run build   # 打包 panel/main.ts → panel/main.js
```

- `service/main.js`：纯 Node ESM，无依赖；实现 `POST /quota`（`usage.read` 契约）
  和面板用的 `/status`、`/usage`、`/credential`
- `panel/main.ts`：通过 `@openchamber/sdk` 的 `connectHost()` 调用自己的服务
- `package.json` 的 `openchamber.contributes.quota.providers` 为空数组：
  扩展自己保存密钥，不读取 OpenCode 的凭据库

## 已知限制

- `/alpha/*` 是未公开接口，Command Code 改字段时需要跟着调整解析
- 月度上限是估算值，不是服务端返回值
- 只覆盖用量展示；不提供「切换账号」或多账号聚合
