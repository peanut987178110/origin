# 潮汐 Tide · 混淆规则
# release 版当前未开启 minify，这份留着将来用。
# 原则：WebView 里的页面逻辑全在 assets/index.html 中，
# 不依赖任何通过反射调用的 Java 类，所以这里可以很激进。

-keep class com.tide.app.MainActivity { *; }
-keepattributes JavascriptInterface
