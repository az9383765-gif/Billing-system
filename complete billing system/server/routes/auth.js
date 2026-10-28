import { Router } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { db, uuid, now, getSetting, setSetting } from '../db.js';
import {
  hashPassword, verifyPassword, createSession, destroySession,
  requireAuth, requireCap, badRequest, ROLES, ROLE_LABELS,
  throttleWait, noteLoginFailure, clearLoginFailures,
  permsFor, ALL_CAPS, can, touchDuty, dutyTotals
} from '../lib.js';

const router = Router();

// 10 bad passwords lock that username, 30 lock that IP (5 minutes)
const throttleKeys = (username, ip) => [
  ['u:' + String(username).trim().toLowerCase(), 10],
  ['ip:' + ip, 30]
];

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return badRequest(res, 'Username and password are required');

  const keys = throttleKeys(username, req.ip);
  const wait = throttleWait(keys);
  if (wait) {
    return res.status(429).json({
      error: `Too many failed login attempts. Try again in ${wait} second${wait === 1 ? '' : 's'}.`,
      retry_after: wait
    });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(username).trim());
  if (!user || !verifyPassword(password, user.password_hash)) {
    noteLoginFailure(keys);
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  clearLoginFailures(keys);
  const session = createSession(user.id);
  res.json({
    token: session.token,
    user: { id: user.id, username: user.username, name: user.name, role: user.role, perms: permsFor(user.id) }
  });
});

// ---------- public: what the login page needs before anyone signs in ----------
// Fresh install = no active account yet. There is no factory password anywhere
// in the product: the first registration becomes the owner (Head) of the shop.
function freshInstall() {
  return db.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1').get().n === 0;
}

router.get('/brand', (req, res) => {
  const setup = freshInstall();
  const demo = [];
  // demo logins (demo databases only) — offered only while their password is untouched
  const seeded = [
    ['store-keeper', 'store-pass-1', 'Inventory Manager'],
    ['counter-boy', 'counter-pass-1', 'Cashier']
  ];
  for (const [u, p, label] of seeded) {
    const row = db.prepare('SELECT password_hash FROM users WHERE username = ? AND active = 1').get(u);
    if (row && verifyPassword(p, row.password_hash)) demo.push({ username: u, password: p, label });
  }
  res.json({
    shop_name: getSetting('shop_name') || 'My Shop',
    currency_symbol: getSetting('currency_symbol') || 'Rs',
    tax_label: getSetting('tax_label') || 'GST',
    setup,
    allow_register: getSetting('allow_register', '1') !== '0',
    google_client_id: getSetting('google_client_id', ''),
    demo
  });
});

// ---------- Google sign-in (optional — the Head switches it on in Settings) ----------
// Google verifies who the person is; MartBill decides what they may access. A
// brand-new Google identity follows exactly the same rules as a self sign-up:
// first person in an empty shop becomes the Head, everyone else waits for
// approval. Nothing here can bypass the Head.
router.post('/google', async (req, res) => {
  const clientId = getSetting('google_client_id', '');
  if (!clientId) return badRequest(res, 'Google sign-in is not set up yet');
  const credential = String((req.body || {}).credential || '');
  if (!credential) return badRequest(res, 'Missing Google sign-in credential');

  // brute-forcing credentials is pointless (Google signs them) but each attempt
  // costs a signature check, so only real failures are counted — 30 in a row
  // from one IP earns a five minute cool-off, one success wipes the counter
  const gKey = ['g:' + req.ip, 30];
  const wait = throttleWait([gKey]);
  if (wait) return res.status(429).json({ error: `Too many attempts. Try again in ${wait} seconds.`, retry_after: wait });

  let payload;
  try {
    const client = new OAuth2Client();
    const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
    payload = ticket.getPayload();
  } catch {
    noteLoginFailure([gKey]);
    return badRequest(res, 'Invalid Google sign-in'); // never leak why
  }
  const email = String(payload?.email || '').toLowerCase().trim();
  if (!email || payload?.email_verified !== true) {
    noteLoginFailure([gKey]);
    return badRequest(res, 'That Google address is not verified');
  }
  clearLoginFailures([gKey]);

  const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
  if (user) {
    const session = createSession(user.id);
    return res.json({
      token: session.token,
      user: { id: user.id, username: user.username, name: user.name, role: user.role, perms: permsFor(user.id) }
    });
  }

  const setupMode = freshInstall();

  // asked once already and still waiting — never a second row for one address
  const earlier = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (earlier && !setupMode) {
    return res.json({
      pending: true,
      message: 'This Google address already has an account request waiting. The Head approves it in Settings → Users.'
    });
  }

  if (!setupMode && getSetting('allow_register', '1') === '0') {
    return res.status(403).json({ error: 'No MartBill account for this Google address — ask the Head to add you.' });
  }

  // a free username derived from the email, the way a person would pick one
  const base = (email.split('@')[0] || 'user').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 15) || 'user';
  let username = base;
  for (let n = 1; db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username); n++) {
    username = `${base.slice(0, 16)}${n}`;
  }
  const name = String(payload?.name || email.split('@')[0]).trim().slice(0, 64);
  const id = uuid();

  if (setupMode) {
    // first person in an empty shop is its owner (Head)
    if (earlier) {
      // a pending row already holds this address — it becomes the Head, not a copy
      db.prepare("UPDATE users SET username = ?, name = ?, role = 'admin', active = 1 WHERE id = ?")
        .run(username, name, earlier.id);
      const session = createSession(earlier.id);
      return res.json({
        token: session.token,
        user: { id: earlier.id, username, name, role: 'admin', perms: permsFor(earlier.id) },
        setup: true
      });
    }
    db.prepare('INSERT INTO users (id, username, password_hash, name, email, role, active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
      .run(id, username, hashPassword(uuid()), name, email, 'admin', now());
    const session = createSession(id);
    return res.json({ token: session.token, user: { id, username, name, role: 'admin', perms: permsFor(id) }, setup: true });
  }
  // normal: the account request waits for the Head, same as any sign-up
  db.prepare('INSERT INTO users (id, username, password_hash, name, email, role, active, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)')
    .run(id, username, hashPassword(uuid()), name, email, 'cashier', now());
  res.json({ pending: true, message: 'Google address recognised. The account stays inactive until the Head approves it in Settings → Users.' });
});

router.post('/register', (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 64);
  const username = String(b.username || '').trim();
  const password = String(b.password || '');

  // setup mode: an empty shop must always be able to create its first account
  const setupMode = freshInstall();

  // the Head can switch sign-ups off in Settings → Users
  if (!setupMode && getSetting('allow_register', '1') === '0') {
    return res.status(403).json({ error: 'New account requests are switched off — ask the Head to create your account.' });
  }
  if (!name) return badRequest(res, 'Please enter your name');
  if (!/^[a-z0-9._-]{3,20}$/i.test(username)) {
    return badRequest(res, 'Username must be 3–20 characters: letters, numbers, dot, dash or underscore');
  }
  if (password.length < 4) return badRequest(res, 'Password must be at least 4 characters');
  if (password.length > 200) return badRequest(res, 'Password is too long');
  if (b.confirm !== undefined && String(b.confirm) !== password) return badRequest(res, 'Passwords do not match');

  // rate-limit sign-ups: 5 attempts per IP, then a 5 minute cool-off
  const regKey = ['reg:' + req.ip, 5];
  const wait = throttleWait([regKey]);
  if (wait) return res.status(429).json({ error: `Too many account requests. Try again in ${wait} second${wait === 1 ? '' : 's'}.` });
  noteLoginFailure([regKey]);

  // ---- first run: the buyer creates the owner (Head) account of their own shop ----
  // (setupMode means no active account exists, so nothing can clash — but an
  //  inactive row may still hold a username; in that case it is revived)
  if (setupMode) {
    const existing = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username);
    let id;
    if (existing) {
      id = existing.id;
      db.prepare("UPDATE users SET username = ?, name = ?, password_hash = ?, role = 'admin', active = 1 WHERE id = ?")
        .run(username, name, hashPassword(password), id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    } else {
      id = uuid();
      db.prepare('INSERT INTO users (id, username, password_hash, name, role, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
        .run(id, username, hashPassword(password), name, 'admin', now());
    }
    const shopName = String(b.shop_name || '').trim();
    if (shopName) setSetting('shop_name', shopName.slice(0, 80));
    const user = db.prepare('SELECT id, username, name, role FROM users WHERE id = ?').get(id);
    const session = createSession(user.id);
    return res.json({ token: session.token, user: { ...user, perms: permsFor(id) }, setup: true });
  }

  // ---- normal: an account request the Head approves in Settings → Users ----
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return badRequest(res, 'That username is already taken — pick another one.');

  const role = ROLES.includes(b.role) ? b.role : 'cashier';
  const id = uuid();
  db.prepare('INSERT INTO users (id, username, password_hash, name, role, active, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
    .run(id, username, hashPassword(password), name, role, now());
  res.json({
    pending: true,
    role,
    message: 'Account created. It stays inactive until the Head approves it in Settings → Users.'
  });
});

router.post('/logout', requireAuth, (req, res) => {
  destroySession(req.token);
  res.json({ ok: true });
});

// ---------- duty heartbeat: "this till is still open and being used" ----------
// The SPA pings this once a minute. It only moves the duty row's last_seen, so
// the server can tell a till someone is working at from one left switched on.
router.post('/ping', requireAuth, (req, res) => {
  touchDuty(req.token);
  res.json({ ok: true, at: now() });
});

router.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

router.post('/change-password', requireAuth, (req, res) => {
  const { old_password, new_password } = req.body || {};
  if (!new_password || String(new_password).length < 4) return badRequest(res, 'New password must be at least 4 characters');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(old_password || '', user.password_hash)) return badRequest(res, 'Current password is incorrect');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(new_password), user.id);
  res.json({ ok: true });
});

// ---------- user management (the Head — cap: users) ----------
const canUsers = requireCap('users');

router.get('/users', requireAuth, canUsers, (req, res) => {
  const duty = dutyTotals();
  const users = db.prepare('SELECT id, username, name, role, active, created_at FROM users ORDER BY username').all()
    .map(u => ({ ...u, permissions: permsFor(u.id), duty: duty[u.id] || { online: false, seconds: 0, seconds_today: 0, last_seen: null } }));
  res.json(users);
});

router.post('/users', requireAuth, canUsers, (req, res) => {
  const { username, password, name, role } = req.body || {};
  if (!username || !password) return badRequest(res, 'Username and password are required');
  if (String(username).trim().length > 64) return badRequest(res, 'Username must be 64 characters or less');
  if (String(password).length > 200) return badRequest(res, 'Password is too long');
  if (role !== undefined && !ROLES.includes(role)) {
    return badRequest(res, `Role must be one of: ${ROLES.map(r => ROLE_LABELS[r]).join(', ')}`);
  }
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(String(username).trim());
  if (exists) return badRequest(res, 'Username already exists');

  // new accounts wait for the Head to approve them before they can log in
  const active = req.body?.active === true ? 1 : 0;
  const finalRole = ROLES.includes(role) ? role : 'cashier';
  // only the Head may create another Head
  if (finalRole === 'admin' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the Head can create another Head account.' });
  }
  const id = uuid();
  db.prepare(
    'INSERT INTO users (id, username, password_hash, name, role, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, String(username).trim(), hashPassword(password), String(name || ''), finalRole, active, now());
  res.json({ id, role: finalRole, active, pending: active === 0 });
});

router.put('/users/:id', requireAuth, canUsers, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { name, role, active, password } = req.body || {};
  if (role !== undefined && !ROLES.includes(role)) {
    return badRequest(res, `Role must be one of: ${ROLES.map(r => ROLE_LABELS[r]).join(', ')}`);
  }

  const nextActive = active !== undefined ? (active ? 1 : 0) : user.active;
  const nextRole = ROLES.includes(role) ? role : user.role;

  // a Users grant must never become a path to the Head's chair: only the
  // Head may touch a Head, and only the Head may promote somebody to Head
  if (req.user.role !== 'admin') {
    if (user.role === 'admin' && (nextActive !== user.active || nextRole !== user.role)) {
      return res.status(403).json({ error: 'Only the Head can change or switch off a Head account.' });
    }
    if (nextRole === 'admin' && nextRole !== user.role) {
      return res.status(403).json({ error: 'Only the Head can promote someone to Head.' });
    }
  }

  // never allow the shop to lock itself out of its own admin account
  if (user.role === 'admin' && (nextActive === 0 || nextRole !== 'admin')) {
    const others = db
      .prepare("SELECT COUNT(*) AS n FROM users WHERE id != ? AND role = 'admin' AND active = 1")
      .get(user.id).n;
    if (others === 0) {
      return res.status(400).json({ error: 'At least one active admin user must remain — create another admin first.' });
    }
  }

  db.prepare('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?').run(
    name !== undefined ? String(name) : user.name,
    nextRole,
    nextActive,
    user.id
  );
  if (password) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), user.id);
  }
  if (nextActive === 0) {
    // switched off — end any duty period here so their hours stop, then kill sessions
    db.prepare('UPDATE login_sessions SET logout_at = ? WHERE user_id = ? AND logout_at IS NULL').run(now(), user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  }
  res.json({ ok: true });
});

// ---------- per-person access: the Head hands out modules, not just roles ----------
// The body is a FULL effective map; only the differences from the person's role
// defaults are stored, so changing their role later still makes sense.
router.put('/users/:id/permissions', requireAuth, canUsers, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  // only the Head hands out modules — a Users grant alone must not let
  // somebody rewrite anyone's access, including their own
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the Head can change per-person modules.' });
  }
  const perms = req.body?.permissions;
  if (!perms || typeof perms !== 'object' || Array.isArray(perms)) {
    return badRequest(res, 'permissions must be a map of capability: true or false');
  }

  // the Head may never talk themself out of Users or Settings (self-lockout)
  if (user.id === req.user.id) {
    const effective = cap => (cap in perms) ? Boolean(perms[cap]) : can(user.role, cap);
    if (!effective('users') || !effective('settings')) {
      return badRequest(res, 'You cannot remove your own access to Users or Settings');
    }
  }

  db.transaction(() => {
    db.prepare('DELETE FROM user_permissions WHERE user_id = ?').run(user.id);
    const ins = db.prepare('INSERT INTO user_permissions (user_id, cap, allowed) VALUES (?, ?, ?)');
    for (const cap of ALL_CAPS) {
      if (cap in perms && Boolean(perms[cap]) !== can(user.role, cap)) {
        ins.run(user.id, cap, perms[cap] ? 1 : 0);
      }
    }
  })();
  res.json({ permissions: permsFor(user.id) });
});

// ---------- delete a person for good (their sessions die with them) ----------
router.delete('/users/:id', requireAuth, canUsers, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.id === req.user.id) return badRequest(res, 'You cannot delete your own account');
  if (user.role === 'admin' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the Head can delete a Head account.' });
  }
  if (user.role === 'admin' && user.active) {
    const others = db
      .prepare("SELECT COUNT(*) AS n FROM users WHERE id != ? AND role = 'admin' AND active = 1")
      .get(user.id).n;
    if (others === 0) {
      return badRequest(res, 'At least one active Head account must remain — create another Head first.');
    }
  }
  db.transaction(() => {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM login_sessions WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM user_permissions WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  })();
  res.json({ ok: true });
});

export default router;
