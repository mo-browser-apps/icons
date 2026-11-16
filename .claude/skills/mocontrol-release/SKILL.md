---
name: mocontrol-release
description: Publish a MoControl app version or inspect or retry a release when the user explicitly requests it.
---

# MoControl application releases

Read `.mocontrol-app.json` for this repository's organizationId and appId. Use the
`mocontrol` MCP connection to verify the app, repository, permissions, and release setup.
If authentication is needed, direct the user to `/mcp` in Claude Code and complete browser consent.
If the connection has no create_release or retry_release tool, it is read only. Ask the user to
reconnect through `/mcp` and choose Full access; do not look for other causes.

Follow the user's instructions and existing repository development, testing, branch, and PR rules.
Use the user's authenticated git/GitHub tools to create branches, push commits, and create PRs.
MoControl does not decide whether or when to merge; an unmerged branch can produce a regular release.

Only create a release when the user explicitly requests publishing or releasing. A code change,
commit, push, PR, successful test, or OAuth connection is not a release request. After completing
a code-only request, suggest publishing a version, but do not call create_release or retry_release.

For an explicit release request:

1. Call get_app with the repository's organizationId and appId. Check its repository, setup,
   signing readiness, platforms, release destination, and published version.
2. Ask for the version if unspecified. If the user explicitly requests a patch/minor/major bump,
   calculate the exact version from the latest published version. Do not silently resolve a conflict
   by choosing another version.
3. Ask which source to release if unspecified, recommending the current pushed branch. Follow any
   explicit instruction to release the default branch or another branch. Do not merge implicitly.
4. Complete relevant tests, push the changes, and create the PR according to repository rules.
   For code you implemented, use its exact remote commit SHA as sourceRef, never unpushed changes.
5. Call create_release with the exact version, sourceRef, release notes, and a fresh random
   idempotencyKey of at least 16 characters. Keep the key with the request. On a timeout or ambiguous
   response, call get_release and reuse that same key and parameters; never start a second request.
6. Poll get_release for the app/version. Dispatch acceptance and a running workflow are not a
   completed release. Report published artifact links only for targets whose state is published.
   Explain partial platform failures and link to the app/workflow for actionable errors.

Retry a failed or cancelled platform only on an explicit retry request, using retry_release. Its
original commit and settings are preserved. Give the retry its own idempotencyKey and reuse that
key after any ambiguous response. Never overwrite an already published target.

Signing credentials are configured in MoControl. If setup is missing, provide the returned setup
link. Never request certificate passwords, private keys, or tokens in chat or commit them to this repo.
