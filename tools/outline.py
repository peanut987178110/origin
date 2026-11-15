#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
outline.py · 把 raw/ 下的课程文本汇总成一份可检索的目录

为什么需要它
------------
raw/ 里有几十份课件。想知道"哪里讲过 RAG"，一个个点开太慢。
这个脚本把每份文件的首行标题、字数、和关键词命中位置汇总成
一份 _outline.txt，之后用编辑器搜一下就能定位。

用法
----
    python tools/outline.py                    # 汇总 raw/
    python tools/outline.py --kw RAG 提示词 工作流   # 顺便标出关键词命中
    python tools/outline.py --src raw --out raw/_outline.txt

输出
----
    raw/_outline.txt    目录 + 关键词索引
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def _fix_console() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass


_fix_console()

DEFAULT_KW = [
    "需求", "提示词", "工作流", "RAG", "微调", "Function", "MCP",
    "Agent", "Skill", "边界", "评测", "指标", "成本", "留存",
]


def first_title(text: str) -> str:
    for line in text.splitlines():
        line = line.strip().lstrip("#").strip()
        if line and not line.startswith("来源："):
            return line[:42]
    return "（无标题）"


def main() -> int:
    ap = argparse.ArgumentParser(description="生成 raw/ 目录与关键词索引")
    ap.add_argument("--src", default="raw")
    ap.add_argument("--out", default="raw/_outline.txt")
    ap.add_argument("--kw", nargs="*", default=None, help="自定义关键词")
    args = ap.parse_args()

    root = Path(__file__).resolve().parent.parent
    src = Path(args.src)
    src = src if src.is_absolute() else root / src
    out = Path(args.out)
    out = out if out.is_absolute() else root / out

    if not src.exists():
        print(f"[error] 找不到目录：{src}")
        return 1

    files = sorted(p for p in src.glob("*.txt") if p.name != "_outline.txt")
    if not files:
        print(f"[warn] {src} 下没有 .txt")
        return 0

    kws = args.kw if args.kw is not None else DEFAULT_KW
    lines: list[str] = []
    lines.append("raw/ 课程文本目录")
    lines.append("=" * 60)
    lines.append(f"共 {len(files)} 份")
    lines.append("")
    lines.append(f"{'文件名':<52}{'字数':>8}")
    lines.append("-" * 60)

    stats = {}
    total_chars = 0
    for p in files:
        text = p.read_text(encoding="utf-8", errors="replace")
        chars = len(text.replace("\n", "").replace(" ", ""))
        total_chars += chars
        stats[p.name] = text
        lines.append(f"{p.name:<52}{chars:>8}")

    lines.append("-" * 60)
    lines.append(f"{'合计':<52}{total_chars:>8}")
    lines.append("")

    lines.append("关键词索引（命中文件数 / 命中次数）")
    lines.append("=" * 60)
    for kw in kws:
        hits = [(name, text.count(kw)) for name, text in stats.items() if kw in text]
        hits.sort(key=lambda x: -x[1])
        lines.append(f"\n【{kw}】{len(hits)} 份 / 共 {sum(h[1] for h in hits)} 次")
        for name, n in hits[:8]:
            lines.append(f"    {n:>3} 次  {name}")

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines), encoding="utf-8")

    print("\n".join(lines[:12]))
    print(f"\n... 完整内容已写入：{out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
