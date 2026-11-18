# btc-race-24h-20261118-bot

"Sharp-V only" dip-bounce bot for the make.fun competition
`btc-race-24h-20261118-1444` — race a BTC (cbBTC/USDC) trading bot live
for 24 hours. Starts with $1,000 USDC, long only, full size, one position.

## Strategy

The dev window (1,440 one-minute bars, 2026-11-17 ~14:44Z to 2026-11-18
~14:44Z) falls 280 bps net and contains exactly **one** recovered dip
(bars 43 → 69 → 85: −271 bps capitulation, +162 bps recovery) and zero
breakouts. Every kit baseline loses on it. So the bot is extremely
selective — it only trades a sharp V:

- **Entry** (decided on bar `i`, fills at the open of bar `i+1`):
  close `>= 180 bps` below the trailing 30-bar high, **and** close up
  `>= 3 bps` vs the previous close (first up-close after the fall).
  One entry per dip event (an event resets when price recovers to within
  50 bps of the trailing high, or after 120 bars). No entries in the
  last 30 bars.
- **Exit** (gross bps on closes vs the entry fill price):
  take profit `+100`, hard stop `−70`, trailing stop `−50` from the
  highest close since entry, max hold `60` bars. Full-size sell.
- `max_slippage_bps: 200`. No breakout/momentum leg (tested in Phase 1:
  it loses on this window in every variant).

Expected dev result: **+$9.34, 1 trade** — in bar 67, out on take profit
at bar 81. The whole dev edge is that single trade; the plan states this
honestly and the bot does not chase trade count with a losing second leg.

## Exit safety

The previous build attempt failed the dev gate with an immediate sell one
bar after entry, from an unexplained exit path. This bot is structured so
that cannot happen:

1. A sell is never emitted on the batch in which the buy fill is
   reported — that batch only records the entry and returns no orders.
2. A sell may only fire after at least one close has been processed with
   the position open (`barsHeld >= 1`, counted before the exit check).
3. The trailing-stop peak is initialised to the entry fill price and
   updated only on closes processed after the fill batch.
4. Entry/exit state is driven by the fills reported in each batch.

## Files

- `main.ts` — the bot (Node 22, `agent-fun/bars-replay/v1`)
- `vendor/makefun-bars.ts` — byte-for-byte copy of the kit SDK shim
- `.makefun/owner.json` — payout wallet claim file

## Grade locally

From the kit directory:

```
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process --worktree
```

## Determinism

No wall clock, no randomness, no environment reads. Two runs on the same
window produce byte-identical action logs.
