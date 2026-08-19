---
source: https://github.com/mattpocock/skills/tree/main/skills/productivity/writing-for-agents
license: MIT, Copyright (c) 2026 Matt Pocock
---

# Skill mechanics

The skill-specific branch of [`writing-for-agents`](SKILL.md): what changes when the document is a skill (where it lives, frontmatter, the invocation choice, router skills, and whether it should be a skill at all). Everything else about writing it is the universal reference in `SKILL.md`.

## Where a skill lives

- Write new skills to `~/.claude/skills/<name>/SKILL.md`. They load on the next session, no restart and no registration step.
- System skills ship inside the image at `/etc/claude-code/.claude/skills/`, built from `app/defaults/skills/` in the Atlas repo. Changing one is a repo edit plus an image rebuild, so a skill you want today goes in `~/.claude/skills/`.
- The folder holds `SKILL.md` (required), plus `references/` for disclosed reference, `scripts/` for executables, and `assets/` for templates. Documentation belongs in `SKILL.md` or `references/`; a `README.md` inside a skill folder is read by nobody.

## Frontmatter

```yaml
---
name: my-skill
description: What it is. Use when <branch>, <branch>, or <branch>.
---
```

- Folder name, `name`, and the skill's spoken name are one string: lowercase, hyphens, at most 64 characters, no leading, trailing, or doubled hyphen. `claude-` and `anthropic-` prefixes are reserved.
- The file is `SKILL.md`, case-sensitive.
- `description` stays under 1024 characters and carries no angle brackets. It is the skill's top-level context pointer, so write it against the pointer rules in `SKILL.md`: leading word first, one trigger per branch, identity the body already carries cut.

## Invocation

Two choices, trading the two loads:

- A **model-invoked** skill keeps a `description`, so the agent can fire it autonomously, and other skills can reach it. You can still type its name: model-invocation always _includes_ user reach; a description only ever adds agent discovery, never removes the human's. The description is the skill's top-level context pointer, forced to stay loaded at all times: permanent context load in exchange for discoverability. A model-invoked skill whose content is all reference is also one home for shared reference: another skill can invoke it, so reference needed by several skills lives in one place. Mechanics: omit `disable-model-invocation`, and write a model-facing description carrying the trigger branches.
- A **user-invoked** skill strips the description from the agent's reach: only the human typing its name can invoke it, and no other skill can. Zero context load, but it spends cognitive load: you are the index that must remember it exists. Mechanics: set `disable-model-invocation: true`; the `description` becomes human-facing: a one-line summary, trigger lists stripped.

Pick model-invocation only when the agent must reach the skill on its own, or another skill must. If it only ever fires by hand, make it user-invoked and pay no context load.

Shared reference that two user-invoked skills both need can live in neither: with no descriptions, neither can fire the other. Push it to a plain file outside the skill system: external reference any skill can point at.

## Splitting by invocation

The invocation cut of splitting (the sequence cut lives in `SKILL.md`): split off a model-invoked skill when you have a distinct leading word that should trigger it on its own (a trigger word you actually use in your prompts), or another skill must reach it. You pay context load for the new always-loaded description, so that independent reach has to be worth it.

## Router skills

When user-invoked skills multiply past what you can remember, that piled-up cognitive load is cured by a **router skill**: one user-invoked skill that names the others and when to reach for each, so the human has one skill to remember instead of many. It can only hint, never fire them: user-invoked skills have no description, so nothing but the human can reach them.

## Skill or memory

A skill carries operating knowledge the agent runs: the flags, the sequence, the gotcha that makes a tool or service behave. Write one once the same pattern has shown up **twice**. Everything else is memory, which the agent reads rather than executes:

- Repeatable procedure with no tool-specific mechanics → `memory/workflows/`
- What happened on one run → `memory/journal/`
- State of one project → `memory/projects/`
- A fact or a preference → `memory/MEMORY.md`

## Bundled scripts

When the agent keeps rebuilding the same logic across runs, that logic belongs in `scripts/` as a tested executable:

- Take every input through flags, environment, or stdin, so a run never waits on a prompt.
- Ship `--help`: it is how the agent learns the interface.
- On failure, print what went wrong, what was expected, and what to try.
- Emit JSON or CSV, so the agent parses instead of guessing.
- Make it idempotent ("create if it does not exist"): agents retry.

## Iteration

Run the skill on a real task, then read the failure as a pointer or hierarchy bug and fix that:

- It never fired → a branch is missing from the description, or its wording is weak.
- It fired on the wrong task → the description claims a branch the body does not handle.
- It fired and the agent skipped the rules → they sit below the steps that bury them, or the completion criterion never demanded them.
