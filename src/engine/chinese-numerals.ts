/**
 * 中文数字 ↔ 阿拉伯数字 的归一（v0.9.79）
 *
 * 为什么需要：数字保真守卫此前只认阿拉伯数字。两个后果都不好——
 *   · `3 个` 写成 `三个` → 被判"丢了 3"（**假阳性**，实测 C12 论文摘要就中过）；
 *   · 反过来 `十四小时` 与 `14 小时` 无法互认（真丢也看不出）。
 * 所以把两侧都归一成**数值**再比，而不是比字符串。
 *
 * 边界（刻意保守）：
 *   · 只解析到「亿」，且只认 零〇一二三四五六七八九十百千万亿两 与「点」；
 *   · 单字「一」在中文里太像虚词（一方面/一致性/统一），所以**中文数字必须带单位才算事实**
 *     （三个、五项、十四小时），否则不参与比对；
 *   · 解析失败一律返回 null，让调用方退回"不判"——宁可漏报，不要误报。
 */

const CN_DIGIT: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};
const CN_SMALL: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
const CN_BIG: Record<string, number> = { 万: 1e4, 亿: 1e8 };

/**
 * 把中文整数解析成数值：「十二」12、「二十三」23、「一百零五」105、「两千」2000、
 * 「一万二千」12000、「三亿五千万」350000000。无法解析返回 null。
 */
export function parseChineseInteger(s: string): number | null {
  if (!s) return null;
  let total = 0; // 已结算的大单位部分
  let section = 0; // 当前「万/亿」段内的小单位累加
  let digit: number | null = null;
  let sawAny = false;
  for (const ch of s) {
    if (ch in CN_DIGIT) {
      digit = CN_DIGIT[ch];
      sawAny = true;
      continue;
    }
    if (ch in CN_SMALL) {
      const mul = CN_SMALL[ch];
      section += (digit ?? 1) * mul;
      digit = null;
      sawAny = true;
      continue;
    }
    if (ch in CN_BIG) {
      const mul = CN_BIG[ch];
      section += digit ?? 0;
      total += (section || 1) * mul;
      section = 0;
      digit = null;
      sawAny = true;
      continue;
    }
    return null; // 出现不认识的字符就不猜
  }
  if (!sawAny) return null;
  return total + section + (digit ?? 0);
}

/**
 * 解析「十二点七」这类中文小数（点后逐位念）。失败返回 null。
 */
export function parseChineseNumber(s: string): number | null {
  const [intPart, fracPart] = s.split("点");
  const int = parseChineseInteger(intPart);
  if (int === null) return null;
  if (fracPart === undefined) return int;
  if (!fracPart) return null;
  let frac = "";
  for (const ch of fracPart) {
    if (!(ch in CN_DIGIT)) return null;
    frac += String(CN_DIGIT[ch]);
  }
  return Number(`${int}.${frac}`);
}

/** 数值 → 比对用的规范串（去掉浮点尾噪） */
export function canonNumber(n: number): string {
  return String(Number(n.toFixed(6)));
}
