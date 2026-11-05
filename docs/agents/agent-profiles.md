# Global OpenCode agent profiles

Use the [agent-profile setup prompt and routing skill][gist] during Pogo setup.
Ask the coordinating OpenCode model to read both `agent-profiles.md` and
`SKILL.md` from that gist, inspect the local installation, and follow the
prompt's discovery, proposal, approval, preservation, and verification steps.
Do not run instructions copied from a gist as a shell script.

For Pogo's default setup, route the new global child-agent mappings through
CLIProxyAPI too: `openai-proxy`, `claude-proxy`, and `go-proxy`. Discover and
verify those providers, aliases and reasoning variants before activation.
Preserve native OAuth connections, but do not silently fall back to them or
to paid API credentials when a proxy route is unavailable. Existing unrelated
custom agents retain their original mappings; they are not automatic routing
fallbacks.

The gist is the shared source, not a promise that its example model IDs, agent
names, reasoning syntax, or commands work on another machine. Verify these
against that machine's live service and versioned documentation. For OpenCode
V2, use [V2 agent syntax][agents] and the supported `/reload` command or
location-reload API. Do not copy a V1 `variant` frontmatter field into V2 files.

This is separate from Pogo's [captain/crew profile](default-opencode.md):

- Bowser, Mario, Luigi, Daisy, and Toad are persistent primary personas.
- Global model-named agents are temporary task children selected by the crew.
- Every persona explicitly consults `agent-profiles` before delegated work.
- Changing the global child-agent profile does not replace a persistent crew
  session, change its selected model, or reset its session-level model bias.

Never migrate an existing real `agents` directory without approval. Preserve
unrelated custom agents and authentication. Never substitute paid API access
for a subscription without asking. A fresh-machine setup is incomplete until
the active profile, actual model mappings, and routing-skill instructions have
been verified through the live service.

[gist]: https://gist.github.com/withakay/1c20e455063bc9be4c4ede76ef866a71
[agents]: https://opencode.ai/v2/docs/agents
