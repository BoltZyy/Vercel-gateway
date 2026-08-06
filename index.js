// api/index.js
// Serverless AI Router Proxy — auto-fallback sequential antar provider
// Kompatibel dengan format OpenAI Chat Completion (SillyTavern / Saucepan.ai dll)

const axios = require("axios");

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

  // Payload dasar hasil forward dari client, model akan di-override per provider
  const basePayload = { ...clientBody };

  let lastError = null;

  // =======================================================================
  // 4. LOOP SEQUENTIAL TRY-CATCH — coba tiap provider satu per satu
  // =======================================================================
  for (const provider of PROVIDERS) {
    // Lewati provider yang key-nya belum diisi (masih placeholder)
    if (!provider.apiKey || provider.apiKey.startsWith("ISI_API_KEY")) {
      lastError = new Error(`${provider.name}: API key belum diisi, dilewati.`);
      continue;
    }

    const payload = {
      ...basePayload,
      model: provider.model,
    };

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
          continue; // lanjut ke provider berikutnya
        }

        // Sukses -> set header SSE dan pipe response ke client
        res.status(200);
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");

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
            timeout: 60000,
          }
        );

        // Sukses -> langsung kembalikan response (sudah format OpenAI-compatible)
        return res.status(200).json(response.data);
      }
    } catch (err) {
      // Tangkap error HTTP (429 rate limit, 401 auth, 500 dll) ATAU network error
      const status = err.response?.status;
      const detail = err.response?.data
        ? JSON.stringify(err.response.data)
        : err.message;

      lastError = new Error(`${provider.name} gagal (${status || "network error"}): ${detail}`);

      // Lanjut otomatis ke provider berikutnya (seamless fallback)
      continue;
    }
  }

  // =======================================================================
  // 5. SEMUA PROVIDER GAGAL
  // =======================================================================
  return res.status(502).json({
    error: {
      message: "Semua provider AI gagal merespons. Cek API key / kuota masing-masing provider.",
      last_error: lastError ? lastError.message : "Tidak diketahui",
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
