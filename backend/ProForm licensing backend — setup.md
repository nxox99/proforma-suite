# ProForm licensing backend — setup

This is a single Cloudflare Worker (`worker.js`) that replaces the old
purely-client-side trial timer and self-computable license key with a
real, tamper-resistant server. No npm dependencies, no bundler — it's
plain JS using `fetch` and the standard Web Crypto API, so you can deploy
it with `wrangler deploy` or paste it straight into the Cloudflare
dashboard's Quick Edit.

## 1. Generate your own signing keypair (don't ship the starter one)

`starter_keys_public_jwk.json` / `starter_keys_private_jwk.json` in this
folder are a **working example keypair** generated during development so
everything here can be tested end-to-end. Treat the private key in that
file as burned — do not use it for a real launch. Generate your own
before going live:

```js
// generate-keys.mjs — run with `node generate-keys.mjs`
const { subtle } = require('crypto').webcrypto;
(async () => {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  console.log('PUBLIC (goes in the Worker secret AND embedded in Index.html):');
  console.log(JSON.stringify(await subtle.exportKey('jwk', kp.publicKey)));
  console.log('\nPRIVATE (Worker secret ONLY — never commit, never put in the app):');
  console.log(JSON.stringify(await subtle.exportKey('jwk', kp.privateKey)));
})();
```

Why ECDSA P-256 and not Ed25519: P-256 verify support in `crypto.subtle`
is available in every browser ProForm already targets (per Manual.html's
existing "Chrome, Edge, Firefox 113+, Safari 16.4+" line), whereas Ed25519
support in Web Crypto is newer and less consistently available. Since the
whole point is that activation must verify **offline, in the browser,
forever**, broad compatibility mattered more here than Ed25519's slightly
smaller keys/signatures.

## 2. Upstash Redis

You said you already have Upstash wired up — reuse that database (or a
dedicated one). Grab the REST URL and token from the Upstash console:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

The worker uses three key patterns, all plain strings/JSON, no setup
needed on the Upstash side beyond having the database exist:

| Key pattern | Value | Purpose |
|---|---|---|
| `trial:<deviceId>` | epoch ms, set once via `NX` | anchors trial start server-side |
| `license:<deviceId>` | JSON `{token,email,deviceId,purchasedAt,sessionId}` | latest issued license per device |
| `license_by_session:<stripeSessionId>` | same JSON | lets purchaseconfirm/receipt pages fetch the key right after Stripe redirects back, before any device-based lookup is possible |
| `lead:<email>` / list `leads:all` | marketing signup info | from the trial-signup form on the website (separate from the technical per-device trial) |

## 3. Resend

- `RESEND_API_KEY` — from the Resend dashboard.
- `RESEND_FROM` — a verified sending address, e.g. `"ProForm <license@yourdomain.com>"`.
- `SUPPORT_TO_EMAIL` — where support.html's contact form delivers messages, e.g. your personal address. The email arrives with Reply-To set to whoever submitted the form, so replying from that inbox goes straight back to them — no separate inbound-mail setup needed for the form itself.

Separately, if you also want `support@proforma-suite.com` to work as a real
mailbox (someone emailing it directly, not through the website form), set
that up with **Cloudflare Email Routing** on the domain's Cloudflare
dashboard (Email → Email Routing → Custom Addresses) — a free, no-code
DNS-level forward straight to your personal inbox. That's unrelated to this
worker and to Resend; Resend's own inbound-email feature exists but is
webhook/API-driven and is overkill for "forward my support address to
Gmail" — Cloudflare's built-in feature is the simpler, purpose-built tool
for that.

## 4. Stripe

1. Create a one-time-payment Price for ProForm in the Stripe dashboard, copy its ID into `STRIPE_PRICE_ID`.
2. Add a webhook endpoint pointing at `https://<your-worker-domain>/api/stripe/webhook`, subscribed to `checkout.session.completed`. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
3. `STRIPE_SECRET_KEY` — your standard secret key (start with the `sk_test_...` one while you wire this up).

## 5. Deploy

```
cd backend
wrangler secret put UPSTASH_REDIS_REST_URL
wrangler secret put UPSTASH_REDIS_REST_TOKEN
wrangler secret put RESEND_API_KEY
wrangler secret put RESEND_FROM
wrangler secret put SUPPORT_TO_EMAIL
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
wrangler secret put STRIPE_PRICE_ID
wrangler secret put LICENSE_PRIVATE_KEY_JWK   # paste the JSON on one line
wrangler secret put LICENSE_PUBLIC_KEY_JWK    # paste the JSON on one line
wrangler deploy
```

Then set `ALLOWED_ORIGINS` in `wrangler.toml` to your real site domain(s)
and attach a route (see the commented-out `routes` block in
`wrangler.toml`) so it's reachable at something like
`https://api.proforma-suite.com`.

## 6. Wire the public key into the app

Take the same `LICENSE_PUBLIC_KEY_JWK` value and paste it into
`Index.html`'s `pfLicense` module (`LICENSE_PUBLIC_JWK` constant near the
top of the module) — see the comment there. This is the only place the
app needs to change when you rotate keys; it never needs the private key.

## 7. Point the front-end at the worker

`Index.html` and the marketing site pages (`trialsignup.html`,
`payment.html`, `purchaseconfirm.html`, `receipt.html`, `downloads.html`,
`support.html`) all read a single `API_BASE` constant near the top of their
scripts. Set it to your deployed worker URL (e.g.
`https://api.proforma-suite.com`) in each file, or serve them from the same
origin as the worker and leave it as `''` (relative paths).

## 8. Host the ProForm app bundle

ProForm ships as 5 files that must stay together in the same folder:
`ProForm.html` itself, plus `README.html`, `Manual.html`, `Tutorial.html`,
and `Legal.html`, which it opens via relative iframe paths from its own
in-app Help menu (`openHelpDoc()`). This is a static-hosting concern, not a
worker one — it lives in the same Cloudflare Pages deployment as the rest
of the marketing site (`site/`), not on the worker.

Recommended path: **`/apps/proform/`** at the Pages project root, alongside
the existing site pages —

```
site/                      ← your Pages deployment root (index.html, store.html, …)
site/apps/proform/
  ProForm.html
  README.html
  Manual.html
  Tutorial.html
  Legal.html
  ProForm-App.zip          ← all 5 files pre-zipped — see below
```

`downloads.html`'s Download button for ProForm points at
`/apps/proform/ProForm-App.zip` and expects it to exist at that exact path
— update that one constant (`appFileMap['dl-proform']` in
`downloads.html`'s script) if you host the bundle somewhere else.

**Why a ZIP and not just linking `ProForm.html` directly:** downloading
`ProForm.html` alone works fine to *open and use immediately in the
browser it was downloaded in*, but the moment the user is offline on their
own machine and clicks a Help/Support link inside the app, those relative
iframe paths need `README.html`/`Manual.html`/`Tutorial.html`/`Legal.html`
sitting in the same local folder — which a single-file download won't
have. Handing out a ZIP of all 5 together avoids that broken-Help
experience. Rebuild the ZIP any time you update any of the 5 files:

```
cd site/apps/proform
zip -X ProForm-App.zip ProForm.html README.html Manual.html Tutorial.html Legal.html
```

Deploy this folder the same way you deploy the rest of `site/` (git push if
your Pages project is git-connected, or drag-and-drop / `wrangler pages
deploy` if you deploy directly) — no separate hosting setup needed, it's
just more static files in the same project.

## What this does *not* change

Your privacy positioning for form content is untouched — none of this
worker ever sees a user's form data, sessions, or custom forms; those
still never leave the user's device. The only things that now cross the
network are: a device fingerprint hash + timestamp (trial anchoring), and
a device fingerprint hash + email (purchase → license issuance). Both
Manual.html and Legal.html have been updated to disclose this precisely —
see the diff in the main ProForm docs.