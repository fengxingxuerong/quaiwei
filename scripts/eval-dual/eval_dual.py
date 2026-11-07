"""双网关独立评委：QuAiWei 去 AI 能力的配对盲测（可复现版）。

判据 1（辅）：绝对分 0-100，越高越像 AI。23 篇 × orig/local09 × 2 席 = 92 次。
判据 2（主）：配对强制选择「哪段更像 AI」。23 篇 × 2 席（0.9 档）+ 8 篇 × 2 席（0.6 档）= 62 次。
两席呈现顺序相反，用于抵消位置偏置；温度 0；甲/乙位置按篇号奇偶轮换。

设计约束（改动时别破坏）：
- 凭证只从环境变量读，不落盘、不回显、不进任何产出文件。
- 结果增量写 JSONL，可断点续跑；`--summarize` 不需要任何凭证或网络。
- 呈现顺序算法 `flip_for` 是复现基线的一部分，不要"顺手优化"。

原始 2026-11-06 记录见 `evidence/eval-dual-2026-11-06/`，方法见 `docs/eval-dual-2026-11-06.md`。
"""
import argparse
import json
import os
import re
import statistics
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

MODEL_DEFAULT = "glm-5.3-flash"

ABS_SYS = (
    "你是一个严格的中文文本鉴别员。判断文本有多像 AI 生成的。"
    "分数定义：100=绝对是 AI 生成，0=绝对是人写。"
    "只输出一个 0 到 100 的整数，不要输出任何解释、标点或其他文字。"
)
PAIR_SYS = (
    "你是中文文本鉴别员。下面给你两段内容相近的文本甲和乙。"
    "请判断哪一段更像 AI 生成的。只输出一个字：甲或乙。"
    "不要输出解释、标点或其他文字。"
)

# 0.6 默认档只在这 8 篇上做配对；与 2026-11-06 基线一致，改动会让胜率不可比。
SUB8 = [
    "C3-tech-popular", "C9-mixed-links", "C11-admin-notice", "C13-manual-steps",
    "C14-finance-flash", "C16-prospectus-risk", "C17-verdict-labor", "C20-speech-opening",
]

NUM_RE = re.compile(r"\d+(?:\.\d+)?")
URL_RE = re.compile(r"https?://[^\s)），,。；;]+")


def parse_args():
    repo = Path(__file__).resolve().parents[2]
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--repo", type=Path, default=repo, help="仓库根（含 scripts/realcase/cases.json）")
    p.add_argument("--arms-dir", type=Path, default=None,
                   help="各臂产物目录，其下须有 09/<id>.humanized.txt 与 06/<id>.humanized.txt")
    p.add_argument("--out", type=Path, default=repo / "eval-out" / "eval-dual",
                   help="输出目录（eval_dual_results.jsonl / eval_dual_report.json）")
    p.add_argument("--results", type=Path, default=None,
                   help="复核已有归档时指定其 JSONL；--summarize 下只读不写")
    p.add_argument("--model", default=MODEL_DEFAULT)
    p.add_argument("--seats", default="AB",
                   help="启用的席位：A / B / AB。跨模型谱系复核只用一个上游时设 A（77 次调用）")
    p.add_argument("--url-a", default=os.environ.get("QUAIWEI_EVAL_URL_A", "http://127.0.0.1:8080"))
    p.add_argument("--url-b", default=os.environ.get("QUAIWEI_EVAL_URL_B", "http://192.168.151.151:18080"))
    p.add_argument("--local-rulers", type=Path, default=None,
                   help="可选：本地两把尺的缓存 JSON；缺省则跳过相关性段，不影响主判据")
    p.add_argument("--summarize", action="store_true", help="只按现有 JSONL 重算汇总，不联网")
    return p.parse_args()


def build_state(args):
    cases = json.load(open(args.repo / "scripts/realcase/cases.json", encoding="utf-8"))["cases"]
    ids = [c["id"] for c in cases]
    text = {c["id"]: {"orig": c["text"]} for c in cases}
    if args.arms_dir:
        for tag, arm in (("09", "local09"), ("06", "local06")):
            for cid in ids:
                f = args.arms_dir / tag / (cid + ".humanized.txt")
                text[cid][arm] = f.read_text(encoding="utf-8").strip()
    return cases, ids, text


def load_upstreams(args):
    seats = "".join(sorted(set(args.seats.upper()) & {"A", "B"}))
    if not seats:
        sys.exit("--seats 只能是 A / B / AB")
    available = {
        "A": (args.url_a, os.environ.get("QUAIWEI_EVAL_KEY_A", "")),
        "B": (args.url_b, os.environ.get("QUAIWEI_EVAL_KEY_B", "")),
    }
    missing = [f"QUAIWEI_EVAL_KEY_{s}" for s in seats if not available[s][1]]
    if missing:
        sys.exit("缺少凭证：" + " / ".join(missing) + "（只走环境变量，不落盘）。"
                 "只想重算汇总请加 --summarize。")
    return [{"seat": s, "name": s, "url": available[s][0].rstrip("/"), "key": available[s][1]}
            for s in seats]


class Runner:
    def __init__(self, args, cases, ids, text, upstreams):
        self.args = args
        self.cases = cases
        self.ids = ids
        self.text = text
        self.upstreams = upstreams
        args.out.mkdir(parents=True, exist_ok=True)
        self.jsonl = args.results or (args.out / "eval_dual_results.jsonl")
        self.report = args.out / "eval_dual_report.json"
        self.lock = threading.Lock()
        self.done = set()
        self.count = [0]
        self.t0 = time.time()
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.load_done()

    def load_done(self):
        if not self.jsonl.exists():
            return
        for line in self.jsonl.read_text(encoding="utf-8").splitlines():
            try:
                self.done.add(json.loads(line)["key"])
            except Exception:
                pass

    def save(self, rec):
        with self.lock:
            with open(self.jsonl, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            self.count[0] += 1
            if self.count[0] % 10 == 0:
                print(f"  ... {self.count[0]} 条新结果 | {round(time.time() - self.t0)}s", flush=True)

    def call(self, up, system, user, max_tokens=4096):
        payload = {
            "model": self.args.model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "temperature": 0,
            "max_tokens": max_tokens,
        }
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        last = ""
        for attempt in range(4):
            req = urllib.request.Request(
                up["url"] + "/v1/chat/completions", data=body,
                headers={"Authorization": "Bearer " + up["key"], "Content-Type": "application/json"},
            )
            try:
                with self.opener.open(req, timeout=200) as r:
                    d = json.load(r)
                msg = d["choices"][0]["message"]
                return (msg.get("content") or "").strip(), None
            except urllib.error.HTTPError as e:
                last = "HTTP " + str(e.code)
                time.sleep(4 * (attempt + 1) if e.code == 429 else 2 * (attempt + 1))
            except Exception as e:
                last = type(e).__name__ + ": " + str(e)[:80]
                time.sleep(2 * (attempt + 1))
        return "", last

    @staticmethod
    def parse_abs(c):
        s = (c or "").strip()
        if re.fullmatch(r"\d{1,3}", s):
            return max(0, min(100, int(s)))
        nums = [int(x) for x in re.findall(r"(?<!\d)\d{1,3}(?!\d)", s)]
        nums = [n for n in nums if 0 <= n <= 100]
        return nums[-1] if nums else None

    @staticmethod
    def parse_pair(c):
        for ch in (c or ""):
            if ch in "甲乙":
                return ch
            if ch in "AB":
                return "甲" if ch == "A" else "乙"
        s = c or ""
        if "第一" in s or "前者" in s:
            return "甲"
        if "第二" in s or "后者" in s:
            return "乙"
        return None

    @staticmethod
    def flip_for(cid, seat, arm_tag):
        v = (sum(map(ord, cid)) + len(arm_tag)) % 2 == 0
        return not v if seat == "B" else v

    def build_tasks(self, seat):
        out = []
        for cid in self.ids:
            for arm in ("orig", "local09"):
                out.append(("abs", cid, arm, seat, None))
        for cid in self.ids:
            out.append(("pair", cid, None, seat, "local09"))
        for cid in SUB8:
            out.append(("pair", cid, None, seat, "local06"))
        return out

    def run_task(self, up, task):
        kind, cid, arm, seat, arm_tag = task
        if kind == "abs":
            key = f"abs|{cid}|{arm}|{seat}"
            if key in self.done:
                return
            user = "请给下面这段文本打分：\n\n<<<" + self.text[cid][arm] + ">>>"
            raw, err = self.call(up, ABS_SYS, user)
            rec = {"key": key, "kind": "abs", "id": cid, "arm": arm, "seat": seat,
                   "score": self.parse_abs(raw), "raw": raw[:60], "err": err}
        else:
            key = f"pair|{cid}|{seat}|{arm_tag}"
            if key in self.done:
                return
            first = arm_tag if self.flip_for(cid, seat, arm_tag) else "orig"
            second = "orig" if first == arm_tag else arm_tag
            user = ("甲：\n<<<" + self.text[cid][first] + ">>>\n\n乙：\n<<<"
                    + self.text[cid][second] + ">>>\n\n哪一段更像 AI 生成的？只输出「甲」或「乙」。")
            raw, err = self.call(up, PAIR_SYS, user)
            pick = self.parse_pair(raw)
            chosen = {"甲": first, "乙": second}.get(pick)
            rec = {"key": key, "kind": "pair", "id": cid, "seat": seat, "armTag": arm_tag,
                   "firstArm": first, "pick": pick, "chosen": chosen,
                   "engineWin": (chosen == "orig") if chosen else None,
                   "raw": raw[:60], "err": err}
        self.save(rec)
        if rec.get("err"):
            print(f"  [{seat}] ERR {rec['key']}: {rec['err']}", flush=True)

    def worker(self, up):
        todo = [t for t in self.build_tasks(up["seat"])
                if (f"abs|{t[1]}|{t[2]}|{t[3]}" if t[0] == "abs"
                    else f"pair|{t[1]}|{t[3]}|{t[4]}") not in self.done]
        print(f"[{up['seat']}] 待跑 {len(todo)} 条", flush=True)
        for t in todo:
            self.run_task(up, t)
        print(f"[{up['seat']}] 完成", flush=True)

    def run(self):
        self.load_done()
        print(f"全量 {len(self.ids)} 篇 | 已完成 {len(self.done)} 条 | 模型 {self.args.model}", flush=True)
        if not self.args.summarize:
            ths = [threading.Thread(target=self.worker, args=(u,), daemon=True) for u in self.upstreams]
            for t in ths:
                t.start()
            for t in ths:
                t.join()
            self.load_done()
        self.summarize()

    @staticmethod
    def corr(a, b):
        if len(a) < 3 or len(a) != len(b):
            return None
        ma, mb = statistics.mean(a), statistics.mean(b)
        num = sum((x - ma) * (y - mb) for x, y in zip(a, b))
        da = sum((x - ma) ** 2 for x in a)
        db = sum((y - mb) ** 2 for y in b)
        return round(num / (da * db) ** 0.5, 3) if da and db else None

    def fidelity(self):
        # 没有实产改写稿时返回 None（未检查），不可写成 []（会被读成「23/23 全过」）。
        if not self.args.arms_dir:
            return None
        bad = []
        for c in self.cases:
            o, n = c["text"], self.text[c["id"]].get("local09")
            if n is None:
                continue
            ok = (sorted(NUM_RE.findall(o)) == sorted(NUM_RE.findall(n))
                  and sorted(URL_RE.findall(o)) == sorted(URL_RE.findall(n))
                  and o.count("```") == n.count("```"))
            if not ok:
                bad.append(c["id"])
        return bad

    def summarize(self):
        recs = [json.loads(l) for l in self.jsonl.read_text(encoding="utf-8").splitlines() if l.strip()]
        abs_r = [r for r in recs if r["kind"] == "abs" and r.get("score") is not None]
        pair_r = [r for r in recs if r["kind"] == "pair" and r.get("engineWin") is not None]

        by = {}
        for arm in ("orig", "local09"):
            for seat in ("A", "B"):
                vals = [r["score"] for r in abs_r if r["arm"] == arm and r["seat"] == seat]
                by[f"{arm}/{seat}"] = {"n": len(vals),
                                       "mean": round(statistics.mean(vals), 1) if vals else None}
            vals = [r["score"] for r in abs_r if r["arm"] == arm]
            by[arm] = {"n": len(vals), "mean": round(statistics.mean(vals), 1) if vals else None}

        pairs = []
        for cid in self.ids:
            for arm in ("orig", "local09"):
                a = next((r["score"] for r in abs_r
                          if r["id"] == cid and r["arm"] == arm and r["seat"] == "A"), None)
                b = next((r["score"] for r in abs_r
                          if r["id"] == cid and r["arm"] == arm and r["seat"] == "B"), None)
                if a is not None and b is not None:
                    pairs.append((a, b, cid, arm))
        agree = {
            "pairs": len(pairs),
            "pearson": self.corr([p[0] for p in pairs], [p[1] for p in pairs]),
            "mae": round(statistics.mean([abs(p[0] - p[1]) for p in pairs]), 1) if pairs else None,
            "within10": round(sum(1 for p in pairs if abs(p[0] - p[1]) <= 10) / len(pairs), 3) if pairs else None,
        }

        per_case = []
        for cid in self.ids:
            row = {"id": cid}
            for arm in ("orig", "local09"):
                v = [r["score"] for r in abs_r if r["id"] == cid and r["arm"] == arm]
                row[arm] = round(statistics.mean(v), 1) if v else None
            row["drop"] = (round(row["orig"] - row["local09"], 1)
                           if row["orig"] is not None and row["local09"] is not None else None)
            per_case.append(row)

        pair_stats = {}
        for tag in ("local09", "local06"):
            sel = [r for r in pair_r if r["armTag"] == tag]
            pair_stats[tag] = {
                "n": len(sel), "engineWin": sum(1 for r in sel if r["engineWin"]),
                "winRate": round(sum(1 for r in sel if r["engineWin"]) / len(sel), 3) if sel else None,
                "bySeat": {s: {"n": len([r for r in sel if r["seat"] == s]),
                               "win": sum(1 for r in sel if r["seat"] == s and r["engineWin"])}
                          for s in ("A", "B")},
                "firstArmChosen": round(sum(1 for r in sel if r["pick"] == "甲") / len(sel), 3) if sel else None,
            }
            same = tot = 0
            for cid in self.ids:
                v = [r["engineWin"] for r in pair_r if r["armTag"] == tag and r["id"] == cid]
                if len(v) == 2:
                    tot += 1
                    same += v[0] == v[1]
            pair_stats[tag]["seatAgreement"] = {"pairs": tot,
                                                "rate": round(same / tot, 3) if tot else None}

        rulers = {}
        if self.args.local_rulers and self.args.local_rulers.exists():
            cache = json.load(open(self.args.local_rulers, encoding="utf-8"))
            ai = [c["aiScore"] for c in cache if c.get("arm") == "orig" and c.get("aiScore") is not None]
            judge = [next((r["orig"] for r in per_case if r["id"] == c["id"]), None)
                     for c in cache if c.get("arm") == "orig" and c.get("aiScore") is not None]
            kept = [(x, y) for x, y in zip(ai, judge) if y is not None]
            rulers["aiScore_orig_vs_judge_orig"] = self.corr([x for x, _ in kept], [y for _, y in kept])

        summary = {
            "model": self.args.model, "cases": len(self.ids),
            "seats": "".join(sorted({r["seat"] for r in recs})),
            "elapsedSec": round(time.time() - self.t0, 1),
            "absCalls": len(abs_r), "pairCalls": len(pair_r),
            "judgeByArm": by, "seatAgreement": agree,
            "pairStats": pair_stats, "localRulers": rulers,
            "fidelityFailures": self.fidelity(),
            "perCase": per_case,
        }
        self.report.write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")

        print("\n=== 双席绝对分（越高越像 AI）===")
        for k in ("orig/A", "orig/B", "orig", "local09/A", "local09/B", "local09"):
            print(f"  {k:<14} n={by[k]['n']:<3} mean={by[k]['mean']}")
        if by["orig"]["mean"] is not None and by["local09"]["mean"] is not None:
            print(f"  降幅 = {round(by['orig']['mean'] - by['local09']['mean'], 1)} 分")
        print("\n=== 配对强制选择 ===")
        print(json.dumps(pair_stats, ensure_ascii=False, indent=1))
        print("\n=== 双席一致性 / 保真 ===")
        print(json.dumps({"seatAgreement": agree,
                          "fidelityFailures": summary["fidelityFailures"]}, ensure_ascii=False, indent=1))
        print("\n报告：" + str(self.report))


if __name__ == "__main__":
    a = parse_args()
    if not a.arms_dir and not a.summarize:
        sys.exit("缺 --arms-dir：需要 09/ 与 06/ 两档 CLI 实产改写稿；只重算汇总请加 --summarize。")
    c, i, t = build_state(a)
    Runner(a, c, i, t, [] if a.summarize else load_upstreams(a)).run()
