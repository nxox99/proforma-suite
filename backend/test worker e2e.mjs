// End-to-end test of the actual worker.js fetch handler — rewritten
// 2026-08-19 to match the SUBSCRIPTION-based backend (the old version of
// this file tested `mode: 'payment'` with a single STRIPE_PRICE_ID; that no
// longer matches worker.js, which now runs `mode: 'subscription'` against a
// four-product PRODUCTS catalog and has two new endpoints). Not just the
// crypto helper functions in isolation, but the real HTTP request/response
// lifecycle: JSON parsing, the Upstash REST call shape (SET ... NX, GET),
// the Stripe REST calls (including subscriptions + billing portal), and
// webhook signature verification. Fake Upstash and fake Stripe servers
// stand in for the real services; global fetch is monkey-patched to
// redirect only those two hostnames to them, so worker.js itself is
// imported and exercised completely unmodified.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// ── Fake Stripe: Checkout Sessions + Subscriptions + Billing Portal ──
// Enough of the subscription-mode surface for worker.js's actual calls:
//   POST /v1/checkout/sessions        (mode=subscription)
//   GET  /v1/checkout/sessions/:id
//   GET  /v1/subscriptions/:id
//   POST /v1/subscriptions/:id        (price swap — the upgrade endpoint)
//   POST /v1/billing_portal/sessions
const stripeSessions = new Map();
const stripeSubscriptions = new Map();
let stripeCounter = 0;

// worker.js's formEncode() produces bracketed keys like `metadata[deviceId]`
// and `subscription_data[metadata][deviceId]` — decode those back into a
// nested object the same shape worker.js built them from.
function parseFormBody(body) {
  const out = {};
  for (const [rawKey, rawVal] of new URLSearchParams(body)) {
    const keys = rawKey.replace(/\]/g, '').split('[');
    let cur = out;
    for (let i = 0; i < keys.length - 1; i++) {
      cur[keys[i]] = cur[keys[i]] || {};
      cur = cur[keys[i]];
    }
    cur[keys[keys.length - 1]] = rawVal;
  }
  return out;
}

const stripeServer = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;

  if (req.method === 'POST' && req.url === '/v1/checkout/sessions') {
    const params = parseFormBody(body);
    const id = 'cs_test_' + (++stripeCounter);
    const subId = 'sub_test_' + stripeCounter;
    const customerId = 'cus_test_' + stripeCounter;
    // Simulate Stripe auto-creating the Subscription for a mode:'subscription'
    // Checkout Session, carrying subscription_data.metadata onto it — exactly
    // what worker.js's issueLicenseFromSession()/webhook handlers expect to
    // retrieve later via GET /v1/subscriptions/:id.
    const itemId = 'si_test_' + stripeCounter;
    stripeSubscriptions.set(subId, {
      id: subId,
      customer: customerId,
      status: 'active',
      current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
      cancel_at_period_end: false,
      metadata: (params.subscription_data && params.subscription_data.metadata) || {},
      // Real Stripe Subscriptions carry their price(s) under items.data[].price
      // — worker.js's upgrade endpoint and the subscription.updated webhook
      // handler both read this to know the item id to swap / the product
      // currently in effect.
      items: { data: [{ id: itemId, price: { id: params.line_items && params.line_items['0'] && params.line_items['0'].price } }] },
    });
    stripeSessions.set(id, {
      id,
      url: 'https://checkout.stripe.com/' + id,
      mode: params.mode,
      payment_status: 'unpaid',
      subscription: subId,
      customer: customerId,
      metadata: params.metadata || {},
      customer_details: { email: params.customer_email },
      amount_total: 1099,
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

  if (req.method === 'GET' && req.url.startsWith('/v1/subscriptions/')) {
    const id = req.url.split('/').pop();
    const s = stripeSubscriptions.get(id);
    res.writeHead(s ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(s || { error: 'not_found' }));
    return;
  }

  // Price swap — what worker.js's /api/subscription/upgrade calls to move
  // an existing Subscription onto a different Price (Stripe's real API
  // prorates this automatically; the fake here just accepts the new price).
  if (req.method === 'POST' && req.url.startsWith('/v1/subscriptions/') && req.url !== '/v1/subscriptions/') {
    const id = req.url.split('/').pop();
    const s = stripeSubscriptions.get(id);
    if (!s) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not_found' })); return; }
    const params = parseFormBody(body);
    const newPriceId = params.items && params.items['0'] && params.items['0'].price;
    if (newPriceId && s.items && s.items.data && s.items.data[0]) s.items.data[0].price.id = newPriceId;
    if (params.metadata) s.metadata = { ...s.metadata, ...params.metadata };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(s));
    return;
  }

  if (req.method === 'POST' && req.url === '/v1/billing_portal/sessions') {
    const params = parseFormBody(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'bps_test_1', url: `https://billing.stripe.com/session/bps_test_1?customer=${params.customer}` }));
    return;
  }

  res.writeHead(404); res.end('{}');
});

await new Promise(r => upstashServer.listen(0, r));
await new Promise(r => stripeServer.listen(0, r));
const upstashPort = upstashServer.address().port;
const stripePort = stripeServer.address().port;
console.log(`Fake Upstash on :${upstashPort}, fake Stripe on :${stripePort}\n`);

// Redirect worker.js's hardcoded api.stripe.com / api.resend.com calls to
// the fakes above; the Upstash URL is env-configured, so it's pointed at
// the fake directly via env.UPSTASH_REDIS_REST_URL.
const realFetch = fetch;
globalThis.fetch = (url, opts) => {
  const u = typeof url === 'string' ? url : url.url;
  if (u.startsWith('https://api.resend.com')) return Promise.resolve(new Response('{}', { status: 401 }));
  if (u.startsWith('https://api.stripe.com')) {
    const p = u.replace('https://api.stripe.com', '');
    return realFetch(`http://127.0.0.1:${stripePort}${p}`, opts);
  }
  return realFetch(url, opts);
};

// NOTE: matches the actual on-disk filename in backend/ (capital W,
// "Worker.js") — see the accompanying review notes about the mismatch
// between this filename and wrangler.toml's `main = "worker.js"` entry.
const worker = (await import('./Worker.js')).default;

const priv = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'starter keys private jwk.json'), 'utf8'));
const pub = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'starter keys public jwk.json'), 'utf8'));

const env = {
  UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${upstashPort}`,
  UPSTASH_REDIS_REST_TOKEN: 'test-token',
  RESEND_API_KEY: 'test-resend-key',
  RESEND_FROM: 'ProForma Suite <billing@example.com>',
  SUPPORT_TO_EMAIL: 'support-inbox@example.com',
  STRIPE_SECRET_KEY: 'sk_test_fake',
  STRIPE_WEBHOOK_SECRET: 'whsec_test_fake',
  // Four recurring Price IDs, one per plan — replaces the old single
  // STRIPE_PRICE_ID now that /api/checkout/create is product-aware.
  STRIPE_PRICE_ID_DOCX: 'price_test_docx',
  STRIPE_PRICE_ID_PROFORM: 'price_test_proform',
  STRIPE_PRICE_ID_SYNTHETIXCR: 'price_test_synthetixcr',
  STRIPE_PRICE_ID_PROREDACTOR: 'price_test_proredactor',
  LICENSE_PRIVATE_KEY_JWK: JSON.stringify(priv),
  LICENSE_PUBLIC_KEY_JWK: JSON.stringify(pub),
  ALLOWED_ORIGINS: 'https://proforma-suite.com',
};

function req(p, opts) {
  return worker.fetch(new Request(`https://api.example.com${p}`, {
    ...opts,
    headers: { Origin: 'https://proforma-suite.com', 'Content-Type': 'application/json', ...(opts && opts.headers) },
  }), env);
}

async function signWebhook(body, secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${body}`;
  const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await webcrypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload)));
  const sigHex = Array.from(mac).map(b => b.toString(16).padStart(2, '0')).join('');
  return `t=${timestamp},v1=${sigHex}`;
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
  console.log('trialStart unchanged:', data.trialStart === firstTrialStart);

  console.log('\n=== /api/checkout/create — rejects an unknown product ===');
  r = await req('/api/checkout/create', { method: 'POST', body: JSON.stringify({ deviceId, email: 'buyer@example.com', product: 'not-a-real-product' }) });
  console.log('Unknown product status (should be 400):', r.status, await r.json());

  console.log('\n=== /api/checkout/create — ProForm Form Manager subscription ===');
  r = await req('/api/checkout/create', { method: 'POST', body: JSON.stringify({ deviceId, email: 'buyer@example.com', product: 'proform' }) });
  data = await r.json();
  console.log('Checkout session:', data);
  const sessionId = data.url.split('/').pop();
  const stripeSession = stripeSessions.get(sessionId);
  console.log('Session created in subscription mode:', stripeSession.mode === 'subscription');
  console.log('subscription_data metadata landed on the Subscription object:', stripeSubscriptions.get(stripeSession.subscription).metadata);

  console.log('\n=== /api/stripe/webhook — checkout.session.completed ===');
  stripeSession.payment_status = 'paid';
  let eventBody = JSON.stringify({ type: 'checkout.session.completed', data: { object: stripeSession } });
  r = await req('/api/stripe/webhook', { method: 'POST', headers: { 'Stripe-Signature': await signWebhook(eventBody, env.STRIPE_WEBHOOK_SECRET) }, body: eventBody });
  console.log('Webhook response status:', r.status, await r.text());

  console.log('\n=== /api/license/by-session — the purchaseconfirm.html flow ===');
  r = await req(`/api/license/by-session?session_id=${sessionId}`, { method: 'GET' });
  data = await r.json();
  console.log('License record:', data);
  const issuedToken = data.token;
  const subscriptionId = data.subscriptionId;

  console.log('\n=== /api/license/verify — the downloads.html flow ===');
  r = await req(`/api/license/verify?deviceId=${deviceId}&key=${encodeURIComponent(issuedToken)}`, { method: 'GET' });
  console.log('Verify (correct device):', await r.json());
  r = await req(`/api/license/verify?deviceId=some-other-device&key=${encodeURIComponent(issuedToken)}`, { method: 'GET' });
  console.log('Verify (wrong device):', await r.json());

  console.log('\n=== /api/license/refresh — subscription still active, issues a freshly-dated token ===');
  r = await req(`/api/license/refresh?deviceId=${deviceId}`, { method: 'GET' });
  data = await r.json();
  console.log('Refresh (active):', data);
  console.log('New token differs from the checkout-issued one:', data.token !== issuedToken);

  console.log('\n=== /api/billing/portal — returns a Stripe-hosted portal URL ===');
  r = await req('/api/billing/portal', { method: 'POST', body: JSON.stringify({ deviceId }) });
  console.log('Billing portal:', await r.json());

  console.log('\n=== /api/subscription/upgrade — rejects an unknown product ===');
  r = await req('/api/subscription/upgrade', { method: 'POST', body: JSON.stringify({ deviceId, newProduct: 'not-a-real-product' }) });
  console.log('Unknown product status (should be 400):', r.status, await r.json());

  console.log('\n=== /api/subscription/upgrade — ProForm subscriber upgrades to the Synthetix-CR bundle ===');
  r = await req('/api/subscription/upgrade', { method: 'POST', body: JSON.stringify({ deviceId, newProduct: 'synthetixcr' }) });
  data = await r.json();
  console.log('Upgrade response:', data);
  console.log('Product switched to synthetixcr:', data.product === 'synthetixcr');
  console.log('New token issued (differs from prior refresh token):', data.valid && data.token);
  const subAfterUpgrade = stripeSubscriptions.get(subscriptionId);
  console.log('Underlying Stripe subscription price actually swapped:', subAfterUpgrade.items.data[0].price.id === env.STRIPE_PRICE_ID_SYNTHETIXCR);
  console.log('Subscription metadata.product kept in sync:', subAfterUpgrade.metadata.product === 'synthetixcr');

  console.log('\n=== /api/subscription/upgrade — calling again with the SAME product is an idempotent no-op ===');
  r = await req('/api/subscription/upgrade', { method: 'POST', body: JSON.stringify({ deviceId, newProduct: 'synthetixcr' }) });
  data = await r.json();
  console.log('Still valid, still synthetixcr, no error:', data.valid === true && data.product === 'synthetixcr');

  console.log('\n=== /api/stripe/webhook — customer.subscription.updated derives the product from the ACTUAL price, not stale metadata ===');
  // Simulate a plan switch that happened somewhere our upgrade endpoint
  // wasn't involved (e.g. directly in the Stripe dashboard), where nothing
  // updates subscription metadata — only the Price itself changes. Confirms
  // the 2026-08-20 webhook fix reads the real price instead of trusting a
  // (now stale) metadata.product.
  subAfterUpgrade.items.data[0].price.id = env.STRIPE_PRICE_ID_PROREDACTOR;
  eventBody = JSON.stringify({ type: 'customer.subscription.updated', data: { object: subAfterUpgrade } });
  r = await req('/api/stripe/webhook', { method: 'POST', headers: { 'Stripe-Signature': await signWebhook(eventBody, env.STRIPE_WEBHOOK_SECRET) }, body: eventBody });
  console.log('Webhook response status:', r.status);
  r = await req(`/api/license/refresh?deviceId=${deviceId}`, { method: 'GET' });
  data = await r.json();
  console.log('Product correctly derived from price despite stale metadata (should be proredactor):', data.product);

  console.log('\n=== /api/stripe/webhook — customer.subscription.updated (cancel_at_period_end toggled from the portal) ===');
  const sub = stripeSubscriptions.get(subscriptionId);
  sub.cancel_at_period_end = true;
  eventBody = JSON.stringify({ type: 'customer.subscription.updated', data: { object: sub } });
  r = await req('/api/stripe/webhook', { method: 'POST', headers: { 'Stripe-Signature': await signWebhook(eventBody, env.STRIPE_WEBHOOK_SECRET) }, body: eventBody });
  console.log('Webhook response status:', r.status);
  r = await req(`/api/license/refresh?deviceId=${deviceId}`, { method: 'GET' });
  console.log('cancelAtPeriodEnd now reflected:', (await r.json()).cancelAtPeriodEnd === true);

  console.log('\n=== /api/stripe/webhook — customer.subscription.deleted (period actually ended) ===');
  sub.status = 'canceled';
  eventBody = JSON.stringify({ type: 'customer.subscription.deleted', data: { object: sub } });
  r = await req('/api/stripe/webhook', { method: 'POST', headers: { 'Stripe-Signature': await signWebhook(eventBody, env.STRIPE_WEBHOOK_SECRET) }, body: eventBody });
  console.log('Webhook response status:', r.status);

  console.log('\n=== /api/license/refresh — after cancellation, no fresh token is issued ===');
  r = await req(`/api/license/refresh?deviceId=${deviceId}`, { method: 'GET' });
  data = await r.json();
  console.log('Refresh (canceled — should be valid:false, reason subscription_canceled):', data);

  console.log('\n=== Webhook signature tampering is still rejected ===');
  r = await req('/api/stripe/webhook', { method: 'POST', headers: { 'Stripe-Signature': `t=${Math.floor(Date.now() / 1000)},v1=deadbeef` }, body: eventBody });
  console.log('Tampered signature response status (should be 400):', r.status);

  upstashServer.close(); stripeServer.close();
})();
