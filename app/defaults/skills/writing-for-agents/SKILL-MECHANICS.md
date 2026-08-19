---
source: https://github.com/mattpocock/skills/tree/main/skills/productivity/writing-for-agents
license: MIT, Copyright (c) 2026 Matt Pocock
---

# Skill mechanics

The skill-specific branch of [`writing-for-agents`](SKILL.md): what changes when the document is a skill (where it lives, frontmatter, what its always-loaded description costs, and whether it should be a skill at all). Everything else about writing it is the universal reference in `SKILL.md`.

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

Every skill here fires from the model. A session is an agent, a trigger, or a subagent, and no human types a skill name. Skills elsewhere choose between model- and user-invocation; in Atlas that choice does not exist, and `disable-model-invocation` would only make a skill unreachable. Two consequences:

- The `description` is the entire invocation mechanism, and it stays in context every turn, in every session, whether the skill fires or not. That permanent context load is what the skill costs simply by existing. A skill nothing triggers is pure cost, and a branch missing from the description is a skill that never runs.
- A skill made of pure reference is one home for shared reference: any other skill can invoke it, so material several skills need lives in one place instead of being duplicated across them.

A skill therefore spends only context load. The cognitive-load half of the trade in `SKILL.md` lands elsewhere, on the workspace documents a human decides to put in front of the agent.

## Splitting off a second skill

The skill-specific cut (the sequence cut lives in `SKILL.md`): split when a distinct leading word should trigger the new skill on its own, or when another skill must reach it independently. You pay a second always-loaded description for that reach, so it has to earn one.

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
