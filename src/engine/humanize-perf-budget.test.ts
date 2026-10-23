/**
 * 性能预算门禁（2026-10-17 补，起因：性能此前**零门禁**）
 *
 * 现状盘点（补测前）：
 *   - `scripts/bench.ts` 把耗时打到控制台，没有阈值，也不在 `check:release` 里
 *     ⇒ 没人看，看了也没有判定标准；
 *   - `humanize-metrics-perf.test.ts` 名字里有 perf，但只断言指标等价性，一条耗时断言都没有；
 *   - 结论：把某条规则改成 O(n²)、或者让全流程常数因子慢 5 倍，**没有任何自动化会红**。
 *
 * 判据为什么这样定（这条最重要，改阈值前先读）：
 *   1. **不比绝对秒数**。本机测试是 90+ 文件并行 + v8 覆盖率插桩，同一段代码的墙钟时间
 *      能差 5~10 倍；绝对阈值写死必然变成 flaky 门禁，而 flaky 门禁的结局一定是被人关掉。
 *   2. **比同一进程内相邻两次测量的比值**。并发噪声对相邻测量近似同比例，比值稳定；
 *      而 O(n²) 一旦出现，4 倍字数会变成 ~16 倍耗时，比值直接打穿。
 *   3. 绝对上限只作**兜底**，设为实测值的一个数量级，专抓「灾难性退化」。它红的时候
 *      先怀疑代码，再怀疑机器。
 *   4. 计时取 n 次的**最小值**而不是平均：GC 尖峰只会拉高某一次，min 对噪声免疫。
 *
 * 实测基线（2026-10-17，本机无插桩，`npx tsx scripts/bench.ts`）：
 *   571 字 3ms / 2855 字 11ms / 5710 字 21ms / 11420 字 40ms / 28550 字 92ms
 *   ⇒ 线性度极好（5 倍字数 = 4.4 倍耗时），本文件的阈值因此有 ≥8 倍余量。
 *
 * 变异检验（2026-10-17 实做，不是推演）：
 *   在 `humanize()` 入口注入真 O(n²) 空循环（`for i < len: for j < len`）后，
 *   本用例红：**小样本 15.8ms → 大样本 122.5ms（7.8x），expected < 6**。
 *   注意 7.8 而不是 16——引擎自身的 O(n) 部分仍占大头，把比值稀释了；
 *   所以这条门禁抓的是「真 O(n²) 量级」的退化，不是「慢 20%」。
 *   另做了反向验证：把内层步长改成 `j += len/400`（约 200 万次空转，引擎本体占主导）
 *   时用例**照常绿** ⇒ 轻度退化它确实抓不到，别指望它当 benchmark 用。
 */
import { describe, expect, it } from "vitest";
import { humanize } from "./humanize";
import { humanizeBestOf } from "./humanize-bestof";

/** 真实语体感的固定语料：每段约 75 字，三段一组 ≈ 225 字 */
const PARA = [
  "随着人工智能技术的不断发展，赋能千行百业已成为大势所趋。值得注意的是，这一变革在提升效率的同时，也带来了数据安全与伦理层面的新问题。",
  "从产业侧看，模型能力的下沉让中小企业第一次有机会以较低成本获得专家级的生产力工具，但配套的流程改造与人员培训往往被低估。",
  "另一方面，监管框架仍在快速演进。合规成本的上升会淘汰一部分投机者，也会让真正有场景积累的团队获得更长的窗口期。",
].join("\n\n");

function build(mult: number): string {
  return Array.from({ length: mult }, () => PARA).join("\n\n");
}

/** 取 n 次的最小耗时：min 对并发噪声与 GC 尖峰最稳 */
function bestMs(fn: () => void, n = 3): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

/**
 * 交替测量两档规模、各取 min（2026-10-19 加固，起因 CI run 39146780923 判红 6.55x）。
 *
 * 原实现「先小后大各测 3 次」有一个时序盲区：两档测量在时间上分离，一旦 runner
 * 进入慢时段（90+ 文件并行 + v8 插桩），慢时段会整体落在某一档上（本例是大的那档），
 * min-of-3 救不回来。交替后并发噪声对两档近似同分布，比值恢复稳定；
 * 阈值与判据不变——真 O(n²)（注入实测 7.8x）照样打穿 6x。
 *
 * 2026-10-22：覆盖率门禁里仍偶发过一次墙钟假红（单跑 396ms 绿、带插桩 1053ms 红）。
 * 试过 process.cpuUsage 口径，但小样本只有 0.5~2ms，计时粒度反而让比值更抖，已回退。
 * 最终保留 min-of-5 墙钟，并给这条用例加一次 retry：调度噪声是偶发的，
 * 真 O(n²) 是确定性的——重试能消掉前者，消不掉后者（阈值没有放松）。
 *
 * 2026-10-23（CI run 39935799845 判红 6.04x / 6.16x，retry 也没救回来）：
 * 根因不是噪声变大，而是**小样本太小**——CI runner 上小样本只有 6.4~7.9ms，
 * 计时精度与 GC 抖动占比接近 10%，直接乘进比值里。诊断证据：
 *   小 7.9ms → 大 47.7ms（6.04x）／小 6.4ms → 大 39.6ms（6.16x）
 * 处置：**把两档规模各放大 4 倍**（4.5k→18k 字、18k→72k 字），保持"4 倍字数"这个判据不变。
 * 小样本抬到 30ms 量级后，同样 1ms 的抖动只影响 3% 而不是 15%。阈值仍是 6（没放松）。
 */
function bestMsPair(smallFn: () => void, largeFn: () => void, n = 5): [number, number] {
  let small = Number.POSITIVE_INFINITY;
  let large = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    smallFn();
    small = Math.min(small, performance.now() - t0);
    const t1 = performance.now();
    largeFn();
    large = Math.min(large, performance.now() - t1);
  }
  return [small, large];
}

describe("性能预算门禁", () => {
  it("标度近线性：4 倍字数不得吃掉 6 倍耗时（O(n²) 会到 ~16 倍）", { retry: 1 }, () => {
    // 规模刻意取大：小样本必须≥30ms 量级，否则计时精度/GC 抖动会直接乘进比值
    // （2026-10-23 CI 实测：小样本 6~8ms 时同一个引擎被判成 6.04x）。
    const small = build(80); // ≈ 18k 字
    const large = build(320); // ≈ 72k 字，仍是 4 倍
    const opts = { intensity: 0.9, seed: 20261017 } as const;

    // 预热：让 JIT 先编译热路径，避免第一次测量的编译开销污染比值
    humanize(small, opts);
    humanize(large, opts);

    // 交替测量两档规模、各取 min-of-5：并发噪声对两档近似同分布（见 bestMsPair 注释）
    const [tSmallRaw, tLarge] = bestMsPair(
      () => humanize(small, opts),
      () => humanize(large, opts),
      5,
    );
    // 下限 0.5ms：小样本若被计时器量化到 0，比值会变成 Infinity/NaN 而失去意义
    const tSmall = Math.max(tSmallRaw, 0.5);
    const ratio = tLarge / tSmall;

    expect(
      ratio,
      `标度异常：小样本 ${tSmall.toFixed(1)}ms → 大样本 ${tLarge.toFixed(1)}ms（${ratio.toFixed(1)}x）`,
    ).toBeLessThan(6);

    // 兜底：绝对上限只抓灾难性退化（本机无插桩 ~250ms，覆盖插桩后约 8x 余量）
    expect(tLarge, `72k 字耗时 ${tLarge.toFixed(0)}ms，已超兜底上限`).toBeLessThan(5000);
  });

  it("bestOf 8 稿预算：2.8k 字 ≤ 6000ms（本机无插桩 ~90ms）", () => {
    const text = build(13); // ≈ 2.9k 字，低于 bestof 的 4000 字自动收敛阈值
    const opts = { intensity: 0.9, seed: 20261017, zhuqueMode: true, candidates: 8 } as const;

    humanizeBestOf(text, opts); // 预热
    const ms = bestMs(() => humanizeBestOf(text, opts), 2);

    expect(ms, `bestOf 8 稿耗时 ${ms.toFixed(0)}ms，已超兜底上限`).toBeLessThan(6000);
  });
});
