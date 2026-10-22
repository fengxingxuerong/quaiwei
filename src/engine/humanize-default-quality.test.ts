import { describe, expect, it } from "vitest";
import { humanize } from "./humanize.ts";
import { replaceWithDevelopment, replaceVocab, softenPassive } from "./humanize-replace.ts";
import { fragmentCanStand } from "./humanize-vocab.ts";
import { fragmentFrontCanStand } from "./humanize-primitives.ts";

/**
 * 默认档（0.6 / plain）的用户路径回归。
 *
 * 2026-10-22 在浏览器里点「示例」→「去味」后读产出，抓到四类问题：
 *   · 28/40 种子把「随着人工智能技术的快速发展」整段删掉，只剩「AI 写作工具应运而生。」；
 *   · 「有效地」抽到「真的」→「还真的降低了运营成本」9/40，书面稿里冒出聊天腔；
 *   · 「推动」抽到「拉动」→「拉动可持续发展」12/40，搭配不成立；
 *   · 「实现」抽到「达成」→「达成更高质量的发展」14/40，搭配不成立。
 *
 * 这些问题都不是单点偶发，所以用多种子钉住，而不是只测一个 seed。
 */
describe("默认档 0.6 / plain 的用户可见质量（2026-10-22）", () => {
  const SAMPLE = `值得注意的是，随着人工智能技术的快速发展，AI 写作工具应运而生。
综上所述，数字化办公不仅极大地提升了工作效率，而且有效地降低了运营成本。
然而，技术的变革也带来了一系列值得关注的挑战。与此同时，如何平衡创新与风险，成为至关重要的课题。
从长远来看，建立完善的监管体系，推动可持续发展，具有十分重要的意义。
因此，我们需要在实践中逐步优化相关流程，进而实现更高质量的发展。`;

  const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);

  it("「随着…发展」改写成保留主语的短句，不整段删掉实义内容", () => {
    for (const seed of SEEDS) {
      const out = humanize(SAMPLE, { intensity: 0.6, seed, style: "plain" });
      expect(out, `seed=${seed}\n${out}`).toContain("人工智能技术");
      expect(out, `seed=${seed}\n${out}`).toContain("快速发展");
      expect(out, `seed=${seed}\n${out}`).not.toContain("现在AI");
    }
  });

  it("默认档不产出搭配/语体病句（拉动可持续、还真的、达成发展）", () => {
    for (const seed of SEEDS) {
      const out = humanize(SAMPLE, { intensity: 0.6, seed, style: "plain" });
      expect(out, `seed=${seed}\n${out}`).not.toContain("拉动可持续");
      expect(out, `seed=${seed}\n${out}`).not.toContain("还真的");
      expect(out, `seed=${seed}\n${out}`).not.toMatch(/达成[^。！？\n]{0,12}发展/);
      expect(out, `seed=${seed}\n${out}`).not.toMatch(/落地[^。！？\n]{0,12}发展/);
    }
  });

  it("光杆连接词不会被切成独立句（所以。我们需要…）", () => {
    // seed 52 在修复前稳定产出「所以。我们需要…」。
    for (const seed of [...SEEDS, 52]) {
      const out = humanize(SAMPLE, { intensity: 0.6, seed, style: "plain" });
      expect(out, `seed=${seed}\n${out}`).not.toMatch(
        /(?:^|\n)(?:所以|于是|因此|可是|不过|然而|而且|并且|但是|而是|接着|进一步|再往下)。/,
      );
    }
    expect(fragmentFrontCanStand("所以")).toBe(false);
    expect(fragmentFrontCanStand("因此")).toBe(false);
    expect(fragmentFrontCanStand("还有")).toBe(false);
    expect(fragmentFrontCanStand("首先是制度建设方面")).toBe(false);
  });

  it("学术摘要不在「提出/将/发现当」处切出无主残句", () => {
    const ACADEMIC = `本文针对低资源场景下的命名实体识别任务，提出了一种基于对抗训练的半监督方法。该方法通过引入梯度反转层，将领域对抗损失与任务损失进行联合优化，从而增强了模型在不同领域之间的迁移能力。我们在三个公开数据集上进行了充分的实验，实验结果表明，所提方法相较于基线模型在 F1 值上平均提升了 3.2 个百分点。进一步的消融实验验证了各个组件的有效性。此外，本文还探讨了标注数据量与模型性能之间的关系，发现当标注样本少于 500 条时，对抗训练带来的增益尤为显著。`;
    for (const seed of SEEDS) {
      const out = humanize(ACADEMIC, { intensity: 0.6, seed, style: "plain" });
      expect(out, `seed=${seed}\n${out}`).not.toMatch(/。\s*提出/);
      expect(out, `seed=${seed}\n${out}`).not.toMatch(/。\s*将[^。]{0,20}联合优化/);
      expect(out, `seed=${seed}\n${out}`).not.toMatch(/。\s*发现当/);
      expect(out, `seed=${seed}\n${out}`).not.toMatch(/(?:^|\n)还有。/);
    }
    expect(fragmentCanStand("提出了一种基于对抗训练的半监督方法")).toBe(false);
    expect(fragmentCanStand("将领域对抗损失与任务损失进行联合优化")).toBe(false);
    expect(fragmentCanStand("发现当标注样本少于 500 条时")).toBe(false);
    expect(fragmentCanStand("有效提高了团队的整体专业素养")).toBe(false);
  });

  it("事实密集段不被结构重排（数字与指标的绑定关系不变）", () => {
    // realcase C16：structure 层曾把 32.68/21.4%/4.27/15.8% 重排成错误配对。
    const PROSPECTUS = `受益于下游新能源汽车行业的持续高景气，公司主营业务收入实现较快增长。2025 年度，公司实现营业收入 32.68 亿元，同比增长 21.4%；实现归属于母公司股东的净利润 4.27 亿元，同比增长 15.8%。报告期末，公司应收账款账面价值为 6.92 亿元，占当期营业收入的比例为 21.18%，存在一定的坏账风险。综上所述，公司所处行业竞争日趋激烈，若未来主要产品价格出现大幅波动，将对公司的经营业绩产生不利影响。`;
    for (const intensity of [0.6, 0.9]) {
      for (const seed of [1, 42, 20261015]) {
        const out = humanize(PROSPECTUS, { intensity, seed, style: "plain" });
        const at = (n: string) => out.indexOf(n);
        expect(at("32.68"), `i=${intensity} seed=${seed}\n${out}`).toBeLessThan(at("21.4"));
        expect(at("21.4"), `i=${intensity} seed=${seed}\n${out}`).toBeLessThan(at("4.27"));
        expect(at("4.27"), `i=${intensity} seed=${seed}\n${out}`).toBeLessThan(at("15.8"));
        expect(at("6.92"), `i=${intensity} seed=${seed}\n${out}`).toBeLessThan(at("21.18"));
        expect(out, `i=${intensity} seed=${seed}\n${out}`).not.toContain("做到营业收入");
        expect(out, `i=${intensity} seed=${seed}\n${out}`).not.toContain("做到较快增长");
        expect(out, `i=${intensity} seed=${seed}\n${out}`).not.toContain("一天天");
        expect(out, `i=${intensity} seed=${seed}\n${out}`).not.toMatch(
          /受益于[^。]{0,30}。\s*公司/,
        );
        expect(out, `i=${intensity} seed=${seed}\n${out}`).not.toMatch(/若[^。]{0,30}。\s*将/);
      }
    }
  });

  it("真实案例的标签/从句不被切成残句（C3/C5/C15）", () => {
    const TECH = `Transformer 架构自 2017 年提出以来，已经成为自然语言处理领域的事实标准。其核心创新在于引入了 Self-Attention 机制。以 BERT 为例，该模型通过在大规模语料上进行 Masked Language Model 预训练，明显提升了下游任务的表现。需要指出的是，并非所有算子都能被 graph capture 正确捕获。`;
    const NEWS = `本报讯（记者 李明）10 月 12 日，蓝海科技在其总部召开新品发布会，正式对外发布了新一代工业机器人产品线。该产品线包含三个型号，分别面向电子制造、汽车零部件以及新能源三大行业场景。`;
    const QA = `问：企业未取得排污许可证即排放污染物，应当承担何种法律责任？答：依据《排污许可管理条例》第三十三条的规定，未取得排污许可证排放污染物的，由生态环境主管部门责令改正或者限制生产、停产整治。`;
    for (const seed of SEEDS) {
      const tech = humanize(TECH, { intensity: 0.6, seed, style: "plain" });
      expect(tech, `seed=${seed}\n${tech}`).not.toContain("需要指出的是。");
      const news = humanize(NEWS, { intensity: 0.6, seed, style: "plain" });
      expect(news, `seed=${seed}\n${news}`).not.toMatch(/日。\s*蓝海/);
      expect(news, `seed=${seed}\n${news}`).not.toMatch(/分别面向[^。]{0,12}。\s*(?:汽车|新能源)/);
      const qa = humanize(QA, { intensity: 0.6, seed, style: "plain" });
      expect(qa, `seed=${seed}\n${qa}`).not.toMatch(/污染物。\s*应当/);
    }
  });

  it("判决书的承前谓语与条件从句不被切碎（C17）", () => {
    const VERDICT = `上诉人北京某科技有限公司因与被上诉人李某劳动争议一案，不服北京市海淀区人民法院（2025）海0105民初12345号民事判决，向本院提起上诉。本院于二〇二六年三月十八日立案后，依法组成合议庭进行了审理。本案现已审理终结。本院认为，根据《中华人民共和国劳动合同法》第十条、第八十二条之规定，用人单位自用工之日起超过一个月不满一年未与劳动者订立书面劳动合同的，应当向劳动者每月支付二倍的工资。`;
    for (const seed of SEEDS) {
      const out = humanize(VERDICT, { intensity: 0.6, seed, style: "plain" });
      expect(out, `seed=${seed}\n${out}`).not.toMatch(/一案。\s*不服/);
      expect(out, `seed=${seed}\n${out}`).not.toMatch(/判决。\s*向本院/);
      expect(out, `seed=${seed}\n${out}`).not.toMatch(/的。\s*应当/);
      expect(out, `seed=${seed}\n${out}`).not.toMatch(/立案后。\s*依法/);
      expect(out, `seed=${seed}\n${out}`).not.toMatch(/上诉请求。\s*撤销/);
    }
    expect(fragmentCanStand("能一下子抱起我")).toBe(false);
    expect(fragmentCanStand("向长期以来关心和支持大会发展的各级领导和社会各界人士")).toBe(false);
    expect(fragmentCanStand("以 BERT 为例")).toBe(false);
    expect(fragmentFrontCanStand("值此 2026 世界制造业大会召开之际")).toBe(false);
    expect(fragmentFrontCanStand("回顾过去五年")).toBe(false);
  });

  it("致辞/儿童作文的承前谓语不被切碎（C19/C20）", () => {
    const KID = `我的爸爸是一名快递员。他每天早上六点钟就出门了，晚上很晚才回家。爸爸的手很粗糙，但是他的力气很大，能一下子抱起我。`;
    const SPEECH = `尊敬的各位领导、各位来宾，同志们、朋友们：大家上午好！值此 2026 世界制造业大会召开之际，我们欢聚一堂，共同见证这一重要时刻。首先，我谨代表本次大会的主办方，向长期以来关心和支持大会发展的各级领导和社会各界人士，表示衷心的感谢和热烈的欢迎！`;
    for (const seed of SEEDS) {
      const kid = humanize(KID, { intensity: 0.6, seed, style: "plain" });
      expect(kid, `seed=${seed}\n${kid}`).not.toMatch(/很大。\s*能/);
      const speech = humanize(SPEECH, { intensity: 0.6, seed, style: "plain" });
      expect(speech, `seed=${seed}\n${speech}`).not.toMatch(/之际。\s*我们/);
      expect(speech, `seed=${seed}\n${speech}`).not.toMatch(/主办方。\s*向/);
      expect(speech, `seed=${seed}\n${speech}`).not.toMatch(/人士。\s*表示/);
      expect(speech, `seed=${seed}\n${speech}`).not.toMatch(/合作。\s*互利/);
      expect(speech, `seed=${seed}\n${speech}`).not.toMatch(/共进。\s*共同/);
      expect(speech, `seed=${seed}\n${speech}`).not.toMatch(/欢聚一堂。\s*共同/);
      expect(speech, `seed=${seed}\n${speech}`).not.toMatch(/过去五年。\s*大会/);
      expect(speech, `seed=${seed}\n${speech}`).not.toMatch(/理念。\s*与各位/);
    }
  });
});

describe("replaceWithDevelopment：保留内容而不是删除整条状语", () => {
  it("去掉「随着」和「的」，保留「X + 发展」", () => {
    const out = replaceWithDevelopment(
      "随着人工智能技术的快速发展，AI 写作工具应运而生。",
      () => 0,
      1,
    );
    expect(out).toBe("人工智能技术快速发展，AI 写作工具应运而生。");
  });

  it("「不断」形态不被误删", () => {
    const out = replaceWithDevelopment("随着信息技术的不断发展，数字化阅读逐渐普及。", () => 0, 1);
    expect(out).toBe("信息技术不断发展，数字化阅读逐渐普及。");
  });

  it("句末没有逗号时补句号，不产生「，。」", () => {
    const out = replaceWithDevelopment("随着时代的发展。", () => 0, 1);
    expect(out).toBe("时代发展。");
  });

  it("后接代词主语时保持原样（既有悬空代词守卫）", () => {
    const src = "随着人工智能技术的不断发展，其在各个领域的应用越来越广泛。";
    expect(replaceWithDevelopment(src, () => 0, 1)).toBe(src);
  });
});

describe("replaceVocab：搭配守卫", () => {
  const last = () => 0.999;

  it("推动 + 非经济宾语不得用「拉动」", () => {
    const out = replaceVocab("推动可持续发展", last, 1, "plain", true);
    expect(out).not.toContain("拉动");
    expect(out).toContain("推进");
  });

  it("推动 + 经济宾语仍允许「拉动」", () => {
    expect(replaceVocab("推动经济增长", last, 1, "plain", true)).toContain("拉动");
  });

  it("有效地不再产出「真的」", () => {
    const out = replaceVocab("有效地降低了运营成本", last, 1, "plain", false);
    expect(out).not.toContain("真的");
  });

  it("实现不再产出「达成」", () => {
    const out = replaceVocab("实现更高质量的发展", last, 1, "plain", false);
    expect(out).not.toContain("达成");
  });

  it("实现 + 指标/成果宾语保留原词，不产出「做到营业收入」", () => {
    for (const text of [
      "实现营业收入 32.68 亿元",
      "实现较快增长",
      "实现归属于母公司股东的净利润",
      "实现流程自动化",
    ]) {
      const out = replaceVocab(text, last, 1, "plain", false);
      expect(out, text).not.toContain("做到");
      expect(out, text).toContain("实现");
    }
  });

  it("生态不再被改成「这块地盘」（专名/机构名不可口语化）", () => {
    const out = replaceVocab("由生态环境主管部门责令改正", last, 1, "plain", true);
    expect(out).toContain("生态");
    expect(out).not.toContain("这块地盘");
  });

  it("正式语体的被动改写使用正式变体", () => {
    const formal = softenPassive("受到广泛关注", last, 1, true);
    expect(formal).not.toMatch(/大家|盯着看|挺受/);
    expect(formal).toMatch(/广受关注|备受关注/);
    expect(softenPassive("得到广泛认可", last, 1, true)).not.toMatch(/大家|口碑|叫好/);
  });
});
