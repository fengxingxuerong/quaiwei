# 商汤（SenseNova 网关）模型可用性实测 · 2026-10-24

> **类型：当前口径**（一段时间内有效，网关变更后会过期——复核方法见文末）
> 探测工具：`scripts/probe-sensenova.mjs`（`npm run probe:models`）

## 一、怎么测的

两个动作，缺一不可：

1. `GET https://token.sensenova.cn/v1/models` —— 网关**在售清单**；
2. 对每个在售模型发一次**最小** `POST /chat/completions`（单条短消息、`max_tokens=2048`、60s 超时）。

为什么必须两步：**在售 ≠ 有权限**。实测反例就摆在下面（`deepseek-v4.1-flash` 在售但套餐 403；
`sensenova-u1.5-lite` 还在列表里但已经 404 下线）。

探测脚本对三类"可救"的失败做了自适应重试，避免误杀：

- `400 …only 1 is allowed` → 该模型强制 `temperature=1`，换 1 重试（`kimi-k3` 属于这类）；
- `429` → **限流**。3 条 Key 的套餐有 tpm/rpm 上限，连着探测很容易撞上；脚本会**轮换到下一条 Key**
  重试（这正是产品里已有的策略），四条都撞再等 3 秒；
- `403`（套餐）/ `404`（下线）→ 真不可用，不重试。

> 这条 429 处理是实测逼出来的：第一次跑时 `deepseek-flash` 与 `kimi-k3` 都报 429，
> 加了 Key 轮换后 `deepseek-flash` 直接通了（1265ms）。**一批 Key 判死是错的。**

## 二、结果（2026-10-24，3 条 Key 轮换）

在售 **7 个**，可用 **5 个**：

| 模型 | 判定 | 首字耗时 | 说明 |
|---|---|---|---|
| `deepseek-v4-flash` | ✅ 可用 | 1916 ms | **主力改写**。速度与质量平衡最好 |
| `sensenova-6.8-flash-lite` | ✅ 可用 | 1389 ms | **最快**，但同族替身多样性差，适合兜底/短稿 |
| `glm-5.2` | ✅ 可用 | 3136 ms | **交叉评判**（思考型：`max_tokens` 给够才有 content） |
| `kimi-k3` | ✅ 可用 | 1967 ms | 备选改写；**网关强制 `temperature=1`**，否则 400 |
| `deepseek-flash` | ✅ 可用 | 1265 ms | 可用，但**容易撞 429**（tpm/rpm 限流）；换 Key 即通 |
| `deepseek-v4.1-flash` | ❌ 不可用 | 67 ms | `403 model is not available in the current token plan`（**在售但套餐无权限**） |
| `sensenova-u1.5-lite` | ❌ 不可用 | 59 ms | `404 model is not found`（**在列表里但已下线**） |

## 三、对项目配置的含义

- `deepseek-v4-flash` = 主改写（`--model` 默认）；`glm-5.2` = 评判（`--judge-model`）；
  `kimi-k3` = 备选（`--alt-model`），且**不能**与主模型同族，否则"竞争"只是同温重采样。
- `kimi-k3` 的 `temperature=1` 硬约束已在 `src/api/llm-chat.ts:70` 自动适配
  （`/kimi/i.test(model) ? 1 : opts.temperature`），CLI 与界面都不用特殊处理。
- `deepseek-flash` 的 429 不是"没权限"，是**配额/限流**——产品里已有 Key 轮换，撞上会自动换一把；
  单次探测脚本也照做（见上）。
- 不要把 `deepseek-v4.1-flash` / `sensenova-u1.5-lite` 写进配置：前者要升级套餐，后者已下线。

## 四、复核方法（清单会过期）

```bash
npm run probe:models                     # 默认打 token.sensenova.cn/v1
node scripts/probe-sensenova.mjs --base https://其它网关/v1
```

脚本**不打印 Key**（只打后缀 4 位用于区分），Key 来源优先级：
`SENSENOVA_KEYS` 环境变量 → `scripts/.sensenova-keys`（gitignore）。

结果有变化时，请同步更新两处：本文件 + `src/api/llm-config.ts` 里 SenseNova 预置的注释块。
