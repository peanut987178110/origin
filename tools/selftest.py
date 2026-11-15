#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
selftest.py · 交付物静态自检

检查的是"仓库本身有没有坏"，不是"模型效果好不好"。
模型效果请用 tools/run_evalset.py。

检查项
------
 T1 必备文件是否存在且非空
 T2 文本文件能否按 UTF-8 解码（发现乱码 / GBK 混入）
 T3 JSON 能否解析，且结构符合预期
 T4 CSV 能否解析、列数是否一致、行数是否符合声明
 T5 HTML 标签是否配对、onclick 引用的函数是否都已定义、getElementById 的 id 是否都存在
 T6 Markdown 内部链接（指向仓库内文件）是否有效
 T7 口径一致性：成本常数在 demo / docs 里是否一致
 T8 是否残留"无出处的量化数据"（防止又把编的数字写回文档）

用法
----
    python tools/selftest.py
    python tools/selftest.py -v     # 打印每条检查明细

退出码 0 = 全部通过
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


# ---------------------------------------------------------------- 控制台编码兜底
# Windows 控制台默认代码页往往是 936(GBK)，打印 ✅/❌/─ 会直接抛
# UnicodeEncodeError 把整个自检打断。自检工具不能因为"控制台编码"
# 这种环境问题中断，所以这里强制切到 UTF-8，实在不行就降级替换。
def _fix_console() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass


_fix_console()

# ---------------------------------------------------------------- 结果收集

class Report:
    def __init__(self, verbose: bool = False):
        self.pass_ = 0
        self.fail_ = 0
        self.verbose = verbose
        self.failures: list[tuple[str, str]] = []

    def ok(self, cond: bool, name: str, detail: str = "") -> None:
        if cond:
            self.pass_ += 1
            if self.verbose:
                print(f"  ✅ {name}")
        else:
            self.fail_ += 1
            self.failures.append((name, detail))
            print(f"  ❌ {name}" + (f"\n     {detail}" if detail else ""))

    def section(self, title: str) -> None:
        print(f"\n── {title} " + "─" * max(0, 58 - len(title)))


# ---------------------------------------------------------------- T1 必备文件

REQUIRED = [
    "README.md",
    "00_学习路线图_14周.md",
    "00_体检报告_项目问题清单.md",
    "docs/00_大模型能力边界清单.md",
    "docs/01_需求挖掘_广义痛点与PMF.md",
    "docs/02_价值评估_商业可行性.md",
    "docs/03_智能构建_人格与提示词设计.md",
    "docs/04_产品架构_工作流与结构设计.md",
    "docs/05_边界设计与验证逻辑.md",
    "docs/06_测试调优_评测集与指标体系.md",
    "docs/07_商业策略_定价与增长.md",
    "docs/08_PRD_潮汐Tide_v1.0.md",
    "docs/09_版本规划与决策记录.md",
    "docs/10_竞品拆解.md",
    "docs/11_用户访谈与需求验证.md",
    "docs/12_合规与危机干预SOP.md",
    "docs/13_数据埋点与指标字典.md",
    "interview/01_岗位JD能力模型拆解.md",
    "interview/02_高频面试题与满分答案.md",
    "interview/03_项目讲解话术_3分钟版.md",
    "interview/04_简历改写建议.md",
    "interview/05_Demo演示脚本.md",
    "interview/06_数据真实性补救_真实评测手册.md",
    "interview/07_作品集搭建指南.md",
    "interview/08_作品集.html",
    "docs/状态机图.svg",
    "src/app/index.html",
    "tools/rag_eval.js",
    "shared/market_data.js",
    "src/app/js/05_chat_core.js",
    "shared/orbit_mind.js",
    "shared/orbit_memory.js",
    "tools/orbit_e2e.js",
    "shared/orbit_play.js",
    "tools/orbit_play_test.js",
    "src/app/js/10_play.js",
    "00_小白教程_用生活比喻看懂潮汐.md",
    "docs/08_PRD_潮汐Tide_v5.md",
    "docs/24_v5当前实现与发布门槛.md",
    "docs/25_Prompt工程文档.md",
    "docs/26_RAG与记忆文档.md",
    "docs/27_Skills文档_智能体能力清单.md",
    "docs/28_工作流文档.md",
    "docs/29_市场数据手册.md",
    "docs/30_JD对照与面试题库.md",
    "tools/build_apk.ps1",
    "tools/verify_app.js",
    "tools/verify_apk.py",
    "docs/18_v3使用说明.md",
    "docs/19_角色设计_人群与性格.md",
    "docs/20_连接大模型指南.md",
    "docs/21_安装与使用指南.md",
    "android/build.gradle.kts",
    "android/settings.gradle.kts",
    "android/app/build.gradle.kts",
    "android/app/src/main/AndroidManifest.xml",
    "android/app/src/main/java/com/tide/app/MainActivity.kt",
    "android/app/src/main/assets/index.html",
    "android/app/src/main/res/values/strings.xml",
    "android/app/src/main/res/values/themes.xml",
    "android/app/src/main/res/values/colors.xml",
    "tools/selftest.py",
    "tools/extract_pdf.py",
    "tools/outline.py",
]

TEXT_SUFFIX = {".md", ".csv", ".json", ".py", ".js", ".html", ".txt"}
# 归档目录：v5 的历史文档原样保留，不参与编码/链接/假数据检查
SKIP_DIRS = {"history_before_v5", "_research", "_legacy", "llama.cpp"}
def _skipped(p: pathlib.Path) -> bool:
    return any(part in SKIP_DIRS for part in p.parts)


def check_files(rep: Report) -> list[Path]:
    rep.section("T1 必备文件存在且非空")
    existing: list[Path] = []
    for rel in REQUIRED:
        p = ROOT / rel
        exists = p.exists()
        rep.ok(exists, f"存在：{rel}", "文件不存在")
        if exists:
            size = p.stat().st_size
            rep.ok(size > 0, f"非空：{rel}", "文件为 0 字节")
            if size > 0:
                existing.append(p)
    return existing


# ---------------------------------------------------------------- T2 编码

def check_encoding(rep: Report, files: list[Path]) -> None:
    rep.section("T2 UTF-8 编码")
    for p in files:
        if p.suffix.lower() not in TEXT_SUFFIX:
            continue
        try:
            raw = p.read_bytes()
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError as e:
            rep.ok(False, f"UTF-8 可解码：{p.relative_to(ROOT)}", f"{e}")
            continue
        # 替换字符说明原文就有乱码。用 chr() 构造，避免本文件自己
        # 含这个字符而把自己判为乱码（自检脚本要能通过自检）。
        bad = text.count(chr(0xFFFD))
        rep.ok(bad == 0, f"无乱码字符：{p.relative_to(ROOT)}",
               f"发现 {bad} 个替换字符（编码损坏）")


# ---------------------------------------------------------------- T3 JSON

def check_json(rep: Report) -> None:
    rep.section("T3 JSON 结构与解析")
    # workflow/ 的 Function 定义已随 v5 服务端移除；这里检查仓库里实际还在的 JSON。
    jsons = [q for q in ROOT.rglob("*.json") if not _skipped(q) and "node_modules" not in q.parts
             and "build" not in q.parts and ".cxx" not in q.parts]
    if not jsons:
        rep.ok(True, "仓库里没有需要解析的 JSON（跳过）")
        return
    bad = []
    for q in jsons:
        try:
            json.loads(q.read_text(encoding="utf-8-sig"))
        except Exception as e:  # noqa: BLE001
            bad.append(f"{q.relative_to(ROOT)}: {e}")
    rep.ok(not bad, f"{len(jsons)} 个 JSON 全部可解析", "; ".join(bad[:5]))


# ---------------------------------------------------------------- T4 CSV

def check_csv(rep: Report) -> None:
    rep.section("T4 CSV 解析与口径")
    # evalset/ 的 120 例评测集随 v5 一起移除（v6 的评测是 E2E + 玩法单测 + 检索评测）。
    csvs = [q for q in ROOT.rglob("*.csv") if not _skipped(q)]
    if not csvs:
        rep.ok(True, "仓库里没有 CSV 需要检查（v6 不再用 evalset/）")
        return
    bad = []
    for q in csvs:
        with q.open("r", encoding="utf-8-sig", newline="") as f:
            rows = [r for r in csv.reader(f) if any(c.strip() for c in r)]
        widths = {len(r) for r in rows}
        if len(widths) > 1:
            bad.append(f"{q.relative_to(ROOT)}: 列数不一致 {sorted(widths)}")
    rep.ok(not bad, f"{len(csvs)} 个 CSV 列数一致", "; ".join(bad[:5]))


# ---------------------------------------------------------------- T5 HTML

VOID_TAGS = {"br", "hr", "img", "input", "meta", "link", "source", "area", "base", "col"}


def check_html(rep: Report) -> None:
    rep.section("T5 HTML 结构")
    # v6：页面源是 src/app/index.html（构建时由 build_app.js 拼进 android assets）
    p = ROOT / "src" / "app" / "index.html"
    if not p.exists():
        rep.ok(False, "src/app/index.html 存在", "缺失")
        return
    html = p.read_text(encoding="utf-8-sig")

    # 标签配对（只查结构性标签，避免被 <br>/<input> 干扰）
    for tag in ["html", "head", "body", "style", "script"]:
        opens = len(re.findall(rf"<{tag}[\s>]", html, re.I))
        closes = len(re.findall(rf"</{tag}>", html, re.I))
        rep.ok(opens == closes, f"<{tag}> 配对（{opens} 开 / {closes} 闭）")

    # id 定义 vs getElementById 引用（页面逻辑在 src/app/js/*.js，一起查）
    js_files = sorted((ROOT / "src" / "app" / "js").glob("*.js"))
    js = "\n".join(f.read_text(encoding="utf-8") for f in js_files)
    defined = set(re.findall(r'id="([^"]+)"', html)) | set(re.findall(r"""id=["']([^"']+)["']""", js))
    used = set(re.findall(r"""getElementById\(\s*['"]([^'"]+)['"]\s*\)""", js))
    missing = {u for u in used if u and not u.startswith("$")} - defined
    # 动态创建的 id（screen(id) 里拼 's-' + id）不在静态扫描范围内，单独排除
    missing = {u for u in missing if not u.startswith("s-") and not u.startswith("m-")}
    rep.ok(not missing, "getElementById 引用的 id 都已定义", "缺少：" + ", ".join(sorted(missing)))

    # 不得出现未闭合的 script 块
    rep.ok(html.count("<script>") == html.count("</script>"), "script 块闭合")

    # 页面保留构建占位符（否则 build_app.js 拼不进模块）
    rep.ok("/*__ORBIT_JS__*/" in html, "页面保留构建占位符 __ORBIT_JS__")


# ---------------------------------------------------------------- T6 链接

def check_links(rep: Report) -> None:
    rep.section("T6 Markdown 内部链接")
    md_files = [m for m in list(ROOT.glob("*.md")) + list((ROOT / "docs").glob("*.md")) +
                list((ROOT / "interview").glob("*.md")) if not _skipped(m)]
    broken: list[str] = []
    total = 0
    for md in md_files:
        text = md.read_text(encoding="utf-8-sig")
        for m in re.finditer(r"\[([^\]]+)\]\(([^)]+)\)", text):
            target = m.group(2).strip()
            if target.startswith(("http://", "https://", "#", "mailto:")):
                continue
            target = target.split("#")[0]
            if not target:
                continue
            total += 1
            resolved = (md.parent / target).resolve()
            if not resolved.exists():
                broken.append(f"{md.relative_to(ROOT)} → {target}")
    rep.ok(not broken, f"内部链接有效（共 {total} 条）", "\n     ".join(broken[:10]))


# ---------------------------------------------------------------- T7 口径

def check_consistency(rep: Report) -> None:
    rep.section("T7 成本口径一致性")
    # v6 端侧：每轮回复的边际成本是 0。这里检查"文档仍然把 v5 的云端成本写成当前结论"——
    # v5 的 0.00568 元/轮只允许出现在标注了"v5 / 历史 / 当时"的语境里。
    doc02 = (ROOT / "docs" / "02_价值评估_商业可行性.md").read_text(encoding="utf-8-sig")
    rep.ok("2040" in doc02, "docs/02 保留 2040 token 口径（v5 成本模型）")
    rep.ok("0.00568" in doc02, "docs/02 单轮成本 0.00568（v5 口径）")

    doc13 = (ROOT / "docs" / "13_数据埋点与指标字典.md").read_text(encoding="utf-8-sig")
    rep.ok("0.00568" in doc13, "docs/13 与同一口径")

    # 算术校验：2040/1e6*2 + 200/1e6*8 = 0.00568
    calc = 2040 / 1_000_000 * 2 + 200 / 1_000_000 * 8
    rep.ok(abs(calc - 0.00568) < 1e-9, f"算术校验：2040+200 → {calc:.5f} 元/轮（v5）")

    # v6 的口径必须写清楚：边际成本为 0，成本是固定项
    prd = (ROOT / "docs" / "08_PRD_Orbit_v6.md").read_text(encoding="utf-8-sig")
    rep.ok("零边际成本" in prd or "边际成本是 0" in prd, "v6 PRD 写明端侧零边际成本")


# ---------------------------------------------------------------- T8 假数据

# 这些数字在项目里曾经被当成"实测结果"使用，但没有运行记录支撑。
# 允许出现在"说明为什么删掉"的语境里，但不允许出现在结论/简历/话术的位置。
SUSPECT_PATTERNS = [
    (r"人格一致率\s*72%", "伪造的 72%"),
    (r"说教率\s*34%", "伪造的 34%"),
    (r"编造记忆率\s*15%", "伪造的 15%"),
    (r"延迟[^|\n]{0,12}-45%", "伪造的 -45%"),
    (r"毛利\s*89%", "已作废的 89% 毛利"),
    (r"单人月\s*token\s*成本约\s*2\s*元", "已作废的 2 元口径"),
]

# 这些文件里出现上述数字属于"正在解释为什么删掉"，豁免。
# 判据放在**整行**上：一行里带这些标记，说明它是在讲历史或反面案例，不是结论。
EXEMPT_HINTS = [
    "体检报告", "数据真实性补救",
    "已删除", "已改掉", "已作废", "已清空", "已全部清空",
    "早期版本", "原稿", "那是按 1200", "值钱的地方",
    "❌", "反面", "不要", "不能", "禁止", "fake", "伪造",
]


def check_fake_data(rep: Report) -> None:
    rep.section("T8 无出处的量化数据残留")
    md_files = list(ROOT.glob("*.md")) + list((ROOT / "docs").glob("*.md")) + \
               list((ROOT / "interview").glob("*.md"))
    offences: list[str] = []
    for md in md_files:
        text = md.read_text(encoding="utf-8-sig")
        # 文件名本身带豁免标记的（体检报告），整篇跳过
        if any(h in md.name for h in EXEMPT_HINTS):
            continue
        for pattern, label in SUSPECT_PATTERNS:
            for m in re.finditer(pattern, text):
                start = text.rfind("\n", 0, m.start()) + 1
                end = text.find("\n", m.end())
                line = text[start:end if end > 0 else len(text)]
                # 看本行 + 上一行：很多说明写在引用块或上一行里
                prev_start = text.rfind("\n", 0, max(0, start - 1)) + 1
                prev_line = text[prev_start:start]
                ctx = prev_line + line
                if any(h in ctx for h in EXEMPT_HINTS):
                    continue
                rel = md.relative_to(ROOT)
                offences.append(f"{rel}: {label} → {line.strip()[:70]}")
    rep.ok(not offences, "没有把无出处数据当结论使用",
           "\n     ".join(offences[:8]))


# ---------------------------------------------------------------- main

def check_build_freshness(rep: Report) -> None:
    """T9 · 构建产物是否与源码同步

    v6：页面由 src/app/index.html（含占位符）+ shared/orbit_*.js + shared/market_data.js
    + src/app/js/NN_*.js 拼成，规则只有 build_app.js 一份。
    旧版做法是"在源码里找关键词、再看产物里有没有"——源文件里只有占位符，
    关键词一个都找不到，这条检查就**永远通过**，等于没查。
    现在直接让 build_app.js 在内存里拼一遍，和产物逐字节比较。

    为什么必须查这条：改了源码却忘了跑 build_app.js，
    就会出现"手机上装的是旧版、电脑上看的是新版"——演示时最致命。
    """
    rep.section("T9 构建产物新鲜度")
    # v6：页面由 index.html + shared/orbit_*.js + src/app/js/NN_*.js 拼成。
    # 直接让 build_app.js 的 assemble() 给出"应该是什么"，再和产物逐字节比，规则只有一份。
    import subprocess
    try:
        expected = subprocess.run(["node", "-e", "process.stdout.write(require('./tools/build_app.js').assemble().out)"],
                                  cwd=str(ROOT), capture_output=True, check=True).stdout.decode("utf-8")
    except Exception as e:  # noqa: BLE001
        rep.ok(False, "能用 build_app.js 拼装页面", str(e)[:120])
        return
    built_path = ROOT / "android" / "app" / "src" / "main" / "assets" / "index.html"
    if not built_path.exists():
        rep.ok(False, "android assets 存在", "文件缺失，请运行 node tools/build_app.js")
        return
    built = built_path.read_text(encoding="utf-8")
    rep.ok(built == expected, "android assets 与源码逐字节一致",
           "构建产物过期 → 请运行 node tools/build_app.js")
    for marker in ["OrbitCore", "OrbitMarket", "AndroidOrbitAI", "checkSafety", "guardReply", "consentText", "syntheticCohort"]:
        rep.ok(marker in built, f"构建产物包含 {marker}")


def main() -> int:
    ap = argparse.ArgumentParser(description="潮汐训练营交付物自检")
    ap.add_argument("-v", "--verbose", action="store_true", help="打印每条检查明细")
    args = ap.parse_args()

    print("=" * 66)
    print("潮汐 Tide · 交付物静态自检")
    print(f"目录：{ROOT}")
    print("=" * 66)
    print("说明：本脚本检查文件完整性与一致性，不检查模型效果。")

    rep = Report(args.verbose)
    files = check_files(rep)
    check_encoding(rep, files)
    check_json(rep)
    check_csv(rep)
    check_html(rep)
    check_links(rep)
    check_consistency(rep)
    check_fake_data(rep)
    check_build_freshness(rep)

    print("\n" + "=" * 66)
    if rep.fail_:
        print(f"❌ 失败 {rep.fail_} 项（通过 {rep.pass_} 项）")
        for name, detail in rep.failures:
            print(f"\n  · {name}")
            if detail:
                print(f"     {detail}")
        return 1
    print(f"✅ 全部通过：{rep.pass_} 项检查")
    return 0


if __name__ == "__main__":
    sys.exit(main())
