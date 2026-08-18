/**
 * ProForm licensing & trial backend — Cloudflare Worker
 * ────────────────────────────────────────────────────────────────
 * Single-file, dependency-free (no npm install / bundler needed — deploy
 * as-is with `wrangler deploy` or paste into the Cloudflare dashboard's
 * Quick Edit). Talks to Upstash Redis (REST API), Resend (email), and
 * Stripe (REST API, called directly with fetch — no Stripe SDK).
 *
 * WHAT THIS REPLACES
 * ───────────────────
 * Previously, ProForm.html's trial timer lived entirely in localStorage
 * (trivially reset by changing the system clock or clearing site data),
 * and the "premium activation key" was a formula — sha256(machineId +
 * hardcoded suffix) — computable by anyone who reads the shipped HTML
 * file, meaning a paid key never actually had to be paid for.
 *
 * This worker fixes both:
 *  - Trial start is anchored server-side per device fingerprint (NX-set
 *    in Upstash, so it can only ever be set once) and re-verified against
 *    server time on every launch the app is online for. Offline launches
 *    fall back to the last confirmed state, so the app still works fully
 *    offline between check-ins — this is a hardening, not a "must be
 *    online always" requirement.
 *  - License keys are now ECDSA P-256 signed tokens, generated only by
 *    this worker (which holds the private key as a secret) after a real
 *    Stripe payment. The app verifies the signature offline using Web
 *    Crypto and an embedded PUBLIC key — forging a valid token without
 *    the private key is computationally infeasible, unlike the old
 *    formula.
 *
 * REQUIRED BINDINGS (wrangler secret / vars — see SETUP.md)
 * ───────────────────────────────────────────────────────────
 *   UPSTASH_REDIS_REST_URL      Upstash Redis REST endpoint
 *   UPSTASH_REDIS_REST_TOKEN    Upstash Redis REST token
 *   RESEND_API_KEY              Resend API key
 *   RESEND_FROM                 e.g. "ProForm <license@yourdomain.com>"
 *   SUPPORT_TO_EMAIL             Inbox that support.html's contact form delivers to
 *                                (e.g. your personal address — see SETUP.md)
 *   STRIPE_SECRET_KEY           sk_live_... / sk_test_...
 *   STRIPE_WEBHOOK_SECRET       whsec_... (from the Stripe webhook config)
 *   STRIPE_PRICE_ID             price_... for the one-time ProForm purchase
 *   LICENSE_PRIVATE_KEY_JWK     JSON string, ECDSA P-256 private key (SECRET)
 *   LICENSE_PUBLIC_KEY_JWK      JSON string, ECDSA P-256 public key (not secret,
 *                                but kept here as the single source of truth —
 *                                must match the key embedded in Index.html)
 *   ALLOWED_ORIGINS              comma-separated list, e.g.
 *                                "https://proforma-suite.com,https://www.proforma-suite.com"
 *   DOWNLOAD_URL                 URL the app installer is served from
 */

const TRIAL_DAYS = 30;
const PRODUCT = 'proform';

// ── CORS ─────────────────────────────────────────────────────────────────
function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const allowOrigin = allowed.includes(origin) ? origin : (allowed[0] || '*');
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Stripe-Signature',
    'Vary': 'Origin',
  };
}
function json(data, status, req, env) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(req, env) },
  });
}

// ── Upstash Redis REST helper ───────────────────────────────────────────
async function upstash(env, commands) {
  const r = await fetch(env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw new Error(`Upstash error ${r.status}: ${await r.text()}`);
  const { result, error } = await r.json();
  if (error) throw new Error(`Upstash command error: ${error}`);
  return result;
}

// ── base64url helpers ───────────────────────────────────────────────────
function b64urlEncode(bytes) {
  let bin = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

// ── License token: sign / verify (ECDSA P-256, raw r||s signature) ─────
async function importPrivateKey(env) {
  const jwk = JSON.parse(env.LICENSE_PRIVATE_KEY_JWK);
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}
async function importPublicKey(env) {
  const jwk = JSON.parse(env.LICENSE_PUBLIC_KEY_JWK);
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
}
async function signLicense(env, deviceId, email) {
  const payload = { v: 1, mid: deviceId, p: PRODUCT, iat: Math.floor(Date.now() / 1000) };
  const payloadB64 = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `v1.${payloadB64}`;
  const key = await importPrivateKey(env);
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${b64urlEncode(sig)}`;
}
async function verifyLicense(env, token, deviceId) {
  const parts = (token || '').trim().split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return { valid: false, reason: 'malformed' };
  const [ver, payloadB64, sigB64] = parts;
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64))); }
  catch { return { valid: false, reason: 'malformed' }; }
  const key = await importPublicKey(env);
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, key, b64urlDecode(sigB64),
    new TextEncoder().encode(`${ver}.${payloadB64}`)
  );
  if (!ok) return { valid: false, reason: 'bad_signature' };
  if (payload.p !== PRODUCT) return { valid: false, reason: 'wrong_product' };
  if (deviceId && payload.mid !== deviceId) return { valid: false, reason: 'device_mismatch' };
  return { valid: true, payload };
}

// ── Resend ───────────────────────────────────────────────────────────────
async function sendEmail(env, { to, subject, html, replyTo }) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.RESEND_FROM, to, subject, html, ...(replyTo ? { reply_to: replyTo } : {}) }),
  });
  if (!r.ok) console.error('Resend error', r.status, await r.text());
  return r.ok;
}

// ── Stripe (raw REST, no SDK) ───────────────────────────────────────────
function formEncode(obj, prefix) {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) parts.push(formEncode(v, key));
    else if (Array.isArray(v)) v.forEach((item, i) => parts.push(formEncode(item, `${key}[${i}]`)));
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return parts.join('&');
}
async function stripeCreateCheckoutSession(env, { deviceId, email, successUrl, cancelUrl }) {
  const body = formEncode({
    mode: 'payment',
    'line_items[0][price]': env.STRIPE_PRICE_ID,
    'line_items[0][quantity]': 1,
    success_url: successUrl,
    cancel_url: cancelUrl,
    customer_email: email || undefined,
    'metadata[deviceId]': deviceId,
    'metadata[product]': PRODUCT,
  });
  const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Stripe error: ${JSON.stringify(data)}`);
  return data; // { id, url, ... }
}
async function stripeRetrieveSession(env, sessionId) {
  const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Stripe error: ${JSON.stringify(data)}`);
  return data;
}

// Verify a Stripe webhook signature manually (HMAC-SHA256), so no SDK is needed.
async function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) return false;
  const signedPayload = `${timestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const expectedHex = bytesToHex(new Uint8Array(mac));
  // Constant-time-ish compare
  if (expectedHex.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expectedHex.length; i++) diff |= expectedHex.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

// ── Route handlers ──────────────────────────────────────────────────────

// POST /api/trial/check  { deviceId }
// Idempotently registers the trial start (first call ever for a device
// wins, via Redis SETNX) and always returns the authoritative status
// computed from Upstash's own clock — not the caller's.
async function handleTrialCheck(req, env) {
  const { deviceId } = await req.json();
  if (!deviceId || typeof deviceId !== 'string' || deviceId.length < 8) {
    return json({ error: 'invalid deviceId' }, 400, req, env);
  }
  const nowMs = Date.now();
  await upstash(env, ['SET', `trial:${deviceId}`, String(nowMs), 'NX']);
  const stored = await upstash(env, ['GET', `trial:${deviceId}`]);
  const trialStart = parseInt(stored, 10);
  const daysElapsed = (nowMs - trialStart) / 86400000;
  const daysLeft = Math.max(0, Math.ceil(TRIAL_DAYS - daysElapsed));
  return json({ trialStart, trialDays: TRIAL_DAYS, daysLeft, serverNow: nowMs }, 200, req, env);
}

// POST /api/trial/lead — marketing-site lead capture (name/email/phone/interest).
// Independent of the technical per-device trial above; just gets the lead
// into Upstash + fires a welcome email via Resend so the signup form on
// the website actually does something instead of only writing localStorage.
async function handleTrialLead(req, env) {
  const body = await req.json();
  const { firstName, lastName, email, phone, interest, app } = body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'invalid email' }, 400, req, env);
  }
  const record = { firstName, lastName, email, phone, interest, app, createdAt: Date.now() };
  await upstash(env, ['SET', `lead:${email}`, JSON.stringify(record)]);
  await upstash(env, ['LPUSH', 'leads:all', email]);
  await sendEmail(env, {
    to: email,
    subject: `Your ${app || 'ProForma Suite'} trial has started`,
    html: `<p>Hi ${firstName || 'there'},</p><p>Thanks for trying ${app || 'ProForma Suite'}. Your ${TRIAL_DAYS}-day trial begins the moment you first open the app — download it any time from the Downloads page.</p>`,
  });
  return json({ ok: true }, 200, req, env);
}

// POST /api/support/send — support.html's contact form. Sends the message
// to the ProForma Suite support inbox (SUPPORT_TO_EMAIL) via Resend, with
// Reply-To set to the visitor's own address so replying from that inbox
// goes straight back to them — no separate inbound-email setup needed for
// this form specifically. Also fires a short best-effort acknowledgment
// back to the visitor; its failure doesn't fail the request, since the
// support message itself already went through.
async function handleSupportSend(req, env) {
  const body = await req.json().catch(() => null);
  const { name, email, subject, message } = body || {};

  if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'invalid email' }, 400, req, env);
  }
  if (!message || typeof message !== 'string' || !message.trim()) {
    return json({ error: 'message required' }, 400, req, env);
  }
  if (message.length > 5000) {
    return json({ error: 'message too long' }, 400, req, env);
  }
  if (!env.SUPPORT_TO_EMAIL) {
    return json({ error: 'support_inbox_not_configured' }, 500, req, env);
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeName    = (name || 'there').toString().slice(0, 200);
  const safeSubject = (subject || 'Support request').toString().slice(0, 200);

  const sent = await sendEmail(env, {
    to: env.SUPPORT_TO_EMAIL,
    replyTo: email,
    subject: `[Support] ${safeSubject} — from ${safeName}`,
    html: `<p><strong>From:</strong> ${esc(safeName)} (${esc(email)})</p>`
        + `<p><strong>Subject:</strong> ${esc(safeSubject)}</p>`
        + `<p>${esc(message).replace(/\n/g, '<br>')}</p>`,
  });
  if (!sent) return json({ error: 'send_failed' }, 502, req, env);

  await sendEmail(env, {
    to: email,
    subject: `We received your message — ${safeSubject}`,
    html: `<p>Hi ${esc(safeName)},</p>`
        + `<p>Thanks for reaching out to ProForma Suite support. We received your message and will get back to you within 24–48 hours, Monday to Friday.</p>`
        + `<p>— ProForma Suite</p>`,
  });

  return json({ ok: true }, 200, req, env);
}

// POST /api/checkout/create  { deviceId, email }
async function handleCheckoutCreate(req, env) {
  const { deviceId, email } = await req.json();
  if (!deviceId) return json({ error: 'deviceId required' }, 400, req, env);
  const origin = req.headers.get('Origin') || '';
  const successUrl = `${origin}/purchaseconfirm.html?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${origin}/payment.html`;
  const session = await stripeCreateCheckoutSession(env, { deviceId, email, successUrl, cancelUrl });
  return json({ url: session.url }, 200, req, env);
}

// POST /api/stripe/webhook — Stripe calls this directly (raw body + signature header)
async function handleStripeWebhook(req, env) {
  const rawBody = await req.text();
  const sig = req.headers.get('Stripe-Signature');
  const ok = await verifyStripeSignature(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!ok) return new Response('Invalid signature', { status: 400 });

  const event = JSON.parse(rawBody);
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const deviceId = session.metadata && session.metadata.deviceId;
    const email = session.customer_details ? session.customer_details.email : session.customer_email;
    if (deviceId) {
      const token = await signLicense(env, deviceId, email);
      const record = { token, email, deviceId, purchasedAt: Date.now(), sessionId: session.id };
      await upstash(env, ['SET', `license:${deviceId}`, JSON.stringify(record)]);
      await upstash(env, ['SET', `license_by_session:${session.id}`, JSON.stringify(record)]);
      if (email) {
        await sendEmail(env, {
          to: email,
          subject: 'Your ProForm license key',
          html: `<p>Thanks for purchasing ProForm!</p><p>Your license key (paste it into the app's Activation dialog):</p><p style="font-family:monospace;font-size:13px;word-break:break-all;background:#f5f5f7;padding:12px;border-radius:8px">${token}</p><p>This key is tied to the device you purchased from and activates instantly, offline, once entered.</p>`,
        });
      }
    }
  }
  return new Response('ok', { status: 200 });
}

// GET /api/license/by-session?session_id=...
// Used by purchaseconfirm.html / receipt.html right after the Stripe redirect.
async function handleLicenseBySession(req, env, url) {
  const sessionId = url.searchParams.get('session_id');
  if (!sessionId) return json({ error: 'session_id required' }, 400, req, env);
  let stored = await upstash(env, ['GET', `license_by_session:${sessionId}`]);
  if (!stored) {
    // Webhook may not have landed yet (rare race) — confirm directly with Stripe as a fallback.
    try {
      const session = await stripeRetrieveSession(env, sessionId);
      if (session.payment_status === 'paid' && session.metadata && session.metadata.deviceId) {
        const token = await signLicense(env, session.metadata.deviceId, session.customer_details?.email);
        const record = { token, email: session.customer_details?.email, deviceId: session.metadata.deviceId, purchasedAt: Date.now(), sessionId };
        await upstash(env, ['SET', `license:${session.metadata.deviceId}`, JSON.stringify(record)]);
        await upstash(env, ['SET', `license_by_session:${sessionId}`, JSON.stringify(record)]);
        stored = JSON.stringify(record);
      }
    } catch (e) { console.error(e); }
  }
  if (!stored) return json({ error: 'not_found' }, 404, req, env);
  return json(JSON.parse(stored), 200, req, env);
}

// GET /api/license/verify?deviceId=...&key=...
async function handleLicenseVerify(req, env, url) {
  const deviceId = url.searchParams.get('deviceId');
  const key = url.searchParams.get('key');
  const result = await verifyLicense(env, key, deviceId);
  return json(result, 200, req, env);
}

// ── Router ───────────────────────────────────────────────────────────────
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(req, env) });

    try {
      if (url.pathname === '/api/trial/check' && req.method === 'POST') return await handleTrialCheck(req, env);
      if (url.pathname === '/api/trial/lead' && req.method === 'POST') return await handleTrialLead(req, env);
      if (url.pathname === '/api/support/send' && req.method === 'POST') return await handleSupportSend(req, env);
      if (url.pathname === '/api/checkout/create' && req.method === 'POST') return await handleCheckoutCreate(req, env);
      if (url.pathname === '/api/stripe/webhook' && req.method === 'POST') return await handleStripeWebhook(req, env);
      if (url.pathname === '/api/license/by-session' && req.method === 'GET') return await handleLicenseBySession(req, env, url);
      if (url.pathname === '/api/license/verify' && req.method === 'GET') return await handleLicenseVerify(req, env, url);
      return json({ error: 'not_found' }, 404, req, env);
    } catch (err) {
      console.error(err);
      return json({ error: 'server_error', message: String(err && err.message || err) }, 500, req, env);
    }
  },
};