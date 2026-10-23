# E2E Test Infra: Live Clinic Queue Tracker

## Test Philosophy
- Opaque-box, requirement-driven. Derived from `ORIGINAL_REQUEST.md` and user-facing specifications.
- No dependency on internal implementation design; tests interact via public HTTP endpoints, SSE streams, and system commands.
- Methodology: Category-Partition + Boundary Value Analysis (BVA) + Pairwise Combinatorial Testing + Real-World Workload Testing.

## Feature Inventory Coverage
| # | Feature ID | Feature Name | Source (Requirement) | Tier 1 | Tier 2 | Tier 3 |
|---|------------|--------------|----------------------|:------:|:------:|:------:|
| 1 | F01 | Multi-Clinic Credentials & Config | ORIGINAL_REQUEST R1, R3 | 5 | 5 | ✓ |
| 2 | F02 | Dedicated Clinic Staff Authentication | ORIGINAL_REQUEST R1, AC | 5 | 5 | ✓ |
| 3 | F03 | Unauthenticated Mutation Protection | ORIGINAL_REQUEST AC | 5 | 5 | ✓ |
| 4 | F04 | Multi-Clinic State Isolation | ORIGINAL_REQUEST R3, AC | 5 | 5 | ✓ |
| 5 | F05 | Queue Operation State Machine | ORIGINAL_REQUEST R1 | 5 | 5 | ✓ |
| 6 | F06 | Atomic Disk Persistence Engine | ORIGINAL_REQUEST R3, R4, AC | 5 | 5 | ✓ |
| 7 | F07 | REST API Endpoints | ORIGINAL_REQUEST R1, R3 | 5 | 5 | ✓ |
| 8 | F08 | Real-Time SSE Broadcasting Engine | ORIGINAL_REQUEST R2, AC | 5 | 5 | ✓ |
| 9 | F09 | Doctor Consultation Status Management | ORIGINAL_REQUEST R1, R2 | 5 | 5 | ✓ |
| 10 | F10 | Dual-Mode Repository Abstraction | ORIGINAL_REQUEST R4 | 5 | 5 | ✓ |
| 11 | F11 | Nurse Controller Layout & Touch UI | ORIGINAL_REQUEST R1, AC | 5 | 5 | ✓ |
| 12 | F12 | Reset Safety Confirmation | ORIGINAL_REQUEST R1 | 5 | 5 | ✓ |
| 13 | F13 | Clinic QR Code Display & Copyable Link | ORIGINAL_REQUEST R1 | 5 | 5 | ✓ |
| 14 | F14 | Printable Clinic Placard / Poster | ORIGINAL_REQUEST R1 | 5 | 5 | ✓ |
| 15 | F15 | Nurse Controller Keyboard Shortcuts | ORIGINAL_REQUEST R1 | 5 | 5 | ✓ |
| 16 | F16 | Zero-Login Mobile Patient View | ORIGINAL_REQUEST R2, AC | 5 | 5 | ✓ |
| 17 | F17 | Patient Live Serving Number Display | ORIGINAL_REQUEST R2, AC | 5 | 5 | ✓ |
| 18 | F18 | Doctor Status Live Display | ORIGINAL_REQUEST R2 | 5 | 5 | ✓ |
| 19 | F19 | "Check My Wait" Calculator | ORIGINAL_REQUEST R2 | 5 | 5 | ✓ |
| 20 | F20 | Local Ticket Memory | ORIGINAL_REQUEST R2 | 5 | 5 | ✓ |
| 21 | F21 | Dual-Stage Web Audio Chime Alerts | ORIGINAL_REQUEST R1, R2, AC | 5 | 5 | ✓ |
| 22 | F22 | Visual & Vibration Alerts | ORIGINAL_REQUEST R2 | 5 | 5 | ✓ |
| 23 | F23 | Single-Command Local Run Pipeline | ORIGINAL_REQUEST R4 | 5 | 5 | ✓ |
| 24 | F24 | 100% Free Hosting Deployment Pipeline | ORIGINAL_REQUEST R4, AC | 5 | 5 | ✓ |

## Test Architecture
- Test Runner: Node.js native test runner via `node --test tests/**/*.test.js` or `npm test`
- Pass/Fail Semantics: Exit code 0 on all tests passing, non-zero on failure
- Directory Layout:
  `tests/`
  ├── `e2e_runner.js`
  ├── `tier1_feature_tests.test.js`
  ├── `tier2_boundary_tests.test.js`
  ├── `tier3_isolation_tests.test.js`
  └── `tier4_workload_tests.test.js`

## Real-World Application Scenarios (Tier 4)
| # | Scenario | Features Exercised | Complexity |
|---|----------|--------------------|------------|
| 1 | Full Clinic Morning Rush (100 patients, concurrent arrivals, doctor status switches) | F01, F04, F05, F07, F08, F09, F17, F19 | High |
| 2 | Multi-Clinic Concurrent Cross-Traffic (Pediatrics, Cardiology, Dental active simultaneously) | F01, F02, F03, F04, F07, F08 | High |
| 3 | Sudden Server Crash & Reboot State Preservation (Durability & Recovery) | F04, F05, F06, F23 | High |
| 4 | Patient Journey (Scan QR -> Wait Calculator -> 2 spots alert -> Called chime) | F13, F16, F17, F19, F20, F21, F22 | Medium |
| 5 | Unauthorized Tampering & Attack Resistance (Invalid tokens, cross-clinic forgery, rapid spam) | F02, F03, F04, F07 | High |

## Coverage Thresholds
- Tier 1: ≥5 per feature (24 features × 5 = ≥120 tests)
- Tier 2: Boundary & Corner Cases (≥5 per critical feature)
- Tier 3: Cross-Feature Interactions & Multi-Clinic Pairwise Isolation
- Tier 4: ≥5 realistic application scenarios
