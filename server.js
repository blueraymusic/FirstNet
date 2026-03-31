const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3001; // Optional port number change
const CSV_PATH = path.join(__dirname, 'accounts.csv');

// Ensure the CSV has headers
function ensureCsv() {
  if (!fs.existsSync(CSV_PATH)) {
    fs.writeFileSync(CSV_PATH, 'id,name,phone,loc,init,color,skills,resources,approved,createdAt\n', 'utf8');
  }
}

function escapeCsv(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function parseCsvLine(line) {
  const values = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        // Peek ahead for escaped quote
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === ',') {
        values.push(cur);
        cur = '';
      } else if (ch === '"') {
        inQuotes = true;
      } else {
        cur += ch;
      }
    }
  }
  values.push(cur);
  return values;
}

function readAccounts() {
  ensureCsv();
  const text = fs.readFileSync(CSV_PATH, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return [];
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const row = parseCsvLine(line);
    const obj = {};
    header.forEach((key, idx) => {
      obj[key] = idx < row.length ? row[idx] : '';
    });

    // Support old CSV schema (9 columns without approved) by realigning createdAt
    if (header.includes('approved') && header.includes('createdAt') && row.length === 9) {
      // At legacy 9-col rows, "approved" gets the old createdAt value, so fix that.
      const possibleDate = obj.approved || '';
      if (possibleDate && !/^(true|false)$/i.test(possibleDate)) {
        obj.createdAt = possibleDate;
        obj.approved = 'false';
      }
    }

    if (!obj.approved) obj.approved = 'false';
    if (!obj.createdAt) obj.createdAt = '';
    return obj;
  });
}


function appendAccount(account) {
  ensureCsv();
  const now = new Date().toISOString();
  const id = `${Date.now()}-${Math.floor(Math.random()*900000+100000)}`;
  const row = [
    id,
    account.name || '',
    account.phone || '',
    account.loc || '',
    account.init || '',
    account.color || '',
    Array.isArray(account.skills) ? account.skills.join('|') : (account.skills || ''),
    Array.isArray(account.resources) ? account.resources.join('|') : (account.resources || ''),
    account.approved ? String(account.approved) : 'false',
    now
  ].map(escapeCsv).join(',') + os.EOL;
  fs.appendFileSync(CSV_PATH, row, 'utf8');
  return { id, createdAt: now };
}

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '.')));

app.get('/api/accounts', (req, res) => {
  try {
    const accounts = readAccounts();
    const { phone, id, approved } = req.query;
    let result = accounts;
    if (phone) {
      result = result.filter(a => a.phone === String(phone).trim());
    }
    if (id) {
      result = result.filter(a => a.id === String(id).trim());
    }
    if (typeof approved !== 'undefined') {
      const desired = String(approved).toLowerCase();
      result = result.filter(a => String(a.approved).toLowerCase() === desired);
    }
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to read accounts' });
  }
});

function writeAccounts(accounts) {
  const header = 'id,name,phone,loc,init,color,skills,resources,approved,createdAt\n';
  const content = accounts.map(acc => {
    const row = [
      acc.id,
      acc.name || '',
      acc.phone || '',
      acc.loc || '',
      acc.init || '',
      acc.color || '',
      Array.isArray(acc.skills) ? acc.skills.join('|') : (acc.skills || ''),
      Array.isArray(acc.resources) ? acc.resources.join('|') : (acc.resources || ''),
      acc.approved ? 'true' : 'false',
      acc.createdAt || ''
    ].map(escapeCsv).join(',');
    return row;
  }).join(os.EOL) + os.EOL;
  fs.writeFileSync(CSV_PATH, header + content, 'utf8');
}

app.post('/api/accounts', (req, res) => {
  const { name, phone, loc, init, color, skills, resources } = req.body || {};
  if (!name || !phone || !loc) {
    return res.status(400).json({ error: 'Missing required fields: name, phone, loc' });
  }
  try {
    const accounts = readAccounts();
    const existing = accounts.find(a => a.phone === String(phone).trim());
    if (existing) {
      return res.json({ success: true, existing: true, id: existing.id, createdAt: existing.createdAt, approved: existing.approved });
    }
    const meta = appendAccount({ name, phone, loc, init, color, skills, resources, approved: false });
    res.json({ success: true, existing: false, ...meta, approved: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save account' });
  }
});

app.post('/api/accounts/approve', (req, res) => {
  const { id, phone } = req.body || {};
  if (!id && !phone) {
    return res.status(400).json({ error: 'Missing required fields: id or phone' });
  }
  try {
    const accounts = readAccounts();
    const target = accounts.find(a => (id && a.id === String(id)) || (phone && a.phone === String(phone)));
    if (!target) {
      return res.status(404).json({ error: 'Account not found' });
    }
    target.approved = 'true';
    writeAccounts(accounts);
    res.json({ success: true, id: target.id, approved: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to approve account' });
  }
});


// Simple in-memory SOS state (single active SOS at a time)
let activeSOS = null;

app.get('/api/sos', (req, res) => {
  if (!activeSOS) return res.json([]);
  res.json([activeSOS]);
});

app.post('/api/sos', (req, res) => {
  const { requesterPhone, requesterName, requesterInit, requesterColor, em, desc, triage } = req.body || {};
  if (!requesterPhone || !requesterName || !em || !triage) {
    return res.status(400).json({ error: 'Missing SOS parameters' });
  }
  const id = `local-${Date.now()}`;
  activeSOS = {
    id,
    requesterPhone,
    requesterName,
    requesterInit,
    requesterColor,
    requesterLat: req.body.requesterLat || null,
    requesterLng: req.body.requesterLng || null,
    helperLat: null,
    helperLng: null,
    em,
    desc: desc || '',
    triage,
    status: 'pending',
    createdAt: new Date().toISOString(),
    acceptedBy: null,
    declinedBy: [],
    chat: [],
    notifiedBy: []
  };
  console.log('[FirstNet] API: sos created', activeSOS.id, activeSOS.requesterPhone);
  res.json({ success: true, sos: activeSOS });
});

app.post('/api/sos/:id/accept', (req, res) => {
  if (!activeSOS || activeSOS.id !== req.params.id) {
    return res.status(404).json({ error: 'SOS not found' });
  }
  if (activeSOS.status !== 'pending') {
    return res.status(400).json({ error: 'SOS is not pending' });
  }
  const helper = req.body.helper || {};
  activeSOS.status = 'accepted';
  activeSOS.acceptedBy = {
    phone: helper.phone || '',
    name: helper.name || '',
    init: helper.init || '',
    color: helper.color || '',
    skills: helper.skills || [],
  };
  if (typeof req.body.helperLat === 'number' || typeof req.body.helperLat === 'string') {
    activeSOS.helperLat = Number(req.body.helperLat);
  }
  if (typeof req.body.helperLng === 'number' || typeof req.body.helperLng === 'string') {
    activeSOS.helperLng = Number(req.body.helperLng);
  }
  activeSOS.acceptedAt = new Date().toISOString();
  console.log('[FirstNet] API: sos accepted', activeSOS.id, helper.phone);
  res.json({ success: true, sos: activeSOS });
});

app.post('/api/sos/:id/update-location', (req, res) => {
  if (!activeSOS || activeSOS.id !== req.params.id) {
    return res.status(404).json({ error: 'SOS not found' });
  }
  const { helperLat, helperLng } = req.body || {};
  if (typeof helperLat !== 'number' || typeof helperLng !== 'number') {
    return res.status(400).json({ error: 'Missing helperLat/helperLng numbers' });
  }
  activeSOS.helperLat = helperLat;
  activeSOS.helperLng = helperLng;
  activeSOS.updatedAt = new Date().toISOString();
  res.json({ success: true, sos: activeSOS });
});

app.post('/api/sos/:id/update-requester-location', (req, res) => {
  if (!activeSOS || activeSOS.id !== req.params.id) {
    return res.status(404).json({ error: 'SOS not found' });
  }
  const { requesterLat, requesterLng } = req.body || {};
  if (typeof requesterLat !== 'number' || typeof requesterLng !== 'number') {
    return res.status(400).json({ error: 'Missing requesterLat/requesterLng numbers' });
  }
  activeSOS.requesterLat = requesterLat;
  activeSOS.requesterLng = requesterLng;
  activeSOS.updatedAt = new Date().toISOString();
  res.json({ success: true, sos: activeSOS });
});

app.post('/api/sos/:id/decline', (req, res) => {
  if (!activeSOS || activeSOS.id !== req.params.id) {
    return res.status(404).json({ error: 'SOS not found' });
  }
  if (activeSOS.status !== 'pending') {
    return res.status(400).json({ error: 'SOS is not pending' });
  }
  const helperPhone = req.body.helperPhone;
  if (!helperPhone) return res.status(400).json({ error: 'Missing helperPhone' });
  activeSOS.declinedBy = activeSOS.declinedBy || [];
  if (!activeSOS.declinedBy.includes(helperPhone)) {
    activeSOS.declinedBy.push(helperPhone);
  }
  console.log('[FirstNet] API: sos declined', activeSOS.id, helperPhone);
  res.json({ success: true, sos: activeSOS });
});

app.post('/api/sos/:id/timeout', (req, res) => {
  if (!activeSOS || activeSOS.id !== req.params.id) {
    return res.status(404).json({ error: 'SOS not found' });
  }
  if (activeSOS.status !== 'pending') {
    return res.status(400).json({ error: 'SOS is not pending' });
  }
  activeSOS.status = 'timeout';
  activeSOS.timedOutAt = new Date().toISOString();
  console.log('[FirstNet] API: sos timeout', activeSOS.id);
  res.json({ success: true, sos: activeSOS });
});

app.post('/api/sos/:id/chat', (req, res) => {
  if (!activeSOS || activeSOS.id !== req.params.id) {
    return res.status(404).json({ error: 'SOS not found' });
  }
  const { sender, text } = req.body || {};
  if (!sender || !text) {
    return res.status(400).json({ error: 'Missing sender or text' });
  }
  const entry = {
    ts: new Date().toISOString(),
    sender,
    text
  };
  activeSOS.chat = activeSOS.chat || [];
  activeSOS.chat.push(entry);
  console.log('[FirstNet] API: sos chat', activeSOS.id, sender, text);
  res.json({ success: true, sos: activeSOS });
});

app.post('/api/sos/:id/clear', (req, res) => {
  if (activeSOS && activeSOS.id === req.params.id) {
    activeSOS = null;
    console.log('[FirstNet] API: sos cleared', req.params.id);
    return res.json({ success: true });
  }
  res.status(404).json({ error: 'SOS not found' });
});

app.listen(PORT, () => {
  console.log(`FirstNet server running at http://localhost:${PORT}`);
  console.log(`Accounts will be stored in ${CSV_PATH}`);
});
