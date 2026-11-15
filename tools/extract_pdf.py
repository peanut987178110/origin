#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
extract_pdf.py · 把课程 PDF 批量抽成纯文本，放进 raw/

为什么需要它
------------
课程资料是 PDF。让 AI 读 PDF 又慢又贵，而且检索效果差。
抽成 txt 之后，grep 就能查，vibe coding 时也能直接贴给模型。

用法
----
    pip install pypdf

    # 抽整个目录
    python tools/extract_pdf.py --src "D:\\课程PDF" --out raw

    # 只抽一个文件
    python tools/extract_pdf.py --src "D:\\课程PDF\\第10课.pdf" --out raw

    # 覆盖已存在的 txt
    python tools/extract_pdf.py --src ... --out raw --force

输出
----
    raw/<原文件名>.txt     每个 PDF 一个 txt，UTF-8 无 BOM
    控制台打印每份的页数与字数，抽不到文字的（扫描件）会单独列出来

注意
----
* 扫描版 PDF 抽不出文字（需要 OCR），脚本会明确报告，不会假装成功。
* 只做抽取，不改原文，不做摘要——摘要交给模型，别在这里掺判断。
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


def extract_one(pdf: Path) -> tuple[str, int]:
    """返回 (文本, 页数)。抽取失败抛异常。"""
    try:
        from pypdf import PdfReader
    except ImportError:
        sys.exit("[error] 缺少 pypdf：pip install pypdf")

    reader = PdfReader(str(pdf))
    pages = []
    for i, page in enumerate(reader.pages, 1):
        try:
            pages.append(page.extract_text() or "")
        except Exception as e:  # noqa: BLE001 单页失败不该中断整份
            pages.append(f"[第 {i} 页抽取失败：{type(e).__name__}]")
    return "\n\n".join(pages).strip(), len(reader.pages)


def main() -> int:
    ap = argparse.ArgumentParser(description="批量抽取 PDF 文本到 raw/")
    ap.add_argument("--src", required=True, help="PDF 文件或目录")
    ap.add_argument("--out", default="raw", help="输出目录（默认 raw）")
    ap.add_argument("--force", action="store_true", help="覆盖已存在的 txt")
    args = ap.parse_args()

    src = Path(args.src)
    out = Path(args.out)
    if not out.is_absolute():
        out = Path(__file__).resolve().parent.parent / out

    if not src.exists():
        print(f"[error] 找不到：{src}")
        return 1

    pdfs = [src] if src.is_file() else sorted(src.rglob("*.pdf"))
    if not pdfs:
        print(f"[warn] {src} 下没有 PDF")
        return 0

    out.mkdir(parents=True, exist_ok=True)
    print(f"待抽取 {len(pdfs)} 份 → {out}\n")

    ok_n = skip_n = fail_n = empty_n = 0
    empties: list[str] = []

    for pdf in pdfs:
        dst = out / (pdf.stem + ".txt")
        if dst.exists() and not args.force:
            print(f"  跳过（已存在）：{pdf.name}")
            skip_n += 1
            continue
        try:
            text, npages = extract_one(pdf)
        except Exception as e:  # noqa: BLE001
            print(f"  ❌ {pdf.name}：{type(e).__name__}: {e}")
            fail_n += 1
            continue

        if not text:
            print(f"  ⚠  {pdf.name}：{npages} 页但抽不到文字（可能是扫描件，需 OCR）")
            empty_n += 1
            empties.append(pdf.name)
            continue

        header = f"# 来源：{pdf.name}\n# 页数：{npages}\n\n"
        dst.write_text(header + text, encoding="utf-8")
        print(f"  ✅ {pdf.name}：{npages} 页 / {len(text)} 字")
        ok_n += 1

    print(f"\n完成：成功 {ok_n} / 跳过 {skip_n} / 失败 {fail_n} / 无文字 {empty_n}")
    if empties:
        print("以下文件抽不到文字，需要 OCR 或手动处理：")
        for name in empties:
            print("  · " + name)
    return 0 if fail_n == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
