"""对比两轮 eval_dual 报告（双席基线 vs 单席跨谱系复核）。

用法：
  python scripts/eval-dual/compare.py <base-report.json> <new-report.json> [--md]

只做读数对比，不重算、不联网。单席与双席的**票数不可直接比大小**，
可比的是胜率方向、逐篇判定一致率、甲被选率是否偏离 0.5。
"""
import argparse
import json
from pathlib import Path


def load(p):
    return json.loads(Path(p).read_text(encoding="utf-8"))


def fmt(x, digits=1):
    if x is None:
        return "—"
    if isinstance(x, float):
        if x.is_integer():
            return f"{x:.1f}"
        # 胜率/甲被选率是 0~1 的比例，按 1 位会压成 0.9 这种误导值
        return f"{x:.3f}" if 0 < x < 1 else f"{x:.{digits}f}"
    return str(x)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("base", help="基线报告（如 evidence/eval-dual-2026-11-06/eval_dual_report.json）")
    ap.add_argument("new", help="新报告（单席复核）")
    ap.add_argument("--md", action="store_true", help="输出 Markdown 表格")
    a = ap.parse_args()

    b, n = load(a.base), load(a.new)
    bj, nj = b["judgeByArm"], n["judgeByArm"]
    bp, np_ = b["pairStats"], n["pairStats"]

    rows = [
        ("评委模型", b.get("model"), n.get("model")),
        ("席位", b.get("seats", "—"), n.get("seats", "—")),
        ("绝对分调用", b["absCalls"], n["absCalls"]),
        ("配对调用", b["pairCalls"], n["pairCalls"]),
        ("原文均分", bj["orig"]["mean"], nj["orig"]["mean"]),
        ("0.9 档均分", bj["local09"]["mean"], nj["local09"]["mean"]),
        ("均分降幅", round(bj["orig"]["mean"] - bj["local09"]["mean"], 1),
         round(nj["orig"]["mean"] - nj["local09"]["mean"], 1)),
    ]
    for tag in ("local09", "local06"):
        bs, ns = bp.get(tag, {}), np_.get(tag, {})
        rows += [
            (f"{tag} 配对票数", bs.get("n"), ns.get("n")),
            (f"{tag} 判改写更像人", bs.get("engineWin"), ns.get("engineWin")),
            (f"{tag} 胜率", bs.get("winRate"), ns.get("winRate")),
            (f"{tag} 甲被选率", bs.get("firstArmChosen"), ns.get("firstArmChosen")),
        ]

    bmap = {r["id"]: r for r in b["perCase"]}
    nmap = {r["id"]: r for r in n["perCase"]}
    common = sorted(set(bmap) & set(nmap))
    same = 0
    for cid in common:
        bd, nd = bmap[cid].get("drop"), nmap[cid].get("drop")
        if bd is None or nd is None:
            continue
        if (bd > 0) == (nd > 0):
            same += 1
    rows += [("逐篇方向一致", f"{same}/{len(common)}", "")]

    if a.md:
        print("| 指标 | 基线 | 新轮 |")
        print("|---|---:|---:|")
        for k, x, y in rows:
            print(f"| {k} | {fmt(x)} | {fmt(y)} |")
    else:
        for k, x, y in rows:
            print(f"{k:<24} base={fmt(x):<12} new={fmt(y)}")


if __name__ == "__main__":
    main()
