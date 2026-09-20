// api/index.js
// Serverless AI Router Proxy — auto-fallback sequential antar provider
// Kompatibel dengan format OpenAI Chat Completion (SillyTavern / Saucepan.ai dll)
// VERSI: 20 Sep 2026 — safety_settings fix, Groq gpt-oss, Cerebras dihapus, Mistral ditambahkan

const axios = require("axios");
const https = require("https");

// HTTP Keep-Alive agent — reuse koneksi TCP/TLS ke provider yang sama
// pada warm invocation, mengurangi overhead handshake berulang.
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

// =========================================================================
// LOGGING HELPER — semua log ditulis dalam format JSON satu baris agar
// mudah dibaca / difilter di Vercel Logs (Vercel otomatis menangkap
// console.log/console.error dari serverless function).
// =========================================================================
function logAttempt(event) {
  console.log(JSON.stringify({
    tag: "GATEWAY_ATTEMPT",
    timestamp: new Date().toISOString(),
    ...event,
  }));
}

function logFinal(event) {
  console.log(JSON.stringify({
    tag: "GATEWAY_FINAL",
    timestamp: new Date().toISOString(),
    ...event,
  }));
}

// =========================================================================
// 1. PLACEHOLDER API KEY — GANTI DENGAN KEY ASLI ANDA
//    Bisa diisi langsung di sini, ATAU (lebih aman) diisi lewat
//    Environment Variables di dashboard Vercel dengan nama yang sama.
// =========================================================================
const KEY_GEMINI_1   = process.env.KEY_GEMINI_1   || "ISI_API_KEY_GEMINI_1_DISINI";
const KEY_GEMINI_2   = process.env.KEY_GEMINI_2   || "ISI_API_KEY_GEMINI_2_DISINI";
const KEY_GROQ       = process.env.KEY_GROQ       || "ISI_API_KEY_GROQ_DISINI";
const KEY_MISTRAL    = process.env.KEY_MISTRAL    || "ISI_API_KEY_MISTRAL_DISINI";
const KEY_OPENROUTER = process.env.KEY_OPENROUTER || "ISI_API_KEY_OPENROUTER_DISINI";

// =========================================================================
// 2. DAFTAR PROVIDER — diproses berurutan (sequential fallback)
//    Jika provider di urutan atas gagal (429 / error / limit), otomatis
//    lanjut ke provider berikutnya tanpa memutus koneksi ke client.
// =========================================================================
const GEMINI_MODEL_TIERS = [
  "gemini-3.5-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.6-flash",
];

const PROVIDERS = [
  // --- Gemini Key 1: dicoba dari model paling hemat ke paling berat ---
  ...GEMINI_MODEL_TIERS.map((model) => ({
    name: `Gemini (Key 1 - ${model})`,
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKey: KEY_GEMINI_1,
    model,
  })),
  // --- Gemini Key 2: cadangan, urutan model sama seperti Key 1 ---
  ...GEMINI_MODEL_TIERS.map((model) => ({
    name: `Gemini (Key 2 - ${model})`,
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKey: KEY_GEMINI_2,
    model,
  })),
  // Groq: llama-3.1-8b-instant dan llama-3.3-70b-versatile resmi
  // decommissioned 16 Agustus 2026. Pengganti resmi:
  // openai/gpt-oss-20b (utama) dan openai/gpt-oss-120b (cadangan).
  {
    name: "Groq",
    baseURL: "https://api.groq.com/openai/v1",
    apiKey: KEY_GROQ,
    model: "openai/gpt-oss-20b",
  },
  {
    name: "Groq (gpt-oss-120b)",
    baseURL: "https://api.groq.com/openai/v1",
    apiKey: KEY_GROQ,
    model: "openai/gpt-oss-120b",
  },
  // Cerebras DIHAPUS: tidak lagi menyediakan free tier permanen berbasis
  // rate limit — hanya $5 kredit trial sekali yang kadaluarsa 30 hari.
  //
  // --- OpenRouter: model spesifik dicoba dulu, openrouter/free di posisi
  //     akhir (di bawah, setelah Mistral) sebagai jaring pengaman utama.
  ...[
    "meta-llama/llama-3.3-70b-instruct:free",
    "google/gemma-4-26b-a4b-it:free",
  ].map((model) => ({
    name: `OpenRouter (${model})`,
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: KEY_OPENROUTER,
    model,
  })),
  // Mistral AI (La Plateforme) — free "Experiment" tier, endpoint OpenAI-
  // compatible (base URL https://api.mistral.ai/v1). Butuh verifikasi
  // nomor telepon + opt-in data training saat pertama daftar akun;
  // rate limit ~1 req/detik, untuk evaluasi bukan produksi volume tinggi.
  {
    name: "Mistral (mistral-small-latest)",
    baseURL: "https://api.mistral.ai/v1",
    apiKey: KEY_MISTRAL,
    model: "mistral-small-latest",
  },
  // OpenRouter jaring pengaman utama — auto-pilih model gratis yang masih
  // aktif, percobaan terakhir sebelum gateway benar-benar menyerah.
  {
    name: "OpenRouter (openrouter/free)",
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: KEY_OPENROUTER,
    model: "openrouter/free",
  },
];

// =========================================================================
// 2b. RESOLVER MODEL SPESIFIK DARI CLIENT (mis. via command /set-model)
// =========================================================================
const PROVIDER_BASE = {
  gemini1: { name: "Gemini (Key 1 - custom)", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: KEY_GEMINI_1 },
  gemini2: { name: "Gemini (Key 2 - custom)", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: KEY_GEMINI_2 },
  groq: { name: "Groq (custom)", baseURL: "https://api.groq.com/openai/v1", apiKey: KEY_GROQ },
  mistral: { name: "Mistral (custom)", baseURL: "https://api.mistral.ai/v1", apiKey: KEY_MISTRAL },
  openrouter: { name: "OpenRouter (custom)", baseURL: "https://openrouter.ai/api/v1", apiKey: KEY_OPENROUTER },
};

const MODEL_MAPPING = {
  "llama-3.1-8b-instant": "groq",
  "llama-3.2-90b-vision-preview": "groq",
  "llama-3.2-11b-vision-preview": "groq",
  "mixtral-8x7b-32768": "groq",
  "gemma2-9b-it": "groq",
  "mistral-small-latest": "mistral",
  "mistral-large-latest": "mistral",
  "open-mistral-7b": "mistral",
  "open-mixtral-8x7b": "mistral",
};

function detectProviderKeyFromPattern(model) {
  const m = model.toLowerCase();
  if (m.includes("gemini")) return "gemini1";
  if (m.includes("/")) return "openrouter";
  if (m.includes("mistral") || m.includes("mixtral")) return "mistral";
  if (m.includes("llama") || m.includes("gemma")) return "groq";
  return null;
}

function resolveCustomProvider(requestedModel) {
  if (!requestedModel || requestedModel === "(tidak disebutkan client)") return null;
  const mappedKey = MODEL_MAPPING[requestedModel] || detectProviderKeyFromPattern(requestedModel);
  if (!mappedKey || !PROVIDER_BASE[mappedKey]) return null;
  const base = PROVIDER_BASE[mappedKey];
  return {
    name: `${base.name} [diminta client: ${requestedModel}]`,
    baseURL: base.baseURL,
    apiKey: base.apiKey,
    model: requestedModel,
  };
}

// =========================================================================
// 3. HANDLER UTAMA
// =========================================================================
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method === "GET" && req.url.includes("/v1/models")) {
    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate");
    return res.status(200).json({
      object: "list",
      data: PROVIDERS.map((p) => ({
        id: p.model,
        object: "model",
        owned_by: p.name,
      })),
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Gunakan POST ke /v1/chat/completions" });
  }

  const clientBody = req.body || {};
  const isStream = clientBody.stream === true;
  const requestedModel = clientBody.model || "(tidak disebutkan client)";
  const basePayload = { ...clientBody };

  let lastError = null;
  const attemptLog = [];

  const customProvider = resolveCustomProvider(requestedModel);
  const executionOrder = customProvider ? [customProvider, ...PROVIDERS] : PROVIDERS;

  if (customProvider) {
    logAttempt({
      requestedModel,
      provider: customProvider.name,
      model: customProvider.model,
      status: "reordered",
      detail: "Model diminta client cocok dengan provider ini, dicoba lebih dulu.",
    });
  }

  // =======================================================================
  // 4. LOOP SEQUENTIAL TRY-CATCH — coba tiap provider satu per satu
  // =======================================================================
  for (const provider of executionOrder) {
    if (!provider.apiKey || provider.apiKey.startsWith("ISI_API_KEY")) {
      lastError = new Error(`${provider.name}: API key belum diisi, dilewati.`);
      logAttempt({
        requestedModel,
        provider: provider.name,
        model: provider.model,
        status: "skipped",
        detail: "API key belum diisi",
      });
      attemptLog.push({ provider: provider.name, model: provider.model, status: "skipped" });
      continue;
    }

    let payload = {
      ...basePayload,
      model: provider.model,
    };

    // Bersihkan sisa field lama yang mungkin dikirim client secara keliru
    delete payload.safetySettings;
    delete payload.safety_settings;

    const isGemini = provider.baseURL.includes("generativelanguage.googleapis.com");
    if (isGemini) {
      // PENTING: endpoint OpenAI-compatible Gemini (v1beta/openai) TIDAK
      // menerima safety_settings di top-level payload — harus dibungkus
      // di dalam extra_body.google, sesuai dokumentasi resmi Google Cloud:
      // docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/call-gemini-using-openai-library
      payload.extra_body = {
        ...(basePayload.extra_body || {}),
        google: {
          ...(basePayload.extra_body?.google || {}),
          safety_settings: basePayload.extra_body?.google?.safety_settings || [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" },
          ],
        },
      };
    } else {
      delete payload.extra_body;
    }

    try {
      if (isStream) {
        // -----------------------------------------------------------------
        // MODE STREAMING: pipe langsung SSE dari provider ke client
        // -----------------------------------------------------------------
        const upstream = await axios({
          method: "post",
          url: `${provider.baseURL}/chat/completions`,
          data: payload,
          headers: {
            Authorization: `Bearer ${provider.apiKey}`,
            "Content-Type": "application/json",
          },
          httpsAgent: keepAliveAgent,
          responseType: "stream",
          timeout: 60000,
          validateStatus: (status) => status < 500,
        });

        if (upstream.status === 429 || upstream.status >= 400) {
          let errBody = "";
          await new Promise((resolve) => {
            upstream.data.on("data", (chunk) => (errBody += chunk));
            upstream.data.on("end", resolve);
            upstream.data.on("error", resolve);
          });
          lastError = new Error(`${provider.name} gagal (HTTP ${upstream.status}): ${errBody}`);
          logAttempt({
            requestedModel,
            provider: provider.name,
            model: provider.model,
            status: "failed",
            httpStatus: upstream.status,
            detail: errBody.slice(0, 500),
          });
          attemptLog.push({ provider: provider.name, model: provider.model, status: "failed", httpStatus: upstream.status });
          continue;
        }

        logAttempt({
          requestedModel,
          provider: provider.name,
          model: provider.model,
          status: "success",
        });
        attemptLog.push({ provider: provider.name, model: provider.model, status: "success" });
        logFinal({
          requestedModel,
          finalProvider: provider.name,
          finalModel: provider.model,
          fallbackHappened: attemptLog.length > 1,
          totalAttempts: attemptLog.length,
          attempts: attemptLog,
        });

        res.status(200);
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Gateway-Requested-Model", requestedModel);
        res.setHeader("X-Gateway-Final-Provider", provider.name);
        res.setHeader("X-Gateway-Final-Model", provider.model);
        res.setHeader("X-Gateway-Fallback-Happened", String(attemptLog.length > 1));

        upstream.data.pipe(res);

        await new Promise((resolve, reject) => {
          upstream.data.on("end", resolve);
          upstream.data.on("error", reject);
          res.on("close", resolve);
        });

        return;
      } else {
        // -----------------------------------------------------------------
        // MODE NON-STREAMING
        // -----------------------------------------------------------------
        const response = await axios.post(
          `${provider.baseURL}/chat/completions`,
          payload,
          {
            headers: {
              Authorization: `Bearer ${provider.apiKey}`,
              "Content-Type": "application/json",
            },
            httpsAgent: keepAliveAgent,
            timeout: 60000,
          }
        );

        logAttempt({
          requestedModel,
          provider: provider.name,
          model: provider.model,
          status: "success",
        });
        attemptLog.push({ provider: provider.name, model: provider.model, status: "success" });
        logFinal({
          requestedModel,
          finalProvider: provider.name,
          finalModel: provider.model,
          fallbackHappened: attemptLog.length > 1,
          totalAttempts: attemptLog.length,
          attempts: attemptLog,
        });

        res.setHeader("X-Gateway-Requested-Model", requestedModel);
        res.setHeader("X-Gateway-Final-Provider", provider.name);
        res.setHeader("X-Gateway-Final-Model", provider.model);
        res.setHeader("X-Gateway-Fallback-Happened", String(attemptLog.length > 1));

        return res.status(200).json({
          ...response.data,
          _gateway_meta: {
            requested_model: requestedModel,
            final_provider: provider.name,
            final_model: provider.model,
            fallback_happened: attemptLog.length > 1,
            attempts: attemptLog,
          },
        });
      }
    } catch (err) {
      const status = err.response?.status;
      const detail = err.response?.data
        ? JSON.stringify(err.response.data)
        : err.message;

      lastError = new Error(`${provider.name} gagal (${status || "network error"}): ${detail}`);

      logAttempt({
        requestedModel,
        provider: provider.name,
        model: provider.model,
        status: "failed",
        httpStatus: status || null,
        detail: String(detail).slice(0, 500),
      });
      attemptLog.push({ provider: provider.name, model: provider.model, status: "failed", httpStatus: status || null });

      continue;
    }
  }

  // =======================================================================
  // 5. SEMUA PROVIDER GAGAL
  // =======================================================================
  logFinal({
    requestedModel,
    finalProvider: null,
    finalModel: null,
    fallbackHappened: attemptLog.length > 1,
    totalAttempts: attemptLog.length,
    attempts: attemptLog,
    allFailed: true,
  });

  return res.status(502).json({
    error: {
      message: "Semua provider AI gagal merespons. Cek API key / kuota masing-masing provider.",
      last_error: lastError ? lastError.message : "Tidak diketahui",
    },
    _gateway_meta: {
      requested_model: requestedModel,
      final_provider: null,
      final_model: null,
      fallback_happened: attemptLog.length > 1,
      attempts: attemptLog,
    },
  });
};

module.exports.config = {
  api: {
    bodyParser: true,
  },
};
