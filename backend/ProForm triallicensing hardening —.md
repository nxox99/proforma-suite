# SUPERSEDED — 2026-08-19

This file was a session log from 2026-08-18 documenting the initial build
of the trial/licensing system, written when ProForma Suite's business
model was still a one-time purchase (no subscriptions, `mode: 'payment'`
in Stripe, a single `STRIPE_PRICE_ID`). On 2026-08-19 the business model
changed to monthly subscriptions across four plans (DOCX Optimizer
$4.99/mo, ProForm Form Manager $10.99/mo, Synthetix-CR bundle $14.99/mo,
ProRedactor $6.99/mo), which changed:

- Stripe Checkout mode: `payment` → `subscription`
- Price IDs: one (`STRIPE_PRICE_ID`) → four (`STRIPE_PRICE_ID_DOCX`,
  `STRIPE_PRICE_ID_PROFORM`, `STRIPE_PRICE_ID_SYNTHETIXCR`,
  `STRIPE_PRICE_ID_PROREDACTOR`)
- Webhook events: added `customer.subscription.updated` and
  `customer.subscription.deleted`
- New endpoints: `GET /api/license/refresh`, `POST /api/billing/portal`
- Signed license tokens: now carry a short `exp` (grace period) instead
  of being valid forever, since a subscription can lapse

The architectural findings in the original version of this file (the
unprotected client-side activation-key formula, the hidden dev-console
cheat code, the site's fake `setTimeout`-based checkout, the
`trial-signup.html` vs `trialsignup.html` filename mismatch) are historical
facts about what was found and fixed on 2026-08-18 — those are still true
as history, just no longer describe the current pricing model if read at
face value. Its content was cleared out here rather than left half-stale;
the current, accurate reference is:

- **"ProForma Suite licensing backend — setup.md"** (in this same folder)
  — current setup instructions for the subscription model.

This stub is left in place (rather than removed) only because this
session's tools can't delete files on your device — feel free to delete
it yourself once you've confirmed you don't need the old content.
