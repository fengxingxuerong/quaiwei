/**
 * src/engine/regional-zh.test.ts —— 地区用词与标点校正的对照测试
 *
 * 守的都是用户能看见的事：词换对了没、代码/链接有没有被改坏、数字有没有动、
 * 以及最要紧的一条——**不传 variant 时一个字都不能变**（这条挂了，标定棘轮跟着漂）。
 */
import { describe, it, expect } from "vitest";
import { applyRegionalVariant, formatRegionalSummary, regionalTerms } from "./regional-zh";

const TW = "zh-TW" as const;

describe("默认关闭：不传 variant 一字不动", () => {
  it("文本原样返回，改动计数为 0（这条是零漂移守卫）", () => {
    const src = "打开软件,在设置里改默认值,账号登录后刷新。";
    const r = applyRegionalVariant(src);
    expect(r.text).toBe(src);
    expect(r.terms).toEqual([]);
    expect(r.punctuation).toBe(0);
  });

  it("空文本不炸", () => {
    expect(applyRegionalVariant("", TW).text).toBe("");
  });
});

describe("用词校正", () => {
  it("常见 IT 词一次换净", () => {
    const r = applyRegionalVariant("打开软件，在设置里改默认值，账号登录后刷新页面。", TW);
    expect(r.text).toBe("打开软体，在设定里改预设值，帐号登入后重新整理页面。");
    expect(r.terms.length).toBe(6);
  });

  it("长词优先：视频会议不能被打散成「影片会议」", () => {
    const r = applyRegionalVariant("视频会议里放了段视频。", TW);
    expect(r.text).toBe("视讯会议里放了段影片。");
  });

  it("换词不动数字：原文几个数字，产出还是几个", () => {
    const src = "共发布 3 个软件版本，修复 17 个问题，覆盖 92% 用户。";
    const out = applyRegionalVariant(src, TW).text;
    for (const n of ["3", "17", "92"]) expect(out).toContain(n);
  });

  it("同一词出现多次时计次正确", () => {
    const r = applyRegionalVariant("软件、软件、还是软件。", TW);
    expect(r.text).toBe("软体、软体、还是软体。");
    expect(r.terms[0]).toMatchObject({ from: "软件", to: "软体", count: 3 });
  });

  it("词表里没有的词不碰（宁少换不多换）", () => {
    const out = applyRegionalVariant("这份文件里程序的质量有待提高。", TW).text;
    expect(out).toBe("这份文件里程序的质量有待提高。");
  });
});

describe("保护区：代码、行内代码、链接、邮箱", () => {
  it("围栏代码块里的词不动", () => {
    const src = ["把软件装好：", "```bash", "pip install 软件", "```", "然后重跑。"].join("\n");
    const out = applyRegionalVariant(src, TW).text;
    expect(out).toContain("把软体装好");
    expect(out).toContain("pip install 软件");
  });

  it("行内代码里的词不动", () => {
    const out = applyRegionalVariant("打开 `软件` 目录，和软件本身。", TW).text;
    expect(out).toContain("`软件`");
    expect(out).toContain("和软体本身");
  });

  it("URL 与邮箱不被标点规则改坏", () => {
    const src = "看 https://example.com/a?b=1 和 dev@example.com，再说。";
    const out = applyRegionalVariant(src, TW).text;
    expect(out).toContain("https://example.com/a?b=1");
    expect(out).toContain("dev@example.com");
  });
});

describe("标点：半角 → 全角", () => {
  it("中文语境里的逗号/问号/叹号变全角", () => {
    expect(applyRegionalVariant("好的,我试试?就这样!", TW).text).toBe("好的，我试试？就这样！");
  });

  it("数字与英文语境的半角标点不动", () => {
    const src = "价格 3,000 元, 版本 v1.2 已经发布, Hello, world。";
    const out = applyRegionalVariant(src, TW).text;
    expect(out).toContain("3,000");
    expect(out).toContain("v1.2");
    expect(out).toContain("Hello, world");
    expect(out).toContain("元，版本");
  });

  it("句点只在两侧是中文时变句号（小数点与版本号不动）", () => {
    expect(applyRegionalVariant("这句话完了.下句开始.", TW).text).toBe("这句话完了。下句开始。");
    expect(applyRegionalVariant("增长了 3.5 个百分点.", TW).text).toBe("增长了 3.5 个百分点。");
  });

  it("括号只在与中文相邻时转全角", () => {
    expect(applyRegionalVariant("他说(我同意)。", TW).text).toBe("他说（我同意）。");
    expect(applyRegionalVariant("调用 foo(1) 即可。", TW).text).toBe("调用 foo(1) 即可。");
  });
});

describe("摘要与词表", () => {
  it("摘要说清换了什么、换了几处", () => {
    const r = applyRegionalVariant("软件和账号,都要改。", TW);
    const s = formatRegionalSummary(r);
    expect(s).toContain("软件→软体");
    expect(s).toContain("用词换了 2 处");
    expect(s).toContain("标点 1 处");
  });

  it("词表按长度倒序（长词必须先命中，否则会拼出错词）", () => {
    const t = regionalTerms();
    for (let i = 1; i < t.length; i++) {
      expect(t[i - 1].cn.length).toBeGreaterThanOrEqual(t[i].cn.length);
    }
    expect(t.every((x) => x.cn !== x.tw)).toBe(true);
  });
});
