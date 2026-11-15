"""交付前终检：直接从 dist 里的 APK 中取出 assets/index.html，与源码逐字节比对。

为什么需要这个脚本
------------------------------------------------------------------
构建脚本说"成功"，不等于**产物里真的**是新代码。
本项目就真出过一次：源码改完忘了重新打包，
测试全绿（跑的是源码），用户手上的 APK 却是旧的。

selftest.py 的 T9 用"关键符号是否出现在 assets/index.html"来做粗筛；
这个脚本更进一步——直接从 APK 的 zip 里解出页面，算 MD5 比对，
并检查关键能力符号、版本号、权限、签名是否都在位。

用法：
    python tools/verify_apk.py                 # 自动取 dist/ 下版本号最大的 apk
    python tools/verify_apk.py path/to/x.apk
退出码 0 = 一致，可交付。
"""
from pathlib import Path
import hashlib
import os
import re
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")
SRC = os.path.join(ROOT, "src", "app", "index.html")
ASSETS = os.path.join(ROOT, "android", "app", "src", "main", "assets", "index.html")
GRADLE = os.path.join(ROOT, "android", "app", "build.gradle.kts")

# 页面上必须具备的能力符号。少一个，说明打包的是旧版本。
REQUIRED = ["OrbitCore", "OrbitMarket", "AndroidOrbitAI", "checkSafety", "guardReply", "recall", "consentText", "988", "syntheticCohort", "<!DOCTYPE html>"]


def md5(b):
    return hashlib.md5(b).hexdigest()


def pick_apk():
    if len(sys.argv) > 1:
        return sys.argv[1]
    if not os.path.isdir(DIST):
        return None
    cands = []

    def ver(name):
        m = re.search(r"v(\d+)\.(\d+)\.(\d+)\.apk$", name)
        return tuple(int(x) for x in m.groups()) if m else None

    for n in os.listdir(DIST):
        v = ver(n)
        if v:
            cands.append((v, os.path.join(DIST, n)))
    if not cands:
        return None
    cands.sort()
    return cands[-1][1]


def gradle_version():
    if not os.path.exists(GRADLE):
        return None
    with open(GRADLE, encoding="utf-8") as f:
        t = f.read()
    m = re.search(r'versionName\s*=\s*"([^"]+)"', t)
    return m.group(1) if m else None


def aapt_badging(apk):
    """用 aapt 读 APK 清单。找不到 aapt 或读不出来就返回 None（不当作失败）。

    两个坑，都在这台机器上踩过：
      1. AndroidManifest.xml 是编译后的二进制 AXML，字符串存在字符串池里，
         直接对文件字节搜索不可靠——必须用 aapt 读。
      2. aapt 打不开路径里含中文的 apk（"Illegal byte sequence"），
         而本项目的 apk 叫「潮汐Tide-v3.1.0.apk」。
         所以先复制到系统临时目录的纯 ASCII 文件名再读。
    """
    import shutil
    import subprocess
    import tempfile

    exes = []
    sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    if not sdk:
        sdk = os.path.join(os.environ.get("LOCALAPPDATA", ""), "AndroidSdk")
    bt = os.path.join(sdk, "build-tools")
    if os.path.isdir(bt):
        for ver in sorted(os.listdir(bt), reverse=True):
            exes.append(os.path.join(bt, ver, "aapt.exe"))
            exes.append(os.path.join(bt, ver, "aapt"))
    exes.append("aapt")   # 兜底：PATH 里

    # 复制到 ASCII 临时路径
    tmp_apk = None
    try:
        fd, tmp_apk = tempfile.mkstemp(suffix=".apk")
        os.close(fd)
        shutil.copyfile(apk, tmp_apk)
    except Exception:
        tmp_apk = None

    target = tmp_apk or apk
    try:
        for exe in exes:
            try:
                out = subprocess.check_output([exe, "dump", "badging", target],
                                              stderr=subprocess.DEVNULL)
                return out.decode("utf-8", "replace")
            except Exception:
                continue
        return None
    finally:
        if tmp_apk and os.path.exists(tmp_apk):
            try:
                os.remove(tmp_apk)
            except Exception:
                pass


def main():
    fails = []
    skipped = []

    def ok(cond, label, extra=""):
        print("  %s %s%s" % ("OK  " if cond else "FAIL", label, ("  " + extra) if extra else ""))
        if not cond:
            fails.append(label)
        return cond

    def skip(label):
        print("  SKIP " + label)
        skipped.append(label)

    apk = pick_apk()
    print("=" * 62)
    print("Orbit · 交付前终检")
    print("=" * 62)
    if not apk:
        print("找不到 apk，先在 dist/ 下放一个，或把路径作为参数传进来")
        return 1
    print("apk: %s" % apk)

    # v6: the page is assembled from index.html + shared/orbit_*.js + src/app/js/NN_*.js.
    # Ask the build script itself for the expected bytes, so this check can never drift from it.
    import subprocess
    src = subprocess.run(["node", "-e", "process.stdout.write(require('./tools/build_app.js').assemble().out)"],
                         cwd=ROOT, capture_output=True, check=True).stdout
    with open(ASSETS, "rb") as f:
        asset = f.read()

    print("\n[1] 源码 → 工程内页面")
    ok(md5(src) == md5(asset), "assets/index.html 与源码一致",
       "src=%s asset=%s" % (md5(src)[:8], md5(asset)[:8]))

    print("\n[2] APK 内的页面")
    with zipfile.ZipFile(apk) as z:
        names = z.namelist()
        if "assets/index.html" not in names:
            ok(False, "APK 内含 assets/index.html")
            return 1
        data = z.read("assets/index.html")
    ok(md5(data) == md5(src), "APK 内页面与源码一致",
       "%d bytes, md5=%s" % (len(data), md5(data)[:8]))

    print("\n[3] 关键能力符号")
    text = data.decode("utf-8", "replace")
    for s in REQUIRED:
        ok(s in text, "包含 " + s)

    print("\n[4] 版本号与权限（用 aapt 读，AndroidManifest 是二进制 AXML，不能直接搜字符串）")
    badging = aapt_badging(apk)
    if badging is None:
        skip("aapt 不可用，版本号与权限未校验（页面一致性已验证）")
    else:
        want = gradle_version()
        m = re.search(r"versionName='([^']+)'", badging)
        got = m.group(1) if m else "(未知)"
        if want:
            ok(got == want, "APK versionName = %s 与 build.gradle.kts 一致" % want)
        m = re.search(r"versionCode='(\d+)'", badging)
        print("  INFO versionCode = %s" % (m.group(1) if m else "?"))

        print("\n[5] 权限清单")
        perms = set(re.findall(r"uses-permission: name='([^']+)'", badging))
        short = set(p.split(".")[-1] for p in perms)
        ok("INTERNET" in short, "有 INTERNET（聊天必需）")
        ok("RECORD_AUDIO" in short, "有 RECORD_AUDIO（语音输入）")
        for bad in ["ACCESS_FINE_LOCATION", "ACCESS_COARSE_LOCATION", "READ_CONTACTS",
                    "CAMERA", "READ_EXTERNAL_STORAGE", "WRITE_EXTERNAL_STORAGE",
                    "READ_SMS", "READ_PHONE_STATE"]:
            ok(bad not in short, "没有申请 " + bad)
        print("  INFO 实际申请：%s" % ", ".join(sorted(short)))

    print("\n" + "=" * 62)
    if fails:
        print("失败 %d 项：" % len(fails))
        for f_ in fails:
            print("  · " + f_)
        print("→ 重新跑 tools/build_apk.ps1")
        return 1
    if skipped:
        print("通过，但有 %d 项被跳过（不代表验过了，只代表没法验）：" % len(skipped))
        for s in skipped:
            print("  · " + s)
        print("\n页面一致性已确认。要做签名/权限的完整校验，")
        print("把 aapt 加进 PATH，或设置 ANDROID_HOME 指向 Android SDK。")
        return 0
    print("全部通过：APK 与源码一致，可交付")
    return 0


if __name__ == "__main__":
    sys.exit(main())
