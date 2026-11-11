# Contributing

Pull requests are welcome.

1. Fork and branch from `main`.
2. `bun install`, then make your change. Read `AGENTS.md` for module ownership and safety rules.
3. Run `bun run check` and `git diff --check`.
4. For runtime changes, exercise the real user path (see the README feature map) and describe the commands and results in the PR. Use disposable fixtures; credentialed Devin calls can incur charges.
5. Update `README.md` and `CHANGELOG.md` when behavior changes. Version bumps are done by the maintainer at release.
6. Open a PR using the template.
