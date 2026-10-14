# opencode-context-stats

Let the model see how much context it has left.

## The problem

A model cannot see its own context window. It has no access to its token count, its
limit, or how full it is. The only available strategy is to guess — and a guess in
either direction is expensive:

- **Under-estimating** causes premature summarisation, needless session splits, and
  "let me start a fresh thread" when there was plenty of room.
- **Over-estimating** causes context exhaustion mid-task, usually with no warning.

This plugin removes the guess.

## What it does

Registers one tool, `context_stats`, which returns:

```
CONTEXT BAND: AMPLE
  Ample headroom. Whole-file and bulk reads are affordable. This is the condition
  under which exhaustive analysis is cheaper than iterative grepping.

  messages counted : 496
  model            : opencode/space-bunny-free
  context limit    : 1048576
  occupancy (est.) : 434372  [latest request (message 495 of 496)]
  usage            : 41.5%

  token totals across counted messages:
    input      706576
    output     143262
    reasoning  121129
    cache read 71921229
    cache write0
```

## Design notes

These are deliberate, and each one exists because the obvious alternative failed.

**The band is the answer; the numbers are the evidence.** A live per-turn token
counter is a pressure point — it invites the model to start managing a budget
instead of doing the work. A threshold-crossed band does not. The raw figures are
still returned underneath, because when the band looks wrong, the numbers are how
you find out why. (They immediately caught a bug in this plugin's own first
version, which reported 6,774% usage from summing cache-read across the session.)

**The tool takes no arguments.** It cannot be steered into producing a flattering
number, and it cannot be used as a vector.

**It reports `unknown` rather than estimating.** If the limit or the token totals
cannot be determined, it says so. A wrong number is worse than no number, because
a wrong number gets acted on.

**Occupancy comes from the latest request, not a running total.** Cache tokens are
per-request reads — the same context is re-read every turn — so summing them across
a session counts the same window repeatedly. Occupancy is the *current* window.

## Bands

| Band | Usage | Meaning |
|---|---|---|
| `ample` | < 50% | Whole-file and bulk reads are affordable. Exhaustive analysis is cheaper than iterative grepping. |
| `tight` | 50–80% | Moderate headroom. Large loads affordable but not unlimited. |
| `critical` | 80–100% | Prefer targeted, greppable reads. Summarise durable state before continuing. |
| `exhausted` | ≥ 100% | Full. Write durable state to disk now. Expect compaction or a split. |
| `unknown` | — | Could not be determined. Do not assume headroom either way. |

The thresholds are deliberately conservative and coarse. Adjust them in
`bandFor()` if you want different numbers — they are the only tunable part.

## Install

```
opencode plugin add github.com/JasonBorejszoMD/opencode-context-stats
```

Or copy the `index.ts` into `.opencode/plugins/context-stats/index.ts` in your
project, or `~/.config/opencode/plugins/context-stats/index.ts` globally.

Restart OpenCode. The tool then appears alongside the built-ins.

## Requirements

- OpenCode v2 (uses the `ctx.tool.transform` plugin API)
- No dependencies, no configuration, no network access

## Accuracy

Occupancy is an estimate derived from the most recent request's token figures. The
OpenCode UI panel reports an authoritative figure; when the two disagree, believe
the panel. This is a reasoning aid, not an instrument.

## Credits

Authored with Sator, who asked for it after a session was cut short by a context
exhaustion nobody could see coming.
