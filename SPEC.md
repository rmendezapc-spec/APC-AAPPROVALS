# Sales Dashboard — Logic Spec
Derived from `Monthly Sales Report.xlsx` (sheets: `2025`, `2026`, `2026 Summary`).
The spreadsheet is the reference implementation. Below is its logic normalized for a real data model.

## 0. Key modeling decision (read first)
The spreadsheet stores records in fixed per-month row blocks. **Do not replicate this.**
Store a flat record table and derive months from `closeDate`. All range-based
formulas in the sheet are an artifact of that layout, not business logic.

---

## 1. Domain types

```ts
type DealStage =
  | 'CLOSED_WON'        // sheet value: "Closed Won (APC Materials)"
  | 'PAYMENT_COLLECTED' // sheet value: "Payment Collected"

/**
 * One row in the sheet. Two distinct semantic kinds share this shape:
 *  - CLOSED_WON        => a NEW deal booked in the month of closeDate
 *  - PAYMENT_COLLECTED => NOT a deal. A cash-receipt event for a deal
 *                         won in an EARLIER month. amount is 0.
 */
interface DealRecord {
  recordId: string        // col A. HubSpot record id. Not unique across rows:
                          //   a PAYMENT_COLLECTED row reuses its origin deal's id.
  dealName: string        // col B
  closeDate: Date         // col C. For PAYMENT_COLLECTED this is the COLLECTION date.
  stage: DealStage        // col D
  pipeline: string        // col E. Currently always "APC Materials".
  amount: number          // col F. 0 for PAYMENT_COLLECTED rows.
  dealOwner: string       // col H. Currently always "Richard Mendez".
  collected: number       // col I. Cash received against this row.
  materialType: string    // col J. Free-text enum, see §6.
  outstanding: number     // col K. DERIVED, see §2. Do not store; compute.
  originRecordId?: string // implicit in the sheet via notes. REQUIRED in the app
                          //   on PAYMENT_COLLECTED rows -> the CLOSED_WON row it pays.
  note?: string           // cell comment
}
```

### Config (hardcoded in the sheet ~20 times — externalize these)
```ts
const CONFIG = {
  COMMISSION_RATE: 0.005,          // 0.5%
  COMMISSION_THRESHOLD: 250_000,   // per-month gate, all-or-nothing
} as const
```

---

## 2. Record-level derivations

```ts
function outstanding(r: DealRecord): number {
  return r.amount - r.collected          // sheet: K = F - I
}
```

**Invariant — no double counting.** A partial balance is attributed to the
**origin** `CLOSED_WON` record only. A `PAYMENT_COLLECTED` record must always
report `outstanding === 0`.

```ts
function assertNoDoubleCount(r: DealRecord) {
  if (r.stage === 'PAYMENT_COLLECTED') {
    assert(r.amount === 0, 'PAYMENT_COLLECTED rows carry amount 0')
    assert(outstanding(r) === 0, 'balance belongs on the origin record')
    assert(r.originRecordId != null, 'must point at its origin CLOSED_WON row')
  }
}
```

When a payment lands, the app must:
1. insert a `PAYMENT_COLLECTED` record (`amount: 0`, `collected: <cash>`, `originRecordId`), **and**
2. increase `collected` on the origin `CLOSED_WON` record by the same cash,
   which mechanically reduces its `outstanding`.

This is what the sheet does by hand via notes (e.g. rows 254/256 → origin rows 141/186).
Enforce it transactionally; it is the single easiest thing to get wrong.

---

## 3. Monthly metrics

```ts
interface MonthMetrics {
  month: string            // 'YYYY-MM'
  dealAmount: number
  outstanding: number
  revenue: number
  outstandingCollected: number
  totalCollected: number
  deals: number
  avgDealSize: number
  commission: number
  largestDeal: number
  smallestDeal: number
}

function monthMetrics(month: string, all: DealRecord[]): MonthMetrics {
  const rows  = all.filter(r => ym(r.closeDate) === month)
  const won   = rows.filter(r => r.stage === 'CLOSED_WON')
  const coll  = rows.filter(r => r.stage === 'PAYMENT_COLLECTED')

  const dealAmount           = sum(won.map(r => r.amount))
  const outstandingTotal     = sum(won.map(outstanding))
  const revenue              = dealAmount - outstandingTotal
  const outstandingCollected = sum(coll.map(r => r.collected))
  const totalCollected       = revenue + outstandingCollected
  const deals                = won.length

  // NOTE: zero-amount records are excluded from smallestDeal (sheet uses MINIFS ">0").
  const positive = won.map(r => r.amount).filter(a => a > 0)

  return {
    month, dealAmount, outstanding: outstandingTotal, revenue,
    outstandingCollected, totalCollected, deals,
    avgDealSize:  deals > 0 ? dealAmount / deals : 0,   // guard is required
    commission:   commissionFor(totalCollected),
    largestDeal:  positive.length ? Math.max(...positive) : 0,
    smallestDeal: positive.length ? Math.min(...positive) : 0,
  }
}

/** All-or-nothing gate, NOT prorated and NOT applied to the excess only. */
function commissionFor(totalCollected: number): number {
  return totalCollected >= CONFIG.COMMISSION_THRESHOLD
    ? totalCollected * CONFIG.COMMISSION_RATE
    : 0
}
```

### Metric semantics cheat-sheet
| Metric | Meaning |
|---|---|
| `dealAmount` | Gross value booked this month |
| `outstanding` | Portion of `dealAmount` not yet collected |
| `revenue` | Cash-equivalent value of *this month's* deals |
| `outstandingCollected` | Cash received this month against *prior* months' deals |
| `totalCollected` | Actual cash in the door this month |
| `deals` | Count of new deals only; collection events never increment it |

---

## 4. YTD aggregation — has a non-obvious rule

```ts
function ytdMetrics(months: MonthMetrics[]): MonthMetrics {
  return {
    month: 'YTD',
    dealAmount:           sum(months.map(m => m.dealAmount)),
    outstanding:          sum(months.map(m => m.outstanding)),
    revenue:              sum(months.map(m => m.revenue)),
    outstandingCollected: sum(months.map(m => m.outstandingCollected)),
    totalCollected:       sum(months.map(m => m.totalCollected)),
    deals:                sum(months.map(m => m.deals)),

    // recomputed from YTD aggregates — NOT an average of monthly averages
    avgDealSize: totalDeals > 0 ? ytdDealAmount / totalDeals : 0,

    // CRITICAL: sum of monthly commissions. Do NOT apply the $250k gate to the
    // YTD total. A month below threshold contributes 0 permanently.
    commission:  sum(months.map(m => m.commission)),

    largestDeal:  Math.max(...months.map(m => m.largestDeal)),
    smallestDeal: Math.min(...months.filter(m => m.smallestDeal > 0)
                                 .map(m => m.smallestDeal)),
  }
}
```

---

## 5. Pipeline activity metrics (`2026 Summary` rows 33–43)

Inputs are **externally sourced** (HubSpot export), not derived from `DealRecord[]`:
`dealsCreated`, `wonCount`, `lostCount`, `pipelineAmount`, `lostAmount`.
`wonAmount` is joined in from `monthMetrics(month).dealAmount`.

```ts
function activityMetrics(a: MonthActivityInput): MonthActivity {
  return {
    ...a,
    // Floor at 0 is REQUIRED: created is cohorted by CREATE date while
    // won/lost are cohorted by CLOSE date, so won+lost can exceed created.
    // A 0 here means "cohort mismatch", not "no open deals". Surface it as such.
    pendingCount:  Math.max(0, a.dealsCreated   - a.wonCount  - a.lostCount),
    pendingAmount: Math.max(0, a.pipelineAmount - a.wonAmount - a.lostAmount),
    winRate:       a.dealsCreated > 0 ? a.wonCount / a.dealsCreated : 0,
  }
}
```
UI rule: when `pendingCount === 0` **and** `wonCount + lostCount > dealsCreated`,
render "n/a (cohort mismatch)" rather than 0. In the sheet, Mar 2026 and
Apr 2026 both hit this.

---

## 6. Material-type rollup

```ts
function materialTotals(all: DealRecord[]): Record<string, number> {
  // Full-year, all stages. Safe only because PAYMENT_COLLECTED rows have amount 0.
  // Prefer filtering to CLOSED_WON explicitly — same result, no hidden dependency.
  return groupSum(all.filter(r => r.stage === 'CLOSED_WON'),
                  r => r.materialType, r => r.amount)
}
```
`materialType` is free text in the sheet with dirty values that must be
normalized on ingest — compound (`TB08 15/CB06 LX`, `CB04/CB06`, `TB06/CB06`),
non-material (`Shipping`, `Color Charge`, `Custom`), and near-duplicates
(`TB08` vs `TB08 15`). Model it as a canonical enum + a mapping table; do not
group on raw strings.

---

## 7. Acceptance tests (real values from the workbook)

```ts
// Feb 2026 — below commission threshold
expect(m('2026-02')).toMatchObject({
  dealAmount: 74984.64, revenue: 74984.64, outstanding: 0,
  outstandingCollected: 0, totalCollected: 74984.64,
  deals: 22, commission: 0,            // 74,984.64 < 250,000
  largestDeal: 12464, smallestDeal: 54.95,
})

// Jan 2026 — above threshold, clean (no outstanding)
expect(m('2026-01')).toMatchObject({
  dealAmount: 366738.75, revenue: 366738.75, totalCollected: 366738.75,
  deals: 25, avgDealSize: 14669.55, commission: 1833.69375,
  largestDeal: 175995, smallestDeal: 129.9,
})

// Jun 2026 — exercises outstanding + prior-month collections
expect(m('2026-06')).toMatchObject({
  dealAmount: 379521.84,
  outstanding: 190741,
  revenue: 188780.84,            // 379,521.84 - 190,741
  outstandingCollected: 76862.30,
  totalCollected: 265643.14,     // 188,780.84 + 76,862.30
  deals: 35,                     // 39 rows - 4 PAYMENT_COLLECTED
  commission: 1328.2157,
})

// YTD Jan–Jul 2026
expect(ytd('2026')).toMatchObject({
  dealAmount: 1653467.58, revenue: 1454386.78,
  outstandingCollected: 258021.06, totalCollected: 1712407.84,
  outstanding: 199080.80, deals: 220,
  commission: 7407.3769,   // sum of monthly; Feb & May contribute 0
  largestDeal: 180003, smallestDeal: 54.95,
})

// Activity, Sep 2025
expect(activity('2025-09')).toMatchObject({
  dealsCreated: 80, wonCount: 20, lostCount: 1,
  pendingCount: 59, winRate: 0.25,
})
```

---

## 8. Known sheet defects — implement the CORRECT behavior, not the sheet's
The spec above is already corrected. These are the divergences, so tests against
live sheet cells won't confuse you:

1. **`2026`!J258** holds `=SUM(K219:K257)` — an outstanding total parked in the
   Material Type column. Other months put `F+I` in J (`J215`). Column J is
   overloaded; the app keeps outstanding and materialType strictly separate.
2. **Largest/Smallest ranges are inconsistent.** Jan `MAX(F32:F56)` excludes
   row 57; Feb includes all rows; March `D14` uses `F88:F109` but `D15` uses
   `F88:F107` (off by two). Spec: always all `CLOSED_WON` rows, `amount > 0`.
3. **`2025` computes `outstandingCollected` from column F; `2026` from column I.**
   Column I (`collected`) is correct. `2026`!F57 = 29,316.76 on a
   PAYMENT_COLLECTED row also violates the `amount === 0` invariant — normalize
   on import.
4. **`2026`!K257** = `=K166`, a stray cross-row reference. Ignore.
5. **Sheet-only artifacts** with no domain meaning: `MONTHLY TOTAL (n deals)`
   label strings, `📅` section banners, spacer columns G/L, and reverse-
   chronological section ordering on `2025` (Dec at rows 33–59, Sep at 119–136)
   vs forward on `2026`.
6. `recordId` values in the March block are truncated to ~9 significant digits
   (`309977000000`) by Excel's 15-digit float precision. **Import IDs as strings.**
7. Close dates are Excel serials (epoch 1899-12-30), e.g. `46053` = 2026-01-08.

---

## 9. Implementation status in `sales-report.html` (as of this note)

- **Baked months** (the static 2025/2026 monthly summary rows parsed from the
  workbook) are trusted as-is from the sheet's own KPI-block cells — the app
  does **not** recompute them from row-level ledger data, which sidesteps most
  of §8's row-range defects for those months (they were never derived that way
  here in the first place).
- **Uploaded (live) months** and **YTD aggregation** now follow §3/§4 exactly:
  `outstanding` is derived (`amount − collected`, never trusted from an
  uploaded column), `avgDealSize = dealAmount / deals`, `smallestDeal`
  excludes non-positive amounts, and **Commission is the $250K all-or-nothing
  gate** (`commissionFor(totalCollected)`) — applied as the live default for
  *every* month (baked or uploaded) whenever there's no manual override, so
  logging a new collection that pushes a month's Total Collected across the
  threshold updates that month's commission automatically.
- **Outstanding Collected** for an uploaded month is `SUMIF(stage =
  PAYMENT_COLLECTED, collected)` from that month's own uploaded rows, **plus**
  any manually-logged Collections — the two are additive, not exclusive.
- **Activity Detail** (Pipeline tab) shows "n/a (cohort mismatch)" instead of a
  bare 0 for Pending # / Pending $ when the `MAX(0, …)` floor actually
  triggered (won + lost > created for that month).
- **Not implemented** (flagged, not silently skipped):
  - §2's transactional origin-record linkage (a Payment Collected event
    retroactively reducing its origin deal's stored `outstanding`) — the
    in-app "Log a Collection" feature is a lighter-weight aggregate ledger by
    design, not a full per-deal payment ledger. Building that properly needs a
    deal-picker UI to choose the origin record, which is a larger feature than
    what's shipped.
  - §6's material-type canonicalization (compound/non-material/near-duplicate
    values folded into a clean enum) — this is a business taxonomy call, not a
    pure logic fix, and hasn't been made unilaterally. Materials currently
    render exactly as the source data spells them.
