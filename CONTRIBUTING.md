# Contributing to Stargate

Use [GitHub Issues](https://github.com/aiconsultancy/stargate/issues) for bug
reports and feature requests. For security issues, follow [SECURITY.md](SECURITY.md).
Include the Stargate release or commit, backend type, and reproduction steps
using synthetic data. Remove credentials, private URLs, workspace identifiers,
prompts, and message contents before sharing logs or examples.

Make a branch from the latest `main` and keep each pull request focused. Use
a Conventional Commit title such as `fix: preserve reply progress after a failure`.
Explain how you verified the change. Follow [AGENTS.md](AGENTS.md) for project
conventions and the [architecture guide](docs/design.md) for code boundaries.
See [development](docs/development.md) for local checks and workflow details.

```sh
mise install
mise run deps
mise run hooks
```

Use local fixtures or mock transports when testing integrations. If you need
a real Slack app or backend to reproduce a bug, use your own test setup.

By submitting a contribution, you agree to license it under the
[MIT License](LICENSE). Keep existing notices when including third-party work.
