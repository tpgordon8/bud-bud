# Bud Bud

Photograph a cannabis product label and get a plain-English read on strength, aroma and what to expect. Free, no account needed. Not medical advice.

## How it's put together

There is one app, in `src/index.html`, and it runs in two places:

- **Public website** — runs on Cloudflare (free). Label photos are read by Google's Gemini AI through the server, so the Gemini key is never exposed to visitors. Feedback and automatic error reports go to a Google Form, and Google Analytics counts usage.
- **Claude version** — the same file, published as a claude.ai artifact, reading labels through the viewer's own Claude account.

`build.py` bundles the app into `worker.mjs`, which is what Cloudflare runs. Pushing to the `main` branch redeploys automatically.

## Settings (Cloudflare → bud-bud → Settings → Variables and secrets)

| Name | Type | What it is |
|---|---|---|
| GEMINI_API_KEY | Secret | Key from Google AI Studio (free tier) |
| FORM_URL | Text | Share link to the "Bud Bud feedback" Google Form |
| GA_ID | Text | Google Analytics measurement ID (starts with G-), optional |
| GEMINI_MODEL | Text | Optional. Models to try in order, comma-separated. Default `gemini-3.5-flash-lite,gemini-3.8-flash` (fast model first, stronger model as backup) |

If Google retires a model, set `GEMINI_MODEL` to its replacement (listed at ai.google.dev/gemini-api/docs/deprecations). No code change needed.

Check everything is connected: open `/api/health` on the live site. `ai`, `analytics` and `feedback` should all be `true`.

## Making changes

1. Edit `src/index.html` (the app) or `src/worker-template.js` (the server).
2. `python3 build.py`
3. `python3 tests/test_all.py` — must show all passed.
4. Commit `src/`, `worker.mjs` and anything else changed.

## Known limits

- Google's free tier has daily caps; when the main model is busy the backup model takes over, and if both are busy visitors see a friendly "too many scans" message.
- Free-tier Google may use submitted photos to improve its products. The in-app terms say so.
- Per-visitor abuse limits are approximate.
- On the website, saved jars stay on that device; the Claude version syncs through the viewer's Claude account.
