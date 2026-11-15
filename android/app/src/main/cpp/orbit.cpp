// orbit.cpp · Orbit on-device inference engine (llama.cpp)
// -----------------------------------------------------------------------------
// Why this file replaces tide.cpp:
//   tide.cpp reloaded a fresh llama_context for every message, re-decoded the
//   whole prompt every turn, used greedy sampling, and only returned text after
//   generation finished. On a phone that meant 10–30 s of "typing…" with nothing
//   on screen, and repetitive replies.
//
// This engine:
//   · loads the model once and keeps ONE context alive for the whole session
//   · reuses the KV cache: only the tokens that differ from the previous turn are
//     decoded (system prompt + earlier history are already cached)
//   · streams UTF-8-safe text chunks back to Kotlin as tokens are produced
//   · supports stop() from another thread
//   · uses top-k / top-p / temperature / repetition penalty instead of greedy
// -----------------------------------------------------------------------------
#include <jni.h>
#include <android/log.h>
#include "llama.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <mutex>
#include <string>
#include <vector>

#define LOG_TAG "OrbitEngine"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)

namespace {

std::mutex g_lock;                       // one generation at a time
llama_model *g_model = nullptr;
llama_context *g_ctx = nullptr;
std::vector<llama_token> g_cached;       // tokens currently in the KV cache (seq 0)
std::atomic<bool> g_stop{false};
int g_n_ctx = 4096;

using clock_t_ = std::chrono::steady_clock;
long ms_since(clock_t_::time_point t) {
    return (long)std::chrono::duration_cast<std::chrono::milliseconds>(clock_t_::now() - t).count();
}

std::string bytes_to_string(JNIEnv *env, jbyteArray arr) {
    if (!arr) return {};
    jsize n = env->GetArrayLength(arr);
    std::string s((size_t)n, '\0');
    if (n > 0) env->GetByteArrayRegion(arr, 0, n, reinterpret_cast<jbyte *>(&s[0]));
    return s;
}

jbyteArray string_to_bytes(JNIEnv *env, const std::string &s) {
    jbyteArray out = env->NewByteArray((jsize)s.size());
    if (!s.empty()) env->SetByteArrayRegion(out, 0, (jsize)s.size(), reinterpret_cast<const jbyte *>(s.data()));
    return out;
}

// Length of the longest prefix of `buf` that ends on a complete UTF-8 character.
size_t utf8_complete_prefix(const std::string &buf) {
    size_t n = buf.size();
    if (n == 0) return 0;
    // walk back over at most 3 continuation bytes to find the lead byte
    size_t i = n;
    int back = 0;
    while (i > 0 && back < 4) {
        unsigned char c = (unsigned char)buf[i - 1];
        if ((c & 0xC0) != 0x80) {                // lead byte or ASCII
            size_t need = (c < 0x80) ? 1 : ((c >> 5) == 0x6) ? 2 : ((c >> 4) == 0xE) ? 3 : ((c >> 3) == 0x1E) ? 4 : 1;
            size_t have = n - (i - 1);
            return have >= need ? n : (i - 1);
        }
        --i; ++back;
    }
    return n;
}

void throw_java(JNIEnv *env, const char *msg) {
    env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), msg);
}

}  // namespace

extern "C" {

// Load the GGUF model and create the persistent context.
JNIEXPORT void JNICALL
Java_com_tide_app_OrbitEngine_nativeLoad(JNIEnv *env, jobject, jstring jpath, jint n_ctx, jint n_threads, jint n_threads_batch) {
    std::lock_guard<std::mutex> guard(g_lock);
    if (g_model && g_ctx) return;
    const char *p = env->GetStringUTFChars(jpath, nullptr);
    std::string path(p);
    env->ReleaseStringUTFChars(jpath, p);

    llama_backend_init();
    auto mp = llama_model_default_params();
    mp.n_gpu_layers = 0;
    mp.use_mmap = true;
    g_model = llama_model_load_from_file(path.c_str(), mp);
    if (!g_model) { throw_java(env, "model_load_failed"); return; }

    auto cp = llama_context_default_params();
    g_n_ctx = n_ctx > 512 ? n_ctx : 4096;
    cp.n_ctx = (uint32_t)g_n_ctx;
    cp.n_batch = 512;
    cp.n_ubatch = 512;
    // v6.3: CPU only. llama.cpp otherwise offloads layers to a GPU/metal backend when the build
    // Said explicitly so a future backend change cannot silently split the model.
    cp.n_threads = n_threads > 0 ? n_threads : 4;
    cp.n_threads_batch = n_threads_batch > 0 ? n_threads_batch : cp.n_threads;
    g_ctx = llama_init_from_model(g_model, cp);
    if (!g_ctx) {
        llama_model_free(g_model); g_model = nullptr;
        throw_java(env, "context_init_failed");
        return;
    }
    g_cached.clear();
    LOGI("loaded %s n_ctx=%d threads=%d/%d", path.c_str(), g_n_ctx, cp.n_threads, cp.n_threads_batch);
}

JNIEXPORT void JNICALL
Java_com_tide_app_OrbitEngine_nativeStop(JNIEnv *, jobject) {
    g_stop.store(true);
}

JNIEXPORT void JNICALL
Java_com_tide_app_OrbitEngine_nativeFree(JNIEnv *, jobject) {
    g_stop.store(true);
    std::lock_guard<std::mutex> guard(g_lock);
    if (g_ctx) { llama_free(g_ctx); g_ctx = nullptr; }
    if (g_model) { llama_model_free(g_model); g_model = nullptr; }
    g_cached.clear();
    llama_backend_free();
}

// Generate a reply.
//   roles / contents : parallel arrays of UTF-8 byte arrays (system, user, assistant, …)
//   prefillOnly      : true = just warm the KV cache with this prompt (no assistant turn, no output)
//   cb               : object with  void onChunk(byte[] utf8)
// Returns stats JSON (UTF-8 bytes).
JNIEXPORT jbyteArray JNICALL
Java_com_tide_app_OrbitEngine_nativeGenerate(JNIEnv *env, jobject, jobjectArray roles, jobjectArray contents,
                                             jint max_tokens, jfloat temp, jfloat top_p, jint seed,
                                             jboolean prefill_only, jobject cb) {
    std::lock_guard<std::mutex> guard(g_lock);
    g_stop.store(false);
    if (!g_model || !g_ctx) { throw_java(env, "engine_not_ready"); return nullptr; }

    auto t_start = clock_t_::now();
    const llama_vocab *vocab = llama_model_get_vocab(g_model);

    // 1) Build the chat prompt with the model's own template.
    jsize n_msg = env->GetArrayLength(roles);
    std::vector<std::string> r(n_msg), c(n_msg);
    std::vector<llama_chat_message> msgs(n_msg);
    for (jsize i = 0; i < n_msg; ++i) {
        auto rb = (jbyteArray)env->GetObjectArrayElement(roles, i);
        auto cb_ = (jbyteArray)env->GetObjectArrayElement(contents, i);
        r[i] = bytes_to_string(env, rb);
        c[i] = bytes_to_string(env, cb_);
        env->DeleteLocalRef(rb); env->DeleteLocalRef(cb_);
    }
    for (jsize i = 0; i < n_msg; ++i) msgs[i] = { r[i].c_str(), c[i].c_str() };

    const char *tmpl = llama_model_chat_template(g_model, nullptr);
    bool add_ass = !prefill_only;
    std::string prompt;
    {
        int need = llama_chat_apply_template(tmpl, msgs.data(), msgs.size(), add_ass, nullptr, 0);
        if (need < 0) { throw_java(env, "template_failed"); return nullptr; }
        prompt.resize((size_t)need + 1);
        int got = llama_chat_apply_template(tmpl, msgs.data(), msgs.size(), add_ass, &prompt[0], (int32_t)prompt.size());
        prompt.resize((size_t)std::max(0, got));
    }

    // 2) Tokenize. Special tokens in the template (<|im_start|> …) must be parsed.
    int n_tok = -llama_tokenize(vocab, prompt.data(), (int32_t)prompt.size(), nullptr, 0, true, true);
    if (n_tok <= 0) { throw_java(env, "tokenize_failed"); return nullptr; }
    std::vector<llama_token> tokens((size_t)n_tok);
    llama_tokenize(vocab, prompt.data(), (int32_t)prompt.size(), tokens.data(), n_tok, true, true);

    int reserve = prefill_only ? 0 : std::max(32, (int)max_tokens);
    // v6.3: a long conversation must not die with "context_full". The prompt is rebuilt every
    // turn as [system + examples] [recent history] [new user turn], so the oldest turns can go:
    // the system prefix (and its KV cache) stays intact. Cut at a turn boundary — the start
    // token of the next turn (Qwen: <|im_start|> = 151644) — instead of mid-sentence.
    while (n_tok + reserve >= g_n_ctx) {
        size_t cut = 0;
        const size_t from = 64, to = tokens.size() > 160 ? tokens.size() - 160 : 0;
        for (size_t i = from; i < to; ++i) { if (tokens[i] == 151644 && i + 1 < tokens.size()) { cut = i; break; } }
        if (cut == 0) cut = tokens.size() / 4;                       // no marker found: drop a quarter
        if (tokens.size() - cut < 96) break;                         // nothing left worth sending
        tokens.erase(tokens.begin() + 1, tokens.begin() + (long)cut);  // keep breathing-room token at 0
        n_tok = (int)tokens.size();
    }
    if (n_tok + reserve >= g_n_ctx) { throw_java(env, "context_full"); return nullptr; }

    // 3) KV cache reuse: keep the longest common prefix, drop the rest.
    size_t common = 0;
    while (common < g_cached.size() && common < tokens.size() && g_cached[common] == tokens[common]) ++common;
    if (common == tokens.size() && common > 0) --common;   // must decode >=1 token to get fresh logits
    llama_kv_self_seq_rm(g_ctx, 0, (llama_pos)common, -1);
    g_cached.resize(common);
    const int reused = (int)common;

    // 4) Prefill the new part.
    auto t_prefill = clock_t_::now();
    const int n_batch = 512;
    for (size_t i = common; i < tokens.size(); i += n_batch) {
        int n = (int)std::min((size_t)n_batch, tokens.size() - i);
        llama_batch batch = llama_batch_get_one(tokens.data() + i, n);
        if (llama_decode(g_ctx, batch) != 0) {
            llama_kv_self_seq_rm(g_ctx, 0, -1, -1); g_cached.clear();
            throw_java(env, "decode_failed");
            return nullptr;
        }
        g_cached.insert(g_cached.end(), tokens.begin() + (long)i, tokens.begin() + (long)i + n);
        if (g_stop.load()) break;
    }
    long prefill_ms = ms_since(t_prefill);

    // 5) Sample.
    int generated = 0;
    long gen_ms = 0;
    bool stopped = false;
    if (!prefill_only && !g_stop.load()) {
        jclass cls = env->GetObjectClass(cb);
        jmethodID on_chunk = env->GetMethodID(cls, "onChunk", "([B)V");

        auto sp = llama_sampler_chain_default_params();
        llama_sampler *smpl = llama_sampler_chain_init(sp);
        llama_sampler_chain_add(smpl, llama_sampler_init_penalties(64, 1.10f, 0.0f, 0.0f));
        llama_sampler_chain_add(smpl, llama_sampler_init_top_k(40));
        llama_sampler_chain_add(smpl, llama_sampler_init_top_p(top_p > 0 ? top_p : 0.9f, 1));
        llama_sampler_chain_add(smpl, llama_sampler_init_temp(temp > 0 ? temp : 0.7f));
        llama_sampler_chain_add(smpl, llama_sampler_init_dist(seed >= 0 ? (uint32_t)seed : LLAMA_DEFAULT_SEED));

        auto t_gen = clock_t_::now();
        std::string pending;
        for (; generated < max_tokens; ++generated) {
            if (g_stop.load()) { stopped = true; break; }
            llama_token t = llama_sampler_sample(smpl, g_ctx, -1);
            if (llama_vocab_is_eog(vocab, t)) break;
            char buf[256];
            int k = llama_token_to_piece(vocab, t, buf, sizeof(buf), 0, false);
            if (k > 0) pending.append(buf, (size_t)k);
            size_t ok = utf8_complete_prefix(pending);
            if (ok > 0) {
                jbyteArray chunk = string_to_bytes(env, pending.substr(0, ok));
                env->CallVoidMethod(cb, on_chunk, chunk);
                env->DeleteLocalRef(chunk);
                pending.erase(0, ok);
            }
            llama_batch batch = llama_batch_get_one(&t, 1);
            if (llama_decode(g_ctx, batch) != 0) break;
            g_cached.push_back(t);
            if ((int)g_cached.size() >= g_n_ctx - 4) break;
        }
        if (!pending.empty()) {
            jbyteArray chunk = string_to_bytes(env, pending);
            env->CallVoidMethod(cb, on_chunk, chunk);
            env->DeleteLocalRef(chunk);
        }
        gen_ms = ms_since(t_gen);
        llama_sampler_free(smpl);
    }

    char stats[256];
    snprintf(stats, sizeof(stats),
             "{\"promptTokens\":%d,\"reusedTokens\":%d,\"prefillMs\":%ld,\"genTokens\":%d,\"genMs\":%ld,\"totalMs\":%ld,\"stopped\":%s}",
             n_tok, reused, prefill_ms, generated, gen_ms, ms_since(t_start), stopped ? "true" : "false");
    return string_to_bytes(env, stats);
}

}  // extern "C"
