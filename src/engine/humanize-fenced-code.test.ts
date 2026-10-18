/**
 * v0.9.54：Markdown 围栏代码块整块冻结 —— humanize() 端到端回归。
 *
 * ## 为什么单独立文件
 *
 * 缺陷是追 realcase C9「段落 6→7」时实测抓出来的，两层后果都**不在**单元测试视野里：
 *   ① 段落切分 `text.split(/\n+/)` + `join("\n\n")` 把代码块**逐行炸开**（行间凭空多出空行）；
 *   ② 更严重的是每行独立跑 `humanizeSingle`，围栏里的**中文注释被当正文改写**
 *      （实测「此外，需要说明的是」→「再说，需要说明的是」）。
 * 代码是事实性内容，与 URL / 邮箱 / 书名号同性质：改它不叫去味，叫篡改。
 *
 * ## 断言纪律
 *
 * - **多种子 × 多强度扫描**：是否替换取决于 rng 落点 + 强度档，单点跑一遍等于抽奖。
 * - **判据写死为独立常量**（下面的 BODY/CODE/TAIL），不从生产词表反查——
 *   否则"删掉词表项"会连带删掉对它的检查，测试给缺陷发通行证。
 * - 每条都配一条反向断言（引擎确实在动 / 无围栏时行为不变），防止"整体没跑"的假绿。
 */
import { describe, expect, it } from "vitest";
import { humanize } from "./humanize.ts";

/** 正文首段：典型 AI 套话，用来证明「引擎确实在动」（不是整体没跑） */
const BODY = "此外，需要说明的是，本次迭代的相关工作已经完成。";
/** 围栏块：内含同一句套话 + 三行代码。这几行**一个字符都不许变** */
const CODE = "```\n// 此外，需要说明的是，这里是代码注释\nconst a = 1;\nconst b = 2;\n```";
/** 尾段 */
const TAIL = "综上所述，本次迭代的相关工作已经完成，后续将持续优化。";
const DOC = `${BODY}\n\n${CODE}\n\n${TAIL}`;

/** 无围栏对照：段间距必须恒为 \n\n（与改动前逐字一致） */
const PLAIN = `${BODY}\n\n${TAIL}\n\n因此，我们认为该方案具备可行性。`;

/**
 * 行长**均匀**的长代码块（CV 低 ⇒ boostBurstinessByCutting 真的会动手）。
 *
 * 短代码块行长短不一、CV 天然达标，切句层直接 break ⇒ 上面的用例**证不出**
 * 节奏兜底那两处 `burstCut` 的围栏保护（变异检验实测：拆掉保护照样绿）。
 * 这一组是专门为它准备的：4 行等长注释，实测（seed 42/20261015/88888，强度 1.0）
 * 保护被拆时会把注释里的「，」切成「。」并吃掉块内换行。
 */
const CODE_LONG = [
  "```",
  "// 此外，需要说明的是，这是第一行注释说明",
  "// 此外，需要说明的是，这是第二行注释说明",
  "// 此外，需要说明的是，这是第三行注释说明",
  "// 此外，需要说明的是，这是第四行注释说明",
  "```",
].join("\n");

const SEEDS = [1, 7, 42, 20261015, 88888];
const LEVELS = [0.6, 0.9, 1];

/** 按 \n\n+ 切出的非空段数 */
const paraCount = (s: string): number => s.split(/\n\n+/).filter((p) => p.trim()).length;

describe("围栏代码块：整块冻结（v0.9.54 主缺陷回归）", () => {
  it("围栏块逐字保留 —— 不改写、不压平、不被逐行炸开（5 seed × 3 强度）", () => {
    for (const intensity of LEVELS) {
      for (const seed of SEEDS) {
        const out = humanize(DOC, { intensity, seed });
        // ① 内容一个字符不变（含中文注释里的套话）
        expect(out.includes(CODE), `i=${intensity} seed=${seed} 围栏块被改动`).toBe(true);
        // ② 没被压平：`splitSentences + join("")` 会把块内换行吃光（实测 8 → 4）
        expect(out.includes("\n```\n// 此外"), `i=${intensity} seed=${seed} 块内换行丢失`).toBe(
          true,
        );
        // ③ 没被逐行炸开：段数守恒为 3（正文 / 代码块 / 尾段）
        expect(paraCount(out), `i=${intensity} seed=${seed} 段落数`).toBe(3);
      }
    }
  });

  it("反向断言：同一篇里正文确实被改了（证明上面不是「整体没跑」的假绿）", () => {
    let changed = 0;
    for (const intensity of LEVELS) {
      for (const seed of SEEDS) {
        const out = humanize(DOC, { intensity, seed });
        if (!out.startsWith(BODY)) changed++;
      }
    }
    // 不要求每个种子都改（rng 落点决定），但整组一次都不改 = 管线压根没跑
    expect(changed).toBeGreaterThan(0);
  });

  it("行长均匀的长代码块同样冻结（证节奏兜底两处 burstCut 的围栏保护）", () => {
    for (const seed of SEEDS) {
      const out = humanize(`${BODY}\n\n${CODE_LONG}\n\n${TAIL}`, { intensity: 1, seed });
      expect(out.includes(CODE_LONG), `seed=${seed} 长代码块被改动`).toBe(true);
      expect(paraCount(out), `seed=${seed} 段落数`).toBe(3);
    }
  });

  it("单段就是一个围栏块 → 原样返回", () => {
    for (const seed of SEEDS) {
      expect(humanize(CODE, { intensity: 1, seed })).toBe(CODE);
    }
  });

  it("波浪号围栏与未闭合围栏同样冻结", () => {
    const tilde = "~~~\n此外，需要说明的是，波浪号围栏\nconst x = 1;\n~~~";
    const open = "```\n此外，需要说明的是，未闭合围栏\nconst y = 2;";
    for (const seed of SEEDS) {
      expect(humanize(`${BODY}\n\n${tilde}\n\n${TAIL}`, { intensity: 1, seed })).toContain(tilde);
      expect(humanize(`${BODY}\n\n${open}\n\n${TAIL}`, { intensity: 1, seed })).toContain(open);
    }
  });
});

describe("无围栏输入：零回归（冻结逻辑不得改变普通文本的行为）", () => {
  it("段间距恒为 \\n\\n，段数守恒，不出现三连换行", () => {
    const expectPara = paraCount(PLAIN);
    for (const intensity of LEVELS) {
      for (const seed of SEEDS) {
        const out = humanize(PLAIN, { intensity, seed });
        expect(paraCount(out), `i=${intensity} seed=${seed} 段数`).toBe(expectPara);
        expect(out.includes("\n\n\n"), `i=${intensity} seed=${seed} 出现三连换行`).toBe(false);
      }
    }
  });

  it("无围栏时输出不含围栏判据的副作用：普通段落仍被改写", () => {
    const out = humanize(PLAIN, { intensity: 1, seed: 20261015 });
    expect(out).not.toBe(PLAIN);
  });
});
