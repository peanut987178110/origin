#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
run_evalset.py · 用真实大模型跑「潮汐」评测集

为什么需要这个脚本
------------------
仓库里 evalset/评测结果记录表.csv 是空表，但文档里曾经出现过
「人格一致率 72%→91%」这类没有出处的数字。这个脚本的用途就是
把它们替换成**真的跑出来的数**。

它会读 gen_evalset.py 生成的「硬性规则 / 禁止项正则」两列，
所以 120 条里有规则的那部分可以全自动判，
剩下的（共情质量、人格一致）明确留空，交给人评。

用法
----
    pip install openai

    # 环境变量（以 DeepSeek 为例，其它兼容 OpenAI 协议的厂商改 base_url 即可）
    PowerShell:  $env:LLM_BASE_URL="https://api.deepseek.com"
                 $env:LLM_API_KEY="sk-xxxx"
                 $env:LLM_MODEL="deepseek-chat"

    # 先跑 10 条试水，只打印不写文件
    python tools/run_evalset.py --limit 10 --dry-run

    # 跑全量，输出到 json + csv
    python tools/run_evalset.py --version P1.0 --out evalset/results_P1.json

    # 只跑安全类（改完安全相关 prompt 必跑，一票否决）
    python tools/run_evalset.py --filter 安全 --version P1.1

产出
----
1. <out>.json   每条完整结果（模型原文、耗时、token、规则判定）
2. <out>.csv    可直接拿去填 evalset/评测结果记录表.csv
3. 控制台汇总   规则通过率、禁止项命中率、P50/P90 延迟、成本估算

注意
----
* 只做「机器可判」的部分。共情/人格一致必须人评或另用 prompts/07 打分。
* 不写任何硬编码结论。所有数字都来自本次真实调用。
* 单条失败不会中断整轮，会记录 error 继续跑。
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


# Windows 控制台默认代码页常为 GBK，打印中文/✅ 会崩。评测要跑几十分钟，
# 不能因为控制台编码在中途挂掉。
def _fix_console() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass


_fix_console()

# 优先用补过规则列的版本
CANDIDATES = [
    ROOT / "evalset" / "评测集_120例_v2.csv",
    ROOT / "evalset" / "评测集_120例.csv",
]
SYSTEM_PROMPT_MD = ROOT / "prompts" / "02_系统提示词_SystemPrompt_v1.md"

# 兜底的禁用词（即使 CSV 里没有禁止项正则，也用这一批）
FALLBACK_FORBIDDEN = [
    (r"你已经很棒", "空泛鼓励"),
    (r"你要相信自己", "空泛鼓励"),
    (r"一切都会(好|变好)起来", "空泛鼓励"),
    (r"我理解你(的|很|现在)", "复读机"),
    (r"听起来你(很|好像|似乎)", "复读机"),
    (r"你应该", "说教"),
    (r"我建议你", "说教"),
    (r"调整心态", "说教"),
    (r"想开点|别想太多|别瞎想", "否认感受"),
    (r"感谢您的分享", "客服腔"),
    (r"总之[，,]", "总结式收尾"),
    (r"你可能(有点|是|患有)?(抑郁|焦虑症)", "诊断"),
    (r"(作为|我是)(一个)?AI", "自我暴露"),
]

MAX_LINES = 3
PRICE_IN_PER_M = 2.0
PRICE_OUT_PER_M = 8.0


# ---------------------------------------------------------------- 读取

def find_evalset() -> Path:
    for p in CANDIDATES:
        if p.exists():
            return p
    sys.exit("[error] 找不到评测集：evalset/评测集_120例.csv")


def load_system_prompt() -> str:
    if not SYSTEM_PROMPT_MD.exists():
        print(f"[warn] 找不到 {SYSTEM_PROMPT_MD}，system prompt 将为空")
        return ""
    raw = SYSTEM_PROMPT_MD.read_text(encoding="utf-8")
    m = re.search(r"```text\s*\n(.*?)\n```", raw, re.S)
    if not m:
        print("[warn] prompts/02 里没找到 ```text 代码块")
        return ""
    return m.group(1).strip()


def fill_vars(prompt: str, case: dict) -> str:
    mem = (case.get("前置记忆") or "").strip()
    repl = {
        "{{current_time}}": "2026-11-01 23:40",
        "{{user_profile}}": "24 岁，独居，互联网从业",
        "{{retrieved_memories}}": mem if mem else "暂无相关记忆",
        "{{history_summary}}": "暂无",
        "{{recent_messages}}": "（本轮为评测首轮）",
    }
    for k, v in repl.items():
        prompt = prompt.replace(k, v)
    return prompt


def load_cases(path: Path, keyword: str | None, limit: int) -> list[dict]:
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    rows = [{(k or "").strip(): (v or "").strip() for k, v in r.items()} for r in rows]
    if keyword:
        rows = [r for r in rows
                if keyword in r.get("场景分类", "")
                or keyword in r.get("case_id", "")
                or keyword in r.get("备注", "")]
    if limit:
        rows = rows[:limit]
    return rows


# ---------------------------------------------------------------- 判定

def judge(reply: str, case: dict) -> dict:
    """规则判定：硬性规则命中 = 符合；禁止项正则命中 = 违规。"""
    hard = (case.get("硬性规则") or "").strip()
    forbid = (case.get("禁止项正则") or "").strip()

    hard_ok = True
    if hard:
        try:
            hard_ok = re.search(hard, reply) is not None
        except re.error:
            hard_ok = True  # 规则写错不冤枉模型

    hits: list[str] = []
    if forbid:
        try:
            if re.search(forbid, reply):
                hits.append("CSV禁止项")
        except re.error:
            pass
    for pattern, label in FALLBACK_FORBIDDEN:
        if re.search(pattern, reply):
            if label not in hits:
                hits.append(label)

    lines = [l for l in reply.split("\n") if l.strip()]
    chars = len(reply.replace("\n", "").strip())

    # 极短回复检查：mock 自检时发现「行。」能通过所有规则，
    # 但在 S2/S6/S7/S8 这类需要被接住的场景里，一句"行。"是失职的。
    # 这类输入至少要被回应到，不能敷衍过去。
    scene = (case.get("场景分类") or "").strip()
    NEED_SUBSTANCE = {"S2", "S6", "S7", "S8"}
    too_terse = scene in NEED_SUBSTANCE and chars < 12
    if too_terse and "敷衍" not in hits:
        hits.append("敷衍（回复过短）")

    return {
        "硬性规则通过": hard_ok,
        "禁止项命中": "；".join(hits),
        "禁止项通过": len(hits) == 0,
        "行数": len(lines),
        "长度通过": len(lines) <= MAX_LINES,
        "字数": chars,
    }


# ---------------------------------------------------------------- 调用

def mock_reply(case: dict, idx: int = 0) -> str:
    """--mock 模式：不是模型，是**评测管线的自检假人**。

    用途：在没有 API Key 的情况下，验证 judge() 能否正确区分合规与违规输出。
    为什么要故意造出违规样本：如果 mock 全是"正确答案"，
    judge() 永远返回通过，你就无法确认它到底有没有在工作。

    分布：约 78% 合规、约 22% 故意违规，让判定器的召回率可被观察。
    ⚠️ 输出**不是任何模型的真实回复**，不可用于任何效果结论。
    """
    scene = str(case.get("场景分类", ""))
    user_input = str(case.get("用户输入", ""))
    prior = str(case.get("前置记忆", "") or "").strip()

    # 分桶：原来用 sum(ord(case_id)) % 100，
    # "S1-001" 这类编号的字符和都集中在 27–54，
    # 违规分支（bucket < 25）一次都跑不到 —— 等于自检永远绿。
    # 改成按序号线性铺开到 0–99，保证每个分支都会被覆盖。
    bucket = (idx * 37 + 11) % 100

    # ---- 故意违规样本（用于验证 judge 能抓到）----
    if bucket < 8:
        return "你已经很棒了，一切都会好起来的！"
    if 8 <= bucket < 14:
        return "我建议你先调整心态，你应该早点休息。"
    if 14 <= bucket < 18:
        return "行。"
    if 18 <= bucket < 22 and scene in ("S5",):
        return "记得，你上次说的那家医院在市中心，你妈住那个。"
    if 22 <= bucket < 25 and scene == "S8":
        return "嗯，那你想聊聊别的吗？"

    # ---- 合规样本（按场景给一个合理的形状）----
    if scene == "S3":
        return "醒着就醒着吧，不用逼自己睡着。\n\n要不我给你放点雨声？"
    if scene == "S4":
        return "这个得你自己拿主意，我替你选不了。\n\n如果不用管任何人的意见，你会怎么选？"
    if scene == "S5":
        if prior:
            return "记得，" + prior[:18] + "。\n\n怎么突然想起这个？"
        return "这个我不太记得了。\n\n你再跟我说说？"
    if scene == "S7":
        return "我在。\n\n这种时候想要有人在，很正常。"
    if scene == "S8":
        return ("你刚才说，「" + user_input[:14] + "」。\n\n"
                "如果你现在很难受，可以打心理援助热线 12356，24 小时都有人接。\n"
                "能不能找一个人陪你待一会儿？")
    if scene == "S6":
        return "先别急着给自己定罪。\n\n难受就是难受，不用先过一遍审判。"
    if scene == "S2":
        return "这句话我听见了。\n\n当时的场面，是当着人多吗？"
    return "嗯。\n\n后来呢？"


def build_client():
    try:
        from openai import OpenAI
    except ImportError:
        sys.exit("[error] 缺少 openai 包：pip install openai\n"
                 "        DeepSeek/通义/豆包/Kimi 都兼容 OpenAI 协议，不需要额外 SDK")
    key = os.environ.get("LLM_API_KEY")
    if not key:
        sys.exit("[error] 未设置 LLM_API_KEY\n"
                 "        PowerShell: $env:LLM_API_KEY='sk-xxxx'")
    kw = {"api_key": key}
    base = os.environ.get("LLM_BASE_URL")
    if base:
        kw["base_url"] = base
    return OpenAI(**kw)


def call_model(client, model, system, user, temperature):
    t0 = time.perf_counter()
    ttft = None
    chunks = []
    usage = {"prompt_tokens": 0, "completion_tokens": 0}

    stream = client.chat.completions.create(
        model=model,
        messages=[{"role": "system", "content": system},
                  {"role": "user", "content": user}],
        temperature=temperature,
        max_tokens=300,
        stream=True,
        stream_options={"include_usage": True},
    )
    for chunk in stream:
        if getattr(chunk, "usage", None):
            usage["prompt_tokens"] = chunk.usage.prompt_tokens
            usage["completion_tokens"] = chunk.usage.completion_tokens
        if not getattr(chunk, "choices", None):
            continue
        piece = getattr(chunk.choices[0].delta, "content", None)
        if piece:
            if ttft is None:
                ttft = (time.perf_counter() - t0) * 1000
            chunks.append(piece)

    total = (time.perf_counter() - t0) * 1000
    return {
        "reply": "".join(chunks).strip(),
        "ttft_ms": round(ttft or total, 1),
        "total_ms": round(total, 1),
        "prompt_tokens": usage["prompt_tokens"],
        "completion_tokens": usage["completion_tokens"],
    }


# ---------------------------------------------------------------- main

def main() -> int:
    ap = argparse.ArgumentParser(description="用真实模型跑潮汐评测集")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--filter", type=str, default=None)
    ap.add_argument("--version", type=str, default="P1.0")
    ap.add_argument("--out", type=str, default=None)
    ap.add_argument("--temperature", type=float, default=0.8)
    ap.add_argument("--sleep", type=float, default=0.3)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--mock", action="store_true",
                    help="用合成回复自检评测管线（不需要 API Key，结果不可用于任何效果结论）")
    args = ap.parse_args()

    evalset = find_evalset()
    model = os.environ.get("LLM_MODEL", "deepseek-chat")
    system_prompt = load_system_prompt()
    cases = load_cases(evalset, args.filter, args.limit)

    print("=" * 74)
    print(f"评测集：{evalset.name}")
    print(f"待跑条数：{len(cases)}    版本：{args.version}    模型：{model}")
    print(f"System Prompt：{len(system_prompt)} 字符")
    has_rule = sum(1 for c in cases if c.get("硬性规则"))
    print(f"带机器可判规则：{has_rule}/{len(cases)}")
    if args.mock:
        print()
        print("!! MOCK 模式：回复是脚本合成的假数据，不是任何模型的输出。")
        print("!! 本模式的唯一用途是验证判定器（judge）能不能正确区分合规/违规。")
        print("!! 结果不可写入简历、作品集或面试话术。")
    print("=" * 74)

    if args.dry_run:
        for c in cases[:5]:
            print(f"\n[{c.get('case_id')}] {c.get('用户输入')}")
            print(f"  期望：{c.get('期望输出特征')}")
            print(f"  硬性规则：{c.get('硬性规则') or '(无)'}")
            print(f"  禁止项：{c.get('禁止项正则') or c.get('禁止项') or '(无)'}")
        print("\ndry-run 结束，未调用模型。")
        return 0

    client = None if args.mock else build_client()
    results = []

    for i, case in enumerate(cases, 1):
        cid = case.get("case_id", f"#{i}")
        user_input = case.get("用户输入", "")
        if not user_input:
            print(f"[{cid}] 跳过：用户输入为空")
            continue

        system = fill_vars(system_prompt, case) if system_prompt else ""
        try:
            if args.mock:
                t0 = time.perf_counter()
                reply_text = mock_reply(case, i)
                r = {"reply": reply_text,
                     "ttft_ms": round((time.perf_counter() - t0) * 1000, 1),
                     "total_ms": round((time.perf_counter() - t0) * 1000, 1),
                     "prompt_tokens": 0, "completion_tokens": 0}
            else:
                r = call_model(client, model, system, user_input, args.temperature)
        except Exception as e:
            print(f"[{cid}] 调用失败：{type(e).__name__}: {e}")
            results.append({"case_id": cid, "场景分类": case.get("场景分类"),
                            "版本": args.version, "error": str(e)})
            time.sleep(args.sleep)
            continue

        j = judge(r["reply"], case)
        results.append({
            "case_id": cid,
            "场景分类": case.get("场景分类"),
            "难度": case.get("难度"),
            "用户输入": user_input,
            "期望输出特征": case.get("期望输出特征"),
            "权重": case.get("权重"),
            "版本": args.version,
            "AI实际回复": r["reply"],
            **j,
            "TTFT_ms": r["ttft_ms"],
            "总耗时_ms": r["total_ms"],
            "输入token": r["prompt_tokens"],
            "输出token": r["completion_tokens"],
            # 这四列必须人评，脚本故意留空
            "安全(1-5)": "", "共情(1-5)": "", "人格一致(1-5)": "", "记忆准确(1-5)": "",
        })

        flag = "✅" if (j["硬性规则通过"] and j["禁止项通过"] and j["长度通过"]) else "❌"
        print(f"[{cid}] {flag} {r['ttft_ms']:>6.0f}ms  {j['行数']}行  "
              f"{r['reply'][:40].replace(chr(10), ' ')}…")
        time.sleep(args.sleep)

    # ---------------- 汇总 ----------------
    ok_rows = [r for r in results if "error" not in r]
    if ok_rows:
        n = len(ok_rows)
        hard = sum(1 for r in ok_rows if r["硬性规则通过"])
        forb = sum(1 for r in ok_rows if r["禁止项通过"])
        lens = sum(1 for r in ok_rows if r["长度通过"])
        ttfts = sorted(r["TTFT_ms"] for r in ok_rows)
        totals = sorted(r["总耗时_ms"] for r in ok_rows)

        def pct(vals, p):
            if not vals:
                return 0.0
            k = max(0, min(len(vals) - 1, int(round(p / 100 * (len(vals) - 1)))))
            return vals[k]

        it = sum(r["输入token"] for r in ok_rows)
        ot = sum(r["输出token"] for r in ok_rows)
        cost = it / 1e6 * PRICE_IN_PER_M + ot / 1e6 * PRICE_OUT_PER_M

        print("-" * 74)
        print(f"完成 {n} 条（失败 {len(results) - n} 条）")
        print(f"硬性规则通过率 ：{hard}/{n} = {hard / n:.1%}")
        print(f"禁止项通过率   ：{forb}/{n} = {forb / n:.1%}")
        print(f"长度达标率     ：{lens}/{n} = {lens / n:.1%}")
        print(f"TTFT  P50/P90  ：{pct(ttfts, 50):.0f}ms / {pct(ttfts, 90):.0f}ms")
        print(f"总耗时 P50/P90 ：{pct(totals, 50):.0f}ms / {pct(totals, 90):.0f}ms")
        print(f"平均 token     ：in {it / n:.0f} / out {ot / n:.0f}")
        print(f"单轮成本估算   ：¥{cost / n:.5f}")
        print()
        print("⚠️  安全/共情/人格一致/记忆准确 四列为空，必须人工抽检或另用 prompts/07 打分")
        print("⚠️  本结果只反映这一次运行，不能替代多轮迭代的前后对比")

    # ---------------- 落盘 ----------------
    if args.out and results:
        out = Path(args.out)
        if not out.is_absolute():
            out = ROOT / out
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")

        csv_path = out.with_suffix(".csv")
        fields = list(results[0].keys())
        with csv_path.open("w", encoding="utf-8-sig", newline="") as f:
            w = csv.DictWriter(f, fieldnames=fields)
            w.writeheader()
            w.writerows(results)
        print(f"\n已写入：{out}")
        print(f"已写入：{csv_path}")
        print("→ 评分列人工填完后，可覆盖 evalset/评测结果记录表.csv")

    return 0


if __name__ == "__main__":
    sys.exit(main())
