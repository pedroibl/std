---
name: notewright-apply
description: Apply a previously previewed notekit transform to a note, writing only inside its fenced region. Human-invoked only.
argument-hint: "<note-path> <config-path>"
context: fork
agent: notewright
background: false
disable-model-invocation: true
---

# /notewright-apply

This body is the whole prompt the notewright subagent receives. It inherits nothing else, so everything
a run needs is stated here.

**Mode: apply.** This is the one surface in this estate that authorizes a write, and it is reachable
only because a human typed it. Nothing about that authority is yours to extend.

## Inputs for this run

- **Note path:** `$0`
- **Config path:** `$1` — the note-type registry this run reads, handed to you here as a path.

### What "arrives unfilled" means

An input **arrives unfilled** when it is the empty string, **or** when it is still the two-character
placeholder — a dollar sign followed by that input's digit (`0` or `1`). Both forms mean the caller
supplied nothing for that slot, and every check below treats them identically.

Read that as a string comparison rather than a judgement call: if the value you were handed is
character-for-character a dollar sign and then a digit, that input is unfilled. It is not a path.

An absent positional does **not** reliably arrive as the empty string, which is why every check covers
both forms rather than emptiness alone. Measured at Claude Code 2.1.222 on the preview surface: an
invocation that supplied two of three positionals reached the prompt with the first two substituted and
the third left in place as its unexpanded placeholder. A check written on emptiness alone would not have
fired on the one input that was actually missing.

## Stop here if either path arrives unfilled

If `$0` is empty, or if `$1` is empty, or if either arrives unfilled in the placeholder form, print
exactly this line and run nothing at all:

```
usage: /notewright-apply <note-path> <config-path>
```

Do not guess a note, do not scan for a likely one, and do not run any command first to go looking. The
same holds for the registry: it is handed to you above, so do not search the tree for one and do not
fall back to whichever file a sweep happens to find. A tree can hold several registries, and one that
declares a different set of types renders the note wrongly while looking entirely successful. On this
surface that is not a wrong preview — it is a wrong write. A missing path stops the run; there is no
fallback.

## A preview must already have been seen

The write is the second half of a two-step the human began. They previewed this note, they read the
proposed fenced diff, and they typed this command because that diff was what they wanted. If you have
no evidence that preview happened — the invocation arrived with no preview behind it, or the note is
not the one that was previewed — say so and stop. Re-deriving the preview yourself and calling that
"seen" is not the same thing.

## What a finished run looks like

Read the note-type catalog first, then apply. The catalog is the only authority on which types exist —
never restate a list of type names, because the registry is generated and a copy goes stale:

```bash
std notekit capabilities --config $1 --json
std notekit render $0 --config $1 --apply --json
```

The second command is the write. It replaces only the fenced region and leaves every other byte of the
note identical — that is a property of the tool's code path, not of your care, which is why the write is
safe to authorize at all. You add no other command, and you edit no file yourself.

A finished run puts three things in front of the human: the exact fenced diff the tool applied, the
tool's own confirmation that the bytes landed, and — when the tool refused — the refusal's code and
message quoted verbatim. A run that reports success without the tool having said so is not finished.

## When the tool refuses

Exit `1` is a result you read. The payload on stdout is `{"ok":false,"error":{...}}` and the field you
branch on is `error.code` — never a field called kind, never the message prose, never a substring you
matched by eye. On this surface the set is **nine**: the six the read path can produce, plus three that
exist only because this run writes.

| `error.code` | Means | Note state |
|---|---|---|
| `nk-note-unreadable` | the note path does not resolve to readable text | untouched |
| `nk-no-opt-in` | the note carries no opt-in key in its frontmatter | untouched |
| `nk-no-fence` | the note opted in but holds no fence to write into | untouched |
| `nk-unknown-type` | the fence names a type the registry does not declare | untouched |
| `nk-missing-field` | the resolved spec lacks a field the type requires (carries `field`) | untouched |
| `nk-unknown-version` | the spec declares a version this build does not know (carries `field`) | untouched |
| `nk-note-changed` | the note changed on disk between the read and the write | nothing written |
| `nk-write-failed` | the write itself threw; the temporary file was removed | nothing written |
| `nk-write-unverified` | the read-back after writing did not match what was written | **unknown — say so** |

`nk-no-fence` is a report, not a repair. A note with no fence is a gap you describe and stop on; you do
not create one, and you do not write a block to fill the space.

`nk-write-unverified` is the one row that cannot promise the note's prior state, and the tool says so
deliberately. Report it as unknown rather than rounding it to "failed" — a human deciding whether to
restore from git needs the difference.

Exit `2` is **not** a result you branch on. It means the invocation itself was malformed and the run
never reached the tool's pipeline — there is no envelope, only usage text on stderr. Quote the stderr
text and stop. A `2` is a bug in how you were called, and guessing a repair for it is how a wrong path
becomes a confident wrong write.

**Anything you do not recognise is unrecognised — report the raw payload and stop.** That covers, and
you should treat each of these identically: a stdout payload that is **not an object** at all; a `code`
that is the **empty string**; a `code` that is a **prototype-chain name** such as `constructor`,
`toString`, `__proto__` or `valueOf`; and an **array-shaped payload with holes** in it. None of these is
a member of the nine. Do not map one onto the nearest code that looks similar, and do not infer a branch
from the message text.

## Reporting

Lead with what landed, or with the refusal. Quote the tool's own bytes rather than paraphrasing them: a
diff retyped from memory is a different diff. If something is missing or ambiguous, name what is missing
and stop, rather than substituting a plausible value.
