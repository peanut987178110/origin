# 潮汐 Tide · APK 一键构建
#
# 用法（项目根目录）：
#     powershell -ExecutionPolicy Bypass -File tools\build_apk.ps1
#
# 做三件事：同步页面 → 单元测试 + 编译 → 复制到 dist\Orbit-v{版本}.apk
# JDK / Android SDK / Gradle 都装在用户目录（不需要管理员权限）。

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$env:JAVA_HOME        = "$env:LOCALAPPDATA\Programs\Microsoft\jdk-17.0.10.7-hotspot"
$env:ANDROID_HOME     = "$env:LOCALAPPDATA\AndroidSdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:PATH = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:PATH"
$gradle = "$env:LOCALAPPDATA\gradle-8.7\bin\gradle.bat"

$missing = @()
if (-not (Test-Path "$env:JAVA_HOME\bin\java.exe"))            { $missing += "JDK 17：$env:JAVA_HOME" }
if (-not (Test-Path "$env:ANDROID_HOME\platforms\android-34")) { $missing += "Android SDK Platform 34" }
if (-not (Test-Path $gradle))                                  { $missing += "Gradle 8.7：$gradle" }
if ($missing.Count) {
    $missing | ForEach-Object { Write-Host "[x] 缺少 $_" -ForegroundColor Red }
    Write-Host "安装方法见 docs/17_安卓打包指南.md" -ForegroundColor Yellow
    exit 1
}

$root = Split-Path $PSScriptRoot -Parent

Write-Host "[1/4] 同步页面到 Android 工程 ..." -ForegroundColor Cyan
Push-Location $root
node tools\build_app.js | Out-Null
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { Write-Host "[x] build_app.js 失败" -ForegroundColor Red; exit 1 }

# 项目路径含中文：AGP 会拒绝构建，单元测试 JVM 的类路径也会损坏（ClassNotFoundException）。
# 解决：建一个纯英文路径的目录联接（junction），指向同一个 android 目录，不复制文件。
$ascii = "C:\tide-android"
if (-not (Test-Path $ascii)) { cmd /c mklink /J $ascii "$root\android" | Out-Null }

Write-Host "[2/4] 单元测试 + 编译 APK ..." -ForegroundColor Cyan
Push-Location $ascii
$ErrorActionPreference = "Continue"
$out = & $gradle testDebugUnitTest assembleDebug --no-daemon --console=plain 2>&1
$code = $LASTEXITCODE
$ErrorActionPreference = "Stop"
Pop-Location
if ($code -ne 0) {
    Write-Host "[x] 构建失败：" -ForegroundColor Red
    $out | Select-String -Pattern "^e:|FAILED|What went wrong|AAPT|error" | Select-Object -First 30
    exit $code
}

$apk = "$ascii\app\build\outputs\apk\debug\app-debug.apk"
if (-not (Test-Path $apk)) { Write-Host "[x] 构建结束但没找到 APK" -ForegroundColor Red; exit 1 }

$ver = (Select-String -Path "$root\android\app\build.gradle.kts" -Pattern 'versionName = "([^"]+)"').Matches[0].Groups[1].Value
$dist = "$root\dist"
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$named = "$dist\Orbit-v$ver.apk"
Copy-Item $apk $named -Force

$tests = 0
Get-ChildItem "$ascii\app\build\test-results\testDebugUnitTest\*.xml" -ErrorAction SilentlyContinue | ForEach-Object {
    $tests += [int]([xml](Get-Content $_.FullName -Raw -Encoding UTF8)).testsuite.tests
}

Write-Host "`n[3/4] 校验产物（直接从 apk 里解出页面比对源码）..." -ForegroundColor Cyan
$env:PYTHONIOENCODING = "utf-8"
$verify = & python "$root\tools\verify_apk.py" $named 2>&1
$vcode = $LASTEXITCODE
if ($vcode -ne 0) {
    Write-Host "[x] 产物校验失败：" -ForegroundColor Red
    $verify | ForEach-Object { Write-Host "    $_" }
    exit $vcode
}

Write-Host "`n[4/4] 构建成功" -ForegroundColor Green
Write-Host "  单元测试：$tests 项通过"
Write-Host "  安装包：$named" -ForegroundColor Green
Write-Host ("  大小：" + [math]::Round((Get-Item $named).Length / 1MB, 2) + " MB")
Write-Host "  安装：把 apk 发到手机（微信/网盘），点击安装，允许「安装未知应用」" -ForegroundColor Gray
