# HANDOFF.md — MediaDrop full reference

Ye document isliye hai ki agar Claude ka session/limit khatam ho jaye, to tum (ya koi bhi dev,
ya koi bhi AI assistant) is file ko padh ke exactly wahi se continue kar sake jahan chhoda tha.
Sab kuch yaha hai: tech stack, folder structure, kya bana hai, kya baaki hai, aur agla step kya
hai.

---

## 1. Ye project kya hai (important clarification)

Ye ek **plain full-stack web app** hai — React frontend + Node/Express backend. Isme koi bhi
AI/LLM "model" use nahi ho raha. Jab tum bole "konse model use honge", to seedha jawab: **koi
nahi** — ye Claude ka use sirf *code likhne ke liye* ho raha hai (jaise ek developer karta),
lekin jo app ban rahi hai usme khud koi AI/ML model embedded nahi hai. Agar aage chal ke tum
chahte ho ki app AI use kare (jaise auto-tagging, content moderation, ya kuch aur), wo alag
se decide karna padega — abhi tak spec me aisa kuch nahi maanga gaya tha.

---

## 2. Tech stack (poora)

### Frontend (`client/`)
| Cheez | Kya | Kyun |
|---|---|---|
| React 18 | UI library | Component-based, spec me explicitly maanga gaya |
| Vite 5 | Dev server + bundler | Fast dev experience, `/api` proxy built-in |
| Tailwind CSS 3 | Styling | Utility-first, dark mode `class` strategy se |
| Custom fonts | IBM Plex Mono + Inter (Google Fonts) | Technical/utility aesthetic — data-readout feel |
| No state library | Plain `useState`/hooks | App chhoti hai, Redux/Zustand ki zaroorat nahi |

### Backend (`server/`)
| Cheez | Kya | Kyun |
|---|---|---|
| Node.js 18+ | Runtime | Spec requirement |
| Express 4 | REST API framework | Spec requirement |
| `axios` | HTTP client | Media metadata fetch karne ke liye (HEAD/GET requests) |
| `helmet` | Security headers | XSS, sniffing, etc. se basic protection |
| `cors` | CORS config | Sirf `CLIENT_URL` se requests allow |
| `express-rate-limit` | Rate limiting | `/analyze` aur `/download` dono pe alag limits |
| `mime-types` | MIME lookup | File extension → content-type |
| `nanoid` | Random ID generation | Download tokens aur request IDs |
| `dotenv` | Env vars | `.env` file load karne ke liye |
| **No database** | — | Sab kuch in-memory (download tokens) — chhoti app ke liye theek hai, production scale pe Redis chahiye hoga |
| **No FFmpeg (abhi tak)** | — | Spec me mention tha, lekin Phase 1-2 me zaroorat nahi padi kyunki hum convert nahi kar rahe, sirf stream/proxy kar rahe hain. Agar aage transcoding chahiye (jaise HLS manifest ko actual MP4 me convert karna), tab FFmpeg add karna padega — niche "Next steps" me likha hai |

---

## 3. Poora folder structure (as of ab)

```
media-downloader/
├── package.json                     # root — concurrently se dono (client+server) chalata hai
├── .env.example                     # env vars template
├── .gitignore
├── README.md                        # quick setup + status
├── HANDOFF.md                       # YE FILE — poora reference
│
├── client/
│   ├── package.json
│   ├── vite.config.js                # dev server + /api proxy to :5000
│   ├── tailwind.config.js            # custom colors (ink/paper/signal), fonts
│   ├── postcss.config.js
│   ├── index.html                    # SEO meta tags, Google Fonts link
│   └── src/
│       ├── main.jsx                  # React entrypoint
│       ├── App.jsx                   # root component — state management yahi hai
│       ├── styles/
│       │   └── index.css             # Tailwind imports + global styles
│       ├── hooks/
│       │   └── useTheme.js           # dark/light mode, localStorage persist
│       ├── services/
│       │   └── api.js                # analyzeUrl(), downloadFormat() — backend calls
│       └── components/
│           ├── Navbar.jsx
│           ├── ThemeToggle.jsx
│           ├── Hero.jsx              # heading + UrlInput + PlatformGrid
│           ├── UrlInput.jsx          # URL paste + Analyze button
│           ├── PlatformGrid.jsx      # supported platform badges (* = limited)
│           ├── LoadingState.jsx      # rotating "Analyzing... / Fetching..." messages
│           ├── ErrorMessage.jsx
│           ├── MediaPreview.jsx      # thumbnail + title + FormatSelector wrapper
│           ├── FormatSelector.jsx    # quality/format/size table + Download button
│           ├── FAQ.jsx               # accordion, spec ke saare 10 questions
│           └── Footer.jsx
│
└── server/
    ├── package.json
    └── src/
        ├── app.js                    # Express app entrypoint — helmet, cors, routes mount
        ├── routes/
        │   └── index.js              # /api/health, /platforms, /analyze, /download (GET+POST)
        ├── controllers/
        │   ├── analyzeController.js  # POST /api/analyze handler
        │   └── downloadController.js # streaming download + validate handlers
        ├── platforms/                # <-- MODULAR ADAPTER SYSTEM (spec ka core requirement)
        │   ├── baseAdapter.js        # BaseAdapter class + PlatformLimitationError — contract
        │   ├── registry.js           # SAB adapters yahi register hote hain (naya add karna ho to bas ek line yaha)
        │   ├── direct.js             # ✅ direct .mp4/.mp3/.jpg URLs — fully working
        │   ├── generic.js            # ✅ koi bhi website — JSON-LD, OG tags, video/audio/img scraping
        │   ├── reddit.js             # ✅ Reddit .json public API — fully working
        │   ├── vimeo.js              # ⚠️ oEmbed se metadata milta hai, download nahi (Vimeo public API limitation)
        │   └── stubAdapters.js       # ⚠️ YouTube/Instagram/Facebook/TikTok/X/Pinterest/TeraBox — honest stubs
        ├── services/
        │   └── downloadTokenStore.js # in-memory token store — create/consume/peek, auto-expiry
        ├── middleware/
        │   ├── requestId.js          # har request ko ek ID deta hai (logging ke liye)
        │   ├── rateLimiters.js       # analyzeLimiter, downloadLimiter
        │   └── errorHandler.js       # koi bhi uncaught error ko safe JSON response me convert karta hai
        └── utils/
            ├── urlSafety.js          # SSRF protection — private IP ranges block karta hai
            └── logger.js             # structured JSON logging, sensitive fields kabhi log nahi karta
```

---

## 4. Data flow (poora request lifecycle)

```
User -> pastes URL -> clicks Analyze
  -> POST /api/analyze { url }
  -> registry.resolveAdapter(url)   [pehla matching adapter jeetta hai]
  -> adapter.analyze(url)            [platform-specific metadata fetch]
  -> har format ke liye createDownloadToken() -> short-lived downloadId
  -> response: { title, thumbnail, type, formats: [{ quality, format, size, downloadId }] }

User -> clicks Download on ek format
  -> GET /api/download/:downloadId/validate   [pehle check — token valid hai?]
  -> agar valid -> <a href="/api/download/:downloadId"> ko click karwate hain
  -> browser khud navigate karke file GET karta hai
  -> server: consumeDownloadToken() [ek-baar-use, turant delete ho jata hai]
  -> adapter.download() -> stream seedha response me pipe hoti hai
  -> browser apna native download UI dikhata hai (progress bar bhi browser ka apna hai)
```

**Important design decision (Phase 2 me change hua)**: Pehle hum fetch()+Blob se poori file
JS memory me buffer kar rahe the, phir download trigger karte the — ye bade files ke liye
risky tha (RAM issue). Ab hum real browser navigation use karte hain (`<a href>` click), jisse
browser khud disk pe stream karta hai, JS kabhi poori file memory me nahi rakhta. Spec ka "prefer
streaming whenever possible" (§7/§9) isi wajah se follow ho raha hai.

---

## 5. Har adapter ka status (honest, exaggerate nahi kiya)

| Platform | Status | Kaise kaam karta hai |
|---|---|---|
| Direct URL (`.mp4`, `.jpg`, etc.) | ✅ SUPPORTED | HEAD request se size/type, phir seedha stream |
| Generic website | ⚠️ SUPPORTED_WITH_LIMITATIONS | JSON-LD, OG tags, `<video>/<audio>/<img>` scraping — depends on target site's HTML |
| Reddit | ✅ SUPPORTED | Reddit ka public `.json` endpoint (koi auth nahi chahiye) |
| Vimeo | ⚠️ SUPPORTED_WITH_LIMITATIONS | oEmbed se sirf title/thumbnail milta hai, actual video file publicly API se resolve nahi hoti |
| YouTube | ⚠️ STUB — clear error deta hai | Reliable extraction ke liye private/changing internal API reverse-engineer karni padegi — ye fragile hai aur YouTube ToS se tension me hai |
| Instagram / Facebook / TikTok / X / Pinterest / TeraBox | ⚠️ STUB | Same reasoning — koi stable public API nahi hai media resolve karne ke liye |

**Ye stubs "fake" nahi hain** — URL detect karte hain sahi se, lekin resolve karne ki koshish
nahi karte, seedha clear error bolte hain. Spec ka §27 explicitly bola tha "fake/mock
functionality mat banao" — isi liye ye approach li gayi hai.

---

## 6. Security jo already implemented hai

- **SSRF protection** (`urlSafety.js`) — localhost, 127.0.0.1, 10.0.0.0/8, 172.16.0.0/12,
  192.168.0.0/16, 169.254.0.0/16, aur DNS-rebinding attacks bhi block karta hai (hostname resolve
  karke actual IP check karta hai, sirf literal IP nahi)
- **Rate limiting** — configurable via env vars, alag-alag `/analyze` aur `/download` ke liye
- **File size limits** — `MAX_FILE_SIZE_MB`, download ke beech me bhi check hota hai (streaming
  ke dauraan)
- **Download timeout** — `MAX_DOWNLOAD_TIME_SECONDS`
- **Single-use download tokens** — ek downloadId sirf ek baar consume ho sakta hai (Phase 2 me
  isko fix kiya — pehle bug tha ki token delete nahi ho raha tha)
- **Filename sanitization** — Content-Disposition header me jaane se pehle
- **Structured logging** — kabhi bhi password/cookie/token log nahi karta
- **Helmet + CORS** — basic security headers, sirf apne frontend origin se requests allow

---

## 7. Environment variables (`.env.example`)

```env
PORT=5000
CLIENT_URL=http://localhost:5173

MAX_FILE_SIZE_MB=2048
MAX_DOWNLOAD_TIME_SECONDS=300

RATE_LIMIT_ANALYZE=10
RATE_LIMIT_DOWNLOAD=5
RATE_LIMIT_WINDOW_MINUTES=1

TEMP_FILE_TTL_MINUTES=15
TEMP_DIR=/tmp/media-downloader
```

---

## 8. Kaise run karein (local machine pe, jaha internet hai)

```bash
cd media-downloader
npm run install:all        # client + server dono ke node_modules install honge
cp .env.example server/.env
npm run dev                 # server (:5000) + client (:5173) dono ek saath
```

**Important**: is sandbox me network disabled hai, isliye main khud live test nahi kar paya
(`npm install` yaha kaam nahi karta). Maine har file `node --check` se syntax-validate ki hai,
lekin tumhe apne machine pe ek baar real run karke dekhna chahiye ki sab theek chal raha hai.

---

## 9. Baaki kya bacha hai (Phase 3, 4, 5 — original spec §28 ke hisaab se)

### Phase 3 — Platform adapters (jitna realistically ho sake)
- YouTube/Instagram/etc. ke liye agar tum chaho to koi **official API** integrate kar sakte ho
  (jaise YouTube Data API v3 — sirf metadata milega, download nahi; Instagram Graph API — sirf
  apne khud ke content ke liye). Ye ToS-compliant hoga lekin pura "kisi bhi video ko download karo"
  wala use-case cover nahi karega.
- Agar tum ek self-hosted tool (jaise `yt-dlp`) ko backend se call karna chahte ho, wo ek
  alag conversation hai — us route me ToS aur legal risk dono important considerations hain,
  isliye maine khud se wo implement nahi kiya. Tumhe explicitly decide karna hoga agar aage
  badhna hai.

### Phase 4 — Security hardening (bacha hua)
- CAPTCHA/bot protection (abhi sirf rate-limiting hai)
- IP-based abuse tracking beyond basic rate-limit (jaise persistent ban list)
- Automated cleanup job for `/tmp/media-downloader/` (abhi zaroorat nahi kyunki sab kuch stream
  hota hai, files disk pe save nahi hoti — lekin agar FFmpeg add hua to ye zaroori hoga)

### Phase 5 — Polish & deployment
- SEO landing pages: `/youtube-downloader`, `/instagram-downloader`, etc. (abhi sirf homepage hai)
- `robots.txt`, `sitemap.xml`
- Docker (`Dockerfile`, `docker-compose.yml`, `.dockerignore`) — spec §23
- Automated tests (URL detection, security/SSRF, API contract) — spec §22
- Production deployment config for Vercel/Netlify (client) + Render/Railway/Fly.io (server)

---

## 10. Agar mera session/limit yahi khatam ho jaye, to next Claude/dev is tarah continue kare

1. Is `HANDOFF.md` ko pura padhe.
2. `server/src/platforms/registry.js` dekhe — yahi single source of truth hai kaunse adapters
   active hain.
3. Naya platform adapter add karna ho to: `baseAdapter.js` ka interface implement karo, naya file
   `platforms/` me banao, `registry.js` me ek line add karo — bas. Koi aur file touch nahi karni
   padegi (ye spec ka explicit requirement tha, follow kiya gaya hai).
4. Phase 3/4/5 me se jo bhi priority ho, upar wali list follow karo.
5. Zip file me se poora code already available hai — bas `npm run install:all` chala ke shuru
   karo.
