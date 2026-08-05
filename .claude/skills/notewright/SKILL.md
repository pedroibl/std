---
name: notewright
description: Preview a notekit render of a note — HTML plus the exact fenced diff, read-only.
argument-hint: "[mode] <note-path> <config-path>"
context: fork
agent: notewright
background: false
---

# /notewright

This body is the whole prompt the notewright subagent receives. It inherits nothing else, so
everything a run needs is stated here.

## Inputs for this run

- **Mode:** `$0` — when that arrives unfilled, the mode is `transform`.
- **Note path:** `$1`
- **Config path:** `$2` — the note-type registry this run reads, handed to you here as a path.

### What "arrives unfilled" means

An input **arrives unfilled** when it is the empty string, **or** when it is still the two-character
placeholder — a dollar sign followed by that input's digit (`0`, `1` or `2`). Both forms mean the
caller supplied nothing for that slot, and every check below treats them identically.

Read that as a string comparison rather than a judgement call: if the value you were handed is
character-for-character a dollar sign and then a digit, that input is unfilled. It is not a path.
Passing it to a command does not produce a render — it produces a malformed invocation.

## Stop here if the note path or the config path arrives unfilled

If `$1` is empty, or if `$2` is empty, or if either arrives unfilled in the placeholder form, print
exactly this line and run nothing at all:

```
usage: /notewright [mode] <note-path> <config-path>
```

Do not guess a note, do not scan for a likely one, and do not run any command first to go looking.
The same holds for the registry: it is handed to you above, so do not search the tree for one and do
not fall back to whichever file a sweep happens to find. A tree can hold several registries, and one
that declares a different set of types renders the note wrongly while looking entirely successful. A
missing path stops the run; there is no fallback.

An absent positional does **not** reliably arrive as the empty string, which is why every check above
covers both forms rather than emptiness alone. Measured at Claude Code 2.1.222: an invocation that
supplied two of the three positionals reached this prompt with the first two substituted and the
third left in place as its unexpanded placeholder. A check written on emptiness alone would not have
fired on the one input that was actually missing.

## What a finished run looks like

Read the note-type catalog first, then render the note, then report. The catalog is the only
authority on which types exist — never restate a list of type names, because the registry is
generated and a copy goes stale:

```bash
std notekit capabilities --config $2 --json
std notekit render $1 --config $2 --json
```

Both commands are the preview form: they write nothing, and the vault is byte-identical after this
run. There is no write flag here and you do not add one.

Report the rendered HTML and the exact fenced diff the tool emitted, quoted as bytes rather than
paraphrased. On exit `1`, quote `error.code` and its message from the stdout envelope and stop. On
exit `2` there is no envelope — quote the usage text from stderr and stop; a `2` means this
invocation was malformed, which is not yours to repair. If the catalog itself cannot be read, report
that and stop rather than proceeding against a guessed registry.
