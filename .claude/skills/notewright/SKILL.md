---
name: notewright
description: Preview a notekit render of a note — HTML plus the exact fenced diff, read-only.
argument-hint: "[mode] <note-path>"
context: fork
agent: notewright
background: false
---

# /notewright

This body is the whole prompt the notewright subagent receives. It inherits nothing else, so
everything a run needs is stated here.

## Inputs for this run

- **Mode:** `$0` — when that is empty, the mode is `transform`.
- **Note path:** `$1`
- **Registry:** the note-type registry the vault ships, reached with `--config`.

## Stop here if the note path is empty

If `$1` is empty, print exactly this line and run nothing at all:

```
usage: /notewright [mode] <note-path>
```

Do not guess a note, do not scan for a likely one, and do not run any command first to go looking.
An absent positional arrives as the empty string, so this is a check on emptiness — not on some
"unset" state that never occurs.

## What a finished run looks like

Read the note-type catalog first, then render the note, then report. The catalog is the only
authority on which types exist — never restate a list of type names, because the registry is
generated and a copy goes stale:

```bash
std notekit capabilities --config <config> --json
std notekit render $1 --config <config> --json
```

Both commands are the preview form: they write nothing, and the vault is byte-identical after this
run. There is no write flag here and you do not add one.

Report the rendered HTML and the exact fenced diff the tool emitted, quoted as bytes rather than
paraphrased. On exit `1`, quote `error.code` and its message from the stdout envelope and stop. On
exit `2` there is no envelope — quote the usage text from stderr and stop; a `2` means this
invocation was malformed, which is not yours to repair. If the catalog itself cannot be read, report
that and stop rather than proceeding against a guessed registry.
