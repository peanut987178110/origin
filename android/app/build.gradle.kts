plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.tide.app"
    compileSdk = 34
    ndkVersion = "27.2.12479018"
    externalNativeBuild { cmake { path = file("src/main/cpp/CMakeLists.txt"); version = "3.22.1" } }
    // llama.cpp must be optimized even in debug APKs (see cpp/CMakeLists.txt)
    defaultConfig { externalNativeBuild { cmake { arguments += listOf("-DCMAKE_BUILD_TYPE=Release") } } }
    // index.html must be stored, not deflated: the app reads assets/index.html byte-for-byte
    // (version check, self-test) and tools/verify_apk.py compares the APK's copy by md5.
    androidResources { noCompress += listOf("gguf", "html") }

    defaultConfig {
        applicationId = "com.tide.app"
        ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
        minSdk = 24            // 覆盖绝大多数在用安卓机
        targetSdk = 34
        versionCode = 10
        versionName = "6.3.0"
        // 潮汐服务端地址：构建时注入，用户不需要配置。
        // 本地联调默认 10.0.2.2（模拟器里指向电脑）；正式包用 -PtideServer=https://api.example.com 覆盖。
        val tideServer = (project.findProperty("tideServer") as String?) ?: "http://10.0.2.2:8787"
        buildConfigField("String", "TIDE_SERVER", "\"" + tideServer + "\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { buildConfig = true }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    // OnBackPressedCallback 来自 activity-ktx，显式声明避免依赖传递带来的版本漂移
    implementation("androidx.activity:activity-ktx:1.9.0")
    implementation("androidx.webkit:webkit:1.11.0")
    // API Key 加密存储（Android Keystore）
    implementation("androidx.security:security-crypto:1.0.0")

    // 单元测试：在电脑上直接测 LlmClient（流式解析 / 鉴权 / 错误处理）
    // org.json 需要真实实现，否则会被 android.jar 的空壳替代（"Method ... not mocked"）
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
