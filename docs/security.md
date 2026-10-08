# Security boundary

This repository is private during foundation work, but every tracked file and
package candidate is treated as potentially publishable. Privacy of the host or
repository is not a substitute for keeping sensitive material out of history.

## Trust boundaries

- **Repository and package:** public-safe source, documentation, and wholly
  synthetic fixtures only. They are not trusted storage for runtime state.
- **Per-user global state:** credentials and integration records live outside
  inspected repositories under `~/.understudy/`. On POSIX systems, directories
  must use owner-only access and private files must use owner read/write access.
- **Project migration state:** the application's Git-ignored `.understudy/` holds
  traces, generated harnesses, fixtures, results, and viewers. Use owner-only
  permissions and exclude it from application packages as well as Git. Credentials
  remain global. The CLI refuses state already tracked by Git.
- **Inspected developer repository:** may contain sensitive application code and
  data. Discovery must not copy its payloads, identifiers, environment values,
  logs, or absolute location into this repository or its package artifacts.
- **Prior source:** reviewed, public-safe implementation logic may be adapted
  into this repository's architecture. History, customer material, private
  assumptions, and fixtures are not import sources; tests remain synthetic.

Repository-local state such as `.understudy/`, `.env` files, logs, coverage,
build output, and package archives is ignored to reduce accidental inclusion.
Project migration state is the explicit runtime exception described above.
Ignore rules do not authorize publishing sensitive material or bringing it into
this CLI source repository.

## Secret handling requirements

- Never place a credential or secret-bearing URL in source, tests, fixtures,
  snapshots, documentation, command examples, error text, or commit messages.
- Never use a real credential as test data. Synthetic values must be visibly
  fake and must not match a production credential format closely enough to be
  mistaken for one.
- Future credential-bearing operations must keep values in private state and
  inject them only into the explicitly authorized child process. Safe output may
  report presence or a non-secret record reference, never the value.
- Child stdout, stderr, request bodies, and response bodies are untrusted data
  and must not become repository artifacts or provenance evidence.

## Source and release controls

The source repository must remain on independent history and private at the
approved `understudylabs/understudy-cli` review remote. Remote privacy is a
hosting control and must be verified outside the tracked-content scanner. The
approved public distribution boundary is the separate
`understudylabs/understudy-cli-releases` repository, which may receive only the
allowlisted compiled release files described below. Publishing source, adding
another public repository or remote, or widening the release contents requires
separate approval. Reused implementation logic must be reviewed, adapted to this
repository's module structure, retain applicable license notices, and be covered
by focused synthetic tests. Source that contains or may derive from customer
material must not be copied or transformed.

These rules are policy until automated tracked-content, packed-content, and
history checks are implemented. Reviewers must distinguish manual inspection
from scanner enforcement.

## Standalone binary releases

Published standalone releases are built only when a maintainer manually runs
the binary release workflow from the exact current `main` commit, supplies a
version tag on that commit, and enters `publish-<tag>` as confirmation. The tag
must equal `v` followed by the package version and must still resolve to that
commit immediately before publication. Merges and tag pushes do not publish.
Pull requests build an ad-hoc-signed preview and execute it with both Node.js
and Bun absent from `PATH`; preview artifacts are never published. The source
repository's workflow token remains read-only throughout the release.
Maintainers may dispatch from GitHub or run
`gh workflow run binary-release.yml --ref main -f release_tag=<tag> -f release_confirmation=publish-<tag>`.

The release contains the raw platform executable, `SHA256SUMS`, the installer,
release metadata, and license notices for the first-party CLI, embedded Bun,
Commander, Zod, and other bundled dependencies. The package includes `LICENSE`
and `NOTICES.txt`; the binary notice bundle includes the MIT text from both files
for the CLI and reused Understudy implementation logic. It contains no
credential, local state, source map, repository checkout, or signing secret.
The executable must remain below 70 MB so runtime growth fails visibly in review.

Bun's compiled-executable defaults that load `.env`, `bunfig.toml`,
`tsconfig.json`, or `package.json` at runtime are explicitly disabled. Release
tests directly verify that a hostile `.env` and `bunfig.toml` preload are not
loaded. Bun still treats caller-provided `BUN_OPTIONS` and `BUN_BE_BUN` as
runtime controls; the installer and release checks remove both variables before
executing the CLI. They are part of the invoking user's environment boundary,
not a source of embedded release configuration.

The build applies an ad-hoc macOS code signature with the minimum Bun runtime
entitlements and verifies the executable before staging it. Manually approved
release runs fail closed unless repository Actions secrets provide a Developer
ID Application certificate and App Store Connect team API key. The signing job
replaces the preview signature, verifies the pinned Team ID, submits a temporary
archive to Apple's notarization service, and requires an `Accepted` response.
The archive and all signing and notarization credentials are removed before the
executable is run or staged, and `SHA256SUMS` is regenerated from the signed
binary. The temporary notarization archive is not published.

The publication job receives only the five verified release files, including
the signed and notarized executable. It mints a short-lived GitHub App token
from a repository Actions secret; that App is installed only on
`understudylabs/understudy-cli-releases` and has only repository Contents write
and Administration read permissions. Administration access is read-only and is
used solely to require immutable releases before publication. The public
release starts as a draft, its exact asset names and GitHub digests are checked,
and only then is it published as the latest immutable release. The workflow
never deletes or replaces release state. An exact immutable publication is
accepted as complete. If a run is interrupted, its draft is preserved; a rerun
may resume only the complete draft bearing that exact run marker, while any
other state requires manual review.

Bun's upstream license states that its statically linked JavaScriptCore and
WebKit components carry relinking obligations. This repository includes Bun's
upstream license inventory, but does not decide whether that inventory alone is
sufficient for external distribution. Tag builds therefore also require the
repository variable `BUN_REDISTRIBUTION_APPROVED` to equal
`bun-v1.4.0-reviewed`. Set it only after the exact Bun 1.4.0 package has received
license review and any required LGPL text, corresponding source, relinkable
application material, written offer, and retention process are in place. A
pull-request preview does not satisfy or bypass that release gate.

The first-party package is licensed under the MIT License in `LICENSE`.
Third-party dependencies retain their own terms, and selecting a source license
does not approve public source hosting or standalone binary distribution.
Before the first public tag, approve the binary distribution terms explicitly
and add any file those terms require to the allowlist and release checks. Tag
builds require `PUBLIC_BINARY_TERMS_APPROVED=understudy-cli-public-v1-reviewed`;
set it only after that explicit review is complete. The Bun redistribution gate
above remains required.

The private source repository must hold these Actions secrets:

- `MACOS_DEVELOPER_ID_P12_BASE64`
- `MACOS_DEVELOPER_ID_P12_PASSWORD`
- `APPLE_NOTARY_KEY_P8_BASE64`
- `UNDERSTUDY_RELEASE_PUBLISHER_PRIVATE_KEY`

It must also hold the non-secret Actions variables
`MACOS_DEVELOPER_ID_TEAM_ID`, `APPLE_NOTARY_KEY_ID`,
`APPLE_NOTARY_ISSUER_ID`, and `UNDERSTUDY_RELEASE_PUBLISHER_CLIENT_ID`, in
addition to the two distribution approval variables above. Compilation and
preview tests run in a credential-free job. The signing job removes its
temporary keychain, certificate, notarization key, archive, and response before
executing the release binary or staging final assets.

These credentials are repository-scoped because the current private-repository
plan does not provide protected environment secrets or reviewers. Manual
dispatch from `main` with the exact tag is the release approval, but it does not
isolate credentials from other same-repository workflows. Every account with
write access and every repository ref it can run is inside the signing and
publishing boundary. Workflow review is procedural rather than platform
enforced on this plan. If that trust is unacceptable, do not configure these
secrets; use protected private environments or an external signing boundary.

Enable release immutability in the public mirror before the first release. The
public release tag points to the mirror's static `main` branch, not to a private
source commit; the private source tag remains the authoritative build input.

The public installer needs no GitHub authentication. The latest release URL is
used only to fetch a version-pinned installer; that installer fetches the binary
and `SHA256SUMS` from one exact tag, verifies the checksum and the baked-in
Developer ID Team ID, tests the candidate, and atomically replaces only the
executable. Rerunning a released installer updates the CLI and leaves
`~/.understudy/` untouched.
