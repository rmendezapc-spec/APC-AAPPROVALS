# APC Deal Approval Board — Build Handoff

<!-- no-op touch commit #3: retrying per GitHub's 22:18 UTC update (workflow success rate up to 97%, though Pages specifically is still flagged as possibly affected). -->

**For:** Claude Code (continuing this build)
**From:** Prior session with Claude (chat interface)
**Repo:** `rmendezapc-spec/APC-AAPPROVALS` (public, GitHub Pages)
**Live URL:** `https://rmendezapc-spec.github.io/APC-AAPPROVALS/`
**File:** Single self-contained `index.html` at repo root (no build step, no framework, vanilla JS)

---

## 1. What this tool is

An internal web app for APC's residential sales team. Sales reps submit deals with a
full cost breakdown and job-site details. Two named managers — **Connor** and **Sandy**
— must both approve a deal before it's considered approved. Everyone (reps + both
managers) is meant to see the same shared list, from their own phone or laptop.

**Deployment model (established/preferred pattern for this team's internal tools):**
single HTML file → GitHub Pages → team members add the URL to their phone home screen
(pseudo-PWA, no app store, no build pipeline).

---

## 2. Current status — READ THIS FIRST

**The one thing that is NOT confirmed working: data persistence.**

The app is wired to Firebase Firestore, but live testing on the deployed GitHub Pages
site has repeatedly shown deals disappearing on refresh, and a red error banner
("Something went wrong saving your last change"). This has **not been root-caused yet**.
Everything else in this document is solid and tested; this is the priority.

### What we know so far
- The Firebase project (`apc-approvals`) and a web app registration (`Deal Board`) exist
  and were created successfully — confirmed via Firebase console screenshots.
- Whether **Firestore Database** was actually created (vs. just navigated toward) is
  **unconfirmed** — the last screenshot in this handoff's source conversation was mid­
  navigation to Build → Firestore Database → Data tab, and we never got a follow-up
  screenshot showing an actual database + collection.
- Browser Network tab (filtered to `firestore`) shows a stream of `channel?VER=8...`
  requests all returning HTTP 200 — but this is a red herring: Firestore uses a
  long-lived streaming ("webchannel") connection, so a 200 status on the outer HTTP
  request does NOT mean the actual read/write operation inside the stream succeeded.
  Permission errors, missing-database errors, etc. get delivered as messages inside
  that stream, invisible at the Network-tab-status-code level.
- Browser Console tab, as screenshotted, only showed noise from an unrelated browser
  extension (a "CTI EXTENSION" / Dialpad content script) — no actual app errors have
  been captured yet. There was a "1 hidden" indicator next to Issues that was never
  successfully expanded/inspected.
- This was never tested end-to-end from the building side either: the sandboxed dev
  environment used to build this (Claude's code execution tool) has an egress allowlist
  that does **not** include `gstatic.com` or Firebase's API domains, so a real
  save/load round-trip to Firestore has never been observed succeeding, only verified
  to fail *gracefully* (no crash, correct fallback error state) when the network call
  is blocked.

### Recommended next diagnostic steps (in order)
1. **Confirm the database exists.** Firebase console → left sidebar → "Databases &
   Storage" → "Firestore Database" → **Data** tab. If this shows a "Create database"
   prompt instead of a data browser, that's the whole bug — Firestore was never
   actually provisioned, only clicked toward.
2. **If it exists:** submit a test deal on the live site, then refresh the Firestore
   Data tab (not the app). Look for collection `apcDealBoard` → document `deals`. If
   it's not there, writes are failing before they reach the server — check:
   - Firestore **Rules** tab — confirm test-mode rules are active and not expired
     (test mode expires 30 days after creation and then denies everything).
   - Browser console, this time actually filtered to show Errors (default level
     filters can hide `console.error()` output in some DevTools configurations —
     make sure "Errors" isn't unchecked in the level dropdown).
3. **If the document IS there but the app still shows nothing on refresh:** the bug is
   in the app's read/subscribe path, not Firestore itself — check
   `window.__firebaseSubscribe` wiring (see §5 below) and confirm `onSnapshot` is
   actually firing (add a temporary `console.log` inside it if needed).
4. Also sanity-check: is this being tested on a work computer/network with a firewall
   that might block Google's Firestore endpoints specifically? Worth ruling out.

---

## 3. Feature list — status of each

| Feature | Status |
|---|---|
| Submit deal w/ full cost breakdown | ✅ Done, tested |
| Grouped, renamable cost sections + free line items | ✅ Done, tested |
| BuilderTrend-style per-line columns (Qty, Unit, Unit Cost, Cost Type, Markup %, Unit Price, Builder Cost, Client Price, Margin %, Profit $) | ✅ Done, tested |
| Editable Margin % that back-solves Markup % (and vice versa) | ✅ Done, tested |
| Section subtotals + deal grand totals | ✅ Done, tested |
| Job site specifics (structured fields + free text) | ✅ Done |
| Dual approval (Connor + Sandy, both required) with per-approver reject reason | ✅ Done, tested |
| Status stamps (Pending / Approved / Rejected) + filter tabs | ✅ Done |
| Photo attachments, client-side compressed before saving | ✅ Done, tested locally (compression pipeline verified with a 5MB test image → ~500KB) |
| Passphrase gate (`PLUTUS`) | ✅ Done — **not real security**, see §6 |
| Dark / light theme toggle, persisted | ✅ Done, tested |
| Auto / Mobile / Web forced layout toggle, persisted | ✅ Done, tested |
| Wide desktop layout (uses up to ~1500px, was capped at 1080px) | ✅ Done |
| **Shared real-time data across team (Firebase Firestore)** | ⚠️ **Wired in, but unverified — see §2** |
| Permanent Firestore security rules (replacing test mode) | ❌ Not started — test mode expires 30 days after project creation |
| Private GitHub repo | ❌ Not started — repo is currently Public; team was checking for a paid GitHub plan (Team/Enterprise) that supports private + Pages; no confirmation yet |

---

## 4. Data model

All deals live in a single JS array `deals`, persisted (intended) as one Firestore
document. Shape of one deal object:

```js
{
  id: "deal_<timestamp>_<rand>",
  customerName: "",
  address: "",
  repName: "",
  date: "YYYY-MM-DD",
  jobSite: {
    propertyType: "",       // one of PROPERTY_TYPES
    accessDifficulty: "",   // one of ACCESS_OPTIONS
    notes: ""
  },
  sections: [
    {
      id: "sec_...",
      name: "General Requirements",   // renamable; sections addable/removable
      items: [
        {
          id: "item_...",
          desc: "",
          qty: 1,
          unit: "each",
          unitCost: 0,
          costType: "Material",       // one of COST_TYPES
          markupPercent: 25           // drives Unit Price / Client Price / Profit / Margin
        }
      ]
    }
  ],
  attachments: [
    { id: "att_...", name: "photo.jpg", dataUrl: "data:image/jpeg;base64,...", addedAt: 169... }
  ],
  approvals: { connor: null, sandy: null },     // true = approved, false = rejected, null = pending
  rejectReasons: { connor: "", sandy: "" },
  createdAt: 169...
}
```

**Constants (top of script):**
```js
COST_TYPES      = ['Labor','Material','Subcontractor','Equipment','Other','None']
PROPERTY_TYPES  = ['Single-Family','Multi-Family','New Construction','Remodel / Addition','Commercial']
ACCESS_OPTIONS  = ['Easy — full access','Moderate — some restrictions','Difficult — tight / crane needed']
DEFAULT_SECTIONS = ['General Requirements','Labor & Installation','Materials & Products','Mobilization']
```

**Per-line-item math** (function `itemCalc(item)`):
```
builderCost = qty * unitCost
unitPrice   = unitCost * (1 + markupPercent/100)
clientPrice = qty * unitPrice
profit      = clientPrice - builderCost
margin      = profit / clientPrice * 100   (0 if clientPrice is 0)
```
Editing **Margin %** directly (function `App.updateItemMargin`) back-solves the
required `markupPercent` to hit that margin, then re-derives everything else from it —
so `markupPercent` is always the single source of truth stored on the item; margin is
just an alternate way to edit it.

Section/deal totals are simple sums of `builderCost`, `clientPrice`, `profit` across
items/sections, with an aggregate margin recomputed from the summed profit/clientPrice
(not averaged).

**Deal status** (function `dealStatus`):
- `rejected` if either approver's value is `false`
- `approved` if both are `true`
- otherwise `pending`

---

## 5. Firebase wiring (as currently implemented)

Firebase config (public — this is normal for Firebase web apps; it is not a secret,
security comes from Firestore Rules, not from hiding this):

```js
{
  apiKey: "AIzaSyDDHjIX-V_DwizD85TzwvcjuDPu1lMZoSc",
  authDomain: "apc-approvals.firebaseapp.com",
  projectId: "apc-approvals",
  storageBucket: "apc-approvals.firebasestorage.app",
  messagingSenderId: "170502222959",
  appId: "1:170502222959:web:2a9b4345c3ac9bef8b099a",
  measurementId: "G-X2P3DWF9DD"
}
```

Loaded via CDN ES modules (no npm/build step):
```
https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js
https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js
```

**Storage model:** the ENTIRE `deals` array is stored as a JSON string in a single
document: `apcDealBoard/deals` (collection `apcDealBoard`, document ID `deals`, field
`data` = `JSON.stringify(deals)`, field `updatedAt` = timestamp).

This is intentionally simple (matches the original "everyone shares one list" model)
but is a known scaling limitation — see §7.

**Two exposed bridge functions** (module script sets these on `window` so the classic
script can call them):
- `window.__firebaseSaveDeals(dealsArray)` → `setDoc(...)`, returns `true`/`false`
- `window.__firebaseSubscribe(callback)` → `onSnapshot(...)`, fires immediately with
  current data and again on every change (real-time sync across devices)

**Classic-script side:**
- `saveDeals()` — calls `window.__firebaseSaveDeals`, sets `storageError` flag if it
  fails or if the bridge function doesn't exist (e.g., module failed to load), then
  re-renders (the red banner is driven by `storageError`)
- `subscribeToDealsOnce()` — wraps `window.__firebaseSubscribe` in a Promise that
  resolves after the first snapshot, so `initApp()` can show a loading state and then
  render real data on first paint, while continuing to receive live updates after that

**A fixed bug worth knowing about:** the passphrase-gate check
(`checkGateOnLoad`) originally ran as an immediately-invoked function at parse time,
which could call `initApp()` (defined in a later `<script>` block) *before that block
had executed* — a real bug that would've broken the app for anyone reopening it after
already unlocking once (i.e., every returning user). Fixed by moving the check into a
`DOMContentLoaded` listener, which guarantees all script blocks have run first. This is
already fixed in the current file — flagging so it isn't accidentally reintroduced.

---

## 6. Security posture (current, intentionally lightweight)

- **Passphrase gate** (`PLUTUS`): a plain string compared in client-side JS, unlock
  state stored in `localStorage`. This is a *deterrent*, not real security — anyone
  who views page source sees the passphrase immediately. It exists only to keep casual
  /accidental visitors out, not to protect sensitive data from a motivated person.
- **Firestore rules**: currently in **test mode** (open read/write to anyone, expires
  30 days after project creation). After that, the app will silently stop saving
  entirely unless real rules are set. This is a ticking clock — worth fixing well
  before the 30-day mark, not after.
- **GitHub repo**: currently **Public**. Team was exploring whether they have access to
  a paid GitHub plan (Team/Enterprise) that would allow a private repo + GitHub Pages
  together (GitHub Free cannot serve Pages from a private repo). No resolution yet.
  Note even on a private repo, the *published Pages URL itself* is still a plain public
  web link once live — private repo only restricts who can see the source code on
  GitHub, not who can load the deployed page.
- Given the above, treat this as: reasonable for an internal tool with trusted users
  who have the link, NOT appropriate yet for data the business would consider
  seriously confidential (real client PII beyond what's already fairly public, etc.).

**Update — Microsoft sign-in added, then made the only login path.** Several
rounds of work since the paragraphs above superseded most of them (real
per-deal Firestore documents, a `users` collection with name/email/role
instead of a single shared passphrase, and real Firestore Rules instead of
test mode — see `firestore.rules` in this repo, which is the actual reference
copy pasted into Firebase Console). The remaining real gap was #3 below: no
verified identity, just a client-side check. That's now fully addressed —
both `index.html` and `sales-report.html` sign in **only** via **"Sign in
with Microsoft"**, using Firebase Auth's Microsoft/OAuth provider restricted
to the American Precast Concrete Entra ID tenant (single sign-in flow shared
by both pages, since they're the same Firebase project and persist the same
session). Each `users` document has an `email` field (editable in Manage
Users) that Microsoft sign-in matches against to resolve who's logged in. A
`viewer` role exists alongside `rep`/`admin`/`approver` for people who need to
see every deal, comment, and download scopes/estimates, but shouldn't start
new deals (e.g. PM/Production Manager, Project Coordinator).

An interim PIN-login fallback existed briefly (so nobody would be locked out
while Microsoft sign-in was still being proven reliable) but has since been
retired app-side — this was a deliberate call made while the tool was still
in testing, not yet rolled out company-wide, so the blast radius of anything
going wrong was small. Firestore Rules now require a real, non-anonymous
Microsoft session (`isRealUser()`) for every collection except read access on
`users` and the three `salesReport*` collections, which stay open to
anonymous sessions on purpose (the pre-login roster bootstrap, and the Sales
Report's no-login-required viewing — see the comment block at the top of
`firestore.rules`). The `pin` field itself is still present (unused) on
existing `users` documents — nothing reads or writes it anymore, and new
accounts are created without one.

**Residual items, in order of what's left**:
1. The "Anonymous" sign-in provider is still enabled in Firebase Console —
   intentionally, since it still serves the two read-only cases above. Fully
   disabling it is possible but would also remove those two read paths; see
   the tradeoff noted in `firestore.rules`' top comment before flipping it.
2. `isAdminOrApproverEmail()` in `firestore.rules` is a hardcoded email list,
   not a live lookup — adding/removing an admin or approver in Manage Users
   changes what the *app* shows immediately, but doesn't change who Firestore
   actually trusts as one until this list is manually updated and re-pasted
   into Firebase Console. Keep these in sync by hand.
3. Stale `pin` field values remain in Firestore on accounts created before
   this round — harmless (nothing reads them), but worth a one-time cleanup
   if that data hygiene ever matters.

---

## 7. Known limitations / good candidates for Claude Code to improve

1. **Single monolithic Firestore document.** All deals share one document
   (`apcDealBoard/deals`), rewritten in full on every save. Firestore documents cap at
   1MB. With photo attachments stored inline as base64 (see #2), this ceiling could be
   hit faster than expected. A proper fix: one Firestore document per deal (a
   `deals` *collection* with each deal as its own doc), which also fixes the "last
   write wins, whole list" concurrency issue.
2. **Attachments stored as inline base64 inside Firestore documents**, not in real
   file storage. This was a deliberate tradeoff: Firebase *Storage* (proper file
   hosting) requires upgrading to the "Blaze" pay-as-you-go plan, which requires a
   credit card on file even though usage would stay in the free tier. The team wanted
   to avoid that, so photos are resized/compressed client-side (max 1280px, JPEG
   quality 0.72) and stored as data URLs directly in the deal record instead. Works,
   but doesn't scale indefinitely — true document uploads (PDFs etc.) aren't supported
   this way at all (1MB doc cap), only photos.
3. ~~No real user identity/auth.~~ **Addressed** — see the Microsoft sign-in update
   in §6 above. Approving/rejecting is still just "whoever is logged into that
   approver's seat," which is correct by design (Connor and Sandy are fixed named
   seats), but that login is now backed by a real Microsoft-verified identity
   rather than a client-side PIN comparison alone (PIN kept only as a fallback).
4. **GitHub Pages deploy friction.** Recurring issue throughout this build: downloading
   a new HTML file from Claude and dragging it into GitHub's upload UI causes browser
   auto-renaming (`file (2).html`, `file (3).html`, etc.) when a same-named file
   already exists locally, leading to stray files being uploaded instead of replacing
   `index.html`. Established workaround: edit `index.html` directly in GitHub's web
   editor (open file → pencil icon → select all → paste new content) instead of
   uploading. Claude Code could set up something sturdier (e.g., a GitHub Action, or
   just a standing convention) if this keeps recurring.
5. **No automated deploy pipeline** — every change is a manual copy-paste into GitHub's
   web editor. Fine at current scale; consider `git` + a real workflow if this tool
   grows.

---

## 8. Testing already done (and what wasn't)

Extensive headless-browser (Playwright) testing was done during the build for:
line-item math (builder cost / unit price / client price / margin / profit, including
the margin→markup back-solve), section/deal totals, photo attachment compression and
lightbox viewing, approve/reject flow including rejection reasons, dark/light theme
persistence across reload, Auto/Mobile/Web forced layout switching, and the
gate-unlock-then-reload scenario (which caught the bug described in §5).

**What was explicitly NOT verified:** an actual successful Firestore read or write.
The sandbox used for building cannot reach Firebase's servers (network egress
allowlist doesn't include Google's Firebase/gstatic domains), so the Firebase
integration was verified only for *graceful degradation* (no crashes, correct error
state) when the network call fails — never for a real success case. This is the
highest-priority thing to verify and fix.

---

## 9. Immediate priority for Claude Code

1. Diagnose and fix the Firestore persistence issue (§2) — this is what actually makes
   the tool usable for the team.
2. Once persistence is confirmed working, set permanent Firestore security rules
   before the 30-day test-mode window closes.
3. Everything else in §7 is a "nice to have, revisit later" list, not urgent.
