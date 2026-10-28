// First-run registration tests on their OWN fresh database.
// The main suite (api.test.js) creates its owner early, so the truly empty
// install — NO factory admin anywhere, first registration becomes the Head —
// is proven here. Run with: npm test (runs both test files).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const PORT = 3211;
const BASE = `http://localhost:${PORT}`;
const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'martbill-register-'));

let child;
let token = '';

async function api(pathname, options = {}) {
  const res = await fetch(BASE + pathname, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}

before(async () => {
  child = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: tempData },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.on('data', d => process.stderr.write(d));
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('Server did not start');
});

after(async () => {
  child?.kill();
  await new Promise(r => setTimeout(r, 700));
  try { fs.rmSync(tempData, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('fresh install: setup mode, no factory login, no hardcoded owner chip', async () => {
  const b = await (await fetch(`${BASE}/api/auth/brand`)).json();
  assert.equal(b.setup, true, 'empty install is in setup mode');
  assert.equal(b.allow_register, true);
  assert.deepEqual(b.demo, [], 'no demo or backdoor login is offered before anyone registered');

  // the default credentials every old system ships with must simply not exist
  const old = await api('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  assert.equal(old.status, 401, 'admin/admin123 must NOT work — there is no hardcoded admin');
});

test('the first registration becomes the Head of the shop', async () => {
  const r = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      shop_name: 'Noor Karyana Store', name: 'Noor Ahmed',
      username: 'noor', password: 'noor-pass-1', confirm: 'noor-pass-1'
    })
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.setup, true, 'created as the owner');
  assert.equal(r.body.user.role, 'admin');
  assert.equal(r.body.user.username, 'noor');
  assert.ok(r.body.token, 'signed in immediately');

  // the owner signs in with the password they chose
  const owner = await api('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'noor', password: 'noor-pass-1' })
  });
  assert.equal(owner.status, 200, 'the owner can log in');
  assert.equal(owner.body.user.role, 'admin');

  // their shop name is live
  token = owner.body.token;
  const s = await api('/api/settings');
  assert.equal(s.body.shop_name, 'Noor Karyana Store');

  // …and the old factory login is still dead
  const old = await api('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  assert.equal(old.status, 401, 'admin/admin123 never works');
});

test('setup mode is over — new sign-ups now wait for the Head', async () => {
  const b = await (await fetch(`${BASE}/api/auth/brand`)).json();
  assert.equal(b.setup, false, 'the shop has its own owner now');
  assert.ok(!b.demo.some(d => d.username === 'admin'), 'no factory owner chip appears');

  const r = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Helper', username: 'helper-1', password: 'help-pass', confirm: 'help-pass', role: 'cashier' })
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.pending, true, 'everyone after the owner needs Head approval');

  const blocked = await api('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'helper-1', password: 'help-pass' })
  });
  assert.equal(blocked.status, 401, 'a pending request cannot log in');
});
