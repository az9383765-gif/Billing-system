// One-off: bring the demo catalogue's GST bands onto real Pakistani rates.
//   77% (a typo'd band) -> 5%, and the old 12% band -> 10%.
// Historical invoices keep the rate they were billed at (invoice_items store their own).

const BASE = 'http://localhost:3000/api';
const login = await fetch(`${BASE}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' })
}).then(r => r.json());
const auth = { authorization: `Bearer ${login.token}`, 'content-type': 'application/json' };

const products = await fetch(`${BASE}/products`, { headers: auth }).then(r => r.json());
let fixed = 0;
for (const p of products) {
  const target = p.tax_rate === 77 ? 5 : p.tax_rate === 12 ? 10 : null;
  if (target === null) continue;
  const res = await fetch(`${BASE}/products/${p.id}`, {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ tax_rate: target })
  });
  if (res.ok) { console.log(`  ${p.name}: ${p.tax_rate}% -> ${target}%`); fixed++; }
  else console.log(`  FAILED ${p.name}: ${res.status} ${(await res.text()).slice(0, 120)}`);
}
console.log(`\n${fixed} product(s) updated`);

const after = await fetch(`${BASE}/products`, { headers: auth }).then(r => r.json());
const bands = {};
for (const p of after) bands[p.tax_rate] = (bands[p.tax_rate] || 0) + 1;
console.log('bands now:', JSON.stringify(bands));
