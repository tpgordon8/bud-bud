// Bud Bud public web app. Cloudflare Worker: serves the page, reads labels with Gemini, forwards feedback to a Google Form.
// Settings (Cloudflare > Worker > Settings > Variables and secrets):
//   GEMINI_API_KEY  (secret)  key from Google AI Studio
//   GA_ID           (text)    Google Analytics measurement ID, like G-ABC123XYZ
//   FORM_URL        (text)    link to your Google Form
//   GEMINI_MODEL    (text, optional) comma-separated models to try in order.
//                   Default: gemini-3.8-flash, then gemini-3.5-flash-lite if the first is busy or unavailable.
const VERSION = '2.2.3';
const modelErrors = {}; // last refusal per model, shown on /api/health for troubleshooting
const DEFAULT_MODELS = 'gemini-3.8-flash,gemini-3.5-flash-lite';
const HTML = __HTML__;
const PROMPT = __PROMPT__;
const hits = new Map();
function limited(key, max, windowMs){
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now); hits.set(key, arr);
  if (hits.size > 5000) hits.clear();
  return false;
}
const SEC = {'x-content-type-options':'nosniff', 'referrer-policy':'strict-origin-when-cross-origin', 'x-frame-options':'DENY', 'permissions-policy':'geolocation=(), microphone=()'};
const json = (o, s = 200) => new Response(JSON.stringify(o), {status:s, headers:Object.assign({'content-type':'application/json', 'cache-control':'no-store'}, SEC)});

export default {
  async fetch(req, env){
    const url = new URL(req.url);
    const ip = req.headers.get('cf-connecting-ip') || 'anon';
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const ga = /^G-[A-Z0-9]{4,20}$/.test(env.GA_ID || '') ? env.GA_ID : '';
      const cfg = 'window.__CFG=' + JSON.stringify({ga, v:VERSION}) + ';';
      return new Response(HTML.replace('/*__CFG__*/', cfg), {headers:Object.assign({'content-type':'text/html; charset=utf-8', 'cache-control':'no-cache'}, SEC)});
    }
    if (url.pathname === '/api/health') {
      let feedback = false;
      if (env.FORM_URL) { try { feedback = (await formInfo(env)).fields.length >= 2; } catch (e) { feedback = false; } }
      let probe;
      if (url.searchParams.get('probe') === '1' && env.GEMINI_API_KEY && !limited('p:' + ip, 5, 600000)) {
        probe = {};
        for (const m of models(env)) {
          try {
            const r = await callModel(env, m, [{role:'user', parts:[{text:'Reply with {"ok":true}'}]}], false);
            let msg = ''; if (!r.ok) { const d = await r.text(); try { msg = JSON.parse(d).error.message; } catch (e) { msg = d.slice(0, 200); } } else await r.text();
            probe[m] = {status:r.status, message:String(msg).slice(0, 300)};
          } catch (e) { probe[m] = {status:0, message:String(e).slice(0, 200)}; }
        }
      }
      return json({ok:true, version:VERSION, ai:!!env.GEMINI_API_KEY, models:models(env), probe, model_errors:modelErrors, analytics:/^G-/.test(env.GA_ID || ''), feedback});
    }
    if (url.pathname === '/api/read' && req.method === 'POST') return read(req, env, ip);
    if (url.pathname === '/api/report' && req.method === 'POST') return report(req, env, ip);
    return new Response('Not found', {status:404});
  }
};

async function read(req, env, ip){
  if (!env.GEMINI_API_KEY) return json({code:'sampling_disabled'}, 503);
  if (limited('r:' + ip, 20, 600000)) return json({code:'rate_limited'}, 429);
  if (+(req.headers.get('content-length') || 0) > 9000000) return json({code:'image_rejected'}, 413);
  let body; try { body = await req.json(); } catch (e) { return json({code:'invalid_request'}, 400); }
  const imgs = Array.isArray(body.images) ? body.images.slice(0, 2) : [];
  if (!imgs.length) return json({code:'invalid_request'}, 400);
  const parts = [{text:PROMPT}];
  for (const im of imgs) {
    const mime = ['image/jpeg', 'image/png', 'image/webp'].includes(im && im.mime) ? im.mime : null;
    const data = im && typeof im.data === 'string' ? im.data : '';
    if (!mime || !data || data.length > 6000000 || !/^[A-Za-z0-9+/=]+$/.test(data.slice(0, 200))) return json({code:'image_rejected'}, 400);
    parts.push({inline_data:{mime_type:mime, data}});
  }
  const contents = [{role:'user', parts}];
  const codes = [];
  for (const model of models(env)) {
    let up;
    try { up = await callModel(env, model, contents, true);
    } catch (e) { codes.push(0); continue; }
    if (up.ok) { delete modelErrors[model]; return new Response(up.body, {headers:{'content-type':'text/event-stream', 'cache-control':'no-store', 'x-model':model}}); }
    const detail = (await up.text()).slice(0, 500);
    console.log('gemini error', model, up.status, detail);
    let msg = detail; try { msg = JSON.parse(detail).error.message || detail; } catch (e) {}
    modelErrors[model] = {status:up.status, message:String(msg).replace(/AIza[0-9A-Za-z_\-]{20,}/g, '[key]').slice(0, 300), at:new Date().toISOString()};
    codes.push(up.status);
  }
  if (codes.includes(429)) return json({code:'rate_limited'}, 429);
  if (codes.length && codes.every(c => c === 400)) return json({code:'image_rejected'}, 400);
  return json({code:'upstream_error'}, 502);
}
function callModel(env, model, contents, stream){
  const gen = {responseMimeType:'application/json', maxOutputTokens:4096};
  if (model.startsWith('gemini-2.5')) { gen.temperature = 0; gen.thinkingConfig = {thinkingBudget:0}; }
  // Flash-Lite models accept 'minimal'; full Flash models (3.8+) require at least 'low'.
  else gen.thinkingConfig = {thinkingLevel: model.includes('lite') ? 'minimal' : 'low'};
  const verb = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
  return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:${verb}`, {
    method:'POST', headers:{'content-type':'application/json', 'x-goog-api-key':env.GEMINI_API_KEY},
    body:JSON.stringify({contents, generationConfig:gen})
  });
}
function models(env){
  return String(env.GEMINI_MODEL || DEFAULT_MODELS).split(',').map(m => m.trim().replace(/[^a-z0-9.\-]/gi, '')).filter(Boolean).slice(0, 3);
}

let formCache = null;
async function formInfo(env){
  if (formCache && formCache.src === env.FORM_URL) return formCache;
  const r = await fetch(env.FORM_URL, {redirect:'follow'});
  const html = await r.text();
  const m = html.match(/FB_PUBLIC_LOAD_DATA_\s*=\s*([\s\S]*?);\s*<\/script>/);
  if (!m) throw new Error('Could not read the Google Form. Is it shared publicly?');
  const data = JSON.parse(m[1]);
  const items = (data[1] && data[1][1]) || [];
  const fields = [];
  for (const it of items) {
    const entry = it && it[4] && it[4][0] && it[4][0][0];
    if (entry) fields.push({title:String(it[1] || '').trim().toLowerCase(), entry});
  }
  const base = (r.url || env.FORM_URL).split('?')[0];
  formCache = {src:env.FORM_URL, fields, post:base.replace(/\/viewform.*$/, '/formResponse')};
  return formCache;
}
async function report(req, env, ip){
  if (!env.FORM_URL) return json({code:'not_configured'}, 503);
  if (limited('f:' + ip, 8, 3600000)) return json({code:'rate_limited'}, 429);
  let b; try { b = await req.json(); } catch (e) { return json({code:'invalid_request'}, 400); }
  const clip = (v, n) => String(v || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, n);
  const vals = {type:clip(b.kind, 40) || 'Other', message:clip(b.message, 2000), details:clip(b.details, 2000), contact:clip(b.contact, 120)};
  if (vals.message.trim().length < 2) return json({code:'invalid_request'}, 400);
  try {
    const f = await formInfo(env);
    const p = new URLSearchParams();
    ['type', 'message', 'details', 'contact'].forEach((k, i) => {
      const fld = f.fields.find(x => x.title.includes(k)) || f.fields[i];
      if (fld) p.append('entry.' + fld.entry, vals[k]);
    });
    const r = await fetch(f.post, {method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'}, body:p.toString()});
    if (!r.ok) { formCache = null; return json({code:'upstream_error'}, 502); }
    return json({ok:true});
  } catch (e) { console.log('form error', String(e)); formCache = null; return json({code:'upstream_error'}, 502); }
}
