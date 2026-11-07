"""A/B 配对能力验收：用「哪段更像 AI」的强制选择裁决两臂，替代 aiScore。

为什么需要它：`aiScore` 与独立评委只有 0.353 相关，且它的构成奖励短句——
任何「少切句」的改动都会被它判成「更像机器」（2026-11-07 三次切句收敛尝试的
共同死因，见 evidence/split-scale-2026-11-07/）。能力验收必须用与目标一致的尺子。

与 eval_dual.py 的分工：
  · eval_dual.py   固定 orig vs local09，评的是「引擎有没有效果」；
  · ab_accept.py   任意两臂，评的是「这次改动是不是更好」。
公共逻辑（call / parse / flip_for）刻意重复而不抽取，避免改动已归档、
被 eval-dual-consistency.test.ts 守着的评测脚本。

用法：
  export QUAIWEI_EVAL_KEY_A=... QUAIWEI_EVAL_KEY_B=...
  python scripts/eval-dual/ab_accept.py \
    --arm-a arms/before --arm-b arms/after \
    --out out-ab [--seats AB] [--model qodercn/dfmodel]

臂目录里每篇为 `<id>.humanized.txt`（回退 `<id>.txt`），id 取自
`scripts/realcase/cases.json`。结果增量写 JSONL，`--summarize` 只重算不联网。
"""
import argparse
import json
import math
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

PAIR_SYS = (
    "你是中文文本鉴别员。下面给你两段内容相近的文本甲和乙。"
    "请判断哪一段更像 AI 生成的。只输出一个字：甲或乙。"
    "不要输出解释、标点或其他文字。"
)


def parse_args():
    repo = Path(__file__).resolve().parents[2]
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--repo", type=Path, default=repo)
    p.add_argument("--arm-a", type=Path, required=False, help="A 臂产物目录")
    p.add_argument("--arm-b", type=Path, required=False, help="B 臂产物目录")
    p.add_argument("--corpus", type=Path, default=None,
                   help="语料目录（*.txt，排除 .humanized.txt）。默认用 scripts/realcase/cases.json；"
                        "改切句强度这类只在长文生效的改动必须换长文语料，否则两臂产物会相同")
    p.add_argument("--out", type=Path, default=repo / "eval-out" / "ab-accept")
    p.add_argument("--results", type=Path, default=None, help="复核已有归档时指定其 JSONL")
    p.add_argument("--model", default=MODEL_DEFAULT)
    p.add_argument("--seats", default="AB", help="A / B / AB")
    p.add_argument("--url-a", default=os.environ.get("QUAIWEI_EVAL_URL_A", "http://127.0.0.1:8080"))
    p.add_argument("--url-b", default=os.environ.get("QUAIWEI_EVAL_URL_B", "http://192.168.151.151:18080"))
    p.add_argument("--mirror", action="store_true",
                   help="只有一个网关时，用同一上游跑 A/B 两席（B 席反序）以抵消位置偏置；调用量翻倍")
    p.add_argument("--summarize", action="store_true", help="只按现有 JSONL 重算，不联网")
    return p.parse_args()


def read_arm(d: Path, cid: str) -> str:
    for name in (cid + ".humanized.txt", cid + ".txt"):
        f = d / name
        if f.exists():
            return f.read_text(encoding="utf-8").strip()
    raise FileNotFoundError(f"{d} 缺 {cid}（试过 .humanized.txt / .txt）")


def flip_for(cid: str, seat: str, tag: str) -> bool:
    """与 eval_dual.py 逐字相同的呈现顺序算法——复现基线的一部分，不要改。"""
    v = (sum(map(ord, cid)) + len(tag)) % 2 == 0
    return not v if seat == "B" else v


def binom_sf(k: int, n: int) -> float:
    if n <= 0:
        return 1.0
    return sum(math.comb(n, i) for i in range(k, n + 1)) / (2**n)


class Runner:
    def __init__(self, args):
        self.args = args
        if args.corpus:
            self.ids = sorted(
                f[:-4] for f in os.listdir(args.corpus)
                if f.endswith(".txt") and not f.endswith(".humanized.txt")
            )
        else:
            cases = json.loads((args.repo / "scripts/realcase/cases.json").read_text(encoding="utf-8"))["cases"]
            self.ids = [c["id"] for c in cases]
        args.out.mkdir(parents=True, exist_ok=True)
        self.jsonl = args.results or (args.out / "ab_results.jsonl")
        self.report = args.out / "ab_report.json"
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

    def call(self, up, system, user, max_tokens=16):
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
                return (d["choices"][0]["message"].get("content") or "").strip(), None
            except urllib.error.HTTPError as e:
                last = "HTTP " + str(e.code)
                time.sleep(4 * (attempt + 1) if e.code == 429 else 2 * (attempt + 1))
            except Exception as e:
                last = type(e).__name__ + ": " + str(e)[:80]
                time.sleep(2 * (attempt + 1))
        return "", last

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

    def worker(self, up):
        todo = [cid for cid in self.ids if f"pair|{cid}|{up['seat']}" not in self.done]
        print(f"[{up['seat']}] 待跑 {len(todo)} 条", flush=True)
        for cid in todo:
            a_text = read_arm(self.args.arm_a, cid)
            b_text = read_arm(self.args.arm_b, cid)
            # flip_for=True 时甲=B 臂，否则甲=A 臂；B 席反序以抵消位置偏置
            a_is_first = flip_for(cid, up["seat"], "ab")
            first, second = (b_text, a_text) if a_is_first else (a_text, b_text)
            user = (
                "甲：\n<<<" + first + ">>>\n\n乙：\n<<<" + second
                + ">>>\n\n哪一段更像 AI 生成的？只输出「甲」或「乙」。"
            )
            raw, err = self.call(up, PAIR_SYS, user)
            pick = self.parse_pair(raw)
            chosen = {"甲": ("b" if a_is_first else "a"), "乙": ("a" if a_is_first else "b")}.get(pick)
            rec = {
                "key": f"pair|{cid}|{up['seat']}", "id": cid, "seat": up["seat"],
                "aIsFirst": a_is_first, "pick": pick, "chosen": chosen,
                "bWin": (chosen == "b") if chosen else None,
                "raw": raw[:40], "err": err,
            }
            self.save(rec)
            if err:
                print(f"  [{up['seat']}] ERR {cid}: {err}", flush=True)

    def run(self):
        seats = "".join(sorted(set(self.args.seats.upper()) & {"A", "B"}))
        upstreams = []
        if not self.args.summarize:
            if not self.args.arm_a or not self.args.arm_b:
                sys.exit("缺 --arm-a / --arm-b（只想重算汇总请加 --summarize）")
            key_a = os.environ.get("QUAIWEI_EVAL_KEY_A", "")
            key_b = os.environ.get("QUAIWEI_EVAL_KEY_B", "")
            if self.args.mirror:
                # 只有一个网关时：同一上游充当两个席位。
                # B 席只用于**反序呈现**，抵消位置偏置——位置偏置是与顺序相关的系统偏差，
                # 与模型是否同源无关；单席实测甲被选率 0.826，必须反序才能用。
                seats = "AB"
                avail = {"A": (self.args.url_a, key_a), "B": (self.args.url_a, key_a)}
            else:
                avail = {"A": (self.args.url_a, key_a), "B": (self.args.url_b, key_b)}
            missing = [f"QUAIWEI_EVAL_KEY_{s}" for s in seats if not avail[s][1]]
            if missing:
                sys.exit("缺少凭证：" + " / ".join(missing) + "（只走环境变量，不落盘）")
            upstreams = [{"seat": s, "url": avail[s][0].rstrip("/"), "key": avail[s][1]} for s in seats]
            print(f"臂 A={self.args.arm_a}  臂 B={self.args.arm_b}  模型 {self.args.model}  席位 {seats}", flush=True)
            ths = [threading.Thread(target=self.worker, args=(u,), daemon=True) for u in upstreams]
            for t in ths:
                t.start()
            for t in ths:
                t.join()
            self.load_done()
        self.summarize()

    def summarize(self):
        recs = [json.loads(l) for l in self.jsonl.read_text(encoding="utf-8").splitlines() if l.strip()]
        ok = [r for r in recs if r.get("bWin") is not None]
        n = len(ok)
        b_win = sum(1 for r in ok if r["bWin"])
        by_seat = {s: {"n": len([r for r in ok if r["seat"] == s]),
                       "bWin": sum(1 for r in ok if r["seat"] == s and r["bWin"])} for s in ("A", "B")}
        same = tot = 0
        for cid in self.ids:
            v = [r["bWin"] for r in ok if r["id"] == cid]
            if len(v) == 2:
                tot += 1
                same += v[0] == v[1]
        per_case = []
        for cid in self.ids:
            v = [r["bWin"] for r in ok if r["id"] == cid]
            if not v:
                continue
            per_case.append({"id": cid, "bWinVotes": sum(1 for x in v if x), "votes": len(v),
                             "winner": "b" if sum(1 for x in v if x) * 2 > len(v) else
                                       ("a" if sum(1 for x in v if x) * 2 < len(v) else "split")})
        summary = {
            "model": self.args.model,
            "seats": "".join(sorted({r["seat"] for r in ok})),
            "cases": len(self.ids), "pairs": n, "bWin": b_win,
            "bWinRate": round(b_win / n, 3) if n else None,
            "bySeat": by_seat,
            "firstArmChosen": round(sum(1 for r in ok if r["pick"] == "甲") / n, 3) if n else None,
            "seatAgreement": {"pairs": tot, "rate": round(same / tot, 3) if tot else None},
            "pValue": binom_sf(b_win, n) if n else None,
            "errors": len([r for r in recs if r.get("err")]),
            "perCase": per_case,
            "armA": str(self.args.arm_a), "armB": str(self.args.arm_b),
            "elapsedSec": round(time.time() - self.t0, 1),
        }
        self.report.write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"\n配对 {n} 票 | B 臂被选「更像人」{b_win} 票 = {summary['bWinRate']}")
        print(f"席位 A {by_seat['A']['bWin']}/{by_seat['A']['n']} · B {by_seat['B']['bWin']}/{by_seat['B']['n']}")
        print(f"双席一致 {summary['seatAgreement']['rate']} | 甲被选率 {summary['firstArmChosen']} | p={summary['pValue']:.2g}")
        print("报告：" + str(self.report))


if __name__ == "__main__":
    Runner(parse_args()).run()
