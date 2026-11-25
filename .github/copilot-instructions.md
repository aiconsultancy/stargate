# Review instructions

Follow `AGENTS.md`. Prioritize correctness, credential safety, access checks,
cancellation, session isolation, and durable execution/delivery transitions.

Before approving any PR, follow the
[thermo-nuclear code quality review](../.agents/skills/thermo-nuclear-code-quality-review/SKILL.md).
Check the findings against the latest diff. State explicitly in the approving
GitHub review that you confirm the thermo-nuclear review for that commit.

For dependency updates:

- Check breaking changes and runtime/SDK compatibility, not only the lockfile.
- Keep the three direct `@earendil-works` packages pinned to the same version.
- Keep OpenCode client/plugin usage consistent with the installed V2 versions.
- Keep GitHub Actions pinned to full commit SHAs with release-version comments.
- Check that frozen Bun installation, strict TypeScript, Oxlint, workflow lint,
  and tests still pass. Do not recommend bypassing or weakening these checks.
- Do not approve source changes disguised as dependency updates.

Do not include prompts, tool output, credentials, or raw SDK errors in reviews.
