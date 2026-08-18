// End-to-end test of the actual worker.js fetch handler — not just the
// crypto helper functions in isolation, but the real HTTP request/response
// lifecycle: JSON parsing, the Upstash REST call shape (SET ... NX, GET),
// the Stripe REST calls, and webhook signature verification. Fake Upstash
// and fake Stripe servers stand in for the real services; global fetch is
// monkey-patched to redirect only those two hostnames to them, so worker.js
// itself is imported and exercised completely unmodified.
import http from 'node:http';
import fs from 'node:fs';
import { webcrypto } from 'node:crypto';

// ── Fake Upstash: a minimal in-memory Redis REST-alike ──
const kv = new Map();
const upstashServer = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const cmd = JSON.parse(body);
  const [op, key, ...rest] = cmd;
  let result = null;
  if (op === 'SET') {
    const nx = rest.includes('NX');
    if (nx && kv.has(key)) result = null;
    else { kv.set(key, rest[0]); result = 'OK'; }
  } else if (op === 'GET') {
    result = kv.has(key) ? kv.get(key) : null;
  } else if (op === 'LPUSH') {
    result = 1; // not exercised deeply here
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ result }));
});

// ── Fake Stripe: just enough of the Checkout Sessions API ──
const stripeSessions = new Map();
let stripeSessionCounter = 0;
const stripeServer = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (req.method === 'POST' && req.url === '/v1/checkout/sessions') {
    const params = new URLSearchParams(body);
    const id = 'cs_test_' + (++stripeSessionCounter);
    stripeSessions.set(id, {
      id,
      url: 'https://checkout.stripe.com/' + id,
      payment_status: 'unpaid',
      metadata: { deviceId: params.get('metadata[deviceId]'), product: params.get('metadata[product]') },
      customer_details: { email: params.get('customer_email') },
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stripeSessions.get(id)));
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/v1/checkout/sessions/')) {
    const id = req.url.split('/').pop();
    const s = stripeSessions.get(id);
    res.writeHead(s ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(s || { error: 'not_found' }));
    return;
  }
  res.writeHead(404); res.end('{}');
});

await new Promise(r => upstashServer.listen(0, r));
await new Promise(r => stripeServer.listen(0, r));
const upstashPort = upstashServer.address().port;
const stripePort = stripeServer.address().port;
console.log(`Fake Upstash on :${upstashPort}, fake Stripe on :${stripePort}\n`);

// Redirect worker.js's hardcoded api.stripe.com calls to the fake server;
// the Upstash URL is env-configured, so it's pointed at the fake directly.
const realFetch = fetch;
globalThis.fetch = (url, opts) => {
  const u = typeof url === 'string' ? url : url.url;
  if (u.startsWith('https://api.stripe.com')) {
    const path = u.replace('https://api.stripe.com', '');
    return realFetch(`http://127.0.0.1:${stripePort}${path}`, opts);
  }
  return realFetch(url, opts);
};

const worker = (await import('./worker.js')).default;

const priv = JSON.parse(fs.readFileSync(new URL('../keys_private_jwk.json', import.meta.url)));
const pub = JSON.parse(fs.readFileSync(new URL('../keys_public_jwk.json', import.meta.url)));

const env = {
  UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${upstashPort}`,
  UPSTASH_REDIS_REST_TOKEN: 'test-token',
  RESEND_API_KEY: 'test-resend-key',
  RESEND_FROM: 'ProForm <license@example.com>',
  STRIPE_SECRET_KEY: 'sk_test_fake',
  STRIPE_WEBHOOK_SECRET: 'whsec_test_fake',
  STRIPE_PRICE_ID: 'price_test_fake',
  LICENSE_PRIVATE_KEY_JWK: JSON.stringify(priv),
  LICENSE_PUBLIC_KEY_JWK: JSON.stringify(pub),
  ALLOWED_ORIGINS: 'https://proforma-suite.com',
};

// Resend calls will fail (no real key) — that's fine, sendEmail() swallows
// failures and logs, matching production behavior when email delivery
// hiccups; it shouldn't block license issuance.
globalThis.fetch = (url, opts) => {
  const u = typeof url === 'string' ? url : url.url;
  if (u.startsWith('https://api.resend.com')) return Promise.resolve(new Response('{}', { status: 401 }));
  if (u.startsWith('https://api.stripe.com')) {
    const path = u.replace('https://api.stripe.com', '');
    return realFetch(`http://127.0.0.1:${stripePort}${path}`, opts);
  }
  return realFetch(url, opts);
};

function req(path, opts) {
  return worker.fetch(new Request(`https://api.example.com${path}`, {
    ...opts,
    headers: { Origin: 'https://proforma-suite.com', 'Content-Type': 'application/json', ...(opts && opts.headers) },
  }), env);
}

(async () => {
  const deviceId = 'e2e-test-device-fingerprint-hash';

  console.log('=== /api/trial/check — first call registers the trial ===');
  let r = await req('/api/trial/check', { method: 'POST', body: JSON.stringify({ deviceId }) });
  let data = await r.json();
  console.log('First call:', data);
  const firstTrialStart = data.trialStart;

  console.log('\n=== /api/trial/check — second call (simulating a cleared-localStorage relaunch) does NOT reset trialStart ===');
  r = await req('/api/trial/check', { method: 'POST', body: JSON.stringify({ deviceId }) });
  data = await r.json();
  console.log('Second call:', data);
  console.log('trialStart unchanged:', data.trialStart === firstTrialStart);

  console.log('\n=== /api/checkout/create ===');
  r = await req('/api/checkout/create', { method: 'POST', body: JSON.stringify({ deviceId, email: 'buyer@example.com' }) });
  data = await r.json();
  console.log('Checkout session:', data);
  const sessionId = data.url.split('/').pop();

  console.log('\n=== /api/stripe/webhook — simulate checkout.session.completed ===');
  const stripeSession = stripeSessions.get(sessionId);
  stripeSession.payment_status = 'paid';
  const eventBody = JSON.stringify({
    type: 'checkout.session.completed',
    data: { object: stripeSession },
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${eventBody}`;
  const hmacKey = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await webcrypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(signedPayload)));
  const sigHex = Array.from(mac).map(b => b.toString(16).padStart(2, '0')).join('');
  r = await req('/api/stripe/webhook', {
    method: 'POST',
    headers: { 'Stripe-Signature': `t=${timestamp},v1=${sigHex}` },
    body: eventBody,
  });
  console.log('Webhook response status:', r.status, await r.text());

  console.log('\n=== /api/license/by-session — the purchaseconfirm.html flow ===');
  r = await req(`/api/license/by-session?session_id=${sessionId}`, { method: 'GET' });
  data = await r.json();
  console.log('License record:', data);
  const issuedToken = data.token;

  console.log('\n=== /api/license/verify — the downloads.html flow ===');
  r = await req(`/api/license/verify?deviceId=${deviceId}&key=${encodeURIComponent(issuedToken)}`, { method: 'GET' });
  console.log('Verify (correct device):', await r.json());

  r = await req(`/api/license/verify?deviceId=some-other-device&key=${encodeURIComponent(issuedToken)}`, { method: 'GET' });
  console.log('Verify (wrong device):', await r.json());

  console.log('\n=== Webhook signature tampering is rejected ===');
  r = await req('/api/stripe/webhook', {
    method: 'POST',
    headers: { 'Stripe-Signature': `t=${timestamp},v1=deadbeef` },
    body: eventBody,
  });
  console.log('Tampered signature response status (should be 400):', r.status);

  upstashServer.close(); stripeServer.close();
})();