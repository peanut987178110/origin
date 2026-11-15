cmake_minimum_required(VERSION 3.22.1)
project(orbit_local)
set(CMAKE_CXX_STANDARD 17)

# ---------------------------------------------------------------------------
# Always build the inference engine optimized.
# Android Gradle builds debug APKs with CMAKE_BUILD_TYPE=Debug (-O0). For llama.cpp
# that is roughly an order of magnitude slower — one of the reasons v5 felt stuck on
# "typing…". The app's own JNI glue is tiny, so we force Release for everything.
# ---------------------------------------------------------------------------
set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
set(CMAKE_C_FLAGS_DEBUG "-O3 -DNDEBUG" CACHE STRING "" FORCE)
set(CMAKE_CXX_FLAGS_DEBUG "-O3 -DNDEBUG" CACHE STRING "" FORCE)

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_COMMON OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(LLAMA_CURL OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)

# ---------------------------------------------------------------------------
# SIMD per ABI (v5 had none enabled → plain scalar code).
#   arm64-v8a : ARMv8.2-A + dotprod. Present on essentially all phones since ~2019
#               (Cortex-A55/A75 and newer). OrbitEngine.kt checks /proc/cpuinfo for
#               "asimddp" before loading, and shows "device not supported" instead of
#               crashing on older chips.
#   x86_64    : AVX2/FMA/F16C — the Android emulator on any modern PC exposes these.
# ---------------------------------------------------------------------------
if (ANDROID_ABI STREQUAL "arm64-v8a")
    set(GGML_CPU_ARM_ARCH "armv8.2-a+dotprod" CACHE STRING "" FORCE)
elseif (ANDROID_ABI STREQUAL "x86_64")
    set(GGML_AVX ON CACHE BOOL "" FORCE)
    set(GGML_AVX2 ON CACHE BOOL "" FORCE)
    set(GGML_FMA ON CACHE BOOL "" FORCE)
    set(GGML_F16C ON CACHE BOOL "" FORCE)
endif()

add_subdirectory(../../../../llama.cpp llama-build)
add_library(orbit_local SHARED orbit.cpp)
target_compile_options(orbit_local PRIVATE -O3)
target_link_libraries(orbit_local llama android log)
