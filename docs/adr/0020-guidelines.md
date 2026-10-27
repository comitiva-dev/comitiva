# 0020 — Guidelines: shared instructions each agent gets only when they apply

- Status: Accepted
- Date: 2026-10-27

## Context

Users repeat the same instructions in many agents' roles: the house style,
who the customers are, rules for sources, a glossary. Copying them is slow,
and the copies drift. Tools like Claude Code and Codex read one `CLAUDE.md`
or `AGENTS.md` per folder, and every run gets the whole file, even the parts
that do not matter to the task.

What we want:

- Write an instruction once and give it to every agent, to a group of
  agents, or to the agents that need it.
- Each agent gets only its own, so a prompt does not grow with every rule
  the team writes.
- Reuse what people already have: an `AGENTS.md` or `CLAUDE.md` split into
  sections.

## Decision

**A guideline is a named block of Markdown** (`Guideline` in the contract):
`name`, `content`, `scope`, `agentTags`, `position`. It is an instruction, a
rule or reference data. Nothing about it assumes code.

**Three ways to reach an agent, and they add up.**

- `scope: 'all'`: every agent.
- `scope: 'tags'`: agents with any of `agentTags` (case-insensitive). Groups
  of agents are the tags agents already have, so there is no group entity.
- An agent's own picks, `Agent.guidelineIds`, work for any guideline whatever
  its scope. `scope: 'agents'` (the default) means it reaches agents only
  through picks.

`guidelinesFor(agent, guidelines)` in the contract is the one rule, and it
keeps the user's order (`position`).

**The runner builds the prompt.** `run.start` carries `guidelines: [{ name,
content }]` resolved by the shell, and `systemPrompt(role, guidelines)` in
the runner appends them after the role under `# Guidelines`, one `## name`
section each, skipping empty ones. API providers get it as the system prompt
and CLI harnesses as `--append-system-prompt` (Claude Code) or
`developer_instructions` (Codex), the same path the role already takes. With
no guidelines, the prompt is exactly the role, as before. Building it in the
runner keeps one format for every shell, including the hub's executor in
Phase 9.

**AGENTS.md in and out, not a live file.** Guidelines live in the app's
database. Import reads a Markdown file and makes one guideline per `##`
section (per `#` section when there is no `##`), keeps deeper headings in
the body, ignores headings in code fences, and names a preamble after the
file's `#` title or the file. Export writes one `AGENTS.md`. A
`<!-- comitiva scope="tags" tags="a, b" -->` line under a heading carries the
scope, so an export imports back the same. Without it, an imported guideline
reaches no agent until someone picks it or changes its scope: importing a
file never changes what running agents get.

**Personal only, for now.** Guidelines are local, like connections. A
workspace's shared agents get none: if each member's Personal guidelines
went into their turns, the same shared agent would answer differently
depending on who sent the message. Workspace guidelines (stored on the hub,
the same for every member) come with Phase 9. The portable bundle
(ADR 0013) does not carry guidelines yet; Export AGENTS.md moves them.

## Consequences

- A new entity, `Guideline`, published as JSON Schema, and `guidelineIds` on
  `Agent`. `RunStartRequest.guidelines` is optional, so a runner and a shell
  of different versions still talk.
- Desktop: migration `0009_guidelines` (`guidelines`, `agent_guidelines`
  with cascades on both sides), `GuidelineRepository`, `GuidelineService`,
  `guidelines.*` IPC, a Guidelines screen (Cmd/Ctrl+5) and a checklist in the
  agent form that shows which guidelines already reach the agent by scope or
  tag.
- Rejected: a live `AGENTS.md` on disk per agent. It suits Git, but the hub
  and the web UI cannot read a desktop's files, and edits outside the app
  would change prompts silently. Rejected too: a separate group entity,
  because tags already group agents in the sidebar and the search.
