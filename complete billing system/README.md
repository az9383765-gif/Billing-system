# MartBill — Complete Billing System

**MartBill** is a professional billing + POS system for shops and markets, built to **work fully offline** and **online**.
Data is stored in a local SQLite database on the shop's own computer, with optional cloud sync/backup when the internet is available.

**Sold-ready for shopkeepers:** a sales-ready login screen with **self sign-up** (the buyer creates their own
owner account on first run — there is no default password anywhere in the product), thermal receipt printing,
A4 GST invoices, barcode scanning, inventory with low-stock alerts, customer credit (udhaar) ledger,
**held bills**, **loyalty points**, **coupons**, an **expense book** and **per-person module access** on top of
the three roles.

---

## Features

| Module | What it does |
|---|---|
| **Billing (POS)** | Product search / barcode scan, cart, discounts **in Rs. or %** (one toggle), cash/card/mobile/credit payment, instant receipt print — and it handles huge carts (**10,000-line bills** are tested and stock is deducted exactly once per product) |
| **Hold & resume bills** | Park a bill mid-sale (**⏸ Held**) and bring it back later with its cart, discount, customer, **loyalty redemption and coupon** exactly as parked — till-local work, it never syncs or enters backups |
| **Loyalty points** | Customers earn ⭐ points on every sale (rate and point value set in Settings → Loyalty), spend them as a discount right at the till, and a return claws back only the points it earned |
| **Coupons (discount codes)** | Fixed-amount or percent codes with min bill, validity date and max-uses cap — created in Settings → Coupons, typed once at the till, every use counted, switch off any code instantly |
| **Expenses (kharcha)** | The Head records rent, salaries, utilities, transport — the daily profit view nets them out; lives as its own tab in Reports behind a separate permission |
| **Invoices** | Sequential invoice numbers, thermal (58/80mm) receipts + A4 tax invoices, reprint anytime, void with stock restore |
| **Returns & refunds** | Head refunds any sold item → credit note (`RET-…`), GST reversed with it, stock comes back, outstanding credit cleared first then cash, printable refund note |
| **Inventory** | Stock auto-deducts on sale, purchase entries, stock adjustments, full movement history, low-stock alerts |
| **Products** | Categories, barcode + generator, cost/selling price, per-product tax rate, **expiry date**, barcode label printing (A4) |
| **Expiry watch** | Expiry dates on grocery batches, **near-expiry report** (Inventory) with expired/expiring badges, POS refuses to bill expired stock |
| **Customers & Udhaar** | Credit limits, ledger with running balance, statement view, collect payments |
| **Reports** | Summary, day-wise (with refunds), product-wise (net of returns), customer credit, tax (CGST/SGST), low stock — all with CSV export |
| **Dashboard** | Today's sales / profit / credit plus **GST today** with a by-rate breakdown for the Head |
| **Tax / GST** | **One GST engine for screen, bill and paper** (`shared/calc.js`): per-product rate, inclusive or exclusive pricing, discounts always reduce the taxable value, GSTIN, CGST+SGST split (label configurable: GST/VAT/Sales Tax), round-off |
| **Online + Offline** | Runs 100% offline locally; cloud sync queue pushes changes when online; full JSON backup/restore |
| **Users & roles** | Head / Inventory Manager / Cashier logins, hashed passwords, session login, Head approves every account — plus **per-person module access**: the Head can grant or deny exact modules for each individual (9 switches), and delete people (never themselves) |
| **Login & sign-up** | Branded split-screen login (shop name, feature highlights, **Remember me**, quick-ID chips), **Create a New Account** on the page — the very first account becomes the Head, later requests wait for Head approval, switchable in Settings → Users |

---

## Roles — the Head decides who does what

| | **Head (admin)** | **Inventory Manager** | **Cashier** |
|---|---|---|---|
| Scan barcode & print bill | ✅ | ✅ | ✅ only this |
| See low-stock alerts | ✅ | ✅ | ✅ shown on POS |
| Enter stock directly | ✅ | ❌ sends a **request** | ❌ |
| Approve stock requests | ✅ | ❌ | ❌ |
| Sales reports | ✅ | ✅ read-only | ❌ |
| Products (add/edit/delete) | ✅ | view only | view only |
| Refund a return (credit note) | ✅ | ❌ | ❌ |
| Void an invoice / sync / backup | ✅ | ❌ | ❌ |
| Approve new logins | ✅ | ❌ | ❌ |

**Approval flow:** a new account stays *pending* and cannot log in until the Head presses **Approve**
(Settings → Users). Requests arrive from two places: the Head creates them in **Settings → Users**, or the
person themselves sends one from the login page (**Create account**). The Inventory Manager's stock entries stay *waiting* until the Head presses
**Approve** on the Inventory page — only then does the stock actually move. The Cashier's sidebar
simply has no Reports or Settings, and any locked screen shows a lock panel.

**Per-person access (beyond the role):** every person's **Edit** dialog in Settings → Users carries a
*Module access* switch grid (Billing, Void & returns, Products, Stock, Reports, Customers, Expenses,
Settings, Users). A single **on/off** here wins over the role default — so the Head can hand *Reports* to a
cashier, or keep a manager out of *Expenses*, without inventing new roles. The Head's own rows are
protected (they cannot delete themselves or strip their own Users/Settings access).

**No factory login ships with the product.** A fresh install has *no accounts at all* — the first person to
register becomes the **Head** (owner). Demo databases made for walkthroughs may still carry demo accounts
(`admin` / `admin123`, `store-keeper` / `store-pass-1`, `counter-boy` / `counter-pass-1`); they appear as
quick chips on the login page **only while their passwords are untouched**.

---

## Login page & account setup

The login screen is designed to be shown to a customer as-is (see `screenshots/feature-login*.png`):

- **Brand panel** — logo, the shop's own name, feature highlights and Rs / PKR · GST · Offline badges.
- **First run (fresh install):** a glowing *"First time here? Create your shop's owner account"* banner opens
  **Set up your shop** — shop name + your name + username + password. The account is created as the **Head**
  and signs you straight in. No default password exists anywhere in the product, so there is nothing to
  change or warn the customer about later.
- **After setup:** *Create account* lets anyone send a **new account request** — name, username, role and
  password. The account stays *pending* until the Head approves it in **Settings → Users** (the Head can turn
  the whole sign-up form off with the *Allow new account requests* switch on that page).
- **Remember me / Forgot password?** — *Remember me* keeps your username on this device (never the password);
  *Forgot password?* explains that the Head sets a new password in **Settings → Users → Edit** — the honest,
  offline-proof answer, no email server required.
- **Login with another ID** — quick chips for the demo logins (while their passwords are untouched) and for
  IDs used on this device before; clicking one fills the form. Passwords show/hide with *Show*.
- Sign-ups are rate-limited (5 attempts per IP, then a short cool-off) and usernames are checked for clashes.

---

## Quick start (for the shopkeeper's computer)

Requirements: **Node.js 18+** (only needed once to install).

```bash
npm install       # install dependencies
npm run build     # build the web interface (one time)
npm run seed      # optional: load demo shop data
npm start         # start the system
```

Then open **http://localhost:3000** in any browser.

**First run:** press **Create account** → **Set up your shop** and create your own Head login —
there is no default username/password to remember or change. (Demo databases created for walkthroughs may
still carry `admin` / `admin123`.)

### Daily use

| Task | How |
|---|---|
| Make a sale | **Billing (POS)** → scan barcode or search → **Complete Sale** → print |
| Add products | **Products** → Add Product (use *Generate* for barcodes) |
| Receive stock | **Inventory** → Purchase Entry |
| Give credit | Select a customer in POS and enter less than the total amount |
| Collect udhaar | **Customers** → Statement → *Receive* payment |
| See reports | **Reports** → pick a date range → Export CSV |

### Development mode

```bash
npm run dev       # hot-reload server + Vite dev UI on http://localhost:5173
```

### Tests

```bash
npm test              # API tests (71: RBAC, GST engine, printed-bill checks, returns, expiry, hold, expenses, loyalty, coupons, per-person access, registration, 10,000-line bills)
npm run test:ui       # browser UI smoke test (16 checks — needs the server running on :3000)
npm run test:features # every feature in the browser (returns, expiry, % discount, GST, sign-up, hold/resume, loyalty earn+redeem, coupons, expenses, module access)
npm run shots:features # screenshots of the features into screenshots/feature-*.png
npm run shots:login    # first-run login / sign-up screenshots (fresh temp database)
```

---

## Delivery package (install on another computer)

Two commands build the package. Both leave the zip next to `package.json` and always exclude
`data/`, `node_modules/` (except the offline variant) and `.git/`:

| Command | Output | Contents | Use when |
|---|---|---|---|
| `npm run deliver` | `MartBill-v1.0.0.zip` (~5 MB) | source + built `dist/` | the shop has internet **once** (installs on first run) |
| `npm run deliver:offline` | `MartBill-v1.0.0-offline.zip` (~11 MB) | same + production `node_modules/` | **no internet at all** — runs straight from the zip |

Add `-- --no-build` to either command to skip rebuilding the interface. Every package contains:

```
server/   src/   shared/   tests/   dist/   screenshots/   tools/
index.html   package.json   package-lock.json   vite.config.js   README.md   start.bat
```

On the shop's computer: unzip anywhere and **double-click `start.bat`**.

| | |
|---|---|
| **First run (online package)** | installs the required files (internet needed once, ~1 minute) and opens http://localhost:3000 |
| **Every run (offline package)** | nothing to install — starts immediately |
| **Later runs** | starts the system straight away — close the black window to stop it |
| **First login** | press **Create account** → **Set up your shop** — the first account becomes the Head (staff logins are handed out later by the Head) |

The shop's data lives in `data/shopbill.db` inside the package folder — copy that file (or use
**Settings → Download Backup**) to back up.

Delivery was verified in a clean folder: `npm ci --omit=dev` → `start.bat` → first-run setup
→ `npm run seed` → `npm test` (71/71) all pass from the unzipped package.

---

## Online mode (cloud sync / multiple devices)

The same app works as your cloud server:

1. **Host it once** on any VPS or Node host (upload the project, run `npm install && npm run build && npm start`).
   It now runs online at that address, and any device with a browser can use it directly.
2. **Device sync (offline shops):** on each shop computer, open **Settings → Online Sync**, enter the cloud URL
   and a shared **sync key**, then *Save & Sync Now*. Every change is queued offline and pushed automatically
   whenever the internet is available (checked every minute).
3. Changes merge safely (idempotent by row ID, last-write-wins by timestamp).

Data is always stored locally first — losing internet never stops billing.

---

## Going live on your own domain

**[DEPLOY.md](DEPLOY.md)** is the step-by-step guide: Render (one-click via `render.yaml`)
or a VPS with nginx + HTTPS, buying the domain, DNS, Google sign-in, backups — and the six
placeholder URLs in `index.html` to swap for your real domain so shared links show the
right preview card.

---

## GST — how the tax is worked out

Every rupee is calculated by **one** engine, `shared/calc.js`. The billing API charges with it, the POS screen
totals with it and the receipt / A4 invoice print it — so the number on the screen, the number the customer
pays and the number in the reports can never drift apart.

| Situation | Rule | Example |
|---|---|---|
| Shelf price **includes** GST (retail norm) | the tax is *extracted* out of the price | Rs. 110 @ 10% → Rs. 100 taxable + Rs. 10 GST |
| Price is **before** tax | the tax is added on top | Rs. 100 @ 10% → Rs. 100 taxable + Rs. 10 GST = Rs. 110 |
| **Discount on an item** | only what is really paid is taxed | Rs. 100 @ 10% with Rs. 10 off → Rs. 90 + Rs. 9 GST |
| **Discount on the bill** | shared across the lines by value | every rupee appears on the printed bill |
| **Round off** (Settings) | takes the bill to the nearest rupee | printed on its own line, never hidden |

- The printed chain is always **Taxable value + GST + Round off = TOTAL**; the discount is printed as
  *already applied*, so a bill never subtracts the same discount twice.
- Per-line discounts are entered in the cart (the `off` box next to each item) and shown on the receipt and
  the A4 invoice next to the item they belong to.
- **Reports → Tax** and the A4 tax table group the same figures by rate (CGST/SGST when the split is on).
- Pakistani demo bands: **0%** zero-rated staples, **5% / 10%** reduced, **18%** standard.
- The **dashboard shows the GST collected today** (Head/manager only) with a by-rate breakdown, so the
  amount to hand over can be read off at a glance.
- **Percentage discounts** (POS discount row → `Rs.` / `%` toggle) are converted into rupees by the same
  engine (`discountFromPercent`) before billing — one calculation path, no drift.
- **Returns reverse the GST**: a credit note takes its taxable value and tax back out of the tax report
  for the period, so what is filed always matches what was really kept.

```bash
node tools/gst-demo.mjs   # bills a mixed-rate basket on a running server, proves screen = bill, prints the receipt
node tools/gst-shots.mjs  # screenshots the POS, receipt and A4 invoice into screenshots/gst-*.png
```

---

## Returns, expiry dates & discounts (mart features)

- **Item returns (credit notes):** open any bill → **↩ Return** (Head only). Pick the quantities, give a
  reason, save — the system prorates the stored taxable value and GST of exactly those pieces, restocks
  them, wipes what the customer still owes first and pays the remainder back in cash. The original bill is
  never rewritten: it just grows a *Returned* badge and a credit-note history, and it can no longer be
  voided. **🖨 Print Credit Note** prints a thermal `RET-…` note with its own barcode.
- **Expiry dates:** set an expiry date per product (Products → *Expiry date*). The Inventory page lists
  everything expiring within 30 days (red = already expired), the POS tile shows an `EXPIRED` / `11d`
  countdown badge, and **expired stock cannot be added to a bill at all**.
- **% discount at the POS:** the discount row has an `Rs.` / `%` toggle. Typing `10` in `%` mode shows the
  rupee amount it converts to, and the engine bills it exactly like the rupees — capped at the bill total.
- **Hold & resume (parked bills):** mid-sale, press **Hold** → name the bill → it moves to **⏸ Held**.
  **Resume** brings back the cart, discount, customer, paid amount, **redeemed points and coupon code**
  exactly as they were parked; the held list is a till-local queue (device-local on purpose — never synced,
  never in backups). Discard (×) throws a parked bill away.
- **Loyalty points:** Settings → Loyalty sets *points per Rs.100* and *value of 1 point*. Customers earn on
  every sale, the POS shows their ⭐ balance next to their name, and typing into *redeem pts* discounts the
  bill (capped at the balance). All three — manual discount, loyalty and coupon — stack into **one**
  combined discount that flows through the single money engine, so GST is reduced exactly once.
  Returns take back only the points that sale earned.
- **Coupons:** Settings → Coupons issues codes (fixed Rs. off or % off, optional min bill, validity date,
  max uses). At the till, type the code → **Apply** → its own totals line appears; the server re-validates
  before every sale (expired, over-used, inactive or below-minimum codes are refused with a clear reason),
  and every use increments the counter.
- **Expenses (kharcha):** Reports → **Expenses** tab (or `#/expenses`) is the Head's expense book — date,
  category, amount, payment method, note. The daily profit numbers net them out, so "profit today" means
  profit. Guarded by its own *view* / *manage* permissions, independent of the role.
- Demo data: `npm run seed` ships a couple of expired and near-expiry batches;
  `node tools/demo-expiry.mjs` puts the same demo dates on an existing shop database.

---

## Printing

- **Thermal printer:** Settings → Invoice & Receipt → Receipt paper → 58mm or 80mm. In the print dialog choose
  the thermal printer and keep margins *None*. Works with any ESC/POS printer (Epson, XPrinter, Rongta, etc.).
- **A4 invoice:** click *A4 Invoice* on any sale — includes GSTIN, CGST/SGST breakup, amount in words and signature box.
- **Barcode labels:** Products → 🏷 → choose quantity → Print (3 per A4 row).
- **Sample output:** `node tools/sample-output.mjs [invoice_no]` renders the newest sale exactly as it prints —
  writes `output/<invoice>-receipt-80mm.html`, `output/<invoice>-invoice-A4.html` and PNG screenshots of both,
  and prints a plain-text preview of the receipt, invoice and business report to the terminal.
  (Useful for showing a customer what the printed bill looks like without wasting paper.)

---

## Project structure

```
├── server/               # Node.js + Express + SQLite backend
│   ├── index.js          # app entry (API + serves the built UI)
│   ├── db.js             # database schema, settings, sync queue
│   ├── lib.js            # auth, sessions, CSV helpers
│   ├── seed.js           # demo data (npm run seed)
│   └── routes/           # auth, products, customers, invoices, returns, held, expenses, coupons, stock, reports, settings, sync
├── src/                  # React frontend (Vite)
│   ├── pages/            # Dashboard, POS, Products, Inventory, Customers, Invoices, Reports, Expenses, Settings
│   ├── components/       # Layout (role-aware sidebar), Modal
│   ├── print.js          # thermal receipt / A4 invoice / barcode label generation
│   ├── refund-print.js   # credit note (return) printing
│   └── api.js, store.jsx, format.js, rbac.js, styles.css
├── shared/calc.js        # THE money engine: GST, discounts, round-off (API + POS + paper)
├── tests/api.test.js     # end-to-end API tests (71 incl. GST, printed-bill, returns, hold, expenses, loyalty, coupons, per-person access, registration, 10,000-line bills)
├── tests/register.test.js # first-run owner sign-up on a fresh database (runs with npm test)
├── tests/e2e-ui.mjs      # browser UI tests (npm run test:ui, server on :3000)
├── tests/e2e-features.mjs # all features in the browser (npm run test:features)
├── tools/                # package.mjs (delivery zips), sample-output.mjs, gst-demo.mjs,
│                         # gst-shots.mjs, role-shots.mjs, feature-shots.mjs, setup-shots.mjs, demo-expiry.mjs
└── dist/                 # built frontend (created by npm run build)
```

## Data & backup

- Database file: `data/shopbill.db` (copy this file to back up manually).
- In-app backup: **Settings → Backup & Restore → Download Backup** (full JSON).
- Keep regular backups — the JSON backup can be restored on any device.

## Notes for sellers

- Defaults are Pakistani: currency **Rs. / PKR**, single **GST** line (no CGST/SGST split), amount in words in
  lakh/crore style ("… Rupees Only"). Change any of it in **Settings**.
- Change the shop name, address, GSTIN and currency in **Settings** before handing over.
- Create individual logins for staff (**Settings → Users**) or let them request one from the login page —
  new accounts stay *pending* until the Head approves them, so you decide exactly who may log in and as
  which role. Switch *Allow new account requests* off if the sign-up form should not be visible at all.
- **Fine-grained control:** open **Edit** on any person and use the *Module access* switches to grant or
  deny single modules for that individual — useful answers to "can my cashier see reports/expenses?"
  without touching the role system.
- On a fresh install the buyer sets up their **own** Head account from the login page — the product ships
  **no default username or password**, so the hand-over never has to mention old credentials.
- Recommended: enable *negative stock = off* (default) so overselling is impossible.

### Good to know (design decisions)

- **Exchange (return + re-buy):** do it as a **Return** on the original bill, then ring the new item as a
  normal sale — the credit note pays the difference back and the new bill goes through the till cleanly.
  (There is deliberately no half-way "exchange" screen that hides one of the two records.)
- **Product variants** (flavours/sizes) are sold as **separate SKUs** — one row each with its own barcode,
  price and stock. That keeps stock counts, expiry batches and reports exact.
- **PDF:** every receipt/invoice prints through the browser — use **Print → Save as PDF** in the print
  dialog (that is also how the thermal printers are driven).
- **Excel:** report exports are **CSV** (`Export CSV`) — Excel, LibreOffice and Google Sheets open them
  directly; no extra library, no formatting surprises.
