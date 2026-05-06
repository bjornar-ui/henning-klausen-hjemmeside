const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();
const PORT = 4000;

// Load password from .env (simple parser, no dotenv dependency)
const envPath = path.join(__dirname, '.env');
const env = {};
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [key, ...val] = line.trim().split('=');
    if (key && val.length) env[key] = val.join('=');
  });
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || env.ADMIN_PASSWORD || 'admin';

// In-memory session tokens (reset on server restart — fine for single user)
const sessions = new Set();

// Data file paths
const DATA_DIR = path.join(__dirname, 'data');
const CONTENT_FILE = path.join(DATA_DIR, 'content.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const ANALYTICS_FILE = path.join(DATA_DIR, 'analytics.json');

// Ensure analytics file exists
if (!fs.existsSync(ANALYTICS_FILE)) writeJSON(ANALYTICS_FILE, { visits: [], events: [] });

// Email transporter (configure SMTP in .env)
const SMTP_HOST = env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = parseInt(env.SMTP_PORT || '587');
const SMTP_USER = env.SMTP_USER || '';
const SMTP_PASS = env.SMTP_PASS || '';
const SMTP_FROM = env.SMTP_FROM || 'noreply@wernerklausen.no';

let transporter = null;
if (SMTP_USER && SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  console.log('E-postvarsling: SMTP konfigurert (' + SMTP_HOST + ')');
} else {
  console.log('E-postvarsling: SMTP ikke konfigurert (legg til SMTP_USER/SMTP_PASS i .env)');
}

// ── AI Analysis with Claude ──
async function analyzeWithClaude(message, settings) {
  if (!settings.aiAnalysis || !settings.anthropicApiKey) return null;

  const customInstructions = settings.aiCustomInstructions || '';
  const customTags = settings.aiTags?.length ? settings.aiTags : ['Nytt oppdrag', 'Eksisterende kunde', 'Prisforespørsel', 'Rådgivning', 'Bytte byrå', 'Haster', 'Generelt spørsmål'];

  // Build date context so AI can resolve relative dates
  const now = new Date();
  const dayNames = ['søndag','mandag','tirsdag','onsdag','torsdag','fredag','lørdag'];
  const dateContext = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(now); d.setDate(d.getDate() + i);
    dateContext.push(`${dayNames[d.getDay()]} = ${d.toISOString().slice(0,10)}`);
  }

  const prompt = `Du er en sorteringsassistent for Werner Klausen Regnskap AS. De er erfarne, autoriserte regnskapsførere — de trenger IKKE råd. Bare fakta og sortering.

Dagens dato: ${now.toISOString().slice(0,10)} (${dayNames[now.getDay()]})
Datoer de neste 14 dagene:
${dateContext.join(', ')}

Analyser henvendelsen og gi tilbake et JSON-objekt med:
- "prioritet": "høy" (tidssensitivt/stort oppdrag), "middels" (normalt), eller "lav" (kan vente)
- "kategori": Én av disse: ${customTags.map(t => '"' + t + '"').join(', ')}
- "tags": Array med 1-3 relevante tags fra listen over
- "oppsummering": Kort, saklig oppsummering (maks 2 setninger, kun fakta — ingen råd)
- "nøkkelinfo": Array med 2-5 korte stikkord som oppsummerer de viktigste faktaene (f.eks. "12 ansatte", "Bruker Tripletex")
- "datoer": Array med objekter for alle nevnte tidspunkter. VIKTIG: Konverter ALLTID relative dager (f.eks. "onsdag", "neste uke", "i morgen") til faktiske datoer i ISO-format. Format: [{"dato": "2026-05-07", "beskrivelse": "Ønsker møte (formiddag)"}]. Tomt array [] hvis ingen datoer nevnt.

VIKTIG: Ikke gi råd eller handlingsforslag. Bare ekstraher fakta. Alle relative datoer MÅ konverteres til faktiske datoer (YYYY-MM-DD).

${customInstructions ? 'Ekstra instruksjoner:\n' + customInstructions + '\n' : ''}
Meldingen ble sendt: ${message.timestamp}

Henvendelse:
Navn: ${message.navn}
${message.bedrift ? 'Bedrift: ' + message.bedrift : ''}
E-post: ${message.epost}
${message.telefon ? 'Telefon: ' + message.telefon : ''}
${message.behov ? 'Valgt område: ' + message.behov : ''}

Melding:
${message.melding || '(ingen melding)'}

Svar KUN med et gyldig JSON-objekt, ingen annen tekst.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': settings.anthropicApiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('Claude API feil:', res.status, err);
      return null;
    }

    const data = await res.json();
    const text = data.content?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return null;
  } catch (err) {
    console.error('AI-analyse feilet:', err.message);
    return null;
  }
}

// ── Process incoming message: AI → Email ──
async function processMessage(message) {
  const settings = readJSON(SETTINGS_FILE) || {};
  let analysis = null;

  // Step 1: AI analysis (if enabled)
  if (settings.aiAnalysis && settings.anthropicApiKey) {
    console.log('AI-analyse: Analyserer melding fra', message.navn);
    analysis = await analyzeWithClaude(message, settings);
    if (analysis) {
      console.log('AI-analyse ferdig:', analysis.prioritet, analysis.kategori);
      // Save analysis back to message in messages.json
      const messages = readJSON(MESSAGES_FILE) || [];
      const msg = messages.find(m => m.id === message.id);
      if (msg) {
        msg.ai = analysis;
        writeJSON(MESSAGES_FILE, messages);
      }
      // Auto-add dates to calendar
      if (analysis.datoer && Array.isArray(analysis.datoer)) {
        const calendar = readJSON(CALENDAR_FILE) || [];
        analysis.datoer.forEach(d => {
          if (d.dato) {
            calendar.push({
              id: crypto.randomUUID(),
              date: d.dato,
              title: message.navn + (message.bedrift ? ' (' + message.bedrift + ')' : ''),
              description: d.beskrivelse || '',
              source: 'ai',
              messageId: message.id,
              created: new Date().toISOString()
            });
          }
        });
        writeJSON(CALENDAR_FILE, calendar);
      }
    }
  }

  // Step 2: Send email (with AI analysis included if available)
  if (settings.emailNotifications && settings.notifyEmail) {
    await sendNotificationEmail(message, analysis, settings);
  }
}

async function sendNotificationEmail(message, analysis, settings) {
  if (!transporter) {
    console.log('E-postvarsling: Ville sendt til', settings.notifyEmail, 'men SMTP er ikke konfigurert');
    return;
  }

  const priorityEmoji = { 'høy': '🔴', 'middels': '🟡', 'lav': '🟢' };
  const priorityLabel = analysis ? `${priorityEmoji[analysis.prioritet] || '⚪'} ${analysis.prioritet.toUpperCase()}` : '';
  const subjectPrefix = analysis ? `[${analysis.prioritet.toUpperCase()}] ` : '';

  try {
    await transporter.sendMail({
      from: `"Werner Klausen Regnskap" <${SMTP_FROM}>`,
      to: settings.notifyEmail,
      subject: `${subjectPrefix}Ny henvendelse fra ${message.navn}${message.bedrift ? ' (' + message.bedrift + ')' : ''}`,
      text: [
        analysis ? `--- AI-ANALYSE ---` : null,
        analysis ? `Prioritet: ${analysis.prioritet}` : null,
        analysis ? `Kategori: ${analysis.kategori}` : null,
        analysis?.tags ? `Tags: ${analysis.tags.join(', ')}` : null,
        analysis ? `Oppsummering: ${analysis.oppsummering}` : null,
        analysis?.nøkkelinfo ? `Nøkkelinfo: ${analysis.nøkkelinfo.join(', ')}` : null,
        analysis ? `---\n` : null,
        `Ny melding via kontaktskjemaet:`,
        ``,
        `Navn: ${message.navn}`,
        message.bedrift ? `Bedrift: ${message.bedrift}` : null,
        `E-post: ${message.epost}`,
        message.telefon ? `Telefon: ${message.telefon}` : null,
        message.behov ? `Område: ${message.behov}` : null,
        ``,
        `Melding:`,
        message.melding || '(ingen melding)',
        ``,
        `---`,
        `Mottatt: ${new Date(message.timestamp).toLocaleString('nb-NO')}`,
        `Se alle meldinger: ${env.SITE_URL || 'http://localhost:4000'}/admin`
      ].filter(Boolean).join('\n'),
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <div style="background:#1A3B30;padding:20px 24px;border-radius:8px 8px 0 0;display:flex;align-items:center;justify-content:space-between;">
            <h2 style="color:#F0D9B8;margin:0;font-size:18px;">Ny henvendelse</h2>
            ${analysis ? `<span style="color:#fff;font-size:12px;font-weight:700;background:${analysis.prioritet === 'høy' ? '#C0392B' : analysis.prioritet === 'middels' ? '#D4A040' : '#27AE60'};padding:3px 10px;border-radius:4px;">${analysis.prioritet.toUpperCase()}</span>` : ''}
          </div>
          ${analysis ? `
          <div style="background:#F5F0E8;padding:16px 24px;border-left:1px solid #DDD5C0;border-right:1px solid #DDD5C0;">
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#9E6E38;margin-bottom:8px;">AI-analyse</div>
            <div style="font-size:14px;color:#1A1815;line-height:1.5;margin-bottom:8px;"><strong>${analysis.oppsummering}</strong></div>
            ${analysis.nøkkelinfo ? '<div style="font-size:13px;color:#5C5950;margin-bottom:8px;">' + analysis.nøkkelinfo.map(i => '• ' + i).join('<br>') + '</div>' : ''}
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              <span style="background:#1A3B30;color:#F0D9B8;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;">${analysis.kategori}</span>
              ${(analysis.tags || []).map(t => `<span style="background:#DDD5C0;color:#5C5950;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;">${t}</span>`).join('')}
            </div>
          </div>` : ''}
          <div style="background:#FAF8F3;padding:24px;border:1px solid #DDD5C0;border-top:${analysis ? 'none' : '1px solid #DDD5C0'};border-radius:0 0 8px 8px;">
            <table style="width:100%;border-collapse:collapse;font-size:14px;">
              <tr><td style="padding:6px 12px 6px 0;color:#5C5950;font-weight:600;vertical-align:top;width:80px;">Navn</td><td style="padding:6px 0;">${message.navn}</td></tr>
              ${message.bedrift ? `<tr><td style="padding:6px 12px 6px 0;color:#5C5950;font-weight:600;vertical-align:top;">Bedrift</td><td style="padding:6px 0;">${message.bedrift}</td></tr>` : ''}
              <tr><td style="padding:6px 12px 6px 0;color:#5C5950;font-weight:600;vertical-align:top;">E-post</td><td style="padding:6px 0;"><a href="mailto:${message.epost}" style="color:#9E6E38;">${message.epost}</a></td></tr>
              ${message.telefon ? `<tr><td style="padding:6px 12px 6px 0;color:#5C5950;font-weight:600;vertical-align:top;">Telefon</td><td style="padding:6px 0;"><a href="tel:${message.telefon}" style="color:#9E6E38;">${message.telefon}</a></td></tr>` : ''}
              ${message.behov ? `<tr><td style="padding:6px 12px 6px 0;color:#5C5950;font-weight:600;vertical-align:top;">Område</td><td style="padding:6px 0;"><span style="background:#F0D9B8;color:#9E6E38;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;">${message.behov}</span></td></tr>` : ''}
            </table>
            ${message.melding ? `<div style="margin-top:16px;padding:16px;background:#F5F0E8;border-radius:6px;border-left:3px solid #C4925A;font-size:14px;line-height:1.6;white-space:pre-wrap;">${message.melding}</div>` : ''}
            <div style="margin-top:20px;text-align:center;">
              <a href="${env.SITE_URL || 'http://localhost:4000'}/admin" style="display:inline-block;background:#1A3B30;color:#F0D9B8;padding:10px 24px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600;">Se i admin-panelet</a>
            </div>
          </div>
        </div>
      `
    });
    console.log('E-postvarsling sendt til', settings.notifyEmail);
  } catch (err) {
    console.error('E-postvarsling feilet:', err.message);
  }
}

// Helpers
function readJSON(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function sanitizeHTML(str) {
  if (typeof str !== 'string') return str;
  // Allow only <em> and </em>, strip everything else
  return str
    .replace(/<(?!\/?em\b)[^>]*>/gi, '')
    .replace(/javascript:/gi, '');
}

function sanitizeDeep(obj) {
  if (typeof obj === 'string') return sanitizeHTML(obj);
  if (Array.isArray(obj)) return obj.map(sanitizeDeep);
  if (obj && typeof obj === 'object') {
    const result = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = sanitizeDeep(v);
    }
    return result;
  }
  return obj;
}

// Auth middleware
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Middleware
app.use(express.json({ limit: '1mb' }));

// ── API Routes ──

// Auth
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.add(token);
    return res.json({ token });
  }
  res.status(401).json({ error: 'Feil passord' });
});

// Logout
app.post('/api/logout', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) sessions.delete(token);
  res.json({ ok: true });
});

// Content — public read
app.get('/api/content', (_req, res) => {
  const data = readJSON(CONTENT_FILE);
  if (!data) return res.status(500).json({ error: 'Content file not found' });
  res.json(data);
});

// Content — admin write
app.put('/api/content', requireAuth, (req, res) => {
  const data = sanitizeDeep(req.body);
  writeJSON(CONTENT_FILE, data);
  res.json({ ok: true });
});

// Messages — public submit
app.post('/api/messages', (req, res) => {
  const { navn, bedrift, epost, telefon, behov, melding } = req.body;

  if (!navn || !epost) {
    return res.status(400).json({ error: 'Navn og e-post er p\u00e5krevd' });
  }

  const messages = readJSON(MESSAGES_FILE) || [];
  const message = {
    id: crypto.randomUUID(),
    navn: sanitizeHTML(navn),
    bedrift: sanitizeHTML(bedrift || ''),
    epost: sanitizeHTML(epost),
    telefon: sanitizeHTML(telefon || ''),
    behov: sanitizeHTML(behov || ''),
    melding: sanitizeHTML(melding || ''),
    timestamp: new Date().toISOString(),
    read: false
  };

  messages.unshift(message);
  writeJSON(MESSAGES_FILE, messages);

  // AI analysis → email notification (async, don't block response)
  processMessage(message);

  res.json({ ok: true, id: message.id });
});

// Messages — admin read
app.get('/api/messages', requireAuth, (_req, res) => {
  const messages = readJSON(MESSAGES_FILE) || [];
  res.json(messages);
});

// Messages — admin delete
app.delete('/api/messages/:id', requireAuth, (req, res) => {
  let messages = readJSON(MESSAGES_FILE) || [];
  const before = messages.length;
  messages = messages.filter(m => m.id !== req.params.id);
  if (messages.length === before) {
    return res.status(404).json({ error: 'Melding ikke funnet' });
  }
  writeJSON(MESSAGES_FILE, messages);
  res.json({ ok: true });
});

// Messages — admin mark as read
app.patch('/api/messages/:id', requireAuth, (req, res) => {
  const messages = readJSON(MESSAGES_FILE) || [];
  const msg = messages.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ error: 'Melding ikke funnet' });
  msg.read = true;
  writeJSON(MESSAGES_FILE, messages);
  res.json({ ok: true });
});

// Settings — admin read
app.get('/api/settings', requireAuth, (_req, res) => {
  const settings = readJSON(SETTINGS_FILE) || { emailNotifications: true, notifyEmail: 'post@wernerklausen.no' };
  res.json(settings);
});

// Settings — admin write
app.put('/api/settings', requireAuth, (req, res) => {
  const { emailNotifications, notifyEmail, aiAnalysis, anthropicApiKey, aiCustomInstructions, aiTags } = req.body;
  const current = readJSON(SETTINGS_FILE) || {};
  const settings = {
    emailNotifications: emailNotifications !== undefined ? !!emailNotifications : !!current.emailNotifications,
    notifyEmail: sanitizeHTML(notifyEmail !== undefined ? notifyEmail : current.notifyEmail || ''),
    aiAnalysis: aiAnalysis !== undefined ? !!aiAnalysis : !!current.aiAnalysis,
    anthropicApiKey: anthropicApiKey !== undefined ? (anthropicApiKey || '') : (current.anthropicApiKey || ''),
    aiCustomInstructions: sanitizeHTML(aiCustomInstructions !== undefined ? aiCustomInstructions : current.aiCustomInstructions || ''),
    aiTags: Array.isArray(aiTags) ? aiTags.map(t => sanitizeHTML(t)).filter(Boolean) : (current.aiTags || [])
  };
  writeJSON(SETTINGS_FILE, settings);
  res.json({ ok: true });
});

// ── Calendar ──
const CALENDAR_FILE = path.join(DATA_DIR, 'calendar.json');
if (!fs.existsSync(CALENDAR_FILE)) writeJSON(CALENDAR_FILE, []);

app.get('/api/calendar', requireAuth, (_req, res) => {
  const events = readJSON(CALENDAR_FILE) || [];
  res.json(events);
});

app.post('/api/calendar', requireAuth, (req, res) => {
  const { date, title, description, source, messageId } = req.body;
  if (!date || !title) return res.status(400).json({ error: 'Dato og tittel er påkrevd' });
  const events = readJSON(CALENDAR_FILE) || [];
  const event = {
    id: crypto.randomUUID(),
    date: sanitizeHTML(date),
    title: sanitizeHTML(title),
    description: sanitizeHTML(description || ''),
    source: sanitizeHTML(source || 'manual'),
    messageId: messageId || null,
    created: new Date().toISOString()
  };
  events.push(event);
  writeJSON(CALENDAR_FILE, events);
  res.json({ ok: true, id: event.id });
});

app.delete('/api/calendar/:id', requireAuth, (req, res) => {
  let events = readJSON(CALENDAR_FILE) || [];
  events = events.filter(e => e.id !== req.params.id);
  writeJSON(CALENDAR_FILE, events);
  res.json({ ok: true });
});

// ── Analytics ──

// Track a page visit or event (public, no auth)
app.post('/api/analytics/track', (req, res) => {
  const { type, page, section, duration, scrollDepth, referrer, screenWidth } = req.body;
  const analytics = readJSON(ANALYTICS_FILE) || { visits: [], events: [] };
  const timestamp = new Date().toISOString();
  const date = timestamp.slice(0, 10); // YYYY-MM-DD

  if (type === 'pageview') {
    analytics.visits.push({
      date,
      timestamp,
      page: sanitizeHTML(page || '/'),
      referrer: sanitizeHTML(referrer || ''),
      screenWidth: parseInt(screenWidth) || 0,
      duration: parseInt(duration) || 0,
      scrollDepth: parseInt(scrollDepth) || 0
    });
  } else if (type === 'event') {
    analytics.events.push({
      date,
      timestamp,
      action: sanitizeHTML(section || ''),
      page: sanitizeHTML(page || '/')
    });
  } else if (type === 'section') {
    analytics.events.push({
      date,
      timestamp,
      action: 'section_view',
      section: sanitizeHTML(section || ''),
      duration: parseInt(duration) || 0,
      page: sanitizeHTML(page || '/')
    });
  }

  // Keep max 90 days of data
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  analytics.visits = analytics.visits.filter(v => v.date >= cutoffStr);
  analytics.events = analytics.events.filter(e => e.date >= cutoffStr);

  writeJSON(ANALYTICS_FILE, analytics);
  res.json({ ok: true });
});

// Get analytics summary (admin only)
app.get('/api/analytics', requireAuth, (req, res) => {
  const analytics = readJSON(ANALYTICS_FILE) || { visits: [], events: [] };
  const days = parseInt(req.query.days) || 30;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const visits = analytics.visits.filter(v => v.date >= cutoffStr);
  const events = analytics.events.filter(e => e.date >= cutoffStr);

  // Visits per day
  const visitsByDay = {};
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    visitsByDay[d.toISOString().slice(0, 10)] = 0;
  }
  visits.forEach(v => { if (visitsByDay[v.date] !== undefined) visitsByDay[v.date]++; });

  // Actions (contact form, phone click, etc.)
  const actions = events.filter(e => e.action && e.action !== 'section_view');
  const actionsByDay = {};
  for (const d of Object.keys(visitsByDay)) actionsByDay[d] = 0;
  actions.forEach(a => { if (actionsByDay[a.date] !== undefined) actionsByDay[a.date]++; });

  // Section engagement
  const sectionEvents = events.filter(e => e.action === 'section_view');
  const sectionStats = {};
  sectionEvents.forEach(e => {
    if (!sectionStats[e.section]) sectionStats[e.section] = { views: 0, totalDuration: 0 };
    sectionStats[e.section].views++;
    sectionStats[e.section].totalDuration += e.duration || 0;
  });
  // Compute avg duration
  for (const s of Object.values(sectionStats)) {
    s.avgDuration = s.views > 0 ? Math.round(s.totalDuration / s.views) : 0;
  }

  // Device breakdown
  let mobile = 0, tablet = 0, desktop = 0;
  visits.forEach(v => {
    if (v.screenWidth < 768) mobile++;
    else if (v.screenWidth < 1024) tablet++;
    else desktop++;
  });

  // Avg scroll depth & visit duration
  const avgScroll = visits.length > 0 ? Math.round(visits.reduce((s, v) => s + (v.scrollDepth || 0), 0) / visits.length) : 0;
  const avgDuration = visits.length > 0 ? Math.round(visits.reduce((s, v) => s + (v.duration || 0), 0) / visits.length) : 0;

  res.json({
    totalVisits: visits.length,
    totalActions: actions.length,
    avgScrollDepth: avgScroll,
    avgDuration,
    visitsByDay: Object.entries(visitsByDay).sort((a, b) => a[0].localeCompare(b[0])).map(([date, count]) => ({ date, count })),
    actionsByDay: Object.entries(actionsByDay).sort((a, b) => a[0].localeCompare(b[0])).map(([date, count]) => ({ date, count })),
    sections: Object.entries(sectionStats).sort((a, b) => b[1].views - a[1].views).map(([name, data]) => ({ name, ...data })),
    devices: { mobile, tablet, desktop }
  });
});

// Admin routes (before static middleware to take priority)
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});
app.get('/admin/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});
app.get('/admin/forside', (_req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'forside', 'index.html'));
});
app.get('/admin/roadmap', (_req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'roadmap', 'index.html'));
});

// ── Static files (replaces http-server) ──
app.use(express.static(__dirname, {
  extensions: ['html'],
  index: 'index.html'
}));

// Export for Vercel serverless
module.exports = app;

// Start locally if not in Vercel
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Werner Klausen Regnskap — server kjører på http://localhost:${PORT}`);
    console.log(`Admin: http://localhost:${PORT}/admin`);
  });
}
