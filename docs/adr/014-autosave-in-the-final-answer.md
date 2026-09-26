# 014: Autosave in the final answer

Amends [ADR 012](012-agent-session-autosave.md) (issue #27).

## Context

ADR 012 asked for the save at `Stop`: `decision: block` with a ~790-byte reason, then
a tagged JSON answer in a continuation turn. In daily use that continuation became
the visible end of every edited turn:

- the whole instruction appeared as a red `Stop hook error` in Claude Code, and under
  `Blocked by hook` in Codex;
- the raw `<continuity-save>{…}</continuity-save>` answer followed it.

Tested on Windows with Claude Code 2.1.280 and Codex 0.157.0 (2026-09-26), in isolated
fixtures, using only hook output and screen reads (no transcripts):

| Mechanism | Claude Code 2.1.280 | Codex 0.157.0 |
| --- | --- | --- |
| Stop `suppressOutput` on the continuation's stop | Continuation still shown | Continuation still shown |
| Stop `suppressOutput` on the blocking stop | — | `Blocked by hook` still shown |
| Stop `hookSpecificOutput.additionalContext` | Continues the turn; shown as `Stop hook feedback`, not as an error | Not in the Stop output schema |
| `MessageDisplay` hook replacing the text | Output parsed (`--debug hooks`) but not applied on screen | No such hook |
| HTML comment in the answer | Shown raw | Shown raw |
| Markdown link reference definition in the answer | Shown raw | Not displayed |
| `PostToolUse` `hookSpecificOutput.additionalContext` | Reaches the model; not displayed | Reaches the model; not displayed |

No mechanism consumes a continuation without showing it. A turn the user reads anyway
can carry the save without a continuation.

## Decision

- **Offer with the edit.** On the first file edit of a turn, `PostToolUse` returns the
  save contract as `additionalContext`. Later edits in the turn are covered by it.
  Sub-agent edits (`agent_id` in the input) and edits spanning several scopes are not
  offered.
- **Save in the answer.** The model ends its final answer with an empty line and
  `[continuity-save]: <{json}>`. That is a CommonMark link reference definition:
  Codex does not display it; Claude Code shows it as one raw line.
- **Apply at the turn's own stop.** `Stop` reads `last_assistant_message` only while an
  offer or request is outstanding, applies the last save line (or legacy tagged block)
  through the same Core calls, and is silent.
- **Fallback.** If the offered turn has no save line, or edits happened without an
  offer, `Stop` asks once through a continuation. Claude Code gets Stop
  `additionalContext`, Codex gets `decision: block`. After an offer, the request is a
  one-line reminder; otherwise it carries the full contract. It is rate-limited to once
  per 15 minutes, and it is never made on a continuation stop.
- **Quiet reporting.** Policy outcomes (rejected, quarantined, duplicate, skipped) are
  silent. Only a failure produces one `systemMessage` line without item text, for
  example `Continuity: save skipped — database busy.`

Unchanged: mode gating (attended Claude Code, daemon-hosted Codex), scope binding,
attribution, secret and rule filtering, handoff closure by the host-recorded id,
content-free session flags, no transcript access.

## Alternatives

- **Keep the continuation and shorten it:** rejected as the default. It stays visible in both providers, as
  a request line plus an answer. It remains as the fallback.
- **`MessageDisplay` to hide the answer:** rejected for now. It is not applied on
  screen in Claude Code 2.1.280, and it would spawn a hook process for every streamed
  flush of every message in every project.
- **HTML comments:** rejected. Both providers show them.
- **An MCP save tool:** rejected. The tool call would be shown too, and ADR 012's
  registration and permission costs remain.
- **Saving silently without asking the model** (transcript, heuristics, every edit):
  rejected, as in ADR 012.
- **Offering at most every 15 minutes:** rejected. Edits between offers would need the
  visible fallback to be saved. Offering on every edited turn keeps Codex fully quiet;
  Claude Code shows one line per edited turn.

## Consequences

- Codex: an edited turn looks like any other turn. Claude Code: one raw save line at
  the end of an edited turn's answer.
- The contract (about 1 KB, 1.4 KB with an open handoff) is added once per edited
  turn to the model's context.
- If the model puts text after the save line, or omits the empty line before it, the
  line is displayed; it is still parsed.
- A model that ignores the offer gets the visible fallback at most every 15 minutes;
  the edits in between are not asked about again.
- Claude Code before 2.1.163 has no Stop `additionalContext`; there the fallback does
  nothing, while the offer path still works.
- Headless runs are unaffected: no offer, no request, exact final answer.
