# ProForma Suite licensing backend — setup

This is a single Cloudflare Worker (`worker.js`) that replaces the old
purely-client-side trial timer and self-computable license key with a
real, tamper-resistant server. No npm dependencies, no bundler needed — it's
plain JS using `fetch` and the standard Web Crypto API, so you can deploy
it with `wrangler deploy` or paste it straight into the Cloudflare
dashboard's Quick Edit.

**2026-08-19 update:** the business model moved from one-time perpetual
purchases to monthly subscriptions across four plans (DOCX Optimizer
$4.99/mo, ProForm Form Manager $10.99/mo, Synthetix-CR bundle $14.99/mo,
ProRedactor $6.99/mo — Synthetix-CR is the DOCX Optimizer + ProForm Form
Manager bundle plan, not a separate app). Everything below reflects that;
if you're re-reading this after the earlier one-time-purchase version,
the main differences are: Stripe Checkout now runs in `mode: subscription`
instead of `mode: payment`, there are four Price IDs instead of one, and
there are two new endpoints (`/api/license/refresh`, `/api/billing/portal`)
plus two new webhook events to subscribe to.

**2026-08-20 update — in-app plan upgrades, and DOCX Optimizer now has real
licensing:**
- New endpoint `POST /api/subscription/upgrade` `{deviceId, newProduct}` —
  lets an already-subscribed device switch plans in place (e.g. a DOCX
  Optimizer subscriber upgrading to the Synthetix-CR bundle from a
  "Send to ProForm Form Manager" upsell) by swapping the existing Stripe
  Subscription's price with proration, rather than canceling and
  re-subscribing. No new secrets needed.
- The `customer.subscription.updated` webhook handler now derives the
  device's product from the subscription's *actual current Price ID*
  instead of trusting Subscription metadata, which could otherwise go
  stale after a plan switch. No config change needed — this is purely a
  `worker.js` behavior fix.
- **DOCX Optimizer had no trial/license system at all before this** — it
  was a fully offline, ungated tool. It now has one: `docx-optimizer/
  dxLicense.js` (device-anchored trial + signed-token activation + the
  `exp`/periodic-refresh check, mirroring ProForm.html's `pfLicense`) and
  `docx-optimizer/dxLicenseUI.js` (the header status pill, the License/
  paywall modal, and the "Upgrade to Synthetix-CR Bundle" button). `app.js`
  gates the Clean and Download actions behind `dxLicense.isPremium()`.
  Uses the same deployed Worker and the same public verify-only key as
  ProForm.html — nothing new to deploy on the backend for this.
- **Bug fixed in ProForm.html's `pfLicense`:** its license check used to
  require an exact `payload.p === 'proform'` match, which meant it would
  incorrectly *reject* a legitimate Synthetix-CR bundle subscriber's token.
  It now accepts either `proform` or `synthetixcr` (see `ACCEPTED_PRODUCTS`
  near the top of the `pfLicense` module). `dxLicense.js` was written with
  the equivalent multi-product acceptance from the start.
- ProRedactor still has no app bundle built, so it has no license module
  yet either — same gap as before, just now the only remaining one.

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
  console.log('PUBLIC (goes in the Worker secret AND embedded in each app):');
  console.log(JSON.stringify(await subtle.exportKey('jwk', kp.publicKey)));
  console.log('\nPRIVATE (Worker secret ONLY — never commit, never put in the app):');
  console.log(JSON.stringify(await subtle.exportKey('jwk', kp.privateKey)));
})();
```

Why ECDSA P-256 and not Ed25519: P-256 verify support in `crypto.subtle`
is available in every browser ProForm Form Manager already targets (per
Manual.html's existing "Chrome, Edge, Firefox 113+, Safari 16.4+" line),
whereas Ed25519 support in Web Crypto is newer and less consistently
available. Since the whole point is that activation must verify
**offline, in the browser, forever**, broad compatibility mattered more
here than Ed25519's slightly smaller keys/signatures.

**Subscription note:** signed license tokens now carry a short `exp`
(GRACE_PERIOD_DAYS in `worker.js`, currently 3 days) instead of never
expiring — see the module doc-comment at the top of `worker.js` for why,
and note that the client-side check of `exp` / periodic call to
`/api/license/refresh` still needs to be added inside each app's own
license module (e.g. ProForm.html's `pfLicense`); that file wasn't
touched by this update.

## 2. Upstash Redis

You said you already have Upstash wired up — reuse that database (or a
dedicated one). Grab the REST URL and token from the Upstash console:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

The worker uses these key patterns, all plain strings/JSON, no setup
needed on the Upstash side beyond having the database exist:

| Key pattern | Value | Purpose |
|---|---|---|
| `trial:<deviceId>` | epoch ms, set once via `NX` | anchors trial start server-side |
| `license:<deviceId>` | JSON `{token,email,deviceId,product,customerId,subscriptionId,status,currentPeriodEnd,cancelAtPeriodEnd,purchasedAt,sessionId}` | latest subscription/license state per device |
| `license_by_session:<stripeSessionId>` | same JSON | lets purchaseconfirm/receipt pages fetch the key right after Stripe redirects back, before any device-based lookup is possible |
| `lead:<email>` / list `leads:all` | marketing signup info | from the trial-signup form on the website (separate from the technical per-device trial) |

## 3. Resend

- `RESEND_API_KEY` — from the Resend dashboard.
- `RESEND_FROM` — a verified sending address, e.g. `"ProForma Suite <billing@yourdomain.com>"`.
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

## 4. Stripe — subscription prices, one per plan

Unlike the old one-time model, you now need **four recurring monthly
Prices** in Stripe (Products → Add Product → Recurring → Monthly), and
four corresponding secrets:

| Plan | Monthly price | Secret name |
|---|---|---|
| DOCX Optimizer | $4.99 | `STRIPE_PRICE_ID_DOCX` |
| ProForm Form Manager | $10.99 | `STRIPE_PRICE_ID_PROFORM` |
| Synthetix-CR (bundle — covers DOCX Optimizer + ProForm Form Manager) | $14.99 | `STRIPE_PRICE_ID_SYNTHETIXCR` |
| ProRedactor | $6.99 | `STRIPE_PRICE_ID_PROREDACTOR` |

Steps:

1. Create each recurring Price in the Stripe dashboard, copy its ID
   (`price_...`) into the matching secret below.
2. Add a webhook endpoint pointing at
   `https://<your-worker-domain>/api/stripe/webhook`, subscribed to:
   - `checkout.session.completed`
   - `customer.subscription.updated` (renewals, plan changes, "cancel at period end" toggles from the billing portal)
   - `customer.subscription.deleted` (fires once a canceled subscription actually reaches the end of its final period — this is what deactivates the license)

   Copy the webhook's signing secret into `STRIPE_WEBHOOK_SECRET`.
3. `STRIPE_SECRET_KEY` — your standard secret key (start with the
   `sk_test_...` one while you wire this up).
4. **Enable the Customer Portal** (Settings → Billing → Customer portal)
   so `/api/billing/portal` has somewhere to send subscribers to manage
   or cancel — this is the actual mechanism behind the "cancel anytime"
   language across the site's Terms/EULA/FAQ.

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
wrangler secret put STRIPE_PRICE_ID_DOCX
wrangler secret put STRIPE_PRICE_ID_PROFORM
wrangler secret put STRIPE_PRICE_ID_SYNTHETIXCR
wrangler secret put STRIPE_PRICE_ID_PROREDACTOR
wrangler secret put LICENSE_PRIVATE_KEY_JWK   # paste the JSON on one line
wrangler secret put LICENSE_PUBLIC_KEY_JWK    # paste the JSON on one line
wrangler deploy
```

Then set `ALLOWED_ORIGINS` in `wrangler.toml` to your real site domain(s)
and attach a route (see the commented-out `routes` block in
`wrangler.toml`) so it's reachable at something like
`https://api.proforma-suite.com`.

## 6. Wire the public key into each app

Take the same `LICENSE_PUBLIC_KEY_JWK` value and paste it into each app's
`pfLicense` module (`LICENSE_PUBLIC_JWK` constant near the top of the
module) — see the comment there. This is the only place an app needs to
change when you rotate keys; it never needs the private key.

**Follow-up not yet done:** each app's `pfLicense` module still needs to
(a) check the token's `exp` field and treat an expired-but-signature-valid
token as "needs re-check" rather than permanently valid, and (b) call the
new `GET /api/license/refresh?deviceId=...` endpoint periodically while
online to get a freshly-dated token and confirm the subscription is still
active. `worker.js`'s module doc-comment flags this explicitly — it's
what actually makes "cancel anytime" take effect inside the app itself,
not just on the website.

## 7. Point the front-end at the worker

`index.html` and the rest of the marketing site pages (`trialsignup.html`,
`payment.html`, `purchaseconfirm.html`, `receipt.html`, `downloads.html`,
`support.html`) all read a single `API_BASE` constant near the top of their
scripts. Set it to your deployed worker URL (e.g.
`https://api.proforma-suite.com`) in each file, or serve them from the same
origin as the worker and leave it as `''` (relative paths).

`payment.html` now also reads a `?product=` URL param (one of `docx`,
`proform`, `synthetixcr`, `proredactor`) and sends it to
`/api/checkout/create` so the worker knows which Stripe Price to use —
every Subscribe link/button on the site already includes it.

## 8. Host the ProForm Form Manager app bundle

ProForm Form Manager ships as 5 files that must stay together in the same
folder: `ProForm.html` itself, plus `README.html`, `Manual.html`,
`Tutorial.html`, and `Legal.html`, which it opens via relative iframe paths
from its own in-app Help menu (`openHelpDoc()`). This is a static-hosting
concern, not a worker one — it lives in the same Cloudflare Pages
deployment as the rest of the marketing site (`site/`), not on the worker.
(The filenames and folder stay `ProForm` — only the site's display name
changed to "ProForm Form Manager".)

Recommended path: **`/apps/ProForm/`** at the Pages project root, alongside
the existing site pages —

```
site/                      ← your Pages deployment root (index.html, store.html, …)
site/apps/ProForm/
  ProForm.html
  README.html
  Manual.html
  Tutorial.html
  Legal.html
  ProForm-App.zip          ← all 5 files pre-zipped — see below
```

`downloads.html`'s Download button for ProForm Form Manager points at
`/apps/ProForm/ProForm-App.zip` and expects it to exist at that *exact*
path, capitalization included — URL paths are case-sensitive, so
`/apps/proform/...` and `/apps/ProForm/...` are different URLs to a web
server even though they look the same to a person. If you rename or move
the folder, update that one constant (`appFileMap['dl-proform']` in
`downloads.html`'s script) to match exactly.

**Why a ZIP and not just linking `ProForm.html` directly:** downloading
`ProForm.html` alone works fine to *open and use immediately in the
browser it was downloaded in*, but the moment the user is offline on their
own machine and clicks a Help/Support link inside the app, those relative
iframe paths need `README.html`/`Manual.html`/`Tutorial.html`/`Legal.html`
sitting in the same local folder — which a single-file download won't
have. Handing out a ZIP of all 5 together avoids that broken-Help
experience. Rebuild the ZIP any time you update any of the 5 files:

```
cd site/apps/ProForm
zip -X ProForm-App.zip ProForm.html README.html Manual.html Tutorial.html Legal.html
```

Deploy this folder the same way you deploy the rest of `site/` (git push if
your Pages project is git-connected, or drag-and-drop / `wrangler pages
deploy` if you deploy directly) — no separate hosting setup needed, it's
just more static files in the same project.

**DOCX Optimizer and ProRedactor aren't hosted yet** — neither has an app
bundle built or a folder under `site/apps/`. DOCX Optimizer's download
button on `downloads.html` is present but not wired to a file (same gap
that existed before this update); ProRedactor's pricing/subscribe flow is
live, but its Downloads Portal card is intentionally shown as "Coming
soon" with a disabled button until its app bundle exists and is hosted the
same way as ProForm Form Manager's.

## What this does *not* change

Your privacy positioning for form content is untouched — none of this
worker ever sees a user's form data, sessions, or custom forms; those
still never leave the user's device. The only things that cross the
network are: a device fingerprint hash + timestamp (trial anchoring), a
device fingerprint hash + email (subscription → license issuance), and,
now, subscription status metadata (active/canceled, current period end)
synced from Stripe via webhooks and the `/api/license/refresh` endpoint.
