// Barber booking app - zero dependencies. Run: node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const TZ = process.env.SHOP_TZ || 'Europe/Sarajevo';
const SLOT_MIN = 30;
const DATA_DIR = process.env.DATA_DIR || __dirname;           // optional: persistent disk folder
const DATA = path.join(DATA_DIR, 'data.json');
const UP_URL = process.env.UPSTASH_REDIS_REST_URL, UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN; // free online storage
const KEY = 'barber-frki-data';
const DAYS_AHEAD = 21;

const defaultHours = { 0: null, 1: ['09:00','17:00'], 2: ['09:00','17:00'], 3: ['09:00','17:00'], 4: ['09:00','17:00'], 5: ['09:00','17:00'], 6: null };
const seed = () => ({ barbers: [{ id: 'b1', name: 'Frki', pin: '1111', hours: defaultHours, daysOff: [], blocked: [] }], bookings: [] });

async function upstash(cmd) {
  const r = await fetch(UP_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + UP_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error('Upstash: ' + (j.error || r.status));
  return j.result;
}
async function readStore() {
  if (UP_URL && UP_TOKEN) return await upstash(['GET', KEY]);          // throws on failure -> app refuses to start (never overwrites data)
  return fs.existsSync(DATA) ? fs.readFileSync(DATA, 'utf8') : null;
}
async function writeStore(text) {
  if (UP_URL && UP_TOKEN) return void await upstash(['SET', KEY, text]);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA + '.tmp', text); fs.renameSync(DATA + '.tmp', DATA);
}
let db, saving = Promise.resolve();
function save() { // saves are queued so they never overlap; resolves when stored
  const snap = JSON.stringify(db);
  const p = saving.then(() => writeStore(snap));
  saving = p.catch(e => console.error('SAVE FAILED:', e.message));
  return p;
}
async function init() {
  const raw = await readStore();
  db = raw ? JSON.parse(raw) : seed();
  const today = nowInShop().date, old = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
  db.bookings = db.bookings.filter(b => b.date >= old);                   // keep storage small
  db.barbers.forEach(b => { b.blocked = (b.blocked || []).filter(x => x.date >= today); b.daysOff = b.daysOff.filter(d => d >= today); });
  if (/^\d{4,8}$/.test(process.env.BARBER_PIN || '')) db.barbers[0].pin = process.env.BARBER_PIN; // set PIN from Render settings
  await save();
  console.log('Storage:', UP_URL && UP_TOKEN ? 'Upstash (online)' : DATA);
}

const sessions = new Map(); // token -> barberId

function nowInShop() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
const toMin = t => +t.slice(0, 2) * 60 + +t.slice(3);
const fromMin = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const weekday = d => new Date(d + 'T12:00:00Z').getUTCDay();
const validDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(new Date(d + 'T12:00:00Z'));
const validTime = t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t);

// every slot inside the barber's working hours for a date (future only), regardless of status
function allSlots(barber, date) {
  const now = nowInShop();
  if (!validDate(date) || date < now.date || barber.daysOff.includes(date)) return [];
  const h = barber.hours[weekday(date)];
  if (!h) return [];
  const out = [];
  for (let m = toMin(h[0]); m + SLOT_MIN <= toMin(h[1]); m += SLOT_MIN) {
    const t = fromMin(m);
    if (date === now.date && t <= now.time) continue;
    out.push(t);
  }
  return out;
}
const isBlocked = (barber, date, time) => (barber.blocked || []).some(x => x.date === date && x.time === time);
function slotsFor(barber, date) {
  const taken = new Set(db.bookings.filter(b => b.barberId === barber.id && b.date === date).map(b => b.time));
  return allSlots(barber, date).filter(t => !taken.has(t) && !isBlocked(barber, date, t));
}

const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const body = req => new Promise(r => { let s = ''; req.on('data', c => { s += c; if (s.length > 1e5) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(s || '{}')); } catch { r({}); } }); });
const clean = (s, n) => String(s || '').replace(/[<>]/g, '').trim().slice(0, n);
const auth = req => sessions.get((req.headers.authorization || '').replace('Bearer ', ''));

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/manifest+json', '.png': 'image/png' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    // ---- public API ----
    if (p === '/api/barbers' && req.method === 'GET')
      return send(res, 200, { tz: TZ, today: nowInShop().date, daysAhead: DAYS_AHEAD, slotMinutes: SLOT_MIN,
        barbers: db.barbers.map(b => ({ id: b.id, name: b.name })) });

    if (p === '/api/slots' && req.method === 'GET') {
      const b = db.barbers.find(x => x.id === url.searchParams.get('barber'));
      if (!b) return send(res, 404, { error: 'Frizer nije pronađen' });
      return send(res, 200, { slots: slotsFor(b, url.searchParams.get('date')) });
    }

    if (p === '/api/book' && req.method === 'POST') {
      const d = await body(req);
      const b = db.barbers.find(x => x.id === d.barberId);
      const name = clean(d.name, 60), phone = clean(d.phone, 30);
      if (!b || !name || !phone) return send(res, 400, { error: 'Unesite ime i broj telefona.' });
      if (!slotsFor(b, d.date).includes(d.time)) return send(res, 409, { error: 'Termin je upravo zauzet. Izaberite drugi.' });
      const booking = { id: crypto.randomUUID(), barberId: b.id, date: d.date, time: d.time, name, phone, createdAt: new Date().toISOString() };
      db.bookings.push(booking);
      try { await save(); } catch (e) { db.bookings = db.bookings.filter(x => x.id !== booking.id); return send(res, 503, { error: 'Greška pri čuvanju termina. Pokušajte ponovo.' }); }
      return send(res, 200, { ok: true, booking: { ...booking, barber: b.name } });
    }

    // ---- admin API ----
    if (p === '/api/admin/login' && req.method === 'POST') {
      const d = await body(req);
      const b = db.barbers.find(x => x.id === d.barberId);
      if (!b || String(d.pin) !== b.pin) return send(res, 401, { error: 'Pogrešan PIN' });
      const token = crypto.randomBytes(24).toString('hex');
      sessions.set(token, b.id);
      return send(res, 200, { token });
    }
    if (p.startsWith('/api/admin/')) {
      const id = auth(req);
      const me = db.barbers.find(x => x.id === id);
      if (!me) return send(res, 401, { error: 'Niste prijavljeni' });

      if (p === '/api/admin/me' && req.method === 'GET') {
        const today = nowInShop().date;
        const bookings = db.bookings.filter(b => b.barberId === me.id && b.date >= today)
          .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
        return send(res, 200, { name: me.name, hours: me.hours, daysOff: me.daysOff.filter(d => d >= today), bookings, today });
      }
      if (p === '/api/admin/hours' && req.method === 'POST') {
        const d = await body(req), hours = {};
        for (let i = 0; i < 7; i++) {
          const h = d.hours && d.hours[i];
          if (!h) { hours[i] = null; continue; }
          if (!validTime(h[0]) || !validTime(h[1]) || toMin(h[0]) >= toMin(h[1])) return send(res, 400, { error: 'Neispravno radno vrijeme: početak mora biti prije kraja.' });
          hours[i] = [h[0], h[1]];
        }
        me.hours = hours; await save(); return send(res, 200, { ok: true });
      }
      if (p === '/api/admin/dayoff' && req.method === 'POST') {
        const d = await body(req);
        if (!validDate(d.date)) return send(res, 400, { error: 'Neispravan datum' });
        if (d.off && !me.daysOff.includes(d.date)) me.daysOff.push(d.date);
        if (!d.off) me.daysOff = me.daysOff.filter(x => x !== d.date);
        await save(); return send(res, 200, { ok: true });
      }
      if (p === '/api/admin/cancel' && req.method === 'POST') {
        const d = await body(req);
        db.bookings = db.bookings.filter(b => !(b.id === d.id && b.barberId === me.id));
        await save(); return send(res, 200, { ok: true });
      }
      if (p === '/api/admin/day' && req.method === 'GET') {
        const date = url.searchParams.get('date');
        if (!validDate(date)) return send(res, 400, { error: 'Neispravan datum' });
        const booked = Object.fromEntries(db.bookings.filter(b => b.barberId === me.id && b.date === date).map(b => [b.time, b]));
        const slots = allSlots(me, date).map(t => booked[t] ? { time: t, status: 'booked', name: booked[t].name, phone: booked[t].phone }
          : { time: t, status: isBlocked(me, date, t) ? 'closed' : 'free' });
        return send(res, 200, { slots });
      }
      if (p === '/api/admin/block' && req.method === 'POST') {
        const d = await body(req);
        if (!validDate(d.date) || !allSlots(me, d.date).includes(d.time)) return send(res, 400, { error: 'Taj termin nije u radnom vremenu.' });
        if (d.off) {
          if (db.bookings.some(b => b.barberId === me.id && b.date === d.date && b.time === d.time)) return send(res, 409, { error: 'Termin je već zakazan. Prvo ga otkaži.' });
          if (!isBlocked(me, d.date, d.time)) me.blocked.push({ date: d.date, time: d.time });
        } else me.blocked = me.blocked.filter(x => !(x.date === d.date && x.time === d.time));
        await save(); return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'Not found' });
    }

    // ---- static ----
    let f = p === '/' ? '/index.html' : p === '/admin' ? '/admin.html' : p;
    const file = path.join(__dirname, 'public', path.normalize(f));
    if (!file.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) { console.error(e); send(res, 500, { error: 'Server error' }); }
});
init().then(() => server.listen(PORT, () => console.log(`Barber booking running on http://localhost:${PORT}  (admin: /admin)`)))
  .catch(e => { console.error('Cannot start (storage error):', e.message); process.exit(1); });
