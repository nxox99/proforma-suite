/**
 * ProForma Suite licensing & trial backend — Cloudflare Worker
 * ────────────────────────────────────────────────────────────────
 * Single-file, dependency-free (no npm install / bundler needed — deploy
 * as-is with `wrangler deploy` or paste into the Cloudflare dashboard's
 * Quick Edit). Talks to Upstash Redis (REST API), Resend (email), and
 * Stripe (REST API, called directly with fetch — no Stripe SDK).
 *
 * BUSINESS MODEL — UPDATED 2026-08-19
 * ────────────────────────────────────
 * ProForma Suite moved from one-time perpetual purchases to monthly
 * subscriptions. Every app (and the Synthetix-CR bundle) is now a
 * recurring Stripe Subscription, not a one-time Checkout payment:
 *   - DOCX Optimizer ............ $4.99/mo   (product slug: docx)
 *   - ProForm Form Manager ...... $10.99/mo  (product slug: proform)
 *   - Synthetix-CR (bundle) ..... $14.99/mo  (product slug: synthetixcr)
 *       Not a separate app — a bundle plan covering DOCX Optimizer AND
 *       ProForm Form Manager under one subscription. There is no
 *       "Synthetix-CR.html" app to download; subscribers download the
 *       two component apps from the Downloads Portal.
 *   - ProRedactor ................ $6.99/mo  (product slug: proredactor)
 *       Pricing/subscribe is live; the app build itself isn't hosted
 *       yet, so its Downloads Portal entry stays "Coming soon."
 * The 30-day free trial is unchanged (still no card required to start).
 * The old 14-day refund policy is gone — subscriptions are cancel
 * anytime, access continues until the end of the current billing period,
 * no prorated/partial-period refunds.
 *
 * WHAT THIS REPLACES
 * ───────────────────
 * Previously, ProForm.html's trial timer lived entirely in localStorage
 * (trivially reset by changing the system clock or clearing site data),
 * and the "premium activation key" was a formula — sha256(machineId +
 * hardcoded suffix) — computable by anyone who reads the shipped HTML
 * file, meaning a paid key never actually had to be paid for. That was
 * fixed with server-issued, ECDSA-signed license tokens (still true here).
 * This revision additionally moves Stripe from one-time `mode: payment`
 * to recurring `mode: subscription`, and makes the checkout/license
 * logic product-aware instead of hardcoded to a single ProForm price.
 *
 * LICENSE TOKEN LIFETIME UNDER SUBSCRIPTIONS
 * ────────────────────────────────────────────
 * A perpetual license could be signed once and verified offline forever.
 * A subscription can lapse, so every signed token now carries a short
 * `exp` (GRACE_PERIOD_DAYS from issuance) — the app is expected to
 * periodically call GET /api/license/refresh while online to get a
 * freshly-signed token (this re-check also re-confirms the subscription
 * is still active with Stripe). If the device stays offline past `exp`,
 * the app should fall back to a degraded/trial-like state rather than
 * trusting a stale token indefinitely — the same "periodic re-check,
 * graceful offline fallback" pattern already used for trial anchoring.
 * NOTE: the actual client-side check of `payload.exp` and the periodic
 * call to /api/license/refresh need to be implemented inside each app's
 * own pfLicense module (e.g. ProForm.html) — that file wasn't part of
 * this update, so this is flagged as a follow-up, not silently assumed
 * done.
 *
 * IN-APP PLAN UPGRADES — ADDED 2026-08-20
 * ─────────────────────────────────────────
 * POST /api/subscription/upgrade lets an already-subscribed device switch
 * products in place (e.g. a DOCX Optimizer subscriber upgrading to the
 * Synthetix-CR bundle from an in-app "Upgrade" button) without canceling
 * and re-subscribing: it swaps the existing Stripe Subscription's price
 * (prorated automatically by Stripe — a credit for unused time on the old
 * price plus a charge for the new one, netted into one adjustment; no new
 * Subscription object, no gap in access, next cycle bills the new price)
 * and immediately re-signs a fresh license token for the new product so
 * the app can unlock instantly rather than waiting on a webhook. Because a
 * subscription's Price can now change without going through Checkout, the
 * `customer.subscription.updated` handler no longer trusts the possibly-
 * stale `product` in Stripe metadata — it derives the product from the
 * subscription's actual current Price ID on every update, which also
 * covers a customer switching plans through Stripe's own hosted Customer
 * Portal (if that's ever enabled) rather than the in-app upgrade button.
 *
 * REQUIRED BINDINGS (wrangler secret / vars — see SETUP.md)
 * ───────────────────────────────────────────────────────────
 *   UPSTASH_REDIS_REST_URL      Upstash Redis REST endpoint
 *   UPSTASH_REDIS_REST_TOKEN    Upstash Redis REST token
 *   RESEND_API_KEY              Resend API key
 *   RESEND_FROM                 e.g. "ProForma Suite <billing@yourdomain.com>"
 *   SUPPORT_TO_EMAIL             Inbox that support.html's contact form delivers to
 *                                (e.g. your personal address — see SETUP.md)
 *   STRIPE_SECRET_KEY           sk_live_... / sk_test_...
 *   STRIPE_WEBHOOK_SECRET       whsec_... (from the Stripe webhook config)
 *   STRIPE_PRICE_ID_DOCX         price_... recurring monthly price, $4.99
 *   STRIPE_PRICE_ID_PROFORM      price_... recurring monthly price, $10.99
 *   STRIPE_PRICE_ID_SYNTHETIXCR  price_... recurring monthly price, $14.99 (bundle)
 *   STRIPE_PRICE_ID_PROREDACTOR  price_... recurring monthly price, $6.99
 *   LICENSE_PRIVATE_KEY_JWK     JSON string, ECDSA P-256 private key (SECRET)
 *   LICENSE_PUBLIC_KEY_JWK      JSON string, ECDSA P-256 public key (not secret,
 *                                but kept here as the single source of truth —
 *                                must match the key embedded in each app's HTML)
 *   ALLOWED_ORIGINS              comma-separated list, e.g.
 *                                "https://proforma-suite.com,https://www.proforma-suite.com"
 *   DOWNLOAD_URL                 URL the app installer is served from
 */

const TRIAL_DAYS = 30;
const GRACE_PERIOD_DAYS = 3; // how long a signed token is valid before the app must re-check online

// Product catalog — single source of truth for what can be subscribed to.
// `priceEnv` names the wrangler secret holding that product's Stripe recurring Price ID.
// `bundleOf` documents that Synthetix-CR is a pricing bundle, not separate software.
const PRODUCTS = {
  docx:        { name: 'DOCX Optimizer',        priceEnv: 'STRIPE_PRICE_ID_DOCX' },
  proform:     { name: 'ProForm Form Manager',   priceEnv: 'STRIPE_PRICE_ID_PROFORM' },
  synthetixcr: { name: 'Synthetix-CR',           priceEnv: 'STRIPE_PRICE_ID_SYNTHETIXCR', bundleOf: ['docx', 'proform'] },
  proredactor: { name: 'ProRedactor',            priceEnv: 'STRIPE_PRICE_ID_PROREDACTOR' },
};

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
// `exp` is a short client re-check window (GRACE_PERIOD_DAYS), NOT the
// subscription's actual renewal date — the server is always the source of
// truth for whether a subscription is still active (see handleLicenseRefresh).
async function signLicense(env, deviceId, email, product) {
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    mid: deviceId,
    p: product,
    iat: nowSec,
    exp: nowSec + GRACE_PERIOD_DAYS * 86400,
  };
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
  if (!PRODUCTS[payload.p]) return { valid: false, reason: 'unknown_product' };
  if (deviceId && payload.mid !== deviceId) return { valid: false, reason: 'device_mismatch' };
  const nowSec = Math.floor(Date.now() / 1000);
  const expired = !!payload.exp && nowSec > payload.exp;
  // Signature-valid but past its short re-check window: still reported as
  // `valid: true` (the signature itself is genuine) with `expired: true` so
  // callers know the app needs to re-confirm subscription status online via
  // /api/license/refresh rather than trusting this token indefinitely.
  return { valid: true, expired, payload };
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
    if (v === undefined) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) parts.push(formEncode(v, key));
    else if (Array.isArray(v)) v.forEach((item, i) => parts.push(formEncode(item, `${key}[${i}]`)));
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return parts.join('&');
}
async function stripeRequest(env, method, path, body) {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Stripe error: ${JSON.stringify(data)}`);
  return data;
}
async function stripeCreateCheckoutSession(env, { deviceId, email, product, successUrl, cancelUrl }) {
  const priceId = env[PRODUCTS[product].priceEnv];
  const body = formEncode({
    mode: 'subscription',
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': 1,
    success_url: successUrl,
    cancel_url: cancelUrl,
    customer_email: email || undefined,
    'metadata[deviceId]': deviceId,
    'metadata[product]': product,
    // Copy the same metadata onto the Subscription object itself, since
    // subscription lifecycle webhooks (customer.subscription.updated /
    // .deleted) receive the Subscription, not the Checkout Session.
    'subscription_data[metadata][deviceId]': deviceId,
    'subscription_data[metadata][product]': product,
  });
  return stripeRequest(env, 'POST', 'checkout/sessions', body);
}
async function stripeRetrieveSession(env, sessionId) {
  return stripeRequest(env, 'GET', `checkout/sessions/${encodeURIComponent(sessionId)}`);
}
async function stripeRetrieveSubscription(env, subscriptionId) {
  return stripeRequest(env, 'GET', `subscriptions/${encodeURIComponent(subscriptionId)}`);
}
async function stripeCreateBillingPortalSession(env, { customerId, returnUrl }) {
  const body = formEncode({ customer: customerId, return_url: returnUrl });
  return stripeRequest(env, 'POST', 'billing_portal/sessions', body);
}
// Swap an existing Subscription's price in place (upgrade/downgrade between
// plans) — Stripe prorates automatically (default proration_behavior).
// Also writes the new product onto the Subscription's metadata so future
// `customer.subscription.updated` events carry it forward as a fallback,
// even though the primary source of truth is the Price ID itself (see
// priceIdToProduct below).
async function stripeUpdateSubscriptionItemPrice(env, { subscriptionId, itemId, newPriceId, newProduct }) {
  const body = formEncode({
    'items[0][id]': itemId,
    'items[0][price]': newPriceId,
    proration_behavior: 'create_prorations',
    'metadata[product]': newProduct,
  });
  return stripeRequest(env, 'POST', `subscriptions/${encodeURIComponent(subscriptionId)}`, body);
}
// Reverse-lookup: given a Stripe Price ID actually attached to a
// subscription right now, find which PRODUCTS key it belongs to. This is
// the source of truth for "what is this device currently entitled to" —
// safer than trusting Subscription metadata, which only gets set at
// Checkout time or by our own upgrade endpoint and could otherwise go
// stale if a plan is ever switched some other way (e.g. directly in the
// Stripe dashboard, or via the hosted Customer Portal).
function priceIdToProduct(env, priceId) {
  for (const [key, def] of Object.entries(PRODUCTS)) {
    if (env[def.priceEnv] === priceId) return key;
  }
  return null;
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
// computed from Upstash's own clock — not the caller's. Unchanged by the
// move to subscriptions: every app still gets a full 30-day, no-card trial.
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

// POST /api/trial/lead — marketing-site lead capture (name/email/phone/interest/app).
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

// POST /api/checkout/create  { deviceId, email, product }
// `product` must be one of the PRODUCTS keys (docx / proform / synthetixcr /
// proredactor) — the marketing site's payment.html now sends this based on
// the ?app= it was opened with.
async function handleCheckoutCreate(req, env) {
  const { deviceId, email, product } = await req.json();
  if (!deviceId) return json({ error: 'deviceId required' }, 400, req, env);
  if (!product || !PRODUCTS[product]) return json({ error: 'unknown_product' }, 400, req, env);
  if (!env[PRODUCTS[product].priceEnv]) return json({ error: 'product_not_configured' }, 500, req, env);
  const origin = req.headers.get('Origin') || '';
  const successUrl = `${origin}/purchaseconfirm.html?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${origin}/payment.html`;
  const session = await stripeCreateCheckoutSession(env, { deviceId, email, product, successUrl, cancelUrl });
  return json({ url: session.url }, 200, req, env);
}

// Shared helper: given a Checkout Session (subscription mode) that has just
// completed or is being polled for, issue/refresh the signed license and
// persist the license record. Used by both the webhook and the by-session
// polling fallback.
async function issueLicenseFromSession(env, session) {
  const deviceId = session.metadata && session.metadata.deviceId;
  const product  = session.metadata && session.metadata.product;
  if (!deviceId || !PRODUCTS[product]) return null;
  const email = session.customer_details ? session.customer_details.email : session.customer_email;
  const subscription = session.subscription ? await stripeRetrieveSubscription(env, session.subscription) : null;
  const token = await signLicense(env, deviceId, email, product);
  const record = {
    token,
    email,
    deviceId,
    product,
    customerId: subscription ? subscription.customer : session.customer,
    subscriptionId: session.subscription || null,
    status: subscription ? subscription.status : 'active',
    currentPeriodEnd: subscription ? subscription.current_period_end : null,
    cancelAtPeriodEnd: subscription ? !!subscription.cancel_at_period_end : false,
    purchasedAt: Date.now(),
    sessionId: session.id,
  };
  await upstash(env, ['SET', `license:${deviceId}`, JSON.stringify(record)]);
  await upstash(env, ['SET', `license_by_session:${session.id}`, JSON.stringify(record)]);
  if (email) {
    const productName = PRODUCTS[product].name;
    const amount = typeof session.amount_total === 'number' ? (session.amount_total / 100).toFixed(2) : null;
    await sendEmail(env, {
      to: email,
      subject: `Your ${productName} subscription is active`,
      html: `<p>Thanks for subscribing to ${productName}!</p>`
          + `<p>Your license key (paste it into the app's Activation dialog):</p>`
          + `<p style="font-family:monospace;font-size:13px;word-break:break-all;background:#f5f5f7;padding:12px;border-radius:8px">${token}</p>`
          + `<p>This key is tied to the device you subscribed from and activates instantly, offline, once entered.</p>`
          + (amount ? `<p>You'll be billed $${amount}/month until you cancel. Cancel anytime — access continues until the end of your current billing period.</p>` : '')
          + (PRODUCTS[product].bundleOf ? `<p>Your Synthetix-CR bundle covers both DOCX Optimizer and ProForm Form Manager — download either (or both) from the Downloads Portal.</p>` : ''),
    });
  }
  return record;
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
    if (session.mode === 'subscription') {
      await issueLicenseFromSession(env, session);
    }
  }

  // Renewal, plan change (including an in-app upgrade or a switch made
  // through Stripe's own Customer Portal), or "cancel at period end" flag
  // toggled — re-sync our cached status/period-end and, if the
  // subscription is still in good standing, extend the client's token.
  if (event.type === 'customer.subscription.updated') {
    const sub = event.data.object;
    const deviceId = sub.metadata && sub.metadata.deviceId;
    // Source of truth for the product is the subscription's actual current
    // Price ID, not the metadata — metadata is only ever set at Checkout
    // time or by our own upgrade endpoint, and would go stale if the price
    // changed some other way. Fall back to metadata.product only if the
    // current price doesn't match any known PRODUCTS entry (shouldn't
    // normally happen, but avoids losing the device entirely in that case).
    const currentPriceId = sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].price
      ? sub.items.data[0].price.id : null;
    const product = (currentPriceId && priceIdToProduct(env, currentPriceId)) || (sub.metadata && sub.metadata.product);
    if (deviceId && PRODUCTS[product]) {
      const stored = await upstash(env, ['GET', `license:${deviceId}`]);
      const record = stored ? JSON.parse(stored) : { deviceId, product };
      const productChanged = record.product && record.product !== product;
      record.product = product;
      record.status = sub.status;
      record.currentPeriodEnd = sub.current_period_end;
      record.cancelAtPeriodEnd = !!sub.cancel_at_period_end;
      record.customerId = sub.customer;
      record.subscriptionId = sub.id;
      if (sub.status === 'active' || sub.status === 'trialing') {
        record.token = await signLicense(env, deviceId, record.email, product);
      }
      await upstash(env, ['SET', `license:${deviceId}`, JSON.stringify(record)]);
      if (productChanged && record.email) {
        await sendEmail(env, {
          to: record.email,
          subject: `Your ProForma Suite plan changed to ${PRODUCTS[product].name}`,
          html: `<p>Your subscription now covers ${PRODUCTS[product].name}. Your license key updated automatically — reopen the app (or use its "check for updates" / refresh action) to pick up the change.</p>`,
        });
      }
    }
  }

  // Subscription has actually ended (Stripe fires this once the canceled
  // subscription reaches the end of its final billing period, not the
  // moment the user clicks "cancel" — which is exactly the "access
  // continues until period end" behavior promised in the Terms of Use).
  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    const deviceId = sub.metadata && sub.metadata.deviceId;
    if (deviceId) {
      const stored = await upstash(env, ['GET', `license:${deviceId}`]);
      if (stored) {
        const record = JSON.parse(stored);
        record.status = 'canceled';
        record.canceledAt = Date.now();
        // Intentionally do NOT reissue a token — the last-issued token will
        // simply run out its GRACE_PERIOD_DAYS and stop refreshing.
        await upstash(env, ['SET', `license:${deviceId}`, JSON.stringify(record)]);
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
        const record = await issueLicenseFromSession(env, session);
        if (record) stored = JSON.stringify(record);
      }
    } catch (e) { console.error(e); }
  }
  if (!stored) return json({ error: 'not_found' }, 404, req, env);
  return json(JSON.parse(stored), 200, req, env);
}

// GET /api/license/verify?deviceId=...&key=...
// Informational signature/product check — see downloads.html's "Validate
// Key" box. Does NOT hit Stripe, so a canceled subscription's last token
// will still verify here until its short `exp` window lapses; treat
// `expired: true` in the response as "re-confirm inside the app."
async function handleLicenseVerify(req, env, url) {
  const deviceId = url.searchParams.get('deviceId');
  const key = url.searchParams.get('key');
  const result = await verifyLicense(env, key, deviceId);
  return json(result, 200, req, env);
}

// GET /api/license/refresh?deviceId=...
// The real subscription-aware check: looks up the device's subscription
// with Stripe directly (not just the cached Upstash record) and, if it's
// still active/trialing, issues a freshly-dated token. This is what each
// app's client should call periodically while online (see the module
// doc-comment above re: ProForm.html follow-up work).
async function handleLicenseRefresh(req, env, url) {
  const deviceId = url.searchParams.get('deviceId');
  if (!deviceId) return json({ error: 'deviceId required' }, 400, req, env);
  const stored = await upstash(env, ['GET', `license:${deviceId}`]);
  if (!stored) return json({ valid: false, reason: 'no_subscription' }, 200, req, env);
  const record = JSON.parse(stored);
  if (!record.subscriptionId) return json({ valid: false, reason: 'no_subscription' }, 200, req, env);

  let sub;
  try {
    sub = await stripeRetrieveSubscription(env, record.subscriptionId);
  } catch (e) {
    console.error(e);
    return json({ error: 'stripe_unreachable' }, 502, req, env);
  }

  record.status = sub.status;
  record.currentPeriodEnd = sub.current_period_end;
  record.cancelAtPeriodEnd = !!sub.cancel_at_period_end;

  if (sub.status !== 'active' && sub.status !== 'trialing') {
    await upstash(env, ['SET', `license:${deviceId}`, JSON.stringify(record)]);
    return json({ valid: false, reason: `subscription_${sub.status}` }, 200, req, env);
  }

  record.token = await signLicense(env, deviceId, record.email, record.product);
  await upstash(env, ['SET', `license:${deviceId}`, JSON.stringify(record)]);
  return json({
    valid: true,
    token: record.token,
    product: record.product,
    currentPeriodEnd: record.currentPeriodEnd,
    cancelAtPeriodEnd: record.cancelAtPeriodEnd,
  }, 200, req, env);
}

// POST /api/billing/portal  { deviceId }
// Returns a Stripe-hosted Billing Portal URL where the subscriber can
// update payment info or cancel — this is the "cancel anytime" mechanism
// referenced across terms.html/eula.html/faq.html.
async function handleBillingPortal(req, env) {
  const { deviceId } = await req.json();
  if (!deviceId) return json({ error: 'deviceId required' }, 400, req, env);
  const stored = await upstash(env, ['GET', `license:${deviceId}`]);
  if (!stored) return json({ error: 'no_subscription' }, 404, req, env);
  const record = JSON.parse(stored);
  if (!record.customerId) return json({ error: 'no_customer' }, 404, req, env);
  const origin = req.headers.get('Origin') || '';
  const session = await stripeCreateBillingPortalSession(env, {
    customerId: record.customerId,
    returnUrl: `${origin}/downloads.html`,
  });
  return json({ url: session.url }, 200, req, env);
}

// POST /api/subscription/upgrade  { deviceId, newProduct }
// Self-service, in-app plan switch — e.g. an "Upgrade to the Synthetix-CR
// bundle" button inside DOCX Optimizer for someone already subscribed to
// DOCX Optimizer alone. Swaps the existing Subscription's price (Stripe
// prorates automatically) rather than canceling and re-subscribing, then
// immediately re-signs a fresh token so the calling app can unlock without
// waiting for the webhook to land. Generic across any PRODUCTS pair — not
// hardcoded to docx→synthetixcr — so it also covers e.g. a later
// downgrade, or upgrading into ProRedactor.
async function handleSubscriptionUpgrade(req, env) {
  const { deviceId, newProduct } = await req.json();
  if (!deviceId) return json({ error: 'deviceId required' }, 400, req, env);
  if (!newProduct || !PRODUCTS[newProduct]) return json({ error: 'unknown_product' }, 400, req, env);
  if (!env[PRODUCTS[newProduct].priceEnv]) return json({ error: 'product_not_configured' }, 500, req, env);

  const stored = await upstash(env, ['GET', `license:${deviceId}`]);
  if (!stored) return json({ error: 'no_subscription' }, 404, req, env);
  const record = JSON.parse(stored);
  if (!record.subscriptionId) return json({ error: 'no_subscription' }, 404, req, env);

  // Already on the requested plan — idempotent no-op, just hand back a
  // fresh token rather than round-tripping Stripe for nothing.
  if (record.product === newProduct && (record.status === 'active' || record.status === 'trialing')) {
    record.token = await signLicense(env, deviceId, record.email, newProduct);
    await upstash(env, ['SET', `license:${deviceId}`, JSON.stringify(record)]);
    return json({
      valid: true, token: record.token, product: record.product,
      currentPeriodEnd: record.currentPeriodEnd, cancelAtPeriodEnd: record.cancelAtPeriodEnd,
    }, 200, req, env);
  }

  let sub;
  try {
    sub = await stripeRetrieveSubscription(env, record.subscriptionId);
  } catch (e) {
    console.error(e);
    return json({ error: 'stripe_unreachable' }, 502, req, env);
  }
  if (sub.status !== 'active' && sub.status !== 'trialing') {
    return json({ valid: false, reason: `subscription_${sub.status}` }, 200, req, env);
  }
  const itemId = sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].id;
  if (!itemId) return json({ error: 'subscription_item_not_found' }, 500, req, env);

  let updatedSub;
  try {
    updatedSub = await stripeUpdateSubscriptionItemPrice(env, {
      subscriptionId: record.subscriptionId,
      itemId,
      newPriceId: env[PRODUCTS[newProduct].priceEnv],
      newProduct,
    });
  } catch (e) {
    console.error(e);
    return json({ error: 'stripe_update_failed' }, 502, req, env);
  }

  record.product = newProduct;
  record.status = updatedSub.status;
  record.currentPeriodEnd = updatedSub.current_period_end;
  record.cancelAtPeriodEnd = !!updatedSub.cancel_at_period_end;
  record.token = await signLicense(env, deviceId, record.email, newProduct);
  await upstash(env, ['SET', `license:${deviceId}`, JSON.stringify(record)]);

  if (record.email) {
    await sendEmail(env, {
      to: record.email,
      subject: `You're now on the ${PRODUCTS[newProduct].name} plan`,
      html: `<p>Your ProForma Suite subscription is now ${PRODUCTS[newProduct].name}, billed monthly. Any prorated adjustment for the switch has already been applied to your Stripe account — no action needed from you.</p>`
          + (PRODUCTS[newProduct].bundleOf ? `<p>Your Synthetix-CR bundle covers both DOCX Optimizer and ProForm Form Manager — download either (or both) from the Downloads Portal.</p>` : ''),
    });
  }

  return json({
    valid: true,
    token: record.token,
    product: record.product,
    currentPeriodEnd: record.currentPeriodEnd,
    cancelAtPeriodEnd: record.cancelAtPeriodEnd,
  }, 200, req, env);
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
      if (url.pathname === '/api/license/refresh' && req.method === 'GET') return await handleLicenseRefresh(req, env, url);
      if (url.pathname === '/api/billing/portal' && req.method === 'POST') return await handleBillingPortal(req, env);
      if (url.pathname === '/api/subscription/upgrade' && req.method === 'POST') return await handleSubscriptionUpgrade(req, env);
      return json({ error: 'not_found' }, 404, req, env);
    } catch (err) {
      console.error(err);
      return json({ error: 'server_error', message: String(err && err.message || err) }, 500, req, env);
    }
  },
};
