// api/index.js
// Serverless AI Router Proxy — auto-fallback sequential antar provider
// Kompatibel dengan format OpenAI Chat Completion (SillyTavern / Saucepan.ai dll)

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
  // event: { requestedModel, provider, model, status: "success"|"failed"|"skipped", detail, httpStatus }
  console.log(JSON.stringify({
    tag: "GATEWAY_ATTEMPT",
    timestamp: new Date().toISOString(),
    ...event,
  }));
}

function logFinal(event) {
  // event: { requestedModel, finalProvider, finalModel, fallbackHappened, totalAttempts }
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
const KEY_CEREBRAS   = process.env.KEY_CEREBRAS   || "ISI_API_KEY_CEREBRAS_DISINI";
const KEY_OPENROUTER = process.env.KEY_OPENROUTER || "ISI_API_KEY_OPENROUTER_DISINI";

// =========================================================================
// 2. DAFTAR PROVIDER — diproses berurutan (sequential fallback)
//    Jika provider di urutan atas gagal (429 / error / limit), otomatis
//    lanjut ke provider berikutnya tanpa memutus koneksi ke client.
// =========================================================================
// Urutan model Gemini per key: paling hemat token dulu (flash-lite),
// baru naik ke flash biasa, dan 3.6-flash paling terakhir karena
// dirancang untuk beban berat/agentic (boros token untuk sekadar roleplay santai).
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
  {
    name: "Groq",
    baseURL: "https://api.groq.com/openai/v1",
    apiKey: KEY_GROQ,
    model: "llama-3.3-70b-versatile",
  },
  {
    name: "Cerebras",
    baseURL: "https://api.cerebras.ai/v1",
    apiKey: KEY_CEREBRAS,
    model: "llama3.3-70b",
  },
  // --- OpenRouter: beberapa model :free dicoba berurutan, ditutup dengan
  //     "openrouter/free" (router otomatis bawaan OpenRouter yang memilih
  //     sendiri model gratis mana pun yang sedang aktif) sebagai jaring
  //     pengaman paling akhir. Roster model gratis di OpenRouter sering
  //     berubah/di-delist, jadi tier terakhir ini penting agar proxy tidak
  //     ikut mati saat satu model spesifik hilang dari katalog.
  ...[
    "cognitivecomputations/dolphin-mistral-24b-venice-edition:free", // uncensored, cocok untuk roleplay
    "google/gemma-4-26b-a4b-it:free",                                // MoE, konteks besar, terverifikasi hidup
    "openai/gpt-oss-20b:free",                                       // ringan, reasoning OpenAI open-weight
    "meta-llama/llama-3.3-70b-instruct:free",                        // model lama yang sudah teruji
    "openrouter/free",                                               // jaring pengaman: auto-pilih model gratis apa pun yang masih aktif
  ].map((model) => ({
    name: `OpenRouter (${model})`,
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: KEY_OPENROUTER,
    model,
  })),
];

// =========================================================================
// 2b. RESOLVER MODEL SPESIFIK DARI CLIENT (mis. via command /set-model)
//     Dipakai saat client secara eksplisit minta model tertentu yang tidak
//     ada di daftar PROVIDERS default di atas. Logika hybrid:
//       1) Cek MODEL_MAPPING (alias exact) dulu.
//       2) Kalau tidak ketemu, tebak dari pola nama model.
//       3) Kalau provider hasil deteksi ini gagal, kode utama akan tetap
//          lanjut ke urutan PROVIDERS default sebagai fallback penuh.
// =========================================================================

// Definisi baseURL + key per provider, dipakai ulang baik oleh PROVIDERS
// (tier default) maupun oleh resolver model custom di bawah ini.
const PROVIDER_BASE = {
  gemini1: { name: "Gemini (Key 1 - custom)", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: KEY_GEMINI_1 },
  gemini2: { name: "Gemini (Key 2 - custom)", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: KEY_GEMINI_2 },
  groq: { name: "Groq (custom)", baseURL: "https://api.groq.com/openai/v1", apiKey: KEY_GROQ },
  cerebras: { name: "Cerebras (custom)", baseURL: "https://api.cerebras.ai/v1", apiKey: KEY_CEREBRAS },
  openrouter: { name: "OpenRouter (custom)", baseURL: "https://openrouter.ai/api/v1", apiKey: KEY_OPENROUTER },
};

// Daftar Pemetaan Utama — alias/exact match model -> key provider di atas.
// Tambahkan entri baru di sini kapan pun ada model spesifik yang perlu
// diarahkan secara pasti (paling akurat, tidak bergantung tebakan pola).
const MODEL_MAPPING = {
  "llama-3.1-8b-instant": "groq",
  "llama-3.2-90b-vision-preview": "groq",
  "llama-3.2-11b-vision-preview": "groq",
  "mixtral-8x7b-32768": "groq",
  "gemma2-9b-it": "groq",
  "llama3.1-8b": "cerebras",
  "llama3.1-70b": "cerebras",
};

// Fallback Pattern Matching — dipakai kalau model tidak ada di MODEL_MAPPING.
function detectProviderKeyFromPattern(model) {
  const m = model.toLowerCase();
  if (m.includes("gemini")) return "gemini1";
  if (m.includes("/")) return "openrouter"; // slug OpenRouter selalu ada "/" (mis. meta-llama/...)
  if (m.includes("llama") || m.includes("gemma") || m.includes("mixtral")) return "groq";
  return null; // tidak terdeteksi -> tidak ada reorder, pakai urutan default saja
}

// Bangun objek provider "custom" siap pakai untuk model spesifik yang diminta client.
function resolveCustomProvider(requestedModel) {
  if (!requestedModel || requestedModel === "(tidak disebutkan client)") return null;

  const mappedKey = MODEL_MAPPING[requestedModel] || detectProviderKeyFromPattern(requestedModel);
  if (!mappedKey || !PROVIDER_BASE[mappedKey]) return null;

  const base = PROVIDER_BASE[mappedKey];
  return {
    name: `${base.name} [diminta client: ${requestedModel}]`,
    baseURL: base.baseURL,
    apiKey: base.apiKey,
    model: requestedModel, // model PERSIS seperti yang diminta client, tidak di-override
  };
}

// =========================================================================
// 3. HANDLER UTAMA
// =========================================================================
module.exports = async (req, res) => {
  // CORS dasar (agar bisa diakses dari browser-based client seperti SillyTavern web)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Endpoint list model (opsional, agar client seperti SillyTavern bisa
  // fetch daftar model tanpa error saat pertama connect)
  if (req.method === "GET" && req.url.includes("/v1/models")) {
    // Cache di CDN Vercel selama 24 jam — daftar model statis, tidak perlu
    // di-generate ulang tiap request.
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

  // Payload dasar hasil forward dari client, model akan di-override per provider
  const basePayload = { ...clientBody };

  let lastError = null;
  const attemptLog = []; // rekam semua percobaan untuk ringkasan akhir

  // Jika client minta model spesifik (mis. via /set-model) yang cocok dengan
  // salah satu provider, coba provider itu DULUAN dengan model persis yang
  // diminta. Kalau gagal, loop di bawah tetap lanjut ke urutan PROVIDERS
  // default penuh (Gemini -> Groq -> Cerebras -> OpenRouter) seperti biasa.
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
    // Lewati provider yang key-nya belum diisi (masih placeholder)
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

    // Siapkan payload sesuai provider:
    // - Untuk Gemini: inject safetySettings (BLOCK_NONE) jika belum ada
    // - Untuk provider lain: hapus safetySettings dari payload (agar tidak error 400)
    let payload = {
      ...basePayload,
      model: provider.model,
    };

    // Conditional payload per provider
    const isGemini = provider.baseURL.includes("generativelanguage.googleapis.com");
    if (isGemini) {
      // Inject safetySettings untuk Gemini jika belum ada di request client.
      // Gunakan kategori spesifik (bukan HARM_CATEGORY_ALL, yang tidak
      // didukung resmi oleh API Gemini) agar payload valid.
      if (!payload.safetySettings) {
        payload.safetySettings = [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" },
        ];
      }
    } else {
      // Strip safetySettings untuk provider non-Gemini (agar tidak error 400 Bad Request)
      delete payload.safetySettings;
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
          validateStatus: (status) => status < 500, // biar 4xx tetap masuk try, ditangani manual
        });

        if (upstream.status === 429 || upstream.status >= 400) {
          // Provider ini gagal / kena limit -> baca sedikit body error lalu lanjut fallback
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
            detail: errBody.slice(0, 500), // batasi panjang log
          });
          attemptLog.push({ provider: provider.name, model: provider.model, status: "failed", httpStatus: upstream.status });
          continue; // lanjut ke provider berikutnya
        }

        // Sukses -> log dan set header SSE, lalu pipe response ke client
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
        // Header meta agar client (atau Anda saat debug) tahu provider/model
        // yang benar-benar mengeksekusi request, tanpa merusak format SSE body.
        res.setHeader("X-Gateway-Requested-Model", requestedModel);
        res.setHeader("X-Gateway-Final-Provider", provider.name);
        res.setHeader("X-Gateway-Final-Model", provider.model);
        res.setHeader("X-Gateway-Fallback-Happened", String(attemptLog.length > 1));

        upstream.data.pipe(res);

        // Tunggu sampai stream selesai sebelum function berakhir
        await new Promise((resolve, reject) => {
          upstream.data.on("end", resolve);
          upstream.data.on("error", reject);
          res.on("close", resolve);
        });

        return; // selesai, tidak perlu coba provider lain
      } else {
        // -----------------------------------------------------------------
        // MODE NON-STREAMING: request biasa, format OpenAI Chat Completion
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

        // Sukses -> log lalu kembalikan response (sudah format OpenAI-compatible)
        // ditambah field _gateway_meta untuk visibilitas provider/model asli.
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
      // Tangkap error HTTP (429 rate limit, 401 auth, 500 dll) ATAU network error
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

      // Lanjut otomatis ke provider berikutnya (seamless fallback)
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

// Konfigurasi khusus Vercel: nonaktifkan body parser bawaan jika perlu raw body,
// tapi di sini kita tetap pakai default (JSON) karena payload client berupa JSON biasa.
module.exports.config = {
  api: {
    bodyParser: true,
  },
};
