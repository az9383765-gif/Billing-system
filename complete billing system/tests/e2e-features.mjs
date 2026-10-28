// Feature UI test: returns & refunds, expiry dates, % discount, dashboard GST,
// held bills, loyalty points, coupons, the expense book and per-person access.
// Run with: npm run test:features   (server must be running on port 3000)
// Kept separate from e2e-ui.mjs so the original suite stays untouched.
import puppeteer from 'puppeteer-core';
import fs from 'fs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];
const executablePath = CANDIDATES.find(p => fs.existsSync(p));
if (!executablePath) {
  console.error('No Edge/Chrome found for UI testing');
  process.exit(1);
}

const errors = [];
const fails = [];
let offlineWindow = false; // true only while the PWA test drives setOfflineMode
const ok = msg => console.log(`  ✔ ${msg}`);
const fail = msg => { fails.push(msg); console.log(`  ✖ ${msg}`); };
const wait = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
// window.confirm() — the Void flow asks for one. Accept only that dialog so the
// suite can drive it; any other confirm (delete customer, restore backup …)
// stays cancelled, exactly as a cautious user would leave it.
page.on('dialog', async d => {
  if (d.message().startsWith('Void invoice')) await d.accept();
  else await d.dismiss();
});
page.on('console', m => {
  if (m.type() !== 'error') return;
  // the test deliberately triggers a 401 on the login form to check the message
  const url = (m.location && m.location() && m.location().url) || '';
  if (url.includes('/api/auth/login')) return;
  // the PWA test pulls the internet on purpose — those network errors are expected
  if (offlineWindow && /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|Failed to load resource/i.test(m.text())) return;
  errors.push('console: ' + m.text());
});

async function expectNoToasts(label) {
  await wait(400);
  const toastErrors = await page.$$eval('.toast.error', els => els.map(e => e.textContent));
  if (toastErrors.length) fail(`${label}: UI error toasts — ${toastErrors.join(' | ')}`);
}

// replace whatever is in an input, the way React notices
async function replaceInput(handle, text) {
  await handle.click();
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await handle.type(text);
}

async function findButtonByText(text) {
  const handles = await page.$$('.modal-foot .btn, .btn');
  for (const h of handles) {
    const t = await h.evaluate(el => el.textContent);
    if (t.includes(text)) return h;
  }
  return null;
}

// navigate and only continue once the SPA really shows the new page
async function gotoPage(hash, selector) {
  await page.evaluate(h => { window.location.hash = h; }, hash);
  await page.waitForFunction(
    (h, sel) => window.location.hash === '#' + h && !!document.querySelector(sel),
    { timeout: 12000 }, hash, selector
  );
  await wait(300);
}

try {
  console.log('Feature UI test against', BASE);

  // ---- login page: quick IDs, real error text, create-account flow ----
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 20000 });
  await page.waitForSelector('.login-card', { timeout: 10000 });

  // "login with another ID" must be active on EVERY device — a fresh install
  // (no past IDs, no demo logins) still offers it, and it lets the person who
  // takes this system sign in with an ID of their own choosing.
  await page.waitForSelector('.alt-block .id-chip', { timeout: 5000 }).catch(() => null);
  const chipCount = await page.$$eval('.id-chip', els => els.length);
  chipCount > 0 ? ok(`login page offers ${chipCount} quick ID chip(s)`) : fail('no "login with another ID" chips');
  const addChip = await page.$('.id-chip.add');
  addChip ? ok('"Use another ID" control is active') : fail('"Use another ID" control missing');
  await addChip.click();
  await wait(150);
  const afterClear = await page.$eval('input[autocomplete="username"]', el => el.value);
  afterClear === ''
    ? ok('another ID clears whatever this device remembered')
    : fail(`"Use another ID" left "${afterClear}" in the field`);
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('autocomplete'));
  focused === 'username'
    ? ok('the ID field takes focus for typing any name')
    : fail(`ID field not focused (activeElement=${focused})`);
  await page.type('input[autocomplete="username"]', 'my-own-id');
  const chosen = await page.$eval('input[autocomplete="username"]', el => el.value);
  chosen === 'my-own-id'
    ? ok('a chosen ID can be typed for sign-in')
    : fail(`username field holds "${chosen}"`);
  // clear again so the wrong-password test below starts from an empty field
  await page.$eval('.id-chip.add', el => el.click());
  await wait(100);

  // a wrong password must show the real reason, not a generic notice
  await page.type('input[autocomplete="username"]', 'admin');
  await page.type('input[autocomplete="current-password"]', 'definitely-wrong');
  await page.click('.login-card button');
  await page.waitForSelector('.login-card .alert.error', { timeout: 8000 });
  const alertText = await page.$eval('.login-card .alert.error', el => el.textContent);
  alertText.includes('Invalid username or password')
    ? ok('wrong password shows the real reason')
    : fail(`unexpected login error text: ${alertText}`);

  // Create account tab opens the sign-up form, and back works
  await page.click('.ltab:not(.on)');
  await page.waitForSelector('input[autocomplete="new-password"]', { timeout: 5000 });
  const roleVisible = await page.$$eval('select.input',
    els => els.some(s => [...s.options].some(o => o.text === 'Head')));
  roleVisible ? ok('register form offers roles the Head will approve') : fail('role select missing on register form');
  const approvalNote = await page.$$eval('.alert.info',
    els => els.some(e => e.textContent.includes('pending')));
  approvalNote ? ok('register form explains Head approval') : fail('missing approval note');
  await page.click('.ltab:not(.on)');
  await page.waitForSelector('input[autocomplete="current-password"]', { timeout: 5000 });

  // real login
  await replaceInput(await page.$('input[autocomplete="username"]'), 'admin');
  await replaceInput(await page.$('input[autocomplete="current-password"]'), 'admin123');
  await page.click('.login-card button');
  await page.waitForSelector('.shell', { timeout: 15000 });
  ok('login succeeds');

  // ---- PWA: installable, service worker, online/offline pill, dark theme ----
  const manifestHref = await page.$eval('link[rel="manifest"]', el => el.getAttribute('href')).catch(() => null);
  manifestHref === '/manifest.json' ? ok('app is installable (manifest linked)') : fail('manifest link missing');

  const swReady = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return false;
    const regs = await navigator.serviceWorker.getRegistrations();
    return regs.length > 0;
  });
  swReady ? ok('service worker registered (app opens with no internet)') : fail('service worker not registered');

  offlineWindow = true;
  await page.setOfflineMode(true);
  await page.waitForFunction(
    () => /offline/i.test(document.querySelector('.sync-badge')?.textContent || ''),
    { timeout: 8000 }
  ).catch(() => null);
  const offlineText = await page.$eval('.sync-badge', el => el.textContent);
  /offline/i.test(offlineText)
    ? ok(`internet drop announced: "${offlineText.trim()}"`)
    : fail(`pill says "${offlineText.trim()}" while offline`);
  await page.setOfflineMode(false);
  await page.waitForFunction(
    () => !/offline/i.test(document.querySelector('.sync-badge')?.textContent || ''),
    { timeout: 8000 }
  ).catch(() => null);
  const onlineText = await page.$eval('.sync-badge', el => el.textContent);
  !/offline/i.test(onlineText)
    ? ok(`connection restored announced: "${onlineText.trim()}"`)
    : fail(`pill still says "${onlineText.trim()}" after reconnect`);
  offlineWindow = false;

  // dark premium theme — one click in the topbar, remembered per device
  const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme || 'light');
  await page.click('.topbar .icon-btn');
  await wait(250);
  const themeAfter = await page.evaluate(() => document.documentElement.dataset.theme);
  themeAfter !== themeBefore ? ok(`theme toggle works (${themeBefore} → ${themeAfter})`) : fail('theme toggle did nothing');
  await page.evaluate(() => { window.location.hash = '/settings'; });
  await page.waitForSelector('.theme-opt', { timeout: 8000 });
  const optOn = await page.$eval('.theme-opt.on', el => el.textContent.trim()).catch(() => '');
  optOn.toLowerCase().includes(themeAfter)
    ? ok('Settings → Appearance reflects the active theme')
    : fail(`active theme "${themeAfter}" not shown in Appearance ("${optOn}")`);
  await page.click('.theme-opt:not(.on)');
  await wait(200);
  const restored = await page.evaluate(() => document.documentElement.dataset.theme);
  restored === 'light' ? ok('theme switched back to light') : fail(`theme stuck on ${restored}`);

  // ---- demo stock self-heal: repeated runs must never bill a product dry ----
  {
    const tok = await page.evaluate(() => localStorage.getItem('shopbill_token'));
    const auth = { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' };
    const body = await (await fetch(BASE + '/api/products', { headers: auth })).json();
    const items = Array.isArray(body) ? body : (body.items || body.products || []);
    let topped = 0;
    for (const p of items) {
      if (Number(p.stock_qty) < 10) {
        const r = await fetch(BASE + '/api/products/' + p.id, {
          method: 'PUT', headers: auth, body: JSON.stringify({ stock_qty: 10 })
        });
        if (r.ok) topped++;
      }
    }
    topped > 0
      ? ok(`demo stock topped back up (${topped} product${topped > 1 ? 's' : ''} below 10)`)
      : ok('demo stock healthy — nothing to top up');
  }

  // ---- POS: expired stock is refused, % discount, near-expiry badge ----
  await page.evaluate(() => { window.location.hash = '/pos'; });
  await page.waitForSelector('.product-tile', { timeout: 10000 });

  const searchFor = async text => {
    const input = await page.$('input[placeholder^="Scan"]');
    await replaceInput(input, text);
    return input;
  };

  await searchFor('Milk Powder');
  await page.waitForFunction(
    () => [...document.querySelectorAll('.product-tile')].some(t => t.textContent.includes('Milk Powder')),
    { timeout: 8000 }
  );

  const milkHandle = await page.evaluateHandle(() =>
    [...document.querySelectorAll('.product-tile')].find(t => t.textContent.includes('Milk Powder'))
  );
  const milkText = await milkHandle.evaluate(el => el.textContent);
  milkText.includes('EXPIRED') ? ok('POS tile flags the expired batch') : fail(`expired tile shows no EXPIRED badge: ${milkText}`);

  await milkHandle.asElement().click();
  await page.waitForSelector('.toast.error', { timeout: 5000 });
  const errToast = await page.$eval('.toast.error', el => el.textContent);
  errToast.includes('expired')
    ? ok('expired stock is refused at the counter — ' + errToast.slice(0, 70) + '…')
    : fail(`unexpected toast: ${errToast}`);
  const cartAfterBlock = await page.$$eval('.cart-line', els => els.length);
  cartAfterBlock === 0 ? ok('nothing was added to the cart') : fail('expired item reached the cart!');
  // let the error toast retire before the rest of the run
  await page.waitForFunction(() => !document.querySelector('.toast.error'), { timeout: 9000 });

  // near-expiry tile still sells, with a countdown badge
  await searchFor('Tea Pack');
  await page.waitForFunction(
    () => [...document.querySelectorAll('.product-tile')].some(t => t.textContent.includes('Tea Pack')),
    { timeout: 8000 }
  );
  const teaHandle = await page.evaluateHandle(() =>
    [...document.querySelectorAll('.product-tile')].find(t => t.textContent.includes('Tea Pack'))
  );
  const teaText = await teaHandle.evaluate(el => el.textContent);
  /\d+d/.test(teaText) ? ok(`near-expiry tile shows a countdown badge (${teaText.match(/\d+d/)[0]})`)
    : fail(`no near-expiry badge: ${teaText}`);
  await teaHandle.asElement().click();
  await page.waitForSelector('.cart-line', { timeout: 5000 });
  ok('near-expiry goods can still be billed');

  const totalBefore = await page.$eval('.totals .t-row.grand span:last-child', el => el.textContent);

  // % discount mode
  const modeResult = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.t-row')].find(r => r.firstElementChild?.textContent === 'Discount');
    if (!row) return 'no discount row';
    const pct = [...row.querySelectorAll('button')].find(b => b.textContent.trim() === '%');
    if (!pct) return 'no % button';
    pct.click();
    return 'ok';
  });
  if (modeResult !== 'ok') fail('% discount toggle: ' + modeResult);
  const discInput = await page.evaluateHandle(() => {
    const row = [...document.querySelectorAll('.t-row')].find(r => r.firstElementChild?.textContent === 'Discount');
    return row.querySelector('input');
  });
  await replaceInput(discInput.asElement(), '10');
  await wait(300);
  const discountRowText = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.t-row')].find(r => r.firstElementChild?.textContent === 'Discount');
    return row.textContent;
  });
  discountRowText.includes('= Rs.')
    ? ok('10% discount converts to rupees on screen — ' + discountRowText.replace('Discount', '').trim())
    : fail(`% discount shows no rupee conversion: ${discountRowText}`);
  const totalAfter = await page.$eval('.totals .t-row.grand span:last-child', el => el.textContent);
  totalAfter !== totalBefore ? ok(`grand total drops with the % discount: ${totalBefore} → ${totalAfter}`)
    : fail('grand total did not change with the discount');

  // complete the sale for real (feeds the dashboard GST card)
  await page.$$eval('.pay-grid .btn', els => {
    const b = els.find(e => e.textContent.includes('Cash'));
    if (b) b.click();
  });
  await page.$$eval('.btn.success', els => {
    const b = els.find(e => e.textContent.includes('Complete Sale'));
    if (b) b.click();
  });
  await page.waitForFunction(
    () => [...document.querySelectorAll('.modal-head h3')].some(h => h.textContent.includes('Sale Completed')),
    { timeout: 10000 }
  );
  ok('sale with % discount saved');
  await page.$$eval('.modal-foot .btn', els => {
    const b = els.find(e => e.textContent.includes('New Sale'));
    if (b) b.click();
  });
  await wait(400);
  await expectNoToasts('POS sale');

  // ---- Dashboard: GST today card + by-rate breakdown ----
  await page.evaluate(() => { window.location.hash = '/'; });
  await page.waitForSelector('.stat', { timeout: 10000 });
  await wait(600);
  const gstCard = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.stat')];
    const c = cards.find(el => el.querySelector('.label')?.textContent.includes('GST Today'));
    return c ? { label: c.querySelector('.label').textContent, value: c.querySelector('.value').textContent, sub: c.querySelector('.sub')?.textContent } : null;
  });
  gstCard && gstCard.value.includes('Rs')
    ? ok(`dashboard shows GST Today: ${gstCard.value} (${gstCard.sub})`)
    : fail('GST Today card missing or not money: ' + JSON.stringify(gstCard));
  const byRate = await page.evaluate(() =>
    [...document.querySelectorAll('.card-title')].some(t => t.textContent.includes('by Rate'))
  );
  byRate ? ok('dashboard lists the GST collected by rate') : fail('GST by-rate card missing');

  // ---- Products: expiry column ----
  await gotoPage('/products', '.tbl');
  const hasExpiryCol = await page.$$eval('th', ths => ths.some(t => t.textContent.trim() === 'Expiry'));
  hasExpiryCol ? ok('products table has an Expiry column') : fail('Expiry column missing');
  const milkRowExpired = await page.evaluate(() => {
    const tr = [...document.querySelectorAll('.tbl tbody tr')].find(r => r.textContent.includes('Milk Powder'));
    return tr ? tr.textContent.includes('EXPIRED') : false;
  });
  milkRowExpired ? ok('products table flags the expired batch') : fail('expired badge missing in products table');

  // ---- Inventory: near-expiry report ----
  await gotoPage('/inventory', '.stat');
  const invBits = await page.evaluate(() => ({
    stat: [...document.querySelectorAll('.stat .label')].some(l => l.textContent.includes('Expiring')),
    card: [...document.querySelectorAll('.card-title')].some(t => t.textContent.includes('Expiring Soon')),
    rows: [...document.querySelectorAll('.card')].filter(c => c.textContent.includes('Expiring Soon'))
      .reduce((n, c) => n + c.querySelectorAll('tbody tr').length, 0)
  }));
  invBits.stat ? ok('inventory shows the expiring-soon counter') : fail('expiring stat missing');
  invBits.card && invBits.rows >= 2 ? ok(`near-expiry report card lists ${invBits.rows} batch(es)`)
    : fail(`near-expiry card incomplete: ${JSON.stringify(invBits)}`);
  await expectNoToasts('inventory');

  // ---- Invoices: full return + credit note ----
  await gotoPage('/invoices', '.tbl tbody tr');
  await page.click('.tbl tbody tr');
  await page.waitForSelector('.modal-head h3', { timeout: 8000 });
  await page.waitForFunction(
    () => [...document.querySelectorAll('.modal-head h3')].some(h => h.textContent.includes('Invoice INV-')),
    { timeout: 8000 }
  );

  const returnBtn = await findButtonByText('↩ Return');
  returnBtn ? await returnBtn.click() : fail('Return button missing on the invoice');
  if (returnBtn) {
    await page.waitForFunction(
      () => [...document.querySelectorAll('.modal-head h3')].some(h => h.textContent.includes('Return against')),
      { timeout: 8000 }
    );
    ok('return form opens from the invoice');

    const qtyInput = await page.evaluateHandle(() => {
      const modal = [...document.querySelectorAll('.modal')].find(m => m.textContent.includes('Return against'));
      return modal.querySelector('input[type="number"]');
    });
    await replaceInput(qtyInput.asElement(), '1');
    await wait(200);

    const saveBtn = await findButtonByText('Save Return & Refund');
    if (saveBtn) await saveBtn.click();
    else fail('Save Return & Refund button missing');

    await page.waitForFunction(
      () => [...document.querySelectorAll('.modal-head h3')].some(h => h.textContent.includes('Credit Note RET-')),
      { timeout: 10000 }
    );
    ok('credit note created (RET-) with refund split');

    const printBtn = await findButtonByText('Print Credit Note');
    printBtn ? ok('refund note is printable') : fail('Print Credit Note button missing');

    // close the credit-note modal (last Close = the top modal)
    await page.$$eval('.modal-foot .btn', els => {
      const closes = els.filter(e => e.textContent.trim() === 'Close');
      closes[closes.length - 1]?.click();
    });
    await wait(300);

    const detailShowsReturn = await page.evaluate(() => {
      const modal = [...document.querySelectorAll('.modal')].find(m => m.textContent.includes('Invoice INV-'));
      if (!modal) return null;
      return {
        history: modal.textContent.includes('Returns (credit notes)'),
        returnedRow: modal.textContent.includes('Returned'),
        qtyBadge: /\d+\s*ret/.test(modal.textContent)
      };
    });
    detailShowsReturn?.history && detailShowsReturn?.returnedRow
      ? ok('invoice detail lists the credit note and the returned amount')
      : fail('invoice detail missing return info: ' + JSON.stringify(detailShowsReturn));

    // close the invoice detail
    await page.$$eval('.modal-foot .btn', els => {
      const b = els.find(e => e.textContent.trim() === 'Close');
      if (b) b.click();
    });
    await wait(400);

    const listBadge = await page.evaluate(() => {
      const tr = document.querySelector('.tbl tbody tr');
      return tr ? tr.textContent.includes('↩') : false;
    });
    listBadge ? ok('invoice list shows the returned amount badge') : fail('returned badge missing in invoice list');
  }
  await expectNoToasts('return flow');

  // ---- settings: the Head switches new account requests off and on ----
  await gotoPage('/settings', '.card');
  const clickSignUpToggle = () => page.evaluate(() => {
    const l = [...document.querySelectorAll('label')]
      .find(x => x.textContent.includes('Allow new account requests'));
    if (!l) return null;
    const cb = l.querySelector('input[type="checkbox"]');
    cb.click();
    return cb.checked;
  });
  try {
    await clickSignUpToggle();
    await page.waitForFunction(
      () => [...document.querySelectorAll('.toast.success')].some(t => t.textContent.includes('requests are OFF')),
      { timeout: 5000 }
    );
    ok('sign-up switch turns OFF');
    const brandOff = await page.evaluate(async () =>
      (await (await fetch('/api/auth/brand')).json()).allow_register);
    brandOff === false
      ? ok('login page now hides Create account')
      : fail('brand still allows sign-ups: ' + brandOff);

    await clickSignUpToggle();
    await page.waitForFunction(
      () => [...document.querySelectorAll('.toast.success')].some(t => t.textContent.includes('requests are ON')),
      { timeout: 5000 }
    );
    ok('sign-up switch turns back ON');
  } finally {
    // never leave the live shop without sign-ups, whatever happened above
    await page.evaluate(async () => {
      const t = localStorage.getItem('shopbill_token');
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
        body: JSON.stringify({ allow_register: '1' })
      });
    }).catch(() => {});
  }
  await expectNoToasts('settings sign-up switch');

  // ============ MartBill additions: loyalty, coupons, hold, expenses, access ============

  // ---- Settings: loyalty scheme + coupon desk ----
  await gotoPage('/settings', '.card-title');
  const settingsCards = await page.evaluate(() => ({
    loyalty: [...document.querySelectorAll('.card-title')].some(t => t.textContent.includes('Loyalty Points')),
    coupons: [...document.querySelectorAll('.card-title')].some(t => t.textContent.includes('Coupons (discount codes)')),
    cloud: [...document.querySelectorAll('.card-title')].some(t => t.textContent.includes('Cloud backup — Supabase'))
  }));
  settingsCards.loyalty ? ok('Settings has the Loyalty Points card') : fail('Loyalty Points card missing');
  settingsCards.coupons ? ok('Settings has the Coupons desk') : fail('Coupons card missing');
  settingsCards.cloud ? ok('Settings has the Supabase cloud backup card') : fail('Cloud backup card missing');

  // ---- hours logged in: the Users card carries each person's duty time ----
  const dutyInfo = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.card')]
      .find(c => c.textContent.includes('the Head decides who can log in'));
    if (!card) return null;
    const heads = [...card.querySelectorAll('th')].map(t => t.textContent.trim());
    const rows = [...card.querySelectorAll('tbody tr')].map(tr => tr.textContent);
    return {
      heads,
      hasHours: heads.includes('Hours'),
      rowsWithTime: rows.filter(t => /\d+m|\d+h/.test(t)).length,
      onDuty: rows.filter(t => t.includes('on duty')).length
    };
  });
  dutyInfo && dutyInfo.hasHours && dutyInfo.rowsWithTime >= 1
    ? ok(`hours logged in shown per person (${dutyInfo.onDuty} on duty right now)`)
    : fail('duty hours column missing: ' + JSON.stringify(dutyInfo));

  // ---- per-person access: the Edit dialog carries Module access switches ----
  const userCardInfo = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.card')]
      .find(c => c.textContent.includes('the Head decides who can log in'));
    if (!card) return null;
    const dels = card.querySelectorAll('button[title="Delete this person"]').length;
    const edit = [...card.querySelectorAll('.btn')].find(b => b.textContent.trim() === 'Edit');
    if (edit) edit.click();
    return { dels, hasEdit: Boolean(edit) };
  });
  userCardInfo && userCardInfo.dels >= 1
    ? ok('user list offers per-person delete')
    : fail('delete button missing in the users list: ' + JSON.stringify(userCardInfo));
  if (userCardInfo?.hasEdit) {
    await page.waitForFunction(
      () => document.body.textContent.includes('Module access — beyond the role'),
      { timeout: 6000 }
    );
    const moduleSw = await page.$$eval('.modal .checkbox', els => els.map(e => e.textContent));
    moduleSw.some(t => t.includes('Billing (POS)')) && moduleSw.some(t => t.includes('Expenses')) && moduleSw.some(t => t.includes('Reports'))
      ? ok(`edit-user dialog exposes ${moduleSw.length} module switches`)
      : fail('module switches missing: ' + JSON.stringify(moduleSw.slice(0, 6)));
    await page.$$eval('.modal-foot .btn', els => {
      const b = els.find(e => e.textContent.trim() === 'Cancel');
      if (b) b.click();
    });
    await wait(300);
    const modalClosed = await page.evaluate(() =>
      ![...document.querySelectorAll('.modal-head h3')].some(h => h.textContent.includes('Edit User'))
    );
    modalClosed ? ok('edit-user dialog closes without changes') : fail('edit-user dialog stayed open');
  }

  // ---- coupon desk: make sure WELCOME50 exists (created through the real UI) ----
  let token = await page.evaluate(() => localStorage.getItem('shopbill_token'));
  const j = async (path, opts = {}) => {
    const r = await fetch(BASE + path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  let liveCoupons = (await j('/api/coupons')).body;
  if (!Array.isArray(liveCoupons)) liveCoupons = [];
  if (!liveCoupons.find(c => c.code === 'WELCOME50')) {
    await page.evaluate(() => {
      [...document.querySelectorAll('.btn')].find(b => b.textContent.includes('New coupon'))?.click();
    });
    await wait(300);
    const fillField = async (labelText, value) => {
      const h = await page.evaluateHandle(l => {
        const lab = [...document.querySelectorAll('label')].find(x => x.textContent.trim() === l);
        const el = lab ? lab.parentElement.querySelector('input') : null;
        if (el) el.focus();
        return el;
      }, labelText);
      const el = h.asElement();
      if (el) await replaceInput(el, value);
      return Boolean(el);
    };
    (await fillField('Code', 'WELCOME50')) || fail('coupon Code field missing');
    (await fillField('Amount off (Rs.)', '50')) || fail('coupon amount field missing');
    const createBtn = await findButtonByText('Create coupon');
    createBtn ? await createBtn.click() : fail('Create coupon button missing');
    await page.waitForFunction(
      () => [...document.querySelectorAll('.card')]
        .some(c => c.textContent.includes('Coupons (discount codes)') && c.textContent.includes('WELCOME50')),
      { timeout: 6000 }
    );
    ok('WELCOME50 coupon created from the Settings desk');
  } else {
    ok('WELCOME50 coupon already on the desk');
  }

  // ---- the Head ticks modules for a counter boy → his OWN panel must show them ----
  {
    const people = (await j('/api/auth/users')).body || [];
    let boy = people.find(u => u.username === 'counter-boy');
    if (!boy) {
      await j('/api/auth/users', {
        method: 'POST',
        body: { username: 'counter-boy', password: 'counter-pass-1', name: 'Counter Boy', role: 'cashier' }
      });
      boy = ((await j('/api/auth/users')).body || []).find(u => u.username === 'counter-boy');
      if (boy) await j(`/api/auth/users/${boy.id}`, { method: 'PUT', body: { active: true } });
    }

    if (boy) {
      const original = { ...(boy.permissions || {}) };
      const granted = await j(`/api/auth/users/${boy.id}/permissions`, {
        method: 'PUT',
        body: { permissions: { ...original, settings: true, sync: true, users: true } }
      });
      granted.status === 200
        ? ok('Head grants Settings + Users to the counter boy')
        : fail('grant failed: ' + JSON.stringify(granted.body));

      // sign in as the counter boy — the panel must offer exactly what was granted
      await page.evaluate(() => {
        [...document.querySelectorAll('.btn')].find(b => b.textContent.includes('Logout'))?.click();
      });
      await page.waitForSelector('.login-card', { timeout: 8000 });
      await replaceInput(await page.$('input[autocomplete="username"]'), 'counter-boy');
      await replaceInput(await page.$('input[autocomplete="current-password"]'), 'counter-pass-1');
      await page.click('.login-card button');
      await page.waitForSelector('.shell', { timeout: 15000 });
      ok('counter boy signed in with his own ID');

      const navSettings = await page.evaluate(() =>
        [...document.querySelectorAll('.nav-item')].some(n => n.textContent.includes('Settings'))
      );
      navSettings
        ? ok('granted counter boy sees Settings in his own sidebar')
        : fail('Settings missing from the granted counter boy sidebar');

      await page.evaluate(() => { window.location.hash = '/settings'; });
      await page.waitForSelector('.card-title', { timeout: 8000 });
      const seen = await page.evaluate(() => {
        const usersCard = [...document.querySelectorAll('.card')]
          .find(c => c.textContent.includes('the Head decides who can log in'));
        const phoneField = [...document.querySelectorAll('.field')]
          .find(f => f.textContent.includes('Phone'));
        const phoneInput = phoneField ? phoneField.querySelector('input') : null;
        return {
          usersRows: usersCard ? usersCard.querySelectorAll('tbody tr').length : 0,
          phoneEditable: Boolean(phoneInput) && !phoneInput.disabled,
          staleAlert: document.body.textContent.includes('Only an admin can change settings'),
          infoAlert: document.body.textContent.includes('Shop settings stay with the Head')
        };
      });
      seen.usersRows >= 1
        ? ok(`his Settings page lists ${seen.usersRows} people — the granted Users module works`)
        : fail('granted Users module did not render: ' + JSON.stringify(seen));
      seen.phoneEditable
        ? ok('granted Settings module makes shop fields editable for him')
        : fail('shop fields still locked for a granted user');
      !seen.staleAlert && !seen.infoAlert
        ? ok('full grant opens the whole page — no admin-only messaging left')
        : fail('unexpected banner for a fully granted user: ' + JSON.stringify(seen));

      // the panel also refuses to make him more powerful than the Head allowed
      await page.evaluate(() => {
        const card = [...document.querySelectorAll('.card')]
          .find(c => c.textContent.includes('the Head decides who can log in'));
        const edit = card && [...card.querySelectorAll('.btn')].find(b => b.textContent.trim() === 'Edit');
        if (edit) edit.click();
      });
      await page.waitForSelector('.modal', { timeout: 6000 });
      const dialog = await page.evaluate(() => ({
        moduleSection: document.body.textContent.includes('Module access — beyond the role'),
        headOption: [...document.querySelectorAll('.modal select')]
          .some(s => [...s.options].some(o => o.value === 'admin'))
      }));
      !dialog.moduleSection
        ? ok('a granted manager cannot hand out modules from the dialog')
        : fail('module switches shown to a non-Head manager');
      !dialog.headOption
        ? ok('a granted manager cannot mint a Head from the role list')
        : fail('Head role option shown to a non-Head manager');
      await page.$$eval('.modal-foot .btn', els => {
        const b = els.find(e => e.textContent.trim() === 'Cancel');
        if (b) b.click();
      });
      await wait(300);

      // put his access back exactly as it was, then return the chair to the Head
      await page.evaluate(() => {
        [...document.querySelectorAll('.btn')].find(b => b.textContent.includes('Logout'))?.click();
      });
      await page.waitForSelector('.login-card', { timeout: 8000 });
      await replaceInput(await page.$('input[autocomplete="username"]'), 'admin');
      await replaceInput(await page.$('input[autocomplete="current-password"]'), 'admin123');
      await page.click('.login-card button');
      await page.waitForSelector('.shell', { timeout: 15000 });
      token = await page.evaluate(() => localStorage.getItem('shopbill_token'));
      const undo = await j(`/api/auth/users/${boy.id}/permissions`, {
        method: 'PUT', body: { permissions: original }
      });
      undo.status === 200
        ? ok("counter boy's modules restored — the Head is back in the chair")
        : fail('could not restore counter boy permissions: ' + JSON.stringify(undo.body));
    } else {
      fail('counter-boy account missing — granted-panel test skipped');
    }
  }

  // ---- POS: park a bill on hold, then bring it back ----
  await gotoPage('/pos', '.product-tile');
  await page.click('.product-tile');
  await page.waitForSelector('.cart-line', { timeout: 6000 });
  // park it WITH the coupon applied — resume must bring the code back too
  const holdCodeBox = await page.$('input[placeholder="code"]');
  holdCodeBox ? await replaceInput(holdCodeBox, 'WELCOME50') : fail('coupon code box missing');
  const holdApplyBtn = await findButtonByText('Apply');
  holdApplyBtn ? await holdApplyBtn.click() : fail('Apply button missing');
  await page.waitForFunction(
    () => [...document.querySelectorAll('.t-row')].some(r => r.textContent.includes('Coupon WELCOME50')),
    { timeout: 6000 }
  );
  await page.evaluate(() => {
    [...document.querySelectorAll('.btn')].find(b => b.textContent.trim() === 'Hold')?.click();
  });
  await page.waitForFunction(
    () => [...document.querySelectorAll('.modal-head h3')].some(h => h.textContent.includes('Hold this bill')),
    { timeout: 6000 }
  );
  const holdBtn = await findButtonByText('Hold bill');
  holdBtn ? await holdBtn.click() : fail('Hold bill confirm missing');
  await page.waitForFunction(
    () => [...document.querySelectorAll('.btn')].some(b => /Held \(\d+\)/.test(b.textContent)),
    { timeout: 6000 }
  );
  ok('bill parked on the till (⏸ Held)');
  await page.evaluate(() => {
    [...document.querySelectorAll('.btn')].find(b => b.textContent.includes('⏸ Held'))?.click();
  });
  await page.waitForFunction(
    () => [...document.querySelectorAll('.modal-head h3')].some(h => h.textContent.includes('Held bills')),
    { timeout: 6000 }
  );
  const resumeBtn = await findButtonByText('Resume');
  resumeBtn ? await resumeBtn.click() : fail('Resume button missing');
  await page.waitForSelector('.cart-line', { timeout: 6000 });
  ok('parked bill resumed with its line back');
  const couponSurvived = await page.evaluate(() =>
    [...document.querySelectorAll('.t-row')].some(r => r.textContent.includes('Coupon WELCOME50'))
  );
  couponSurvived ? ok('the parked coupon came back with the bill') : fail('coupon lost across hold/resume');
  await page.evaluate(() => {
    [...document.querySelectorAll('.btn')].find(b => b.textContent.trim() === 'Clear')?.click();
  });
  await wait(400);
  (await page.$$eval('.cart-line', els => els.length)) === 0
    ? ok('clear empties the resumed cart')
    : fail('Clear left lines behind');
  await expectNoToasts('hold flow');

  // ---- loyalty: choose a customer → points line → earn on a sale → redeem ----
  const firstCustomer = await page.evaluate(() => {
    const sel = document.querySelector('#pos-customer');
    if (!sel) return null;
    const opt = [...sel.options].find(o => o.value);
    return opt ? { value: opt.value, text: opt.textContent } : null;
  });
  firstCustomer
    ? ok('POS customer dropdown ready for loyalty — ' + firstCustomer.text.trim())
    : fail('no customers in the POS dropdown');
  if (firstCustomer) {
    await page.select('#pos-customer', firstCustomer.value);
    await page.waitForFunction(
      () => document.querySelector('input[placeholder="redeem pts"]'),
      { timeout: 5000 }
    );
    ok('choosing a customer shows the loyalty points line');

    // make one real sale so this customer banks points (earns 1 pt per Rs.100)
    await page.click('.product-tile');
    await page.waitForSelector('.cart-line', { timeout: 6000 });
    await page.$$eval('.pay-grid .btn', els => {
      const b = els.find(e => e.textContent.includes('Cash'));
      if (b) b.click();
    });
    await page.$$eval('.btn.success', els => {
      const b = els.find(e => e.textContent.includes('Complete Sale'));
      if (b) b.click();
    });
    await page.waitForFunction(
      () => [...document.querySelectorAll('.modal-head h3')].some(h => h.textContent.includes('Sale Completed')),
      { timeout: 10000 }
    );
    await page.$$eval('.modal-foot .btn', els => {
      const b = els.find(e => e.textContent.includes('New Sale'));
      if (b) b.click();
    });
    // the refreshed dropdown now shows this customer's banked ⭐ points
    await page.waitForFunction(
      id => {
        const sel = document.querySelector('#pos-customer');
        const opt = sel ? [...sel.options].find(o => o.value === id) : null;
        return Boolean(opt && opt.textContent.includes('⭐'));
      },
      { timeout: 8000 }, firstCustomer.value
    );
    ok('the sale banked loyalty points for the customer');
    await page.select('#pos-customer', firstCustomer.value);
    await page.waitForFunction(
      () => document.querySelector('input[placeholder="redeem pts"]'),
      { timeout: 5000 }
    );
    const redeemInput = await page.$('input[placeholder="redeem pts"]');
    await replaceInput(redeemInput, '999');
    await wait(350);
    const capped = await redeemInput.evaluate(el => el.value);
    const hasLoyaltyRow = await page.evaluate(() =>
      [...document.querySelectorAll('.t-row')].some(r => r.textContent.includes('⭐ Loyalty'))
    );
    Number(capped) > 0 && hasLoyaltyRow
      ? ok(`redeeming 999 caps at the balance (${capped} pts) and discounts the bill`)
      : fail(`loyalty redeem failed (capped=${capped}, loyaltyRow=${hasLoyaltyRow})`);
    await page.evaluate(() => {
      [...document.querySelectorAll('.btn')].find(b => b.textContent.trim() === 'Clear')?.click();
    });
    await wait(350);
  }

  // ---- coupon applied right at the till ----
  await page.click('.product-tile');
  await page.waitForSelector('.cart-line', { timeout: 6000 });
  const codeBox = await page.$('input[placeholder="code"]');
  codeBox ? await replaceInput(codeBox, 'WELCOME50') : fail('coupon code box missing on the POS');
  const applyBtn = await findButtonByText('Apply');
  applyBtn ? await applyBtn.click() : fail('Apply coupon button missing');
  await page.waitForFunction(
    () => [...document.querySelectorAll('.t-row')].some(r => r.textContent.includes('Coupon WELCOME50')),
    { timeout: 6000 }
  );
  const couponTotal = await page.$eval('.totals .t-row.grand span:last-child', el => el.textContent);
  ok('WELCOME50 applied on the bill, total now ' + couponTotal);
  await page.evaluate(() => {
    [...document.querySelectorAll('.btn')].find(b => b.textContent.trim() === 'Clear')?.click();
  });
  await wait(350);
  await expectNoToasts('loyalty & coupon flow');

  // ---- Reports → Expenses: the expense book lives where the Head reads reports ----
  await gotoPage('/reports', '.pill-tabs');
  const expensesPill = await page.evaluate(() => {
    const p = [...document.querySelectorAll('.pill')].find(x => x.textContent.includes('Expenses'));
    if (p) p.click();
    return Boolean(p);
  });
  expensesPill ? null : fail('Expenses pill missing from Reports');
  await page.waitForFunction(
    () => document.body.textContent.includes('Expenses (kharcha)'),
    { timeout: 6000 }
  );
  ok('Reports opens the expense book (kharcha)');
  await expectNoToasts('expenses tab');

  // ---- customers carry their star points ----
  await gotoPage('/customers', '.tbl');
  const ptsCol = await page.$$eval('th', ths => ths.some(t => t.textContent.includes('Pts')));
  ptsCol ? ok('customers table shows the loyalty points column') : fail('loyalty Pts column missing');
  await expectNoToasts('customers page');

  // ---- void end-to-end: cancel a real coupon+loyalty bill in the browser ----
  if (firstCustomer) {
    const pts = async () => Number(((await j('/api/customers/' + firstCustomer.value)).body || {}).loyalty_points || 0);
    const uses = async () => {
      const list = (await j('/api/coupons')).body || [];
      const c = list.find(x => x.code === 'WELCOME50');
      return c ? Number(c.used_count) : null;
    };
    const pts0 = await pts();
    const uses0 = await uses();

    // a real till sale: this customer, this coupon, paid in cash
    await gotoPage('/pos', '.product-tile');
    await page.select('#pos-customer', firstCustomer.value);
    await page.click('.product-tile');
    await page.waitForSelector('.cart-line', { timeout: 6000 });
    const voidCode = await page.$('input[placeholder="code"]');
    voidCode ? await replaceInput(voidCode, 'WELCOME50') : fail('coupon code box missing for the void flow');
    const voidApply = await findButtonByText('Apply');
    voidApply ? await voidApply.click() : fail('Apply button missing for the void flow');
    await page.waitForFunction(
      () => [...document.querySelectorAll('.t-row')].some(r => r.textContent.includes('Coupon WELCOME50')),
      { timeout: 6000 }
    );
    await page.$$eval('.pay-grid .btn', els => {
      const b = els.find(e => e.textContent.includes('Cash'));
      if (b) b.click();
    });
    await page.$$eval('.btn.success', els => {
      const b = els.find(e => e.textContent.includes('Complete Sale'));
      if (b) b.click();
    });
    await page.waitForFunction(
      () => [...document.querySelectorAll('.modal-head h3')].some(h => h.textContent.includes('Sale Completed')),
      { timeout: 10000 }
    );
    await page.$$eval('.modal-foot .btn', els => {
      const b = els.find(e => e.textContent.includes('New Sale'));
      if (b) b.click();
    });

    // that bill is now the newest one on the Invoices page
    const newest = (await j('/api/invoices?limit=1')).body[0];
    const pts1 = await pts();
    const uses1 = await uses();
    newest && newest.coupon_code === 'WELCOME50'
      ? ok(`sale saved with the coupon — Rs. ${newest.total}, banked ${newest.loyalty_earned} pts`)
      : fail(`newest invoice missing or coupon not stored (got ${newest && JSON.stringify(newest.coupon_code)})`);
    uses1 === uses0 + 1 ? ok('the coupon use is counted on the new bill') : fail(`coupon uses ${uses0} → ${uses1}`);
    pts1 > pts0 ? ok(`points grew ${pts0} → ${pts1} on the sale`) : fail(`points did not grow (${pts0} → ${pts1})`);

    await gotoPage('/invoices', '.tbl');
    await page.waitForFunction(() => document.querySelector('tbody tr.clickable'), { timeout: 8000 });
    const rowNo = await page.$eval('tbody tr.clickable td', el => el.textContent.trim());
    rowNo === newest.invoice_no ? null : fail(`first row is ${rowNo}, newest sale is ${newest.invoice_no}`);
    await page.click('tbody tr.clickable');
    await page.waitForSelector('.modal-foot .btn.danger', { timeout: 6000 });
    const voidBtn = await findButtonByText('Void Invoice');
    voidBtn ? await voidBtn.click() : fail('Void Invoice button missing');
    // the dialog handler above accepts the "Void invoice …" confirm
    await page.waitForFunction(
      () => [...document.querySelectorAll('.toast.success')].some(t => t.textContent.includes('voided')),
      { timeout: 8000 }
    );
    await page.waitForFunction(() => !document.querySelector('.modal'), { timeout: 6000 });
    ok(`voided ${newest.invoice_no} from the invoice screen`);

    // the default list drops it …
    await page.waitForFunction(
      no => ![...document.querySelectorAll('tbody tr')].some(r => r.textContent.includes(no)),
      { timeout: 8000 }, newest.invoice_no
    );
    ok('the voided bill leaves the invoice list');

    // … and "show voided" brings it back with the VOID badge
    await page.evaluate(() => {
      const lab = [...document.querySelectorAll('label.checkbox')].find(l => l.textContent.includes('show voided'));
      const cb = lab && lab.querySelector('input');
      if (cb && !cb.checked) cb.click();
    });
    await page.waitForFunction(
      no => [...document.querySelectorAll('tbody tr')].some(r => r.textContent.includes(no) && r.textContent.includes('VOID')),
      { timeout: 8000 }, newest.invoice_no
    );
    ok('"show voided" brings it back with the VOID badge');

    // everything the bill did to the shop is undone
    const after = (await j('/api/invoices/' + newest.id)).body;
    const pts2 = await pts();
    const uses2 = await uses();
    after.invoice.voided === 1 ? null : fail('the server does not mark the invoice voided');
    pts2 === pts0 ? ok(`loyalty points returned to ${pts2}`) : fail(`points after void: expected ${pts0}, got ${pts2}`);
    uses2 === uses0 ? ok('the coupon use was returned') : fail(`coupon uses after void: expected ${uses0}, got ${uses2}`);
  } else {
    fail('void flow skipped — the POS customer dropdown was empty');
  }
  await expectNoToasts('void flow');

  // ---- offline-first: bill with the internet down, it syncs itself back ----
  offlineWindow = true;
  try {
    const invCount = async () => {
      const rows = (await j('/api/invoices?limit=2000')).body;
      return Array.isArray(rows) ? rows.length : 0;
    };
    const before = await invCount();

    await page.setOfflineMode(true);
    // a hard reload with no internet: the service worker serves the app shell
    // and the session comes back from the on-device copy
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.shell', { timeout: 20000 });
    ok('app opens after a full reload with no internet (service worker)');

    await page.evaluate(() => { window.location.hash = '/pos'; });
    await page.waitForSelector('.product-tile', { timeout: 10000 });
    ok('product tiles load from the on-device copy while offline');

    await searchFor('Tea Pack');
    await page.waitForFunction(
      () => [...document.querySelectorAll('.product-tile')].some(t => t.textContent.includes('Tea Pack')),
      { timeout: 8000 }
    );
    const offTile = await page.evaluateHandle(() =>
      [...document.querySelectorAll('.product-tile')].find(t => t.textContent.includes('Tea Pack'))
    );
    await offTile.asElement().click();
    await page.waitForSelector('.cart-line', { timeout: 5000 });

    await page.$$eval('.pay-grid .btn', els => {
      const b = els.find(e => e.textContent.includes('Cash'));
      if (b) b.click();
    });
    await page.$$eval('.btn.success', els => {
      const b = els.find(e => e.textContent.includes('Complete Sale'));
      if (b) b.click();
    });
    await page.waitForFunction(
      () => [...document.querySelectorAll('.toast')].some(t => t.textContent.includes('Saved offline')),
      { timeout: 8000 }
    ).catch(() => null);
    const offToast = await page.$$eval('.toast', els => els.map(e => e.textContent).join(' | '));
    offToast.includes('Saved offline')
      ? ok('bill taken with no internet is saved on the device')
      : fail(`offline sale not acknowledged: "${offToast}"`);
    const cartAfterOffline = await page.$$eval('.cart-line', els => els.length);
    cartAfterOffline === 0
      ? ok('offline cart cleared — the bill is safely queued')
      : fail('offline bill left items in the cart');

    // the pill counts the queued bill
    await page.waitForFunction(
      () => /queued/i.test(document.querySelector('.sync-badge')?.textContent || ''),
      { timeout: 5000 }
    ).catch(() => null);
    const queuedPill = await page.$eval('.sync-badge', el => el.textContent);
    /queued/i.test(queuedPill)
      ? ok(`pill shows the queued bill: "${queuedPill.trim()}"`)
      : fail(`pill does not show the queued bill: "${queuedPill.trim()}"`);

    // internet comes back — the bill syncs itself, no human needed
    await page.setOfflineMode(false);
    await page.waitForFunction(
      () => !/queued|to sync/i.test(document.querySelector('.sync-badge')?.textContent || ''),
      { timeout: 20000 }
    ).catch(() => null);
    const syncedPill = await page.$eval('.sync-badge', el => el.textContent);
    !/queued|to sync/i.test(syncedPill)
      ? ok(`queued bill drained automatically: pill now "${syncedPill.trim()}"`)
      : fail(`bill still queued after reconnect: "${syncedPill.trim()}"`);
    const afterCount = await invCount();
    afterCount === before + 1
      ? ok(`the offline bill reached the server exactly once (${before} → ${afterCount} invoices)`)
      : fail(`invoice count after sync: expected ${before + 1}, got ${afterCount}`);
  } catch (e) {
    fail('offline billing exception: ' + e.message);
  } finally {
    offlineWindow = false;
  }
  await expectNoToasts('offline billing');
} catch (e) {
  fail('exception: ' + e.message);
} finally {
  await browser.close();
}

if (errors.length) {
  console.log('\nBrowser errors:');
  for (const e of [...new Set(errors)]) console.log('  • ' + e);
}
if (fails.length || errors.length) {
  console.log(`\nFAILED: ${fails.length} assertion(s), ${errors.length} browser error(s)`);
  process.exit(1);
}
console.log('\nALL FEATURE UI TESTS PASSED');
