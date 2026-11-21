// Stage 5's sign-in, checked end to end on the laptop: register a loopback client (as Claude Code does), authorize
// with PKCE in a real browser (the test backend's consent page on the sign-in frontend, the simulation person's
// login), take the code, get a token, list the web door's tools through /mcp, call get_brief once (the trace gets a
// line), then revokes the check's connection. Never prints a token. Needs hour.ps1 -Start first.
// Run: node scripts/sim/connector/signin-check.cjs, with Playwright reachable: GROOT (the global npm root holding
// @playwright/mcp) and CHROME_EXE (its Chromium), or a `playwright` package. BASE: default http://localhost:8012.
const path = require('path');
const crypto = require('crypto');
const { chromium } = require(process.env.GROOT ? path.join(process.env.GROOT, '@playwright/mcp/node_modules/playwright') : 'playwright');

const BASE = process.env.BASE || 'http://localhost:8012';
const REDIRECT = 'http://127.0.0.1:53682/callback';
const EMAIL = 'tara.connector-sim@recollect.local';
const PASSWORD = 'connectorsim123';

async function json(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error(`${res.status} ${text.slice(0, 200)}`); }
}

async function mcp(token, body, id) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id, ...body }),
  });
  return { status: res.status, body: await json(res) };
}

(async () => {
  const meta = await json(await fetch(`${BASE}/.well-known/oauth-authorization-server`));
  const prm = await json(await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`));
  console.log('discovery:', meta.issuer, '| resource', prm.resource);
  const reg = await json(await fetch(meta.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Sign-in check', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
  }));
  if (!reg.client_id) throw new Error('registration refused: ' + JSON.stringify(reg).slice(0, 200));
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(8).toString('hex');
  const url = new URL(meta.authorization_endpoint);
  url.search = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state, resource: prm.resource, scope: prm.scopes_supported.join(' ') }).toString();

  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXE });
  const page = await (await browser.newContext()).newPage();
  const seen = [];
  let code = null;
  page.on('request', (r) => {
    const u = r.url();
    if (r.isNavigationRequest()) seen.push(u.replace(/request=[^&]+/, 'request=…').replace(/code=[^&]+/, 'code=…').slice(0, 90));
    if (u.startsWith(REDIRECT)) { const q = new URL(u).searchParams; if (q.get('state') === state) code = q.get('code'); }
  });
  const apiHosts = new Set();
  page.on('request', (r) => { if (r.resourceType() === 'xhr' || r.resourceType() === 'fetch') apiHosts.add(new URL(r.url()).host); });
  try {
    await page.goto(url.toString(), { timeout: 120000 });
    await page.waitForURL(/\/login/, { timeout: 120000 });
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: 'Continue with email' }).click().catch(() => {});
    await page.waitForTimeout(400);
    await page.locator('input[type="email"], input[name="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForURL(/\/oauth\/consent/, { timeout: 120000 });
    await page.getByRole('button', { name: 'Allow' }).waitFor({ timeout: 60000 });
    const shown = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 260);
    console.log('consent page says:', shown);
    await page.getByRole('button', { name: 'Allow' }).click();
    for (let i = 0; i < 40 && !code; i++) await page.waitForTimeout(250);
  } finally {
    console.log('pages:', seen.join(' -> '));
    console.log('the pages called:', [...apiHosts].join(', '));
    await browser.close();
  }
  if (!code) throw new Error('no code came back');

  const tok = await json(await fetch(meta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier, resource: prm.resource }).toString(),
  }));
  if (!tok.access_token) throw new Error('token refused: ' + JSON.stringify(tok).slice(0, 200));
  console.log('token: received (' + tok.token_type + ', ' + tok.expires_in + ' s, scope ' + tok.scope + ')');

  const init = await mcp(tok.access_token, { method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'signin-check', version: '1' } } }, 1);
  console.log('initialize:', init.status, init.body.result ? init.body.result.serverInfo.name : JSON.stringify(init.body).slice(0, 200));
  const list = await mcp(tok.access_token, { method: 'tools/list', params: {} }, 2);
  const names = (list.body.result?.tools ?? []).map((t) => t.name);
  console.log('tools:', names.length, '|', names.join(' '));
  const brief = await mcp(tok.access_token, { method: 'tools/call', params: { name: 'get_brief', arguments: {} } }, 3);
  const text = brief.body.result?.content?.[0]?.text ?? JSON.stringify(brief.body).slice(0, 200);
  console.log('get_brief:', text.replace(/\s+/g, ' ').slice(0, 400));
  const revoked = await fetch(meta.revocation_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tok.refresh_token || tok.access_token, client_id: reg.client_id }).toString() });
  console.log('revoked the check connection:', revoked.status);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
