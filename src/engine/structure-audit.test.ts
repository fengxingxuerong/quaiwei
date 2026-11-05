/**
 * src/engine/structure-audit.test.ts —— 篇章结构审计的对照测试
 *
 * 守两件事：
 *  1. **确定性**：同输入同输出（报告可 diff、可进 CI），一次随机都不许有。
 *  2. **不误伤**：人写的正常文章不该被判硬伤；每条判据都要有「该报」与「不该报」两侧样本，
 *     只测「能报出来」等于没测——误伤才是这类工具真正的死法。
 *
 * 注意样本长度：结构判据只在**成篇**的稿子上生效（<200 字直接不判、论点判据要 250 字、
 * 无人称腔要 300 字）。所以这里的样本都按真实文章的体量写，不是三句话的玩具样本——
 * 用短样本测结构，测的其实是门槛而不是判据。
 */
import { describe, it, expect } from "vitest";
import { auditStructure, splitBlocks, formatStructureReport } from "./structure-audit";

const codes = (t: string, style?: string) => auditStructure(t, { style }).issues.map((i) => i.code);

describe("切块：标题与段落", () => {
  it("认 markdown / 中文序号 / 数字序号 / 整行加粗四种标题", () => {
    const blocks = splitBlocks(
      [
        "# 一级",
        "正文一。",
        "二、二级",
        "正文二。",
        "3. 三级",
        "正文三。",
        "**加粗标题**",
        "正文四。",
      ].join("\n\n"),
    );
    expect(blocks.filter((b) => b.kind === "heading").map((b) => b.text)).toEqual([
      "一级",
      "二级",
      "三级",
      "加粗标题",
    ]);
  });

  it("代码围栏整块跳过，不参与段落统计", () => {
    const blocks = splitBlocks(
      ["前言段落，够长了吧。", "```", "const a = 1;", "```", "后记段落。"].join("\n"),
    );
    expect(blocks.filter((b) => b.kind === "para").map((b) => b.text)).toEqual([
      "前言段落，够长了吧。",
      "后记段落。",
    ]);
  });

  it("正文里的「1. 先做 X」不算标题（带句末标点）", () => {
    const blocks = splitBlocks("1. 先把需求写清楚，再动手，否则返工三次。");
    expect(blocks.every((b) => b.kind === "para")).toBe(true);
  });
});

describe("标题承诺：说了几个就得给几个", () => {
  const head = "## 三个提高效率的方法";
  it("承诺三个只写两段 → 报 heading-promise-unpaid", () => {
    const text = [head, "第一段讲方法一，先把目标拆到周。", "第二段讲方法二，把会议砍一半。"].join(
      "\n\n",
    );
    expect(codes(text)).toContain("heading-promise-unpaid");
  });

  it("兑现了三段 → 不报", () => {
    const text = [head, "方法一，拆目标。", "方法二，砍会议。", "方法三，留缓冲。"].join("\n\n");
    expect(codes(text)).not.toContain("heading-promise-unpaid");
  });

  it("问句标题正文没回答 → 报；正文给了原因 → 不报", () => {
    const q = "## 为什么远程办公没有提高效率";
    const no = [
      q,
      "远程办公已经推行了好几年，很多公司都做过尝试，员工反馈也各不相同，有人觉得省了通勤，有人觉得边界没了，各有各的说法，谁也说服不了谁。",
    ].join("\n\n");
    expect(codes(no)).toContain("heading-promise-unpaid");
    const yes = [
      q,
      "原因很具体：沟通成本被摊到了每一次异步消息里，原本一句口头就能对齐的事，现在要走三轮文字确认，决策链条反而更长，于是整体更慢。",
    ].join("\n\n");
    expect(codes(yes)).not.toContain("heading-promise-unpaid");
  });
});

describe("论点前置", () => {
  const LATE = [
    "随着数字化转型的推进，越来越多的企业开始关注这一议题，各种论坛、白皮书与案例集层出不穷，讨论的热度一直不减，但真正落到执行层面的并不多。",
    "第一方面，工具层的投入在持续增加，很多团队都采购了新的系统，也组织了多轮培训，可是用起来的人始终是少数，多数功能上线三个月后就没人再点开过。",
    "第二方面，组织层的调整也在发生，跨部门协作的流程被重新梳理了一遍，职责边界写进了文档，但真出了问题时，仍然没有人愿意站出来说这件事由我负责。",
    "第三方面，数据层的治理被提上日程，口径统一成了绕不开的前置工作，几个部门为了一个指标的定义来回讨论了两个月，最后还是各算各的，报表依旧对不上。",
    "因此我的判断是：真正的瓶颈不在工具，也不在流程，而在没有人对最终结果负责，谁都能说这件事不归我管。",
  ].join("\n\n");

  it("结论落在最后一段、开头是「随着」→ 报 thesis-delayed", () => {
    expect(codes(LATE)).toContain("thesis-delayed");
  });

  it("结论在第一段 → 不报", () => {
    const text = [
      "我的判断是：真正的瓶颈不在工具，而在没有人对最终结果负责。",
      "第一方面，工具层的投入在持续增加，很多团队都采购了新的系统，也组织了多轮培训，可是用起来的人始终是少数，多数功能上线三个月后就没人再点开过。",
      "第二方面，组织层的调整也在发生，跨部门协作的流程被重新梳理了一遍，职责边界写进了文档，但真出了问题时，仍然没有人愿意站出来说这件事由我负责。",
      "第三方面，数据层的治理被提上日程，口径统一成了绕不开的前置工作，几个部门为了一个指标的定义来回讨论了两个月，最后还是各算各的，报表依旧对不上。",
      "所以先定责任人，再谈系统，否则换多少套工具都是白换。",
    ].join("\n\n");
    expect(codes(text)).not.toContain("thesis-delayed");
  });

  it("段落太少 / 太短不判（叙事文不该被这条打）", () => {
    expect(codes("今天很冷。\n\n我出门买了杯豆浆。\n\n回来路上摔了一跤。")).not.toContain(
      "thesis-delayed",
    );
  });
});

describe("首尾复述", () => {
  const first =
    "远程办公并没有提高效率，它只是把办公室里的沟通成本，换成了一种更隐蔽、也更难被看见的成本。";
  const last =
    "所以说到底，远程办公并没有真正提高效率，它只是把办公室里的沟通成本换成了另一种更隐蔽也更难被看见的成本而已。";
  const body =
    "中间这几段讲的是完全不同的东西：供应链的账期怎么谈、渠道的返点怎么算、售后的响应时间怎么压，每一件都要单独拆开算，混在一起看只会得出一个平均数，而平均数在这里毫无意义。";

  it("末段把首段换个说法又说一遍 → 报 intro-outro-echo", () => {
    expect(codes([first, body, last].join("\n\n"))).toContain("intro-outro-echo");
  });

  it("末段给的是新东西 → 不报", () => {
    const fresh =
      "如果要我给一个可执行的建议：先量一次决策从提出到落地的天数，再决定要不要继续远程；这个数字超过五天，问题就不在办公地点。";
    expect(codes([first, body, fresh].join("\n\n"))).not.toContain("intro-outro-echo");
  });
});

describe("小标题密度", () => {
  it("三个标题、每节二十来字 → 报 heading-overdense", () => {
    const text = [
      "## 一、背景",
      "行业正在变化，所有人都在谈这件事。",
      "## 二、问题",
      "问题也很明显，只是没人愿意先说。",
      "## 三、结论",
      "结论就一句话，先做小范围验证。",
    ].join("\n\n");
    expect(codes(text)).toContain("heading-overdense");
  });

  it("标题少、每节够厚 → 不报", () => {
    const long =
      "这一段要说清楚一件事，所以它必须足够长，长到能把前因后果都交代完，而不是丢一句结论就走。事情的起点其实很具体：一个季度里换了三套流程，每一套都只跑了一半就停了，没人知道停的原因，也没人追问。";
    const text = ["## 一、背景", long, long, "## 二、结论", long, long].join("\n\n");
    expect(codes(text)).not.toContain("heading-overdense");
  });
});

describe("无人称解说腔", () => {
  const base = [
    "我们可以看到，这个行业正在发生变化，而且变化的速度比大多数人预想的要快得多，很多过去成立的经验正在失效，一些看上去稳固的岗位也开始松动。",
    "值得注意的是，真正被冲击的并不是技术岗位，而是那些靠信息差吃饭的中间环节，它们的价值正在被快速压缩，而且这个过程几乎不可逆。",
    "需要指出的是，很多团队还没有为这种变化做好准备，流程仍然按三年前的节奏在跑，培训也停留在工具操作层面，没有人认真讨论过分工要怎么改。",
    "综上所述，这一轮调整不会在短期内结束，与其等一个明确的信号，不如先把手上那些依赖信息差的工作重新审一遍，看看哪些环节其实可以取消。",
    "换言之，过去靠位置获得的优势，现在要靠判断力来换，而这个转换对多数人来说并不舒服，因为它要求一个人先承认自己此前的一部分工作其实没有创造价值。",
  ].join("\n\n");

  it("两处以上标记且没有「我/你」→ 报 impersonal-narrator", () => {
    expect(codes(base)).toContain("impersonal-narrator");
  });

  it("有「我」在场 → 不报", () => {
    expect(
      codes(`${base}\n\n我见过的团队里，至少有一半是这样，包括我自己带过的那两个。`),
    ).not.toContain("impersonal-narrator");
  });

  it("academic 文风降级为 low（学术写作里「我们」合法）", () => {
    const r = auditStructure(base, { style: "academic" });
    const hit = r.issues.find((i) => i.code === "impersonal-narrator");
    expect(hit?.severity).toBe("low");
  });
});

describe("编号步骤化", () => {
  it("一段里三个序数词 → 报 stepified-enumeration", () => {
    const text =
      "首先要把需求写清楚，其次要把验收标准写下来，最后才是排期和人力，顺序反了就一定返工。";
    expect(codes(text)).toContain("stepified-enumeration");
  });

  it("只用了一个序数词 → 不报", () => {
    const text = "首先要做的是把需求写清楚，其余的事情都可以边做边调整，不必一次定死。";
    expect(codes(text)).not.toContain("stepified-enumeration");
  });
});

describe("段落均匀", () => {
  it("五段长度几乎一致 → 报 uniform-paragraphs", () => {
    const p = "这一段大约三十来个字用来描述一个完整的小意思方便对比长度差异是否足够明显可见一斑。";
    expect(codes([p, p, p, p, p].join("\n\n"))).toContain("uniform-paragraphs");
  });

  it("长短交错 → 不报", () => {
    const text = [
      "短句也可以成段。",
      "这一段要长得多，因为它需要交代前因后果，还要把中间那些容易被忽略的细节说清楚，否则读者会以为结论是凭空掉下来的，那样反而不可信。",
      "再说一句短的。",
      "然后又是一段长的，讲的是另一件事：执行层面的摩擦往往不在方案本身，而在谁来拍板、什么时候拍板、拍错了算谁的。",
      "收尾。",
    ].join("\n\n");
    expect(codes(text)).not.toContain("uniform-paragraphs");
  });
});

describe("确定性与边界", () => {
  it("同输入跑两次，报告逐字相同", () => {
    const text = [
      "## 三个建议",
      "随着行业变化，我们可以看到很多团队都在调整，方向大体相同，落地却千差万别，有人先改流程，有人先换工具。",
      "首先，要定目标；其次，要定责任人；最后，要定复盘节奏，这三件事缺一件都会在两个月后原形毕露。",
      "综上所述，这三件事必须一起做，否则哪一件都落不了地，最后只剩下文档里的一行字。",
    ].join("\n\n");
    expect(JSON.stringify(auditStructure(text))).toBe(JSON.stringify(auditStructure(text)));
  });

  it("短稿不判结构，并在结论里说清楚", () => {
    const r = auditStructure("就这么一句话。");
    expect(r.issues).toEqual([]);
    expect(r.verdict).toContain("太短");
  });

  it("报告里带定位、证据与方向，不只是一句「像 AI」", () => {
    const text = ["## 三个建议", "只有一段。", "还是同一段。"].join("\n\n");
    const out = formatStructureReport(auditStructure(text));
    expect(out).toContain("证据：");
    expect(out).toContain("方向：");
    expect(out).toContain("只报告，未改动任何字");
  });
});
