# Werner Klausen Regnskap — Hjemmeside

> **Sist oppdatert:** 2026-05-05 | **Status:** Under utvikling

---

## Prosjektoversikt

Hjemmeside for **Werner Klausen Regnskap AS**, et autorisert regnskapsbyrå i Norge. Bygget som en single-page site med Express-backend, admin-panel og AI-drevet meldingsanalyse.

**Eier/maker:** Studio Solberg (Bjørnar Solberg)
**Klient:** Werner Klausen Regnskap AS (Henning Saksvik Klausen + Raymond A. Werner)

---

## Arkitektur

| Komponent | Teknologi | Status |
|-----------|-----------|--------|
| **Frontend** | Vanilla HTML/CSS/JS (single file) | LIVE |
| **Backend** | Express.js (server.js) | LIVE (lokal) |
| **Data** | JSON-filer på disk | Midlertidig |
| **Hosting** | Vercel (statisk) + lokal server | Delvis |
| **Video** | MP4 intro + loop | LIVE |
| **Admin** | HTML admin-panel | LIVE |

### Planlagt produksjonsarkitektur

| Komponent | Teknologi | Status |
|-----------|-----------|--------|
| **Auth** | AWS Cognito (via Studio Solberg) | PLANLAGT |
| **Database** | AWS DynamoDB | PLANLAGT |
| **API** | Studio Solberg API-gateway | PLANLAGT |
| **Hosting** | Vercel (frontend) + AWS (backend) | PLANLAGT |

---

## VIKTIG: Studio Solberg er eier/plattform

Werner Klausen-siden er en **klientside bygget på Studio Solberg-plattformen**. Det betyr:

- **Innlogging** → AWS Cognito, administrert av Studio Solberg
- **API-tilgang** → Studio Solberg API-nøkler og gateway
- **Database** → Studio Solberg sin DynamoDB-instans (eu-north-1)
- **Brukerrettigheter** → Werner Klausen-brukere får tilgang via Studio Solberg-systemet
- **Administrasjon** → Admin-panelet skal autentisere mot Cognito, ikke lokal passord

### Migrering fra lokal til produksjon (TODO)

1. **Auth**: Bytt fra lokal passord (`ADMIN_PASSWORD` i .env) til Cognito JWT-validering
2. **Data**: Migrer `data/content.json` → DynamoDB tabell
3. **Meldinger**: Migrer `data/messages.json` → DynamoDB tabell
4. **Settings**: Migrer `data/settings.json` → DynamoDB tabell
5. **Analytics**: Migrer `data/analytics.json` → DynamoDB tabell
6. **E-post**: Bytt fra nodemailer/SMTP til AWS SES (allerede i Studio Solberg-stack)
7. **API**: Flytt alle `/api/*` endepunkter til Studio Solberg API-gateway

---

## Mappestruktur

```
henning-klausen-hjemmeside/
├── index.html                    # Hoved-side (alt inline CSS/JS)
├── server.js                     # Express-server (lokal utvikling + API)
├── package.json                  # Express + nodemailer
├── vercel.json                   # Vercel deploy-config
├── .env                          # ADMIN_PASSWORD, SMTP-credentials
├── admin/
│   ├── index.html                # Admin dashboard (KPI, grafer, meldinger)
│   └── forside/
│       └── index.html            # Innholdsredigering (CMS)
├── data/
│   ├── content.json              # Alt redigerbart innhold (→ DynamoDB)
│   ├── messages.json             # Kontaktskjema-meldinger (→ DynamoDB)
│   ├── settings.json             # E-post + AI-innstillinger (→ DynamoDB)
│   ├── analytics.json            # Besøksstatistikk (→ DynamoDB)
│   └── calendar.json             # Kalender-events (→ DynamoDB)
├── IntroReversed.mp4             # Hero intro-video (reversed, 6s)
├── StaticLoopVideo.mp4           # Hero loop-video (6s)
├── Intro.mp4                     # Original intro
├── moss-overlay.png              # Mose-overgang hero → stats
└── .vercel/                      # Vercel project config
```

---

## Nøkkelpersoner

| Navn | Rolle | Kontakt |
|------|-------|---------|
| **Henning Saksvik Klausen** | Daglig leder, autorisert regnskapsfører | post@wernerklausen.no |
| **Raymond A. Werner** | Rådgiver, siviløkonom | post@wernerklausen.no |
| **Bjørnar Solberg** | Utvikler (Studio Solberg) | — |

---

## API-endepunkter (nåværende, lokal)

| Metode | Endepunkt | Auth | Formål |
|--------|-----------|------|--------|
| POST | `/api/auth` | Nei | Passord → token (→ Cognito) |
| GET | `/api/content` | Nei | Hent innhold |
| PUT | `/api/content` | Ja | Lagre innhold |
| POST | `/api/messages` | Nei | Motta kontaktskjema |
| GET | `/api/messages` | Ja | Hent meldinger |
| DELETE | `/api/messages/:id` | Ja | Slett melding |
| PATCH | `/api/messages/:id` | Ja | Marker som lest |
| GET | `/api/settings` | Ja | Hent innstillinger |
| PUT | `/api/settings` | Ja | Lagre innstillinger |
| POST | `/api/analytics/track` | Nei | Spor besøk/events |
| GET | `/api/analytics` | Ja | Hent statistikk |
| GET | `/api/calendar` | Ja | Hent kalender |
| POST | `/api/calendar` | Ja | Legg til event |
| DELETE | `/api/calendar/:id` | Ja | Slett event |

---

## Funksjoner

### Hero
- Video intro (reversed) → sømløs crossfade til loop
- "Velkommen til Werner Klausen Regnskap AS" splash over videoen
- Tekst på høyre side (kuben til venstre)
- Mose-overgang til stats-seksjon
- Scroll = skip intro

### Admin Dashboard (`/admin`)
- Single-viewport, ingen scroll
- Sidebar med nav-ikoner
- KPI-kort (uleste, totalt, snitt besøkstid)
- Besøk & handlinger-graf (Chart.js)
- Populære seksjoner (barer)
- Enhets-fordeling (donut)
- Meldingsinnboks (slide-panel)
- Innstillinger (modal)

### AI-analyse av meldinger
- Claude Haiku analyserer hver henvendelse
- Gir: prioritet, kategori, nøkkelinfo, datoer
- Datoer konverteres fra relative ("onsdag") til absolutte (2026-05-07)
- Datoer kan eksporteres til .ics (Outlook/Calendar)
- Analyse sendes med i e-postvarsling
- Ca. kr 0,05-0,10 per melding
- Av/på i admin + Anthropic API-nøkkel

### E-postvarsling
- Nodemailer → SMTP (→ AWS SES i prod)
- Mottar: post@wernerklausen.no
- Inkluderer AI-analyse hvis aktivert
- Av/på i admin

### Analytics (egenutviklet)
- Sidevisninger med varighet og scroll-dybde
- Seksjonsengasjement (tid brukt per seksjon)
- Handlinger (telefon-klikk, e-post, skjema)
- Enhetsfordeling (mobil/nettbrett/desktop)
- 90 dagers datalagring

---

## Design

| Element | Verdi |
|---------|-------|
| **Primærfarge** | Forest green `#1A3B30` |
| **Aksent** | Gold `#C4925A` |
| **Bakgrunn** | Cream `#F5F0E8` |
| **Heading-font** | Fraunces (serif) |
| **Body-font** | Manrope (sans-serif) |
| **Hero** | Kinematisk video med skog + speilkube |
| **Overgang** | Organisk mose-PNG mellom hero og stats |

---

## Lokal utvikling

```bash
npm install
npm start          # http://localhost:4000
```

Admin: http://localhost:4000/admin (passord: se .env)

---

## Huskeliste

- [ ] Migrer auth til Cognito (Studio Solberg)
- [ ] Migrer data til DynamoDB
- [ ] Bytt e-post til AWS SES
- [ ] Koble admin til Studio Solberg API-gateway
- [ ] Sett opp custom domain (wernerklausen.no)
- [ ] Optimaliser video-filer (WebM-versjoner)
- [ ] Legg til portrettbilder av Henning og Raymond
- [ ] Implementer "År i bransjen" som beregnes fra startdato
