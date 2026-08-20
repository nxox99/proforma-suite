# ProForm trial hardening & ProForma Suite site pricing model — 2026-08-18

## Context
Follow-on from the earlier offline-trial-hardening work (see `claude/export-bugfixes-2026-08-13.md` for the unrelated document-export bug fixes). This session covered two things: (1) hardening ProForm's offline trial/license system against clock tampering and key forgery, and (2) reviewing and fixing the ProForma Suite marketing site (the Cloudflare Pages site, git-connected/auto-deployed from GitHub, that sells DOCX Optimizer, ProForm, and Synthetix-CR) so its copy, links, and purchase flow actually match what was built.

## Key decisions locked in this session
- **Business model: one-time purchase, not subscription.** Every app is bought once for a flat price and the license is perpetual (no renewal, no billing cycle). Matches the Cloudflare Worker/Stripe integration already built (`mode: 'payment'`, one-time Checkout).
- **One-time prices — CONFIRMED by user**: DOCX Optimizer $99, ProForm $299, Synthetix-CR $399. Live in `pricing.html`, `store.html`, `index.html`, and `terms.html` §3.
- **Trial length: 30 days**, confirmed multiple times. No registration/email/key is required to start a trial — it begins automatically on first launch of the downloaded app (device-fingerprint + server-anchored, see the trial-hardening design below).
- **Licensing accuracy rewrite approved and done.** `faq.html`/`eula.html`/`copyright.html`/`terms.html` previously described a fictional "Hardware ID" scheme (processor/motherboard/NIC-derived, remotely revocable). Rewritten to correctly describe a browser-based device fingerprint (`buildMid()` in ProForm.html), in-app activation, and **no remote-deactivation/revocation capability**.
- **App bundle hosting path — CONFIRMED and LIVE: `/apps/ProForm/`** (capital P, capital F — matches the user's actual GitHub repo folder name exactly; URL paths are case-sensitive, so this casing must be preserved everywhere it's referenced) at the Pages project root, alongside the marketing pages. Contains `ProForm.html`, `README.html`, `Manual.html`, `Tutorial.html`, `Legal.html`, and a prebuilt `ProForm-App.zip` of all five. Full structure and deploy notes in `backend/SETUP.md` §8. `downloads.html`'s Download button points at `/apps/ProForm/ProForm-App.zip` — if this folder is ever renamed, that one constant (`appFileMap['dl-proform']`) must be updated to match exactly, including case.
- **Support form/inbox — implemented.** Two separate things:
  1. `support.html`'s contact form POSTs to a new Worker endpoint (`/api/support/send`) which emails the message to `SUPPORT_TO_EMAIL` (new required secret — set to Nauman's personal address) via Resend, Reply-To set to the visitor. Also fires a best-effort acknowledgment to the visitor.
  2. For `support@proforma-suite.com` to work as a real mailbox (direct email, not via the form) — that's **Cloudflare Email Routing** (free, dashboard-configured DNS forward), not Resend and not a Pages folder. Documented in `backend/SETUP.md` §3.

## Trial/license hardening design (ProForm.html)
- Server-anchored trial via Upstash Redis (`SET trial:<deviceId> <timestamp> NX`) with online re-verification each launch; offline fallback decays a cached server-confirmed `daysLeft` by real elapsed local time. Full offline usability preserved.
- ECDSA P-256 signed license tokens (`v1.<payload>.<signature>`). Public verify-only key embedded client-side; private key only as a Worker secret.
- Removed a hidden Shift+P,R,O,K,E,Y dev-console backdoor that self-computed a valid key client-side.
- Cloudflare Worker (`worker.js`, dependency-free) talks directly to Upstash Redis, Resend, and Stripe REST APIs. Stripe webhook signatures verified manually via HMAC-SHA256. New required secret this session: `SUPPORT_TO_EMAIL`.

## Site fixes applied this session (across all `site/*.html`)
- Sitewide link bug fixed everywhere: `synthetix-cr.html` → real file is `synthetixcr.html` (no hyphen).
- Removed orphaned/broken trailing script fragments (genuine `SyntaxError`s) in `store.html`, `eula.html`, `copyright.html` — the latter two meant their consent-banner script silently failed to run at all.
- Rescoped the absolute "no data is ever sent to our servers" privacy claim (7+ files) to the accurate version.
- **`index.html` and `store.html` both had a "fake successful purchase" bug**: purchase modal opened the payment link in a new tab, then unconditionally redirected the current tab to a "Purchase confirmed!" page after 800ms regardless of actual payment outcome. Fixed in both — modal now navigates the same tab straight to `payment.html` (real Stripe redirect), never assumes success.
- Rewrote `pricing.html` (removed monthly/annual toggle), `store.html` (subscription copy → one-time; added working Buy buttons — the purchase modal existed with nothing ever triggering it), `index.html` (same fixes + a stray Synthetix-CR "bundle" copy-paste bug), `faq.html`/`eula.html` (large accuracy rewrites), `copyright.html`/`terms.html` (smaller fixes), `downloads.html`/`trialconfirm.html` (leftover subscription copy).
- `terms.html` §3 renamed "Subscription License" → "One-Time License Purchase"; §2 no longer claims registration is required to start a trial.
- **`downloads.html`'s Download button gap, fixed**: previously downloaded `ProForm.html` alone, which breaks the in-app Help menu offline (needs README/Manual/Tutorial/Legal in the same local folder). Fixed via a prebuilt `ProForm-App.zip`.
- **Case-sensitivity bug, found and fixed after first deploy**: downloads.html originally hardcoded the path as lowercase `/apps/proform/`, but the user's actual GitHub folder is `/apps/ProForm/` (capital P, F). This 404'd silently on click (looked like "nothing happens"). Fixed by updating the code to match the real folder casing exactly, rather than asking the user to rename anything in GitHub. **Any future edits to this path must preserve the exact `ProForm` capitalization.**

## Known open items / not yet done
- **`SUPPORT_TO_EMAIL` secret needs to actually be set** via `wrangler secret put SUPPORT_TO_EMAIL` — code is ready, secret is a manual step for the user.
- **Cloudflare Email Routing for `support@proforma-suite.com` is a manual dashboard step for the user** — documented in SETUP.md, can't be done from this session.
- **No license transfer/re-activation automation exists** — described as manual/case-by-case in faq.html/eula.html, since no Worker endpoint for it was built.
- Two stale/pre-fix duplicate uploads (`payment.html`, `terms.html`) appeared in one upload batch — confirmed identical to the original unfixed versions, not an instruction to revert; no action taken.
- `icons/*.png` referenced across the site were not verified to exist — asset dependency, not a code issue.
- User has since confirmed via screenshot that the `/apps/ProForm/` folder is live on GitHub/Cloudflare Pages with all 6 files (5 HTML + zip) — deployment of the app bundle itself is done; the only remaining piece was the path-casing bug above, now fixed.

## File locations (this session's working copies)
All under `/home/claude/proform/` in the cloud workspace (ProForm.html + doc bundle + `backend/` Worker files at the top level, marketing site under `site/`, prebuilt app-bundle ZIP under `dist/apps/proform/ProForm-App.zip` — note the *local workspace* folder is lowercase; only the user's actual deployed GitHub/Cloudflare path is capitalized `ProForm`). All touched files were delivered to the user via chat; `site/` there is the current, fixed state of the whole ProForma Suite site.