# AI Router Proxy (Serverless, Vercel-ready)

Proxy AI router dengan auto-fallback berurutan antar provider (Gemini → Groq →
Cerebras → OpenRouter), kompatibel format OpenAI Chat Completion. Bisa
langsung dipakai sebagai "Custom OpenAI endpoint" di SillyTavern / Saucepan.ai.

## Struktur

```
.
├── api/
│   └── index.js      <- Serverless function utama (logika router + fallback)
├── package.json
├── vercel.json
└── .env.example
```

## Cara Deploy ke Vercel

1. Push folder ini ke repository GitHub Anda.
2. Buka [vercel.com](https://vercel.com) → **New Project** → import repo tersebut.
3. Vercel akan otomatis mendeteksi `package.json` dan `api/index.js` — tidak perlu
   konfigurasi build khusus (Framework Preset: "Other").
4. **Sebelum/sesudah deploy**, isi Environment Variables di
   **Project Settings → Environment Variables**:
   - `KEY_GEMINI_1`
   - `KEY_GEMINI_2`
   - `KEY_GROQ`
   - `KEY_CEREBRAS`
   - `KEY_OPENROUTER`
5. Redeploy setelah environment variable diisi (Vercel tidak auto-reload env var
   pada deployment yang sudah jalan).

Alternatif: Anda juga bisa langsung mengganti string
`"ISI_API_KEY_..._DISINI"` di dalam `api/index.js` dengan key asli — tapi
**tidak disarankan** kalau repo bersifat publik.

## Endpoint

Setelah deploy, endpoint Anda:

```
https://<nama-project-anda>.vercel.app/v1/chat/completions
```

Gunakan URL ini sebagai "Custom OpenAI-compatible endpoint" di SillyTavern /
Saucepan.ai. Tidak ada autentikasi tambahan (endpoint terbuka) — field
`Authorization` dari client tidak divalidasi oleh proxy ini, hanya diteruskan
apa adanya (tidak dipakai untuk memilih provider).

## Urutan Fallback

1. Gemini (Key 1) — model `gemini-3.6-flash`
2. Gemini (Key 2) — model `gemini-3.6-flash`
3. Groq — model `llama-3.3-70b-versatile`
4. Cerebras — model `llama3.3-70b`
5. OpenRouter — model `meta-llama/llama-3.3-70b-instruct:free`

Jika satu provider gagal (HTTP 429 / error apa pun / network timeout), proxy
otomatis lanjut ke provider berikutnya dalam daftar — termasuk untuk mode
`stream: true`. Provider yang key-nya masih placeholder otomatis dilewati.

## Catatan Model Gemini

Model `gemini-3.6-flash` dipakai karena merupakan model Flash terbaru Google
per dokumentasi resmi OpenAI-compatibility Gemini (Juli 2026). Jika akun Anda
belum punya akses ke model ini, ganti nilai `model` pada provider Gemini di
`api/index.js` menjadi `gemini-2.5-flash-lite` (perlu diperhatikan: model ini
dijadwalkan Google untuk dihentikan per 16 Oktober 2026).

## Testing Lokal (opsional)

```bash
npm install
vercel dev
```

Lalu test dengan curl:

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "any",
    "messages": [{"role": "user", "content": "Halo, test proxy"}],
    "stream": false
  }'
```
