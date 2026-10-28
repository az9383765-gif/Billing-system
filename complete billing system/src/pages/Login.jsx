import React, { useEffect, useState, useRef } from 'react';
import { useApp } from '../store.jsx';
import { api } from '../api.js';
import { ROLES, ROLE_LABELS } from '../rbac.js';
import { Button } from '../components/ui/index.js';

// ---------- IDs this device has used: quick chips for "login with another ID" ----------
const IDS_KEY = 'shopbill_ids';
function recentIds() {
  try {
    const v = JSON.parse(localStorage.getItem(IDS_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function rememberId(u) {
  try {
    localStorage.setItem(IDS_KEY, JSON.stringify([u, ...recentIds().filter(x => x !== u)].slice(0, 4)));
  } catch { /* storage blocked — chips simply stay empty */ }
}

const ReceiptIcon = (
  <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 3h14v18l-2.3-1.6L14.4 21l-2.4-1.6L9.6 21l-2.3-1.6L5 21z" />
    <path d="M8.5 8h7M8.5 11.5h7M8.5 15h4" />
  </svg>
);

// ---------- Google sign-in (the Head switches it on in Settings) ----------
// The script is loaded only when a Client ID exists and only once per page —
// an offline device simply never sees the button, passwords still work.
let gisPromise = null;
function loadGis() {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => { gisPromise = null; reject(new Error('Google script blocked')); };
    document.head.appendChild(s);
  });
  return gisPromise;
}

function Hero({ brand }) {
  return (
    <aside className="login-hero">
      <div className="orb o1" /><div className="orb o2" /><div className="orb o3" />
      <div className="hero-top">
        <div className="hero-logo">{ReceiptIcon}</div>
        <div>
          <div className="hero-name">MartBill</div>
          <div className="hero-tagline">Billing · POS · Inventory</div>
        </div>
      </div>
      <div className="hero-mid">
        <h1>The billing system that sells itself.</h1>
        <p className="hero-lead">
          GST-ready thermal bills, barcode POS, live stock &amp; expiry alerts and a Head
          who approves every account. Works fully offline — your data stays on this device.
        </p>
        <ul className="hero-points">
          <li><span className="tick">✓</span> Pakistani GST billing in Rs / PKR</li>
          <li><span className="tick">✓</span> Barcode POS with low-stock &amp; expiry signals</li>
          <li><span className="tick">✓</span> Roles: Head · Inventory Manager · Cashier</li>
          <li><span className="tick">✓</span> Sales reports, returns &amp; near-expiry alerts</li>
        </ul>
      </div>
      <div className="hero-foot">
        <span className="hero-pill">Rs / PKR</span>
        <span className="hero-pill">GST ready</span>
        <span className="hero-pill">Offline first</span>
        <span className="hero-pill">v1.0.0</span>
        {brand?.shop_name ? <span className="hero-pill shop">{brand.shop_name}</span> : null}
      </div>
    </aside>
  );
}

function MobileBrand({ brand }) {
  return (
    <div className="m-brand">
      <div className="brand-logo" style={{ width: 40, height: 40, fontSize: 20 }}>S</div>
      <div>
        <h2>MartBill</h2>
        <div className="muted small">{brand?.shop_name || 'Billing & POS System'}</div>
      </div>
    </div>
  );
}

export default function Login() {
  const { login, loginWithToken } = useApp();
  const [view, setView] = useState('login'); // login | register | done
  const [brand, setBrand] = useState(null);
  const [username, setUsername] = useState(() => {
    // "Remember me" keeps the username on this device (never the password)
    try { return localStorage.getItem('shopbill_user') || ''; } catch { return ''; }
  });
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(() => {
    try { return !!localStorage.getItem('shopbill_user'); } catch { return false; }
  });
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [recent] = useState(() => recentIds());
  const [reg, setReg] = useState({ shop_name: '', name: '', username: '', role: 'cashier', password: '', confirm: '' });
  const [regError, setRegError] = useState('');
  const [regBusy, setRegBusy] = useState(false);
  const [doneMsg, setDoneMsg] = useState('');

  // public info for the login page (shop name, fresh-install flag, demo logins)
  useEffect(() => {
    let alive = true;
    api('/auth/brand')
      .then(b => { if (alive) setBrand(b); })
      .catch(() => { /* server unreachable — the form still works, login reports it */ });
    return () => { alive = false; };
  }, []);

  const setup = !!brand?.setup;
  const allowRegister = !!brand && brand.allow_register !== false;
  const demo = brand?.demo || [];
  const goRegister = () => { setRegError(''); setView('register'); };
  const goLogin = () => { setRegError(''); setError(''); setView('login'); };
  const setRegField = (k, v) => setReg(r => ({ ...r, [k]: v }));

  // ---------- Google sign-in button (only when the Head has switched it on) ----------
  const googleId = brand?.google_client_id || '';
  const gBtnRef = useRef(null);
  const [gScriptFail, setGScriptFail] = useState(false);

  // Google hands over a signed credential; MartBill decides what it means
  const googleDone = async credential => {
    setError('');
    setBusy(true);
    try {
      const r = await api('/auth/google', { method: 'POST', body: { credential } });
      if (r.pending) {
        setDoneMsg(r.message || 'Google address recognised. The Head must approve this account in Settings → Users.');
        setView('done');
      } else {
        await loginWithToken(r.token);
        rememberId(r.user?.username || '');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const googleDoneRef = useRef(googleDone);
  googleDoneRef.current = googleDone;

  useEffect(() => {
    if (!googleId || view !== 'login' || !gBtnRef.current) return undefined;
    let alive = true;
    loadGis()
      .then(() => {
        if (!alive || !gBtnRef.current || !window.google?.accounts?.id) return;
        window.google.accounts.id.initialize({
          client_id: googleId,
          callback: data => googleDoneRef.current(data?.credential)
        });
        window.google.accounts.id.renderButton(gBtnRef.current, {
          theme: 'outline', size: 'large', width: 320, text: 'continue_with'
        });
      })
      .catch(() => { setGScriptFail(true); }); // no internet / script blocked — passwords still work
    return () => { alive = false; };
  }, [googleId, view]);

  // offline system — there are no reset emails; the Head owns every password
  const forgotPw = () =>
    setError('Ask the Head of this shop to set a new password for you: Settings → Users → Edit.');

  // "Use another ID" — clear whatever this device remembers so whoever sits down
  // next can sign in with an ID of their own choosing (never locked to one name)
  const userRef = useRef(null);
  const useAnotherId = () => {
    setUsername('');
    setPassword('');
    setError('');
    try { localStorage.removeItem('shopbill_user'); } catch { /* storage blocked */ }
    requestAnimationFrame(() => userRef.current?.focus());
  };

  const submit = async e => {
    e.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      await login(username.trim(), password);
      rememberId(username.trim());
      try {
        if (remember) localStorage.setItem('shopbill_user', username.trim());
        else localStorage.removeItem('shopbill_user');
      } catch { /* storage blocked — nothing to remember */ }
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const submitRegister = async e => {
    e.preventDefault();
    if (regBusy) return;
    setRegError('');
    if (!reg.name.trim()) { setRegError('Please enter your name'); return; }
    if (!reg.username.trim()) { setRegError('Please choose a username'); return; }
    if (setup && !reg.shop_name.trim()) { setRegError('Please enter your shop name'); return; }
    if (reg.password.length < 4) { setRegError('Password must be at least 4 characters'); return; }
    if (reg.password !== reg.confirm) { setRegError('Passwords do not match'); return; }
    setRegBusy(true);
    try {
      const body = {
        name: reg.name.trim(),
        username: reg.username.trim(),
        password: reg.password,
        confirm: reg.confirm
      };
      if (setup) body.shop_name = reg.shop_name.trim();
      else body.role = reg.role;
      const r = await api('/auth/register', { method: 'POST', body });
      if (r.setup || r.token) {
        // first run — the owner account is ready, sign straight in
        await login(reg.username.trim(), reg.password);
        rememberId(reg.username.trim());
      } else {
        setDoneMsg(r.message || 'Account created. The Head must approve it before it can sign in.');
        setView('done');
      }
    } catch (err) {
      setRegError(err.message);
    } finally {
      setRegBusy(false);
    }
  };

  return (
    <div className="login-page">
      <Hero brand={brand} />

      <main className="login-side">
        {view === 'login' ? (
          <form className="login-card" onSubmit={submit}>
            <MobileBrand brand={brand} />

            <div className="ltabs" role="tablist">
              <div className="ltab on" role="tab" aria-selected="true">Sign in</div>
              {allowRegister && !setup ? (
                <div className="ltab" role="tab" aria-selected="false" onClick={goRegister}>Create account</div>
              ) : null}
            </div>

            <div className="card-head">
              <h2>Welcome back</h2>
              <div className="tag">{brand?.shop_name ? `Sign in to ${brand.shop_name}` : 'Sign in to continue'}</div>
            </div>

            {/* stable slots — content appears without shifting the fields below */}
            <div className="banner-slot">
              {setup && allowRegister ? (
                <div className="setup-banner" role="button" tabIndex={0} onClick={goRegister}>
                  ✨ First time here? <b>Create your shop's owner account</b> →
                </div>
              ) : null}
            </div>
            <div className="alert-slot">
              {error ? <div className="alert error">{error}</div> : null}
            </div>

            <div className="field">
              <label>Username</label>
              <input
                className="input" autoFocus autoComplete="username" ref={userRef}
                value={username} onChange={e => setUsername(e.target.value)}
                placeholder="Enter username"
              />
            </div>
            <div className="field">
              <label>Password</label>
              <div className="pwd-wrap">
                <input
                  className="input" type={showPw ? 'text' : 'password'} autoComplete="current-password"
                  value={password} onChange={e => setPassword(e.target.value)}
                  placeholder="Enter password"
                />
                <span
                  className="pwd-eye" role="button" tabIndex={0}
                  onClick={() => setShowPw(v => !v)}
                  onKeyDown={e => { if (e.key === 'Enter') setShowPw(v => !v); }}
                >{showPw ? 'Hide' : 'Show'}</span>
              </div>
            </div>

            <div className="login-opts">
              <label className="remember">
                <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
                Remember me
              </label>
              <span
                className="forgot" role="button" tabIndex={0}
                onClick={forgotPw}
                onKeyDown={e => { if (e.key === 'Enter') forgotPw(); }}
              >Forgot password?</span>
            </div>

            <Button className="login-btn" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>

            {/* Google sign-in — rendered only when the Head has set a Client ID,
                and only the script's own button lives inside this slot */}
            {googleId ? (
              <div className="google-slot">
                <div className="or-line"><span>or</span></div>
                {gScriptFail ? (
                  <div className="muted small center">
                    Google sign-in needs an internet connection — sign in with your password instead.
                  </div>
                ) : (
                  <>
                    <div className="g-btn" ref={gBtnRef} />
                    <div className="muted small center" style={{ marginTop: 6 }}>
                      A new Google address still waits for the Head's approval.
                    </div>
                  </>
                )}
              </div>
            ) : null}

            {/* always active — the block exists on every device, even a fresh
                install with no past IDs, so anyone can pick up this system and
                sign in with an ID of their own choosing */}
            <div className="alt-block">
              <div className="alt-title">Login with another ID</div>
              <div className="id-chips">
                {recent.map(id => (
                  <div
                    key={'r' + id} className="id-chip" role="button" tabIndex={0}
                    onClick={() => { setUsername(id); setPassword(''); setError(''); }}
                  >
                    <span className="dot grey" />{id}
                  </div>
                ))}
                {demo.map(d => (
                  <div
                    key={'d' + d.username} className="id-chip" role="button" tabIndex={0}
                    onClick={() => { setUsername(d.username); setPassword(d.password); setError(''); }}
                  >
                    <span className="dot" />{d.label} · {d.username}
                  </div>
                ))}
                <div
                  className="id-chip add" role="button" tabIndex={0}
                  onClick={useAnotherId}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); useAnotherId(); } }}
                >
                  <span className="dot plus">＋</span>Use another ID
                </div>
              </div>
            </div>

            <div className="muted small center" style={{ marginTop: 16 }}>
              Works offline &amp; online · Your data stays on this device
            </div>
          </form>
        ) : null}

        {view === 'register' ? (
          <form className="login-card" onSubmit={submitRegister}>
            <MobileBrand brand={brand} />

            <div className="ltabs" role="tablist">
              <div className="ltab" role="tab" onClick={goLogin}>Sign in</div>
              <div className="ltab on" role="tab" aria-selected="true">Create account</div>
            </div>

            {setup ? (
              <>
                <div className="card-head">
                  <h2>Set up your shop</h2>
                  <div className="tag">Create the owner (Head) account — you'll be signed in right away.</div>
                </div>
                <div className="alert info">
                  This <b>Head</b> account approves users, sees every report and controls all settings.
                </div>
                <div className="field">
                  <label>Shop name</label>
                  <input
                    className="input" autoFocus value={reg.shop_name}
                    onChange={e => setRegField('shop_name', e.target.value)}
                    placeholder="e.g. Al-Hafiz Karyana Store"
                  />
                </div>
              </>
            ) : (
              <>
                <div className="card-head">
                  <h2>Create a new account</h2>
                  <div className="tag">A new ID for this billing system.</div>
                </div>
                <div className="alert info">
                  Your account starts <b>pending</b> — the Head approves it in <b>Settings → Users</b>,
                  then you can sign in.
                </div>
              </>
            )}

            <div className="alert-slot">
              {regError ? <div className="alert error">{regError}</div> : null}
            </div>

            <div className="field">
              <label>Your name</label>
              <input
                className="input" value={reg.name}
                onChange={e => setRegField('name', e.target.value)}
                placeholder="Full name"
              />
            </div>
            <div className="field">
              <label>Username</label>
              <input
                className="input" autoComplete="username" value={reg.username}
                onChange={e => setRegField('username', e.target.value)}
                placeholder="e.g. bilal_ahmed"
              />
            </div>
            {!setup ? (
              <div className="field">
                <label>Role</label>
                <select className="input" value={reg.role} onChange={e => setRegField('role', e.target.value)}>
                  {ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                </select>
                <div className="muted small" style={{ marginTop: 5 }}>
                  The Head can change this before approving.
                </div>
              </div>
            ) : null}
            <div className="field">
              <label>Password</label>
              <input
                className="input" type="password" autoComplete="new-password" value={reg.password}
                onChange={e => setRegField('password', e.target.value)}
                placeholder="At least 4 characters"
              />
            </div>
            <div className="field">
              <label>Confirm password</label>
              <input
                className="input" type="password" autoComplete="new-password" value={reg.confirm}
                onChange={e => setRegField('confirm', e.target.value)}
                placeholder="Repeat password"
              />
            </div>

            <Button className="login-btn" disabled={regBusy}>
              {regBusy ? 'Creating…' : setup ? 'Create my shop account' : 'Request account'}
            </Button>

            <div className="link-row" role="button" tabIndex={0} onClick={goLogin}>
              ← Back to sign in
            </div>
          </form>
        ) : null}

        {view === 'done' ? (
          <div className="login-card center">
            <div className="done-ico">✓</div>
            <h2>Account request sent</h2>
            <div className="tag" style={{ margin: '8px 0 22px' }}>{doneMsg}</div>
            <Button className="login-btn" onClick={goLogin}>Back to sign in</Button>
          </div>
        ) : null}
      </main>
    </div>
  );
}
