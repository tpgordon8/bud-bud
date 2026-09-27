import http from 'node:http';
import worker from '../worker.mjs';
const env = {GEMINI_API_KEY:'SECRET_TEST_KEY_123', GA_ID:'G-TEST1234', FORM_URL:'https://docs.google.com/forms/d/e/FAKEFORM/viewform?usp=sf_link'};
const log = {gemini:[], formPosts:[]};
let mode = 'ok'; // ok | 429 | first429 | first404 | all429
const PAYLOAD = {"is_cannabis_label":true,"product_type":"flower","product_name":"Gelato 41","brand":"Green Co","cannabinoids":[{"key":"THCa","value":26.1,"unit":"%","sure":true},{"key":"THC","value":0.8,"unit":"%","sure":true}],"terpenes":[{"name":"Limonene","value":0.5,"unit":"%","sure":true}]};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  if (url.startsWith('https://generativelanguage.googleapis.com/')) {
    log.gemini.push({url, key:opts.headers['x-goog-api-key'], body:JSON.parse(opts.body)});
    const isFirst = url.includes('gemini-3.5-flash-lite:');
    if (mode === '429' || mode === 'all429') return new Response('{}', {status:429});
    if (mode === 'first429' && isFirst) return new Response('{}', {status:429});
    if (mode === 'first404' && isFirst) return new Response('{}', {status:404});
    const text = JSON.stringify(PAYLOAD), h = Math.ceil(text.length/2);
    const sse = [text.slice(0,h), text.slice(h)].map(c => 'data: ' + JSON.stringify({candidates:[{content:{parts:[{text:c}]}}]}) + '\r\n\r\n').join('');
    return new Response(sse, {headers:{'content-type':'text/event-stream'}});
  }
  if (url.startsWith('https://docs.google.com/forms/')) {
    if (!opts.method || opts.method === 'GET') {
      const data = [null, [null, [[111,'Type',null,0,[[1001,null,0]]],[222,'Message',null,1,[[1002,null,0]]],[333,'Details',null,1,[[1003,null,0]]],[444,'Contact',null,0,[[1004,null,0]]]]]];
      return new Response(`<html><script>var FB_PUBLIC_LOAD_DATA_ = ${JSON.stringify(data)};</script></html>`);
    }
    log.formPosts.push({url, body:Object.fromEntries(new URLSearchParams(opts.body))});
    return new Response('ok');
  }
  return realFetch(url, opts);
};
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost:8787');
  if (u.pathname === '/__log') { res.end(JSON.stringify(log)); return; }
  if (u.pathname === '/__mode') { mode = u.searchParams.get('m'); res.end('ok'); return; }
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) headers.set(k, v);
  headers.set('cf-connecting-ip', req.headers['x-test-ip'] || '1.1.1.1');
  const r = await worker.fetch(new Request(u.href, {method:req.method, headers, body: req.method !== 'GET' ? body : undefined}), env);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  if (r.body) { const rd = r.body.getReader(); for (;;) { const {done, value} = await rd.read(); if (done) break; res.write(value); } }
  res.end();
}).listen(8787);
