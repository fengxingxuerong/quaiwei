# 合并两席单席评测 → 双席异源口径（离线，不联网）
# 用法: py -3.12 scripts/eval-dual/merge_two_seats.py <seatA.jsonl> <seatB.jsonl> <out.json>
# seatA = glm-5.3-flash @8080（2026-11-13），seatB = qodercn/dfmodel @18326（2026-11-19）
import json
import math
import sys


def load(path):
    recs = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                recs.append(json.loads(line))
    return recs


def binom_one_tail_ge(k, n, p0=0.5):
    return sum(math.comb(n, i) for i in range(k, n + 1)) * (p0**n)


def pearson(xs, ys):
    n = len(xs)
    if n < 2:
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    cov = sum((a - mx) * (b - my) for a, b in zip(xs, ys))
    vx = sum((a - mx) ** 2 for a in xs)
    vy = sum((b - my) ** 2 for b in ys)
    if vx == 0 or vy == 0:
        return None
    return cov / math.sqrt(vx * vy)


def main():
    a_path, b_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    A, B = load(a_path), load(b_path)

    # 绝对分：按 (id, arm) 配两席
    absA = {(r["id"], r["arm"]): r["score"] for r in A if r["kind"] == "abs" and r["err"] is None}
    absB = {(r["id"], r["arm"]): r["score"] for r in B if r["kind"] == "abs" and r["err"] is None}
    abs_stats = {}
    for arm in ("orig", "local09"):
        pairs = [(absA[k], absB[k]) for k in absA if k in absB and k[1] == arm]
        if pairs:
            xs, ys = [p[0] for p in pairs], [p[1] for p in pairs]
            pr = pearson(xs, ys)
            abs_stats[arm] = {
                "n": len(pairs),
                "pearson": round(pr, 3) if pr is not None else None,
                "mae": round(sum(abs(a - b) for a, b in pairs) / len(pairs), 1),
                "meanA": round(sum(xs) / len(xs), 1),
                "meanB": round(sum(ys) / len(ys), 1),
            }

    # 配对票：key = pair|<id>|A|<armTag>；engineWin=true = 判 orig 更像 AI（改写有效）
    pairA = {(r["id"], r["armTag"]): r for r in A if r["kind"] == "pair" and r["err"] is None}
    pairB = {(r["id"], r["armTag"]): r for r in B if r["kind"] == "pair" and r["err"] is None}

    summary = {}
    for arm in ("local09", "local06"):
        cases = sorted({i for (i, a) in pairA if a == arm} & {i for (i, a) in pairB if a == arm})
        winA = winB = agree = firstPicked = 0
        per_case = {}
        for i in cases:
            ra, rb = pairA[(i, arm)], pairB[(i, arm)]
            wa, wb = bool(ra["engineWin"]), bool(rb["engineWin"])
            winA += wa
            winB += wb
            agree += wa == wb
            firstPicked += (ra["chosen"] == ra["firstArm"]) + (rb["chosen"] == rb["firstArm"])
            per_case[i] = {"A_engineWin": wa, "B_engineWin": wb}
        votes = winA + winB
        n_cases = len(cases)
        summary[arm] = {
            "n_cases": n_cases,
            "votes": votes,
            "seatA_win": winA,
            "seatB_win": winB,
            "combined_win": votes,
            "combined_winRate": round(votes / (2 * n_cases), 3) if n_cases else None,
            "p_one_tail": binom_one_tail_ge(votes, votes) if votes else None,
            "seat_agreement": round(agree / n_cases, 3) if n_cases else None,
            "firstArmChosen": round(firstPicked / (2 * n_cases), 3) if n_cases else None,
            "per_case": per_case,
        }

    out = {"seatA": a_path, "seatB": b_path, "pair": summary, "abs_cross_seat": abs_stats}
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(json.dumps({k: {kk: vv for kk, vv in v.items() if kk != "per_case"} for k, v in summary.items()}, ensure_ascii=False, indent=2))
    print(json.dumps(abs_stats, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
