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
    "prompts/01_人格卡_潮汐.md",
    "prompts/02_系统提示词_SystemPrompt_v1.md",
    "prompts/03_情绪与意图识别.md",
    "prompts/04_记忆抽取与写入.md",
    "prompts/05_安全风控分类.md",
    "prompts/06_危机干预回复.md",
    "prompts/07_回复质量自动打分.md",
    "workflow/情绪陪伴主链路_节点清单.md",
    "workflow/dify_workflow_说明.md",
    "workflow/外部工具_Function定义.json",
    "evalset/评测集_120例.csv",
    "evalset/评测结果记录表.csv",
    "evalset/Badcase归因表.csv",
    "interview/01_岗位JD能力模型拆解.md",
    "interview/02_高频面试题与满分答案.md",
    "interview/03_项目讲解话术_3分钟版.md",
    "interview/04_简历改写建议.md",
    "interview/05_Demo演示脚本.md",
    "interview/06_数据真实性补救_真实评测手册.md",
    "interview/07_作品集搭建指南.md",
    "interview/08_作品集.html",
    "docs/状态机图.svg",
    "demo/index.html",
    "src/app/index.html",
    "android/app/src/main/java/com/tide/app/LlmClient.kt",
    "android/app/src/main/java/com/tide/app/KeyStore.kt",
    "android/app/src/test/java/com/tide/app/LlmClientTest.kt",
    "tools/test_model.js",
    "tools/rag_eval.js",
    "tools/v5_client_test.js",
    "server/server.js",
    "server/db.js",
    "server/server_test.js",
    "server/care_flow_test.js",
    "server/guard_test.js",
    "shared/tide_core.js",
    "shared/market_data.js",
    "src/app/js/05_chat_core.js",
    "shared/orbit_mind.js",
    "shared/orbit_memory.js",
    "tools/orbit_e2e.js",
    "shared/orbit_play.js",
    "tools/orbit_play_test.js",
    "src/app/js/10_play.js",
    "analytics/queries.sql",
    "analytics/report.js",
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
    "tools/demo_sim_test.js",
    "tools/engine_ab.js",
    "tools/engine_ab3.js",
    "tools/run_evalset.py",
    "tools/gen_evalset.py",
    "tools/extract_pdf.py",
    "tools/outline.py",
    "tools/_demo_loader.js",
    "evalset/评测集_120例_v2.csv",
    "evalset/规则覆盖率报告.txt",
]

TEXT_SUFFIX = {".md", ".csv", ".json", ".py", ".js", ".html", ".txt"}


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
    p = ROOT / "workflow" / "外部工具_Function定义.json"
    if not p.exists():
        rep.ok(False, "外部工具定义存在", "文件缺失")
        return
    try:
        data = json.loads(p.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as e:
        rep.ok(False, "JSON 可解析", str(e))
        return
    rep.ok(True, "JSON 可解析")

    # 允许两种形态：list[...] 或 {"tools": [...]}
    tools = data if isinstance(data, list) else data.get("tools", [])
    rep.ok(isinstance(tools, list), "顶层是工具列表")
    rep.ok(len(tools) >= 6, f"工具数量 ≥ 6（实际 {len(tools)}）")

    names = []
    for t in tools:
        if not isinstance(t, dict):
            rep.ok(False, "每个工具是对象", str(t)[:60])
            continue
        name = t.get("name") or (t.get("function") or {}).get("name")
        names.append(name)
        rep.ok(bool(name), f"工具有 name：{name}")
        # 参数 schema 存在性（两种常见写法都接受）
        has_schema = any(k in t for k in ("parameters", "input_schema")) or \
                     any(k in (t.get("function") or {}) for k in ("parameters", "input_schema"))
        rep.ok(has_schema, f"工具有参数 schema：{name}")
    rep.ok(len(set(names)) == len(names), "工具名不重复", str(names))


# ---------------------------------------------------------------- T4 CSV

def check_csv(rep: Report) -> None:
    rep.section("T4 CSV 解析与口径")
    evalset = ROOT / "evalset" / "评测集_120例.csv"
    if evalset.exists():
        with evalset.open("r", encoding="utf-8-sig", newline="") as f:
            rows = list(csv.reader(f))
        rep.ok(len(rows) >= 1, "评测集非空")
        header = rows[0]
        body = [r for r in rows[1:] if any(c.strip() for c in r)]
        rep.ok(len(body) == 120, f"评测集 120 例（实际 {len(body)}）")
        widths = {len(r) for r in body}
        rep.ok(len(widths) == 1, "列数一致", f"出现列数 {sorted(widths)}")
        rep.ok(len(widths) == 1 and widths.pop() == len(header), "列数与表头一致")

        # 每条必须有输入和期望
        blank = [r[0] for r in body if len(r) > 3 and not r[3].strip()]
        rep.ok(not blank, "每条都有用户输入", "空输入：" + ",".join(blank[:5]))

        # 场景分布
        from collections import Counter
        dist = Counter(r[1].strip() for r in body if len(r) > 1)
        rep.ok(len(dist) == 8, f"覆盖 8 个场景（实际 {len(dist)}）", str(dict(dist)))

        # 权重档位：实际数据是 2/3/4/5/8/10 六档（不是文档曾经写的 2/5/10 三档）。
        # 这里按真实分布校验，并把分布打印出来，避免文档和 CSV 再次漂移。
        from collections import Counter
        wdist = Counter(r[7].strip() for r in body if len(r) > 7 and r[7].strip())
        allowed = {"2", "3", "4", "5", "8", "10"}
        rep.ok(set(wdist) <= allowed, "权重档位在约定集合内（2/3/4/5/8/10）", str(dict(wdist)))
        # 安全类必须是高权重
        s8_new = [int(r[7]) for r in body if len(r) > 7 and r[1].strip() == "S8" and r[7].strip()]
        rep.ok(all(w >= 8 for w in s8_new), "安全类（S8）权重均 ≥ 8", str(sorted(set(s8_new))))
        print(f"     权重分布：{dict(sorted(wdist.items(), key=lambda x: int(x[0])))}")

    for name, expect_cols in [("评测结果记录表.csv", None), ("Badcase归因表.csv", None)]:
        p = ROOT / "evalset" / name
        if not p.exists():
            rep.ok(False, f"{name} 存在", "缺失")
            continue
        with p.open("r", encoding="utf-8-sig", newline="") as f:
            rows = list(csv.reader(f))
        rep.ok(len(rows) >= 1, f"{name} 有表头")
        widths = {len(r) for r in rows if r}
        rep.ok(len(widths) == 1, f"{name} 列数一致", f"{sorted(widths)}")
        if expect_cols:
            rep.ok(len(rows[0]) == expect_cols, f"{name} 列数 = {expect_cols}")


# ---------------------------------------------------------------- T5 HTML

VOID_TAGS = {"br", "hr", "img", "input", "meta", "link", "source", "area", "base", "col"}


def check_html(rep: Report) -> None:
    rep.section("T5 HTML 结构")
    p = ROOT / "demo" / "index.html"
    if not p.exists():
        rep.ok(False, "demo/index.html 存在", "缺失")
        return
    html = p.read_text(encoding="utf-8-sig")

    # 标签配对（只查结构性标签，避免被 <br>/<input> 干扰）
    for tag in ["html", "head", "body", "style", "script"]:
        opens = len(re.findall(rf"<{tag}[\s>]", html, re.I))
        closes = len(re.findall(rf"</{tag}>", html, re.I))
        rep.ok(opens == closes, f"<{tag}> 配对（{opens} 开 / {closes} 闭）")

    # id 定义 vs getElementById 引用
    defined = set(re.findall(r'id="([^"]+)"', html))
    used = set(re.findall(r"""getElementById\(\s*['"]([^'"]+)['"]\s*\)""", html))
    used |= set(re.findall(r"""el\(\s*['"]([^'"]+)['"]\s*\)""", html))
    missing = {u for u in used if u and not u.startswith("$")} - defined
    rep.ok(not missing, "getElementById 引用的 id 都已定义", "缺少：" + ", ".join(sorted(missing)))

    # onclick 引用 vs function 定义
    onclick_fns = set(re.findall(r"onclick=\"(\w+)\(", html))
    defined_fns = set(re.findall(r"function\s+(\w+)\s*\(", html))
    arrow_fns = set(re.findall(r"(?:const|let|var)\s+(\w+)\s*=\s*(?:function|\()", html))
    all_fns = defined_fns | arrow_fns
    missing_fn = onclick_fns - all_fns
    rep.ok(not missing_fn, "onclick 引用的函数都已定义",
           "缺少：" + ", ".join(sorted(missing_fn)))

    # 不得出现未闭合的 script 块
    rep.ok(html.count("<script>") == html.count("</script>"), "script 块闭合")

    # 必须声明"不调用真实模型"——这是诚信边界，不能被删
    rep.ok("不调用真实大模型 API" in html,
           "Demo 保留「不调用真实大模型 API」声明")


# ---------------------------------------------------------------- T6 链接

def check_links(rep: Report) -> None:
    rep.section("T6 Markdown 内部链接")
    md_files = list(ROOT.glob("*.md")) + list((ROOT / "docs").glob("*.md")) + \
               list((ROOT / "interview").glob("*.md"))
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
    # 单轮成本 0.00568 元 = 2040 in × ¥2/M + 200 out × ¥8/M
    demo = (ROOT / "demo" / "index.html").read_text(encoding="utf-8-sig")
    rep.ok("0.00568" in demo, "Demo 成本常数 = 0.00568", "Demo 里没找到 0.00568")
    rep.ok("0.0044" not in demo.replace("0.005684", ""),
           "Demo 里没有残留旧常数 0.0044")

    doc02 = (ROOT / "docs" / "02_价值评估_商业可行性.md").read_text(encoding="utf-8-sig")
    rep.ok("2040" in doc02, "docs/02 使用 2040 token 口径")
    rep.ok("0.00568" in doc02, "docs/02 单轮成本 0.00568")

    doc13 = (ROOT / "docs" / "13_数据埋点与指标字典.md").read_text(encoding="utf-8-sig")
    rep.ok("0.00568" in doc13, "docs/13 与同一口径")

    # 严格来说 2040/1e6*2 + 200/1e6*8 = 0.00568
    calc = 2040 / 1_000_000 * 2 + 200 / 1_000_000 * 8
    rep.ok(abs(calc - 0.00568) < 1e-9, f"算术校验：2040+200 → {calc:.5f} 元/轮")


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

    v5 起，APK 里的页面由四个源文件拼成：
      src/app/index.html（含占位符） + shared/tide_core.js + shared/market_data.js + src/app/app.js
    旧版做法是"在源码里找关键词、再看产物里有没有"——v5 的 index.html 只有占位符，
    关键词一个都找不到，这条检查就**永远通过**，等于没查。
    现在直接按 build_app.js 的规则在内存里拼一遍，和产物逐字节比较。

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
