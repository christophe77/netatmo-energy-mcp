## What and why

<!-- What does this change, and which issue does it address? -->

## Checklist

- [ ] Read-only guarantee kept: no Netatmo write endpoint or write scope.
- [ ] Tests added or updated. `pnpm check` and `pnpm test:coverage` pass.
- [ ] No real data committed: no IDs, names, locations or tokens; fixtures are synthetic or sanitized.
- [ ] Any new Netatmo field or behaviour is sourced in `docs/api-capabilities.md`.
- [ ] Tool changes: `pnpm build && pnpm docs:tools` run and the README table updated.
- [ ] `CHANGELOG.md` updated under _Unreleased_ (user-visible changes).
- [ ] Commits follow Conventional Commits.
