# QuAiWei · Chinese AI-text humanizer

[![CI](https://github.com/fengxingxuerong/quaiwei/actions/workflows/ci.yml/badge.svg)](https://github.com/fengxingxuerong/quaiwei/actions/workflows/ci.yml)

**Local-first. No API key required. Works offline. Deterministic (fixed seed).**

Rewrites machine-polished Chinese prose so it reads like a person wrote it. Unlike most projects
in this space (a list of rules handed to an LLM), this is a **compiled TypeScript engine with a
2,400-case regression suite** — every rule is anchored to a real text sample and locked by a test.

> 中文完整文档：[README.md](README.md) · [成绩页 SCORECARD](SCORECARD.md) · [CHANGELOG](CHANGELOG.md) · [Contributing](CONTRIBUTING.md)

---

## 30-second demo (real engine output, reproducible)

**Input** (151 chars, stock-phrase-heavy AI style, local proxy score **63**):

> 值得注意的是，数字化转型已经成为企业发展的必然趋势。综上所述，通过持续的创新能力，企业不仅能够提升自身的核心竞争力，更能够在激烈的市场竞争中立于不败之地。首先，企业需要构建全链路的数字化体系；其次，需要打造闭环的运营机制；最后，需要以数据赋能业务增长。总而言之，这一进程标志着行业进入了新的发展阶段。

**Output** (intensity 0.6 · plain style · seed 20260905; proxy score 63→43):

> 数字化转型已经成为企业发展的必然趋势。归结起来，借一贯的创新能力，企业不光能够提高自身的核心竞争力。更能够在激烈的市场竞争中立于不败之地。总的来看，这一进程标志着行业进入了新的发展阶段。企业需要构建全流程的数字化体系；再者，需要建完整回路的运营机制；需要以数据助力业务增长。

Stock openers (`值得注意的是`, `综上所述`, `首先/其次/最后`) are gone; numbers and stance are
untouched. Reproduce it yourself:

```bash
git clone https://github.com/fengxingxuerong/quaiwei.git && cd quaiwei
npx tsx scripts/humanize-cli.ts in.txt --out out.txt --intensity 0.6 --seed 20260905
```

The proxy score is a **local heuristic** (stock-phrase density, sentence-length evenness) — it is
useful for before/after trend on the same text, **not** calibrated to any vendor's detector.

---

## What makes it different

| | Rule-list skills (blader/humanizer, Humanizer-zh, stop-slop…) | QuAiWei |
|---|---|---|
| Engine | A markdown file the LLM reads | TypeScript engine, **2,400+ test cases**, CI on every push |
| Runs offline | No (needs an LLM) | **Yes** — default path is local, costs nothing, sends nothing |
| Reproducible | No | **Yes** — fixed seed; same input + same seed → same output (CLI / MCP) |
| Built-in scoring | No | Yes — heuristic proxy score + explainable per-item trace (`--explain`) |
| Real detector loop | No | **Any vendor**: `--detector-url` takes any POST-`{text}`→JSON endpoint (repeatable, several detectors side by side), scores land in a batch report |
| Fidelity guards | Hoping the model behaves | Number-fidelity guard (lost/mutated numbers are flagged), 23 structural invariants (code blocks / tables / headings / quotes), strict mode rolls back invented facts |
| Own failure data | One sentence, if any | A whole [SCORECARD](SCORECARD.md) page: what it can't do, with dated numbers |

The skills you compare this against are excellent **prompt catalogues**. This is the layer below:
something you can `git clone` and unit-test.

**What it deliberately does not do offline:** it does not rearrange paragraph structure or rewrite
sentence order ("changes words, not bones") — that is the price of the *no-invented-facts*
guarantee. Structure-level rewriting exists only in the optional LLM deep mode. A fine-tuned 12B
local model ([sgaofen/humanizer-local-model](https://github.com/sgaofen/humanizer-local-model))
occupies that exact gap; it trades 4 GB of weights and ~73% Chinese fact fidelity for it. Both
trade-offs are stated; pick per job.

---

## Install

**Try it in your browser** — no install needed: **[online demo](https://fengxingxuerong.github.io/quaiwei/)** (live)

**Desktop (Windows, no install, ~203 MB zip / ~513 MB extracted):**
[latest release](https://github.com/fengxingxuerong/quaiwei/releases/latest) — unzip, double-click
`QuAiWei.exe`. The published desktop build can lag behind the repo version; check the release page.

**CLI** (needs the repo locally + Node ≥ 22.12):

```bash
git clone https://github.com/fengxingxuerong/quaiwei.git && cd quaiwei
npx tsx scripts/humanize-cli.ts ./drafts --out ./out          # batch a directory (.txt/.md/.docx)
npx tsx scripts/humanize-cli.ts in.txt --api                  # optional LLM deep loop
npx tsx scripts/humanize-cli.ts in.txt --detector-url <url> --detector-path data.prob --report rep.json
```

Input can be a file or a directory (`.txt` / `.md` / `.docx`). Encoding is auto-detected
(UTF-8 / BOM / UTF-16 / GBK); output is always UTF-8.

**MCP server** (Claude Code / Desktop / Cursor / any MCP client):

```bash
npm run build:cli && node dist-cli/quaiwei-mcp.mjs
```

Tools: `humanize_text`, `detect_ai`, `quality_report`, `academic_report` — stdio JSON-RPC,
protocol versions `2025-06-18` / `2025-03-26` / `2024-11-05`, zero dependencies.

**As an Agent Skill:**

```bash
npx skills add fengxingxuerong/quaiwei
```

---

## Options worth knowing

| Flag | Default | Notes |
|---|---|---|
| `--intensity <0-1>` | `0.6` | Rewrite strength; use `0.9` explicitly for aggressive rewriting |
| `--style` | `plain` | `plain` \| `casual` \| `academic` — use `academic`/`plain` for papers and official documents |
| `--zhuque` | off | Injects anti-fingerprint features |
| `--seed <n>` | `20260905` | Fixes randomness, makes runs reproducible |
| `--explain` | off | Emits a per-edit trace: which rule fired, which table it came from |
| `--strict` | off | Refuses delivery and rolls back if facts were invented |
| `--api` | off | LLM deep loop (otherwise pure local engine) |
| `--detector-url <url>` | — | Any POST-`{text}`→JSON detector; repeatable for side-by-side vendors |
| `--detector-path <json.path>` | — | JSON path to the AI-probability field of that detector |
| `--report <file>` | — | Per-file JSON: timing, word count, engine, round scores, downgrade reasons |
| `--variant zh-TW` | off | Regional wording adjustments (word/punctuation level; not glyph conversion — run OpenCC yourself) |
| `--academic-check` | off | Hard gate for academic use: verdict READY / NOT READY |

Full list: see the parameter table in `SKILL.md` — it is asserted against the CLI both ways by
`skill-md.test.ts`, so it cannot drift.

---

## How the local engine works

Pure TypeScript, zero third-party dependencies at runtime, runs in browser and Node:

1. **Shield** — fenced code blocks, front matter, tables and other structure are frozen first.
2. **Replace** — ~1,000-entry vocabulary of AI stock phrases / officialese → natural alternatives;
   template openers dropped; passive and formulaic collocations relaxed.
3. **Split & merge sentences** — break up uniform sentence lengths (burstiness), merge over-short ones.
4. **Inject humanity** (intensity-gated) — parentheticals, self-QA, fragments; punctuation loosened.
5. **Guards** — fingerprint caps (template repetition), register gating, number fidelity,
   structural invariants; `bestOf` runs 8 candidates and keeps the one that scores best without
   breaking fidelity gates.

Intensity below 0.35 does nothing (the ramp starts there — deliberately, after a cliff was
measured at 0.40 between "merge on / split off" thresholds).

---

## Honest disclaimer

**This project does not promise to pass any detector.**

- `aiScore` is a **local heuristic proxy score**. It is **not calibrated** to any vendor's number.
  Before/after on the *same* text is meaningful; across texts it is not. Human-written Wikipedia
  articles score 8–95 (median 35) — the metric measures stock-phrase density, not "humanness".
- It measures vocab-level tells only: injecting AI clichés raises it in 19/21 cases (+14.6 mean),
  but rewriting formal register to casual barely moves it (2/21, −0.6). **A low score does not
  prove it reads human.**
- Known failure, measured: on government-style reports the local score said "fine" (**2**) while
  the external detector said "definitely AI" (**90**). Four of five deliverables scored ≤13 locally
  and ≥70 externally. Do not use the before/after drop as a safety verdict — the UI shows a banner
  when local and external scores disagree hard.
- The old aiScore → Zhuque official-score calibration (18 hand-transcribed points, a per-genre
  conversion line, drift ratchet, evidence ledger with **0/18 credential coverage**) was **removed
  entirely in v0.9.83**: an unverifiable conversion pretends to a precision it cannot back.
  History lives in `docs/fingerprint-and-zhuque-calibration.md` (archived).

## Competitor landscape (measured 2026-10-27; scan script: `node scripts/scan-github-sector.mjs --md`)

| Project | ★ | Offline | Chinese | Structure-level | Detector hook-up |
|---|---:|:--:|:--:|:--:|:--:|
| blader/humanizer | 60,979 | ✗ | ✗ | LLM decides | ✗ |
| op7418/Humanizer-zh | 21,047 | ✗ | ✓ | LLM decides | ✗ |
| hardikpandya/stop-slop | 18,371 | ✗ | ✗ | LLM decides | ✗ |
| petergyang/no-ai-slop | 12,847 | ✗ | ✗ | LLM decides | ✗ |
| sgaofen/humanizer-local-model | 546 | ✓ | ✓ | ✓ (12B weights) | self-reported once |
| **quaiwei** | 3 | ✓ | ✓ | LLM deep mode only | **✓ any HTTP endpoint, multi-vendor** |

Self-reported pass-rates elsewhere (">50% → 11%", "100% human-rate cases") have **not been
reproduced here** — and no forward pass-rate sample exists in this repo either (the credential
ledger, stuck at 0/18, was removed with the calibration subsystem in v0.9.83). Both facts are
stated so the reader can tell them apart.

## Development

```bash
npm ci                # install
npm run check:env     # environment probe (esbuild platform binary present & runnable)
npm test              # 2,400+ cases, ~15 s
npm run check:release # the full gate chain CI runs
```

CI runs on every push: type check, lint, format, regex self-check, version-sync across 11 files,
unit tests with coverage gate, engine regressions, real-corpus matrix, relative-improvement gate.

## License

MIT
