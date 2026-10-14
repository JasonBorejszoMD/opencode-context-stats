
/**
 * context-stats — reports this session's context window occupancy on demand.
 *
 * Why this exists: the model cannot see its own context budget. Without it, the
 * only available strategy is to guess, and a wrong guess in either direction is
 * costly — under-estimating causes premature summarisation and needless session
 * splits; over-estimating causes context exhaustion mid-task.
 *
 * Design notes:
 * - Bounded input. The tool takes no arguments, so it cannot be steered into
 *   producing a number that flatters the caller.
 * - Coarse band, not a raw number, is the headline. A live per-turn counter is a
 *   pressure point; a threshold-crossed band is not. Raw figures are included for
 *   reference but are not the answer being returned.
 * - Honest nulls. If the limit or the token totals cannot be determined, the
 *   tool says so rather than estimating. Canon #1064.
 */

type Band = {
  band: "ample" | "tight" | "critical" | "exhausted" | "unknown";
  advice: string;
};

function bandFor(ratio: number | null): Band {
  if (ratio === null || !Number.isFinite(ratio)) {
    return {
      band: "unknown",
      advice:
        "Occupancy could not be determined. Do not assume headroom is plentiful or scarce. " +
        "Prefer targeted reads over wholesale loads until a real figure is available.",
    }
  }
  if (ratio >= 1)
    return {
      band: "exhausted",
      advice:
        "Context window is full or over. Durable state must be written to disk now, before " +
        "any further reads. Expect compaction or a session split.",
    }
  if (ratio >= 0.8)
    return {
      band: "critical",
      advice:
        "Context is getting tight. Prefer targeted and greppable reads over loading whole " +
        "files. If work must continue past this point, summarise durable state to disk first.",
    }
  if (ratio >= 0.5)
    return {
      band: "tight",
      advice:
        "Moderate headroom remains. Large loads are affordable but not unlimited — check the " +
        "figure again after any substantial read.",
    }
  return {
    band: "ample",
    advice:
      "Ample headroom. Whole-file and bulk reads are affordable. This is the condition under " +
        "which exhaustive analysis is cheaper than iterative grepping.",
    }
  }

function tokensOf(message: any): Record<string, number> {
  // SessionMessageInfo shape varies by version; sum whatever is present and do not guess.
  const t = (message as any)?.tokens ?? (message as any)?.data?.tokens ?? {}
  const n = (v: any) => (typeof v === "number" && Number.isFinite(v) ? v : 0)
  return {
    input: n(t.input ?? t.input_tokens),
    output: n(t.output ?? t.output_tokens),
    reasoning: n(t.reasoning ?? t.reasoning_tokens),
    cacheRead: n(t.cache?.read ?? t.cache_read),
    cacheWrite: n(t.cache?.write ?? t.cache_write),
  }
}

// `Plugin.define` is an identity function used only for type inference, so a
// plain object literal is equivalent at runtime. Declared inline to avoid a
// module-resolution dependency in the loader.
export default {
  id: "context-stats",
  async setup(ctx) {
    let activeSessionID: string | undefined
    let activeModel: { providerID?: string; id?: string } | undefined

    // Track which session and model the agent loop is currently using.
    // The tool itself does not receive a sessionID, so we capture it here.
    await ctx.session.hook("context", (event: any) => {
      activeSessionID = event?.sessionID ?? activeSessionID
      activeModel = event?.model ?? activeModel
    })

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "context_stats",
        description:
          "Report this session's context window occupancy: a coarse band (ample / tight / " +
          "critical / exhausted), the underlying token figures, and the model's context limit. " +
          "Call before planning any large file read, bulk load, or analysis sweep. Takes no arguments.",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        execute: async (_input, _context) => {
          let sessionID = activeSessionID
          let messages: readonly any[] | undefined
          let sessionError: string | undefined

          if (sessionID) {
            try {
              messages = await ctx.session.context({ sessionID })
            } catch (e) {
              sessionError = e instanceof Error ? e.message : String(e)
            }
          } else {
            // Fallback: most recently updated session. Reported honestly if ambiguous.
            try {
              const list: any = await (ctx.session as any).list?.()
              const items = list?.data ?? list ?? []
              if (Array.isArray(items) && items.length) {
                const sorted = [...items].sort(
                  (a: any, b: any) => (b?.time?.updated ?? 0) - (a?.time?.updated ?? 0),
                )
                sessionID = sorted[0]?.id
                messages = await ctx.session.context({ sessionID: sessionID! })
              } else {
                sessionError = "no active session could be identified"
              }
            } catch (e) {
              sessionError = e instanceof Error ? e.message : String(e)
            }
          }

          const totals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
          let counted = 0
          if (messages) {
            for (const m of messages) {
              const t = tokensOf(m)
              totals.input += t.input
              totals.output += t.output
              totals.reasoning += t.reasoning
              totals.cacheRead += t.cacheRead
              totals.cacheWrite += t.cacheWrite
              counted++
            }
          }

          // Context occupancy is the CURRENT window, not a running total.
          //
          // First implementation summed cache-read across every message in the
          // session and reported 6774.7% usage. Cache tokens are per-request
          // reads, so summing them counts the same context repeatedly - the
          // same window is re-read on every turn.
          //
          // Correct basis: the most recent request that carried token figures.
          // That single request's input + cache-read + output approximates the
          // context actually being held right now.
          let occupancy = null
          let occupancyBasis = "(unavailable)"
          if (messages && messages.length) {
            for (let i = messages.length - 1; i >= 0; i--) {
              const t = tokensOf(messages[i])
              const window = t.input + t.cacheRead + t.cacheWrite
              if (window > 0) {
                occupancy = window + t.output
                occupancyBasis = `latest request (message ${i + 1} of ${messages.length})`
                break
              }
            }
          }

          // Resolve the model's declared context limit. Null if unavailable.
          let limit: number | null = null
          let modelLabel = activeModel
            ? `${activeModel.providerID ?? "?"}/${activeModel.id ?? "?"}`
            : null
          try {
            const models: any = await ctx.model.list()
            const list = models?.data ?? models ?? []
            if (Array.isArray(list) && activeModel) {
              const found = list.find(
                (m: any) =>
                  m?.id === activeModel.id &&
                  (!activeModel.providerID || m?.providerID === activeModel.providerID),
              )
              const c = found?.limit?.context
              if (typeof c === "number" && Number.isFinite(c) && c > 0) limit = c
            }
          } catch {
            limit = null
          }

          const ratio = limit !== null && occupancy !== null ? occupancy / limit : null
          const { band, advice } = bandFor(ratio)

          const lines = [
            `CONTEXT BAND: ${band.toUpperCase()}`,
            `  ${advice}`,
            "",
            `  messages counted : ${counted}`,
            `  model            : ${modelLabel ?? "(unresolved)"}`,
            `  context limit    : ${limit ?? "(unavailable)"}`,
            `  occupancy (est.) : ${occupancy ?? "(unavailable)"}  [${occupancyBasis}]`,
            `  usage            : ${ratio === null ? "(unavailable)" : (ratio * 100).toFixed(1) + "%"}`,
            "",
            "  token totals across counted messages:",
            `    input      ${totals.input}`,
            `    output     ${totals.output}`,
            `    reasoning  ${totals.reasoning}`,
            `    cache read ${totals.cacheRead}`,
            `    cache write${totals.cacheWrite}`,
          ]
          if (sessionError) lines.push("", `  note: ${sessionError}`)

          return { content: lines.join("\n") }
        },
      })
    })
  },
}
