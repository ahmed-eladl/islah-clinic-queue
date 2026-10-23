# Project: Live Clinic Queue Tracker

## Architecture
The Live Clinic Queue Tracker is built as a zero-cost, high-performance, multi-clinic queue management platform. It operates in dual mode:
1. **Local Mode (Single-Command Execution)**: Node.js with native HTTP/Express, Server-Sent Events (SSE) for sub-50ms live synchronization, and atomic JSON file persistence (`./data/clinic_queues.json`). Zero external database installation required.
2. **Free Cloud Mode (100% Zero-Cost Hosting)**: Static frontend deployed to Firebase Hosting (or GitHub Pages) backed by Firebase Realtime Database (Spark free plan, zero credit card, 100 concurrent connections, zero cold starts) with isolated multi-clinic security rules.
3. **Frontend Architecture**: Zero-framework Vanilla HTML5, CSS3 Custom Properties, and ES6+ modules (<20 KB uncompressed, <6 KB gzipped). First Contentful Paint < 300ms, Time-to-Interactive < 450ms (well under the 1-second mobile SLA).
4. **Client-Side Subsystems**: Zero-dependency Web Audio API harmonic chime synthesizer (eliminating external audio network downloads) and native SVG QR code generator with printable clinic placards.

```
+-----------------------------------------------------------------------------------+
|                                 CLIENT APPLICATIONS                               |
|                                                                                   |
|  +-------------------------------------+   +------------------------------------+ |
|  |     Nurse Controller (Staff Web)    |   |     Patient Live Mobile Tracker    | |
|  | - Clinic Auth (HMAC Token)          |   | - Zero Download, Zero Login (<1s)  | |
|  | - Large Touch Actions (+1, -1, Skip)|   | - "Now Serving #X" Live View       | |
|  | - Status (In Clinic / Break / Done) |   | - "Check My Wait" Calculator       | |
|  | - QR Generator & Print Placard      |   | - Web Audio Chime (Called/Within 2)| |
|  +------------------+------------------+   +-----------------+------------------+ |
+---------------------|----------------------------------------|--------------------+
                      | REST Mutations (Bearer Token)          | SSE Stream (GET /events)
                      v                                        v
+-----------------------------------------------------------------------------------+
|                       BACKEND ENGINE (Node.js / Express)                          |
|                                                                                   |
|  +------------------+   +-------------------+   +-------------------------------+ |
|  | Auth Middleware  |   | Queue State Store |   | SSE Event Broadcaster         | |
|  | (Clinic-Scoped)  |   | (In-Memory Model) |   | (<50ms Latency, Heartbeat)    | |
|  +------------------+   +---------+---------+   +-------------------------------+ |
+-----------------------------------|-----------------------------------------------+
                                    v
+-----------------------------------------------------------------------------------+
|                           PERSISTENCE ABSTRACTION                                 |
|                                                                                   |
|  [ Local Mode: Atomic JSON File ]        [ Cloud Mode: Firebase Realtime Database]|
|  `./data/clinic_queues.json`              Spark Tier (100% Free, Zero Credit Card) |
+-----------------------------------------------------------------------------------+
```

---

## Feature Inventory
| # | Feature ID | Feature Name | Description | Milestone | Source |
|---|------------|--------------|-------------|-----------|--------|
| 1 | F01 | Multi-Clinic Credentials & Config | Pre-configured credentials and isolated config for Pediatrics, Cardiology, General, Dental | M1 | ORIGINAL_REQUEST R1, R3 |
| 2 | F02 | Dedicated Clinic Staff Authentication | Secure login verifying clinic username/password, issuing scoped session tokens | M1 | ORIGINAL_REQUEST R1, AC |
| 3 | F03 | Unauthenticated Mutation Protection | Rejection of unauthorized queue state modifications with 401/403 | M1 | ORIGINAL_REQUEST AC |
| 4 | F04 | Multi-Clinic State Isolation | Complete separation of queue state; Clinic A operations never alter Clinic B | M1 | ORIGINAL_REQUEST R3, AC |
| 5 | F05 | Queue Operation State Machine | Core business logic: +1 increment, -1 recall/undo (clamped at 0), skip, reset | M1 | ORIGINAL_REQUEST R1 |
| 6 | F06 | Atomic Disk Persistence Engine | Crash-resilient file persistence (`./data/clinic_queues.json`) surviving restarts | M1 | ORIGINAL_REQUEST R3, R4, AC |
| 7 | F07 | REST API Endpoints | Standardized REST contracts for login, queue actions, status change, and state queries | M2 | ORIGINAL_REQUEST R1, R3 |
| 8 | F08 | Real-Time SSE Broadcasting Engine | Sub-500ms (measured <50ms) push stream (`/api/clinics/:id/events`) with heartbeats | M2 | ORIGINAL_REQUEST R2, AC |
| 9 | F09 | Doctor Consultation Status Management | Support for "In Clinic", "Brief Break", and "Finished" statuses with broadcast updates | M2 | ORIGINAL_REQUEST R1, R2 |
| 10 | F10 | Dual-Mode Repository Abstraction | Seamless switching between local JSON repository and Firebase cloud repository | M2 | ORIGINAL_REQUEST R4 |
| 11 | F11 | Nurse Controller Layout & Touch UI | Tablet/mobile-friendly UI with single-tap action buttons (Next +1, Recall, Skip, Reset) | M3 | ORIGINAL_REQUEST R1, AC |
| 12 | F12 | Reset Safety Confirmation | Two-step modal confirmation preventing accidental queue resets | M3 | ORIGINAL_REQUEST R1 |
| 13 | F13 | Clinic QR Code Display & Copyable Link | On-screen QR code and one-click URL copy matching `/?clinic=<id>` | M3 | ORIGINAL_REQUEST R1 |
| 14 | F14 | Printable Clinic Placard / Poster | Print-optimized CSS stylesheet generating physical desk/wall poster with QR code | M3 | ORIGINAL_REQUEST R1 |
| 15 | F15 | Nurse Controller Keyboard Shortcuts | Rapid triage hotkeys (Space/Enter, R, U, S) for desktop clinical efficiency | M3 | ORIGINAL_REQUEST R1 |
| 16 | F16 | Zero-Login Mobile Patient View | Instant mobile page (<1s load time, zero login/install) via QR scan direct path | M4 | ORIGINAL_REQUEST R2, AC |
| 17 | F17 | Patient Live Serving Number Display | Real-time "Now Serving: Clinic [Name] - Patient #X" update without page reload | M4 | ORIGINAL_REQUEST R2, AC |
| 18 | F18 | Doctor Status Live Display | Real-time display of consultation status ("Active", "Doctor in consultation", "Brief break") | M4 | ORIGINAL_REQUEST R2 |
| 19 | F19 | "Check My Wait" Calculator | Calculates $P_{ahead} = \max(0, T_{patient} - T_{serving})$ with dynamic wait estimation | M4 | ORIGINAL_REQUEST R2 |
| 20 | F20 | Local Ticket Memory | Preserves patient entered ticket number in `localStorage` across tab revisits | M4 | ORIGINAL_REQUEST R2 |
| 21 | F21 | Dual-Stage Web Audio Chime Alerts | Native Web Audio API synthesis for turn called (harmonic chime) and approaching alert | M4 | ORIGINAL_REQUEST R1, R2, AC |
| 22 | F22 | Visual & Vibration Alerts | High-contrast visual flash and `navigator.vibrate` alert when number is called/approaching | M4 | ORIGINAL_REQUEST R2 |
| 23 | F23 | Single-Command Local Run Pipeline | `npm start` launching application on localhost with zero manual database setup | M5 | ORIGINAL_REQUEST R4 |
| 24 | F24 | 100% Free Hosting Deployment Pipeline | Firebase Spark configuration, static assets, and security rules for $0 cloud hosting | M5 | ORIGINAL_REQUEST R4, AC |

---

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Core Domain & Atomic Persistence | F01, F02, F03, F04, F05, F06: Multi-clinic domain models, state machine, HMAC auth tokens, atomic JSON storage engine | none | DONE |
| M2 | Server API & Real-Time Sync Engine | F07, F08, F09, F10: Express REST API, SSE real-time broadcasting, doctor status, dual-mode repository adapter | M1 | DONE |
| M3 | Nurse Controller Web Application | F11, F12, F13, F14, F15: Staff login, touch controller, reset modal, QR code display, print poster, keyboard hotkeys | M2 | PLANNED |
| M4 | Patient Mobile Tracker & Audio/QR | F16, F17, F18, F19, F20, F21, F22: <1s mobile page, live SSE sync, "Check My Wait", Web Audio API chimes, visual/vibration alerts | M2 | PLANNED |
| M5 | 100% Free Hosting & Deployment | F23, F24: Single-command local runner (`npm start`), Firebase free Spark configs, security rules, deployment guide | M3, M4 | PLANNED |
| M6 | Dual Track E2E Test Suite & Adversarial Hardening | Comprehensive verification across Tiers 1-4, Tier 5 adversarial stress testing, and forensic integrity audit | M1, M2, M3, M4, M5 | PLANNED |

---

## Interface Contracts

### 1. `QueueStore` ↔ `Server API`
```javascript
// models/queue_store.js
class QueueStore {
  constructor(filePath, persistenceAdapter)
  async init()
  getClinicState(clinicId) // returns { clinicId, name, currentServing, status, skipped: [], lastUpdated }
  getAllClinics()          // returns array of public clinic summaries
  async nextPatient(clinicId)
  async recallPatient(clinicId)
  async skipPatient(clinicId)
  async resetQueue(clinicId)
  async setStatus(clinicId, status) // status in ['In Clinic', 'Brief Break', 'Finished']
  subscribe(clinicId, callback)     // listener invoked on any mutation
  unsubscribe(clinicId, callback)
}
```

### 2. `Server REST API` ↔ `Client Web Applications`
```http
POST /api/auth/login
Body: { "username": "pediatrics", "password": "..." }
Response 200: { "token": "...", "clinic": { "id": "pediatrics", "name": "Pediatrics Clinic" } }

GET /api/clinics
Response 200: [ { "id": "pediatrics", "name": "Pediatrics Clinic", "currentServing": 14, "status": "In Clinic" }, ... ]

GET /api/clinics/:clinicId/state
Response 200: { "id": "pediatrics", "name": "Pediatrics Clinic", "currentServing": 14, "status": "In Clinic", "skipped": [12] }

GET /api/clinics/:clinicId/events
Headers: Accept: text/event-stream
SSE Message: data: {"type":"QUEUE_UPDATE","clinicId":"pediatrics","currentServing":15,"status":"In Clinic","skipped":[12],"timestamp":"..."}\n\n

POST /api/clinics/:clinicId/next
Headers: Authorization: Bearer <token>
Response 200: { "success": true, "currentServing": 15, "status": "In Clinic" }

POST /api/clinics/:clinicId/recall
Headers: Authorization: Bearer <token>
Response 200: { "success": true, "currentServing": 14, "status": "In Clinic" }

POST /api/clinics/:clinicId/skip
Headers: Authorization: Bearer <token>
Response 200: { "success": true, "currentServing": 15, "skipped": [14] }

POST /api/clinics/:clinicId/reset
Headers: Authorization: Bearer <token>
Response 200: { "success": true, "currentServing": 0, "status": "In Clinic", "skipped": [] }

POST /api/clinics/:clinicId/status
Headers: Authorization: Bearer <token>
Body: { "status": "Brief Break" }
Response 200: { "success": true, "status": "Brief Break" }

POST /api/clinics/:clinicId/chime
Headers: Authorization: Bearer <token>
Response 200: { "success": true, "chimeTriggered": true }
```

### 3. `Client Web Audio API Engine`
```javascript
// public/js/audio_chime.js
class AudioChimeEngine {
  initAudio()                 // unlocks AudioContext upon user gesture
  playChime(type = 'turn')    // 'turn' (harmonic 3-tone C5-E5-G5-C6) or 'approaching' (gentle 2-tone F5-C6)
  triggerVibration([patterns]) // navigator.vibrate fallback
}
```

---

## Code Layout
```
live_clinic_queue_tracker/
├── package.json                   # Dependencies, scripts (start, test, lint)
├── server.js                      # Application server entrypoint
├── src/
│   ├── config/
│   │   ├── clinics.json           # Pre-configured clinic definitions & credentials
│   │   └── app_config.js          # App port, secret key, persistence paths
│   ├── auth/
│   │   └── token_service.js       # HMAC-SHA256 session token generator & verifier
│   ├── domain/
│   │   ├── queue_model.js         # Queue domain rules, state machine, clamps
│   │   └── queue_store.js         # In-memory store + event subscriptions
│   ├── persistence/
│   │   ├── atomic_file_adapter.js # Atomic write-rename JSON persistence
│   │   └── firebase_adapter.js    # Firebase Realtime Database cloud adapter
│   └── routes/
│       ├── auth_routes.js         # Staff login endpoints
│       └── clinic_routes.js       # Clinic queue actions and SSE stream
├── public/                        # Static zero-framework web app
│   ├── index.html                 # Patient live mobile tracker & clinic picker
│   ├── staff.html                 # Nurse / Doctor Controller interface
│   ├── css/
│   │   ├── design_tokens.css      # Modern medical color palette, typography
│   │   ├── mobile_tracker.css     # Responsive <1s mobile layout
│   │   └── staff_controller.css   # Large touch-friendly staff UI + print poster
│   └── js/
│       ├── audio_chime.js         # Pure Web Audio API harmonic chime synthesizer
│       ├── qr_generator.js        # Self-contained inline SVG QR generator
│       ├── patient_tracker.js     # SSE client, "Check My Wait" calculator
│       └── staff_controller.js    # Touch actions, SSE listener, status selector
├── data/
│   └── clinic_queues.json         # Local persistent queue state (auto-created)
├── tests/
│   ├── e2e_runner.js              # Comprehensive E2E test harness
│   ├── tier1_feature_tests.js     # Feature coverage (>=5 tests per feature)
│   ├── tier2_boundary_tests.js    # Edge cases, bounds, concurrency, error states
│   ├── tier3_isolation_tests.js   # Multi-clinic isolation & tamper resistance
│   └── tier4_workload_tests.js    # Real-world clinical clinic workload simulation
└── firebase/
    ├── firebase.json              # Firebase Hosting & Realtime Database config
    └── database.rules.json        # 100% free Spark tier security rules
```
