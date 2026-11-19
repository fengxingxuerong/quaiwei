# 用户真实网关实测 · 2026-11-19（--api 通道 + 补齐项验收）

> 凭证由用户提供，只存仓库外临时文件，未入库、未回显。网关 `http://127.0.0.1:8080/v1`，
> 模型 `glm-5.3-flash`（`/v1/models` 另列 `glm-5.3`，本轮未测）。最小 chat 请求 HTTP 200。

## 一、结论

| 项 | 结果 |
|---|---|
| `--api` 基础改写 | ✅ 3 篇全部走 LLM，无回退（串行 `--jobs 1`） |
| `--pin` 事实钉住走 API | ✅ 修复后 2/2 钉住成功，`fallbackToOriginal:false` |
| `--voice-sample` 走 API | ✅ 声口生效：短句/破折号/口语化贴合样本 |
| 声口配对盲测 | 6 票 5 胜（0.833），**p=0.109 ≥ 0.05 ⇒ 测不出差异**，仅方向性提示 |
| 数字守卫伪量词 bug | ✅ 发现并修复（「这一升级」的「一升」被当成 1 升），回归测试通过 |

## 二、过程中发现并修复的两个真缺陷

### 1. `--pin` 走 LLM 路径必然失败
- **现象**：私用区占位符 `U+E0000U+E001` 被 LLM 剥成 `0`（实测直接调用确认），
  `restorePins` 找不到 token ⇒ 每次都整篇回退原文。
- **修复**：LLM 路径改用可读标记 `⟦逐字保留N⟧` + `pinCount` 字段在 system prompt 加硬指令
  （`pinDirectiveBlock`），restore 按可读 token 还原。本地引擎仍用私用区。
- **验证**：重跑 `fin.txt`，两段（5.6 个百分点 / 12.3%）逐字保留，无回退。
  见 `pin-api-report.json`。

### 2. 数字守卫把「这一升级」误判为 1 升
- **现象**：`numericFidelityWarning` 对原文/产出都含「2026年11月19日」的文本报
  「产出缺少原文中的数字：1升」。
- **根因**：`CHINESE_RE` 把「这一升级」里的「一升」当成中文数字 + 单位「升」。
- **修复**：`src/engine/number-fidelity.ts` 加 `NON_QUANTITY_SUFFIX`（仅 `升:` 跟
  `级/降/高` 时排除），阿拉伯与中文数字两条路径都过同一守卫。真实升数（5 升/3 升）照常拦。
- **验证**：`src/engine/number-fidelity.test.ts` +2 用例，30/30 绿；误报复现脚本返回 `(none)`。

### 3. 连带修复：`pinCount` 被 store 白名单漏读
`DEFAULT_API` 新增字段后 `src/store.test.ts` 的往返一致性测试红（2 例）。
`src/store.ts` 补 `pinCount` 逐字段白名单读取，63/63 绿。

## 三、声口盲测（方向性，不作能力口径）

- 语料：3 篇模拟 AI 短稿（自建，`orig/`）；两臂同网关同模型同参数，唯一差异是 `--voice-sample`。
- 裁决：`scripts/eval-dual/ab_accept.py --seats AB --mirror`（单网关双席反序抵消位置偏置），
  6 票中 B 臂（有声口）5 胜，双席一致 0.667，甲被选率 0.667，p=0.109。
- **按项目口径：p ≥ 0.05 一律写「测不出差异」**，不得写成赢。样本仅 3 篇、单模型同源评委、
  甲被选率偏离 0.5，全部是已知陷阱。只作「值得扩大样本再测」的方向性提示。
- 逐票见 `ab-mirror/ab_report.json`。

## 四、可复现

```bash
# 网关与 key 走环境变量（凭证不落命令行历史）
export QUAIWEI_API_KEY=<用户提供>
# pin 走 API
npx tsx scripts/humanize-cli.ts <input> --out <out> --api \
  --base-url http://127.0.0.1:8080/v1 --model glm-5.3-flash --no-deep \
  --pin <逐字保留清单> --report <report.json>
# 声口
npx tsx scripts/humanize-cli.ts <input> --out <out> --api \
  --base-url http://127.0.0.1:8080/v1 --model glm-5.3-flash --no-deep \
  --voice-sample <本人写作样本.txt>
# 配对
python scripts/eval-dual/ab_accept.py --arm-a <无声口臂> --arm-b <有声口臂> \
  --corpus <原文目录> --out <out> --seats AB --mirror \
  --model glm-5.3-flash --url-a http://127.0.0.1:8080
```

⚠️ `--url-a` 传 **bare host**，脚本自己拼 `/v1/chat/completions`；传 `/v1` 会 404。
⚠️ `--jobs 3` 实测触发 429（网关限流），批量走串行 `--jobs 1`。

## 五、门禁

`tsc` 0 / `eslint` 0 / `check:release` exit 0 / 全量 vitest 129 文件 2395 用例全绿 /
`build:cli` + MCP 冒烟 11/11。
