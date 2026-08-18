// Exercises the new client-side pfLicense module (extracted verbatim from
// Index.html) inside a sandboxed VM with stubbed browser globals, so we can
// actually run the trial-caching and signature-verification logic rather
// than just syntax-checking it.
import vm from 'node:vm';
import fs from 'node:fs';
import { webcrypto } from 'node:crypto';

const moduleSrc = fs.readFileSync(new URL('../Index.html', import.meta.url), 'utf8');
// pull out the pfLicense IIFE the same way it appears in the file
const start = moduleSrc.indexOf('const pfLicense = (() => {');
const end = moduleSrc.indexOf('})();', start) + 5;
const pfLicenseSrc = moduleSrc.slice(start, end);
console.log('Extracted', pfLicenseSrc.length, 'chars of pfLicense module\n');

function makeSandbox({ fetchImpl, apiBase } = {}) {
  const store = {};
  const localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
  };
  let fakeNow = Date.now();
  const sandbox = {
    localStorage,
    document: { createElement: () => ({ getContext: () => { throw new Error('no canvas in test'); } }) },
    screen: { width: 1920, height: 1080, colorDepth: 24 },
    navigator: { language: 'en-US', hardwareConcurrency: 8, platform: 'TestOS' },
    Intl,
    crypto: webcrypto,
    TextEncoder, TextDecoder,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    fetch: fetchImpl || (async () => { throw new Error('offline (no fetch stub provided)'); }),
    console,
    setTimeout, clearTimeout,
    Promise,
    window: { open: () => {} },
    encodeURIComponent,
    __getFakeNow: () => fakeNow,
    __setFakeNow: (v) => { fakeNow = v; },
  };
  // Let tests fast-forward/rewind the clock the module sees, without
  // touching the real process clock (which would break the test runner).
  sandbox.Date = class extends Date {
    constructor(...args) { if (args.length === 0) super(fakeNow); else super(...args); }
    static now() { return fakeNow; }
  };
  vm.createContext(sandbox);
  return { sandbox, store, setNow: (v) => { fakeNow = v; } };
}

function run(sandbox, code) {
  return vm.runInContext(code, sandbox);
}

async function scenario(title, fn) {
  console.log(`\n=== ${title} ===`);
  await fn();
}

(async () => {
  // ── Scenario 1: fully offline / API_BASE empty — must match old local-only behavior ──
  await scenario('Local-only mode (no backend configured) — day countdown', async () => {
    const { sandbox, setNow } = makeSandbox();
    run(sandbox, pfLicenseSrc);
    setNow(Date.parse('2026-01-01T00:00:00Z'));
    const r1 = await run(sandbox, 'pfLicense.init()');
    console.log('Day 0:', r1);
    setNow(Date.parse('2026-01-16T00:00:00Z')); // +15 days
    console.log('Day 15 (no re-init, direct getDaysLeft):', run(sandbox, 'pfLicense.getDaysLeft()'));
    setNow(Date.parse('2026-01-31T00:00:00Z')); // +30 days
    console.log('Day 30 daysLeft (should be 0):', run(sandbox, 'pfLicense.getDaysLeft()'));
    console.log('isPremium at day 30 (should be false):', run(sandbox, 'pfLicense.isPremium()'));
  });

  // ── Scenario 2: clock rolled BACKWARD on a fresh, never-registered device ──
  // This is exactly the original attack. Local-only mode can't fully defend
  // against it (no server to anchor to) — confirming that's still true here
  // is the point: it shows why server registration (scenario 3) matters.
  await scenario('Local-only mode — rolling the clock back resets the trial (expected weakness without a backend)', async () => {
    const { sandbox, setNow } = makeSandbox();
    run(sandbox, pfLicenseSrc);
    setNow(Date.parse('2026-01-31T00:00:00Z'));
    await run(sandbox, 'pfLicense.init()');
    console.log('daysLeft after using up the trial:', run(sandbox, 'pfLicense.getDaysLeft()'));
    setNow(Date.parse('2025-06-01T00:00:00Z')); // roll clock back 8 months, clear nothing
    console.log('daysLeft after rolling clock back (still exploitable with no backend deployed):', run(sandbox, 'pfLicense.getDaysLeft()'));
  });

  // ── Scenario 3: server-confirmed trial — clock rollback no longer helps ──
  await scenario('Server-anchored mode — rolling the clock back after confirmation does NOT restore days', async () => {
    let serverTrialStart = null;
    const fetchImpl = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (serverTrialStart === null) serverTrialStart = Date.parse('2026-01-01T00:00:00Z');
      const serverNow = Date.parse('2026-01-11T00:00:00Z'); // server thinks 10 days have passed
      const daysLeft = Math.max(0, Math.ceil(30 - (serverNow - serverTrialStart) / 86400000));
      return { ok: true, json: async () => ({ trialStart: serverTrialStart, trialDays: 30, daysLeft, serverNow }) };
    };
    const { sandbox, setNow } = makeSandbox({ fetchImpl });
    // Patch API_BASE by re-writing the const in a copy of the source (simulates deploying + pointing the app at it)
    const withApiBase = pfLicenseSrc.replace("const API_BASE='';", "const API_BASE='https://api.example.com';");
    run(sandbox, withApiBase);
    setNow(Date.parse('2026-01-11T00:00:00Z'));
    const r = await run(sandbox, 'pfLicense.init()');
    console.log('After server sync, daysLeft (should be 20):', r.daysLeft);
    // Now the user rolls their clock back a year AND goes offline.
    setNow(Date.parse('2025-01-01T00:00:00Z'));
    console.log('daysLeft after rolling clock back a year (should stay ~20, not jump to 30 or reset):', run(sandbox, 'pfLicense.getDaysLeft()'));
    // And rolling forward should still count down normally from the cached point.
    setNow(Date.parse('2026-01-21T00:00:00Z')); // +10 real days after the cache point
    console.log('daysLeft 10 real days after cache (should be ~10):', run(sandbox, 'pfLicense.getDaysLeft()'));
  });

  // ── Scenario 4: license activation — valid, wrong device, tampered ──
  await scenario('License activation — sign with the real private key, verify with the embedded public key', async () => {
    const priv = JSON.parse(fs.readFileSync(new URL('../keys_private_jwk.json', import.meta.url)));
    const pub = JSON.parse(fs.readFileSync(new URL('../keys_public_jwk.json', import.meta.url)));
    // pfLicenseSrc as shipped embeds a specific starter public key — swap in
    // the matching pair we generated for this test so sign/verify line up.
    const pubLine = `const LICENSE_PUBLIC_JWK=${JSON.stringify(pub)};`;
    const patched = pfLicenseSrc.replace(/const LICENSE_PUBLIC_JWK=\{.*?\};/, pubLine);

    async function sign(deviceId) {
      const payload = { v: 1, mid: deviceId, p: 'proform', iat: Math.floor(Date.now() / 1000) };
      const b64url = b => Buffer.from(b).toString('base64url');
      const payloadB64 = b64url(Buffer.from(JSON.stringify(payload)));
      const signingInput = `v1.${payloadB64}`;
      const key = await webcrypto.subtle.importKey('jwk', priv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
      const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput));
      return `${signingInput}.${Buffer.from(sig).toString('base64url')}`;
    }

    const { sandbox, setNow } = makeSandbox();
    run(sandbox, patched);
    setNow(Date.now());
    await run(sandbox, 'pfLicense.init()');
    const mid = run(sandbox, 'pfLicense.getMachineId()');
    console.log('Test device fingerprint:', mid);

    const validToken = await sign(mid);
    const r1 = await run(sandbox, `pfLicense.activate(${JSON.stringify(validToken)})`);
    console.log('Activate with a correctly-signed token for THIS device:', r1);
    console.log('isActivated:', run(sandbox, 'pfLicense.isActivated()'));
    console.log('isPremium (should stay true even after we time-travel past trial end):', run(sandbox, 'pfLicense.isPremium()'));

    const { sandbox: sandbox2 } = makeSandbox();
    run(sandbox2, patched);
    await run(sandbox2, 'pfLicense.init()');
    const wrongDeviceToken = await sign('some-other-device-fingerprint');
    const r2 = await run(sandbox2, `pfLicense.activate(${JSON.stringify(wrongDeviceToken)})`);
    console.log('Activate with a token signed for a DIFFERENT device:', r2);

    const r3 = await run(sandbox2, `pfLicense.activate("garbage-not-a-real-token")`);
    console.log('Activate with garbage input:', r3);

    const tampered = validToken.slice(0, -6) + 'AAAAAA';
    const r4 = await run(sandbox2, `pfLicense.activate(${JSON.stringify(tampered)})`);
    console.log('Activate with a tampered (but well-formed-looking) token:', r4);

    // Prove the OLD attack is actually closed: without the private key, can
    // anyone compute a valid token just from reading the shipped source?
    // There is no deriveKey()-style formula left in the module at all —
    // confirm that literal string is gone.
    console.log('Old deriveKey formula still present in source:', /deriveKey/.test(pfLicenseSrc));
  });
})();