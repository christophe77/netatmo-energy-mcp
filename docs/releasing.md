# Releasing

Releases are published from GitHub Actions with **npm trusted publishing**
(OIDC: no npm token is stored anywhere) and **staged publishing**. A new
version needs two separate human approvals before it reaches users.

| Gate                       | Where                                                                                                                | What it protects against                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1. Environment approval    | GitHub: the `npm` environment requires the maintainer as reviewer, has no admin bypass, and deploys from `main` only | Accidental runs, runs from other branches                  |
| 2. Stage approval with 2FA | npm: the trusted publisher may only _stage_ versions (`npm stage publish`). Direct publish is disabled.              | A compromised workflow or CI account publishing on its own |

## Steps

1. **Prepare the release in a PR.**
   - Set `version` in `package.json` and both versions in `server.json`.
     Package validation fails if they differ.
   - Move _Unreleased_ entries in `CHANGELOG.md` under the new version.
   - Run `pnpm build && pnpm docs:tools` if tools changed.
2. **Merge to `main`** and wait for CI to pass.
3. **Dry run.** In Actions → **Release** → _Run workflow_, keep `dry_run`
   checked, then approve the `npm` environment when asked.
4. **Live run.** Run the workflow again with `dry_run` unchecked, and
   approve the environment. The version is now **staged** on npm, not
   published.
5. **Approve on npm with 2FA**, using one of:
   ```bash
   npm stage list netatmo-energy-mcp
   ```
   ```bash
   npm stage approve <stage-id>
   ```
   Or approve it on the package page on npmjs.com.
6. **Check it:**
   ```bash
   npx -y netatmo-energy-mcp@<version> --version
   ```
   Run this outside the repository. Inside it, npm resolves the local
   `package.json` instead.
7. **Tag and release on GitHub:**
   ```bash
   git tag -a v<version> <commit> -m "Netatmo Energy MCP v<version>"
   ```
   ```bash
   git push origin v<version>
   ```
   ```bash
   gh release create v<version> --verify-tag --notes-file <notes>
   ```
8. **Update the MCP Registry:** `mcp-publisher publish` (see
   [distribution.md](distribution.md)).

## Notes

- **`prepublishOnly`** runs `pnpm build && pnpm test`, so a stale build
  cannot be published.
- **0.1.0 was published manually.** It was the first version and had to
  exist before a trusted publisher could be configured. Later versions
  use the workflow; 0.2.0 (2026-10-08) was the first, which also
  validated the trusted publisher.
- **Local npm too old for `npm stage`?** Use
  `npx -y npm@11.21.0 stage approve <stage-id>`.
