# --api 自动结构钉住 · C23 端到端验证 · 2026-11-21

## 一、优化的是什么

11-21 的 `--api` v0.9.89 复测发现 **C23-frontmatter-indent 数字丢失**：
LLM 改写把 YAML frontmatter（`date: 2026-10-18`）整块吞掉，丢了 2026/10/18 三个数字。
本地引擎早有 `format-integrity.ts` 逐字冻结 frontmatter / 围栏块，但 **`--api` 路径把整篇丢给 LLM
重写，看不到这层保护**。

## 二、改了什么

| 文件 | 改动 |
|---|---|
| `scripts/pin-guard.ts` | 新增 `autoStructurePins(text)`：从原文提取 frontmatter（含首尾 `---`）与围栏代码块（含围栏行），交给既有 pin 通道 |
| `scripts/humanize-cli.ts` | 仅 `--api`（cfg 存在）时，把自动结构 pin 与用户显式 `--pin` 合并去重；本地引擎路径不加（已有 format-integrity，避免重复） |
| `scripts/pin-guard.test.ts` | +5 用例（C23 frontmatter / 围栏+frontmatter 排序 / 无结构 / 自带边界跳过 / 往返还原） |

机制：LLM 只见 `⟦逐字保留N⟧` 占位符，产出后 `restorePins` 还原；**任一结构块丢失 ⇒ 整篇回退原文**。
默认行为（本地引擎、无 frontmatter/围栏的稿）逐字不变。

## 三、验证

### 单元 / 门禁
- `pin-guard.test.ts`：14 用例全过（原 9 + 新 5）。
- tsc 0 / lint 0 / 全量 vitest **129 文件 2400 用例全绿**（基线 2395，+5 即新增用例）。

### 端到端（`verify.json`）
用 C23 原文 + `glm/glm-5.3-flash`（reasoning_effort=low）走
preparePins → LLM → restorePins，两组对照：

| 组 | frontmatter 存活 | 含 date 数字 | 备注 |
|---|---|---|---|
| A 无结构钉住（基线） | ✅ | ✅ | 本次 LLM 自己就保留了 |
| B 自动结构钉住 | ✅ | ✅ | 提取 1 pin、token 全部还原、0 缺失、未触发回退 |

**必须如实说明**：A 组这次也保留了 frontmatter ⇒ **没有复现 11-21 那次失败**（LLM 非确定性，
同 prompt 不同批次输出不同）。因此本轮证明的是「机制正确、且不破坏正常产出」，
**不是「修复了 C23 失败」**。要证明后者需多次重采样A组出现失败、B组不失败的配对证据。

## 四、边界

- 自动提取范围是 frontmatter + 围栏代码块；**缩进代码块不提取**——整块钉住会连同前后正文一起吞，
  且 C23 新臂里缩进代码行本身存活率较高；需逐字保留可显式 `--pin`。
- `⟦逐字保留N⟧` 占位符存活率非 100%；丢失时按既有契约整篇回退（宁可不改，也不毁事实）。
- 原文若自带 pin 占位符边界，`preparePins` 整体拒绝（既有防歧义行为，未改）。

## 五、复现

```bash
# 单测
cd /d/projects && env -u NODE_OPTIONS node /d/projects/quaiwei/node_modules/vitest/vitest.mjs \
  run --root D:/projects/quaiwei scripts/pin-guard.test.ts

# 端到端（需 18326 GLM 直连通道 + reasoning_effort=low）
env -u NODE_OPTIONS node node_modules/tsx/dist/cli.mjs scripts/_verify-autopin.ts
# → evidence/autopin-c23-2026-11-21/verify.json
```
