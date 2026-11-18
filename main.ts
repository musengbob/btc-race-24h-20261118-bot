// Sharp-V only dip-bounce bot for btc-race-24h-20261118-1444.
//
// Strategy (from the Phase 1 plan, dev window 2026-11-17 ~14:44Z to
// 2026-11-18 ~14:44Z, 1,440 bars, -280 bps net, exactly ONE recovered dip):
//   Entry: close >= 180 bps below the trailing 30-bar high AND close up
//          >= 3 bps vs the previous close (first up-close after the fall).
//          One entry per dip event; no entries in the last 30 bars.
//   Exit:  take profit +100 bps, hard stop -70 bps, trailing stop -50 bps
//          from the highest close since entry, max hold 60 bars.
//          All exits measured gross on closes vs the entry fill price.
//   Size:  full cash (100%), one position, long only.
//   max_slippage_bps: 200.
//
// Exit-safety invariants (the previous attempt failed the gate with an
// immediate sell one bar after entry, so these are structural, not tweaks):
//   1. A sell is NEVER emitted on the batch in which the buy fill is
//      reported. The fill batch only records the entry; it returns [].
//   2. A sell may only fire after at least one close has been processed
//      with the position open (barsHeld >= 1).
//   3. The trailing-stop peak is initialised to the entry fill price and
//      updated ONLY on closes processed after the fill batch.
//   4. Entry/exit state is driven by the fills reported in each batch,
//      never inferred from a price move on the fill batch itself.
//
// Determinism: no wall clock, no randomness, no environment reads. All
// decisions are pure functions of the bars and fills received.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- entry parameters ---
const DIP_LOOKBACK_BARS = 30; // trailing-high window, closes, inclusive
const DIP_THRESHOLD_BPS = 180; // gross bps below trailing 30-bar high
const BOUNCE_MIN_BPS = 3; // close[i] vs close[i-1]
const NO_ENTRY_LAST_BARS = 30; // never enter in the final 30 bars
const EVENT_RESET_BPS = 50; // event resets once within 50 bps of high
const EVENT_MAX_BARS = 120; // ... or 120 bars after the event started

// --- exit parameters (gross bps vs entry fill price, on closes) ---
const TAKE_PROFIT_BPS = 100;
const HARD_STOP_BPS = -70;
const TRAILING_STOP_BPS = 50; // from highest close since entry
const MAX_HOLD_BARS = 60;

// --- order parameters ---
const MAX_SLIPPAGE_BPS = 200;
const TOTAL_BARS = 1440;

function bpsDrop(numerator: bigint, denominator: bigint): bigint {
  // (denominator - numerator) * 10000 / denominator, integer bps.
  if (denominator <= 0n) return 0n;
  return ((denominator - numerator) * 10000n) / denominator;
}

function bpsMove(from: bigint, to: bigint): bigint {
  // (to - from) * 10000 / from, integer bps (signed).
  if (from <= 0n) return 0n;
  return ((to - from) * 10000n) / from;
}

// --- bot state (all derived from bars + fills, nothing else) ---
const closes: bigint[] = []; // closes[seq] = close of bar seq
let entryFillPrice: bigint | null = null; // fill price of the open position
let peakClose = 0n; // highest close since entry (init = entry fill)
let barsHeld = 0; // closes processed while open AFTER the fill batch
let eventActive = false; // inside a dip event: no re-entry until reset
let eventStartSeq = -1;

function trailingHigh(seq: number, lookback: number): bigint {
  let high = 0n;
  const start = Math.max(0, seq - lookback);
  for (let i = start; i <= seq; i++) {
    const c = closes[i];
    if (c !== undefined && c > high) high = c;
  }
  return high;
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = BigInt(bar.c);
    closes[batch.seq] = close;

    // ---- 1. Fold this batch's fills in FIRST (before any decision). ----
    let buyFilledThisBatch = false;
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        entryFillPrice = BigInt(fill.price);
        peakClose = entryFillPrice; // (c) peak starts at the fill price
        barsHeld = 0;
        buyFilledThisBatch = true;
        eventActive = true;
        eventStartSeq = batch.seq;
      } else if (fill.side === 'sell') {
        entryFillPrice = null;
        peakClose = 0n;
        barsHeld = 0;
        // A stop-out / exit keeps the dip event locked until it resets.
        eventActive = true;
        eventStartSeq = batch.seq;
      }
    }

    const heldQty = state.positions.get(SYMBOL)?.qty ?? 0n;
    const hasPosition = heldQty > 0n && entryFillPrice !== null;

    // Safety fallback (should never trigger: fills always precede the
    // position appearing in the account): a position with no recorded
    // entry is anchored at the current close and never sold this batch.
    if (heldQty > 0n && entryFillPrice === null) {
      entryFillPrice = close;
      peakClose = close;
      barsHeld = 0;
      return [];
    }

    // ---- 2. Position open: exits only. ----
    if (hasPosition) {
      const entry = entryFillPrice as bigint;
      // (a)+(b) GUARD: never sell on the fill batch. On every later
      // batch, count this close first (so barsHeld >= 1 here means at
      // least one close has been processed with the position open),
      // then update the peak from it, then evaluate the exits.
      if (buyFilledThisBatch) {
        return [];
      }
      barsHeld += 1;
      if (close > peakClose) peakClose = close;

      const moveBps = bpsMove(entry, close);
      const trailBps = bpsDrop(close, peakClose); // >= 0 while below peak
      const heldTooLong = barsHeld >= MAX_HOLD_BARS;
      if (
        moveBps >= BigInt(TAKE_PROFIT_BPS) ||
        moveBps <= BigInt(HARD_STOP_BPS) ||
        trailBps >= BigInt(TRAILING_STOP_BPS) ||
        heldTooLong
      ) {
        return [
          {
            side: 'sell',
            symbol: SYMBOL,
            qty: heldQty,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          },
        ];
      }
      return [];
    }

    // No position (and none recorded): make sure stale entry state is gone.
    entryFillPrice = null;
    peakClose = 0n;
    barsHeld = 0;

    // ---- 3. No position: entry only. ----
    if (state.warmingUp) return [];
    if (batch.seq >= TOTAL_BARS - NO_ENTRY_LAST_BARS) return [];
    if (batch.seq < DIP_LOOKBACK_BARS + 1) return [];
    const prevClose = closes[batch.seq - 1];
    if (prevClose === undefined) return [];

    const high = trailingHigh(batch.seq, DIP_LOOKBACK_BARS);
    if (high <= 0n) return [];
    const dipBps = bpsDrop(close, high);

    // Event reset: recovered to within 50 bps of the trailing high,
    // or 120 bars have elapsed since the event started.
    if (eventActive) {
      if (dipBps <= BigInt(EVENT_RESET_BPS) || batch.seq - eventStartSeq >= EVENT_MAX_BARS) {
        eventActive = false;
      } else {
        return [];
      }
    }

    const bounceBps = bpsMove(prevClose, close);
    if (dipBps >= BigInt(DIP_THRESHOLD_BPS) && bounceBps >= BigInt(BOUNCE_MIN_BPS)) {
      const notional = state.cash > 0n ? state.cash : 0n;
      if (notional <= 0n) return [];
      return [
        {
          side: 'buy',
          symbol: SYMBOL,
          notional_quote_units: notional,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        },
      ];
    }
    return [];
  },
});
