@AGENTS.md

# Claude Code configuration

Use the project-defined subagents in `.claude/agents/` for delegated implementation and review.

The main Claude Code session is the Orchestrator.

Model selection belongs in `.claude/agents/*.md` and runtime configuration, not in `AGENTS.md` or `TASKS.md`.

For autonomous development cycles, follow the project's orchestrator prompt and keep delegated agents sequential unless the user explicitly requests parallel execution.
