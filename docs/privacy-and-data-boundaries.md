# Privacy and data boundaries

The durable repository boundary is stricter than “no secrets.” No
customer-derived material may enter tracked history or package contents, even
when it appears harmless or has been transformed.

## Prohibited material

The prohibition applies to source, documentation, examples, fixtures, tests,
snapshots, generated files, lockfiles, command output, commit content, and
package archives. Do not include:

- prompts, completions, messages, tool arguments, payloads, captures, or traces
  originating from customer activity;
- customer-linked organization, project, workload, request, user, account, or
  resource identifiers;
- credentials, tokens, cookies, authorization headers, private endpoints, or
  secret-bearing URLs;
- absolute paths that reveal a person's name, machine layout, workspace, or
  private checkout; or
- names, URLs, paths, issue references, or other identifiers for a private
  repository.

Redaction does not change provenance. Hashed, truncated, tokenized, anonymized,
perturbed, summarized, or manually retyped customer material remains
customer-derived and is prohibited.

## Synthetic-only fixtures

A fixture or example is acceptable only when every value was independently
invented for the test. Keep it minimal and deterministic, use reserved example
names and domains, and use unmistakably fake credentials. Do not derive shape,
wording, identifiers, timestamps, distributions, or edge cases from a customer
record or production export.

Product-neutral schemas and behaviors may be represented with synthetic values.
A synthetic fixture proves only the behavior asserted by its focused test; it
does not make adjacent source material safe to copy.

## Runtime separation

Credentials and account-level integration records belong in the per-user global
`~/.understudy/` directory. Application migration state belongs in that project's
Git-ignored `.understudy/migrations/<run-id>/`: traces, fixtures, generated
harnesses, journals, reports, and viewers. On POSIX, use owner-only directories
and files. The CLI rejects tracked migration state and verifies the ignore rule
before writing; ignore rules do not prevent a later forced Git add or inclusion
by another packaging tool. The agent must keep this state out of history and
application packages. Real customer material must never be placed in this CLI
source checkout or its package; use separate application workspaces. Environment
files, logs, build output, coverage, and package archives are not source evidence.

## Review rule

Reviewed public-safe implementation logic may be reused within this repository's
architecture, with applicable license notices and wholly synthetic proof. If a
source contains or may derive from customer material, do not copy or transform
it. Learn only its public-safe behavior and implement that behavior independently.

Manual review remains necessary until tracked-content, packed-content, and
history scanners land. `.gitignore` reduces accidents but does not enforce this
policy.
