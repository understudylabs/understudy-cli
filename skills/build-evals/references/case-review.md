# Review cases with a person who knows the workload

Use this guide for Medium's discovery and independent labeling. Its purpose is
to turn concrete observations into defensible criteria. A working page and a
set of agent-written labels do not demonstrate that human review happened.

Keep records, annotations, newly authored private viewer code, and generated
pages in the private application eval directory. Existing viewer source can
remain in its established location; record its version and command, and keep
customer evidence out of that source. Preserve the existing viewer's formats and review
records when they retain the necessary evidence and attribution. The optional
bundled formats and commands are defined in [formats.md](formats.md).
The example in [worked-example.md](worked-example.md)
shows what a useful observation, criterion, and disagreement look like.

## 1. Agree on how the person wants to review

Ask explicitly, using the host's question tool when available or an ordinary
chat question:

> Where would you prefer to review these cases: your existing trace viewer, a
> readable Markdown document, or a local interactive page? Would seeing one task
> at a time, a side-by-side input/output view, or a full conversation help most?

Recommend a presentation after reading five to ten varied development records.
Reuse the person's existing interface if it exposes the needed evidence and
can preserve review attribution. A short Low review can work well in Markdown.
For a larger Medium discovery session, an interactive page usually makes
repeated review and evidence references easier. Do not require a new interface
when the existing one already meets the need.

Describe the question the person is answering. During discovery it is: “What is
wrong, missing, surprising, or acceptable here, and what evidence makes you say
that?” During formal labeling it is: “Does this output meet this particular
criterion?” These are separate activities. Early discovery must allow free-text
observations without requiring the person to choose your proposed categories.

If review is asynchronous, prepare the material and a precise response format,
such as case ID, quoted evidence, and note. Stop short of claiming reviewed or
confirmed requirements. If the person is reviewing live, tell them how new
annotations will reach you and what you will do with them.

## 2. Design the view around the actual responsibility

Inventory primary content, metadata, repeated fields, variable fields, roles,
tool pairs, artifacts, and relevant end state. Confirm where the selected
workload starts and ends. Label other workload steps as context or dependencies;
do not turn their successes or costs into this workload's results.

Use a renderer that lets the person judge the product behavior directly:

| Workload output | Useful default presentation |
| --- | --- |
| Email or support reply | User request, factual context, then an email-like reply with subject and body |
| Structured extraction | Source beside a field table; mark missing, extra, and differing fields |
| Retrieval and answer | Question, ranked retrieved passages with stable document IDs, answer and citations; separate retrieval and answer labels |
| Tool-using conversation | Ordered turns, paired tool calls/results, final response, and independently observed end state |
| Code or file changes | Task, file tree or diff with line numbers, execution/test result, then the relevant conversation |
| Image, document, or other artifact | The artifact the criterion depends on, its source/version, and a reference panel; text/JSON remains available as a fallback |

Show important content at readable contrast. Use consistent role labels and
colors, spacing between logical steps, and a shared border around a tool call
and result. Render code as code and tables as tables. Keep long JSON collapsible
with a useful summary. Collapse an identical repeated prompt, but do not hide
all system messages or tool results: either may contain the evidence of a bug.
Show only recorded content; do not invent missing intermediate reasoning.

The header should identify the selected workload, case, source, run/attempt,
and current review phase. Show the full input and relevant context, the actual
output, and missing-evidence warnings. Make the expected behavior available in
a reference panel once its authority is established. For independent human
labels, hide automated verdicts and their reasons until the human has decided;
otherwise the judge may anchor the reviewer. Do not hide legitimate task facts.

Make every summary lead to the underlying case. A result view must include
unrun, failed, timed-out, and unscored attempts as well as successes. Label costs
and timings with their units and coverage. “Unknown” is different from zero.
If a run is incomplete, show completed versus planned attempts. Calculate all
totals from saved rows instead of typing numbers into the page.

## 3. Select for discovery, then track what was covered

Start from a frozen inventory of eligible cases from the resolved workload.
Keep related conversations, retries, and synthetic variations together. Protect
any reserved test partition: neither discovery scans nor an agent's background
taxonomy search may inspect its content. If the data has already been inspected,
record that fact instead of declaring it untouched later.

The bundled review command renders every case in the chosen eval directory.
Prepare a separate private development selection before using it when other
cases are reserved. A client-side filter does not protect hidden test content.

Describe variation that could expose different errors: user intent, ambiguity,
language, input length, tool path, missing evidence, output type, or domain
boundary. Keep a random component alongside representative selections.

For a development corpus larger than about fifty cases, a practical first batch
is fifteen to twenty-five cases: roughly two thirds representatives across
important groups and one third randomly drawn from the eligible remainder.
Deduplicate related cases, save the random seed, and record the selection
reason for each case. These numbers are a starting point, not a completion
threshold. Review all cases when the corpus is small enough.

If grouping is unclear, use appropriate normalized structural or semantic
features to identify roughly six to ten clusters, then choose representatives
and random records. Use existing local tools where possible. Sending content
to an embedding service is another data transfer and possibly a paid call;
include it in the authorized scope. Inspect whether the clusters reflect useful
differences instead of merely length or formatting.

A cluster map is an optional navigation aid, not a measure of completeness.
A local two-dimensional projection can show group, selected/not selected, and
reviewed/not reviewed, with clicks leading to cases. A coverage table is often
clearer for small data. Maintain counts for eligible groups, sampled cases,
human-reviewed cases, pending suggestions, and uncovered dimensions. Discovery
sampling is deliberately enriched for variety; its failure percentages do not
estimate production prevalence.

## 4. Choose the bundled page or build the needed private extension

The bundled starting point is:

```sh
node <skill-dir>/scripts/eval.mjs review --eval .understudy/evals/important-tasks
```

It reads the current cases and any supplied observed executions without calling
the application or grader. Its HTML shows readable input, expected behavior,
output, ordered trace, raw details, filters, free-text discovery notes, and
separate criterion labels. To review completed runs, use the `report` command.
Neither command launches a live annotation server.

The bundled page keeps edits in memory until explicit browser save or export.
It does not provide server autosave, span comments, a cluster map, a live
taxonomy, an accept/dismiss suggestion queue, or a next-case keyboard workflow.
If the chosen review process needs those features, build and test a private
viewer extension or adapt the person's existing viewer. Keep its script and
stable HTML filename in the eval directory; do not overwrite the generated
`report.html`. Read the bundled renderer before extending it so evidence binding
and escaping are retained. Do not report a planned extension as already working.

A useful live viewer has three views: the task content, coverage across the
corpus, and progress with confirmed modes and pending suggestions. The content
view supports next/previous, jump by case ID, filters, and a reviewed/unreviewed
counter. Later, when criteria are settled, add Pass/Fail/Defer, undo, and save
and next. Keyboard actions must not fire while someone is typing a note.

Use task-level notes as the default. When precise wording matters, add optional
span comments. Store the source field or turn ID, exact quote, and character
offsets against the frozen source text. Do not use a transient DOM position as
the evidence identity. Highlight a selected range before focusing the comment
box, so the person can still see it; remove the temporary highlight on cancel.
Show saved notes beside their evidence or in an accessible list, with edit and
delete controls. Tooltips alone are insufficient. Distinguish agent suggestions
with a label and different border treatment, with visible accept/dismiss buttons.

For a live local service, keep sampling separate from rendering. A small server
can expose current samples, annotations, coverage, taxonomy, and suggestions as
separate endpoints; the viewer polls for new samples and suggestions and saves
each annotation change. Use versioned updates so two stale tabs cannot silently
overwrite each other. Persist before acknowledging a save, show a saving/error
state, and retain an append-only edit history plus a current snapshot. Store
these sidecar files under a private `review/` directory; they are not additional
fields in `cases.jsonl` or `results.jsonl`.

Bind such a service to loopback, validate Host/Origin and a session token on
mutations, and expose only explicit routes. Disable arbitrary path reads and
directory listing. Enforce owner-only files/directories, bounded request sizes,
schema validation, and atomic snapshot replacement. A browser cache is not the
authoritative record. Do not add a cloud backend merely to obtain autosave.

Treat all captured content as untrusted data. Escape text and attribute values;
render Markdown only through a sanitizer with raw HTML and remote images
disabled. Use local assets and an appropriate restrictive content security
policy. Do not fetch external fonts, scripts, images, or links automatically.
Artifact paths must resolve to regular files inside the private eval directory,
without symlinks or traversal. Use size limits. Display model-written HTML only
in an inert sandbox without script or same-origin privileges; prefer a static
image or text when that is enough. Keep answer material inaccessible to the
application under test.

## 5. Preserve review identity, evidence, and edits

Use the bundled version 2 annotation contract when exchanging labels with its
page. Each row has:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `2` for this annotation format |
| `scope` | Opaque frozen review-scope identity generated by the page |
| `evidenceId` | Generated identity of the exact attempt evidence and criterion |
| `caseId`, `repetition` | The stable case and one-based attempt being reviewed |
| `criterionId` | A declared criterion, or `null` for discovery observations |
| `label` | `Pass`, `Fail`, or `Defer`; `null` for discovery observations |
| `note` | The person's observation and supporting evidence |
| `reviewer`, `reviewedAt` | Who made this judgment and its timestamp |

Preserve generated scope and evidence identities; an arbitrary replacement hash
does not establish compatibility. If adopting the bundled viewer with an
existing record format, write and verify a conversion against the matching
frozen evidence. Keeping the native viewer requires no such conversion. Keep span
anchors, taxonomy membership, suggestion state, and edit history in separate
sidecars keyed to these identities. Do not put unsupported fields into the
runtime's case, result, or calibration rows.

Record a real, nonempty reviewer identifier before treating notes as human
evidence. An agent's proposed text must retain its author/source until a person
accepts or edits it. A suggestion is not a label. In particular, accepting a
discovery observation does not automatically assign every criterion a Fail.

The bundled page rejects explicit imports containing stale evidence or a
different scope. Browser restore skips stale annotations and reports them. A
changed output or criterion needs re-review; keep the old judgment with its old
evidence rather than silently carrying it forward. Merely finishing unrelated
attempts should not invalidate existing judgments.

Browser save is opt-in and may store a copy outside the private application
directory. Browser downloads also use the browser's configured destination.
Move exports into the private eval directory, set owner-only permissions, and
remove extra copies. Avoid shared browser profiles. The bundled export is the
current annotation state, not an audit log: preserve successive exports or use
the private extension's edit journal when history matters.

## 6. Run the breadth-and-depth loop

Start with free-text human observations. Do not ask the person to work through
an invented failure taxonomy before they have read examples. Organize their
notes into proposed modes, each with a short definition, confirmed example IDs,
supporting quotes, exclusions, and a version. Keep confirmed and suggested
counts separate, counting distinct cases rather than repeated notes.

During an active live session, monitor actual saved annotation revisions. With
a private service, a simple content/revision poll about every two seconds is
sufficient. With the static page, explicitly use exported files or ask the
person to share the saved notes; browser edits do not magically reach the agent.
Say which mechanism is active. Do not claim to be watching after the process or
interactive session has ended.

After roughly five distinct human-reviewed cases provide a useful signal,
take one discovered mode and search the eligible development corpus for more
instances. Supply the mode definition, exclusions, and human examples. Scan
both reviewed and unreviewed records: a newly recognized mode may have been
missed earlier. For parallel work, one worker per mode is often useful; maintain
a coverage ledger and deduplicate returned case/evidence matches. If only part
of the corpus was scanned, show the eligible and scanned counts and reason.

Each suggested match needs the case/attempt identity, the suspected mode,
quoted evidence or span, a short explanation, and `pending` status. Prefer
finding plausible instances over declaring them true. The human can accept,
dismiss, or edit each suggestion, with bulk actions only after inspecting the
selected evidence. Store the decision and reviewer. A dismissed suggestion must
not keep returning unchanged as if nobody reviewed it.

Discuss ambiguous boundaries using concrete examples. If a mode definition
changes, version it and queue affected earlier cases for re-review. Preserve
original notes and decisions. The agent can propose a grouping, but only an
appropriate human or an established product rule supplies authority for what
counts as a failure.

Return to breadth after each depth pass. Add cases from uncovered groups and a
fresh random selection; explain why they were chosen. Revisit earlier cases
after important new modes appear. Track whether new review batches mostly
repeat known failures or reveal new ones. Stop when the agreed review budget is
used or coverage and discovery saturation support stopping. A budget stop with
open gaps is an incomplete discovery result, not proof that no other failures
exist.

## 7. Move from discovery to independent labels

Turn confirmed modes into narrow criteria with clear pass, fail, and missing
evidence boundaries. Show acceptable alternatives and near misses, then ask a
domain reviewer to apply the frozen rubric. Add category tags only now if they
help. Allow Defer with a reason for genuinely unresolved cases.

For calibration, obtain labels without showing the judge's prediction. Use a
separate blinded view or the pre-grading review page with no saved automated
verdicts. A subset independently labeled by two people can reveal ambiguity;
record disagreements and adjudication, rather than silently replacing one
person's answer. Split related groups together, and keep few-shot training
examples out of development and final testing.

Export human decisions, then join them to actual saved judge predictions by
case/output identity and criterion. Use the existing calibration tools and native
records when suitable. If choosing the bundled calibration helper, the annotation
export is not itself `calibration.jsonl`; perform the explicit conversion in
[formats.md](formats.md) and retain the evidence manifest. Human Defer, judge abstention, missing
prediction, and judge failure are different states. Human annotations also stay
separate from the automated result report.

## 8. Verify and hand off the review surface

Before asking the person to spend time in a custom viewer, check it with
representative short, long, structured, missing-output, and untrusted-content
examples. Inspect the rendered page at useful window sizes. Exercise a whole
workflow: note, edit, undo if offered, label, defer, navigate, reload, export,
import, stale-evidence rejection, and the save-failure path. Test every feature
you claim, including autosave and suggestion acceptance. Confirm that full
evidence remains accessible when sections are collapsed and printing is useful.

Hand off the private viewer location or exact launch command, the review
question, reviewed/eligible counts, confirmed taxonomy, unresolved decisions,
coverage gaps, annotation export location, and the next labeling step. If no
person has reviewed yet, say so. Stop a temporary server when the session ends
and provide a restart command; do not imply a background review loop continues.
Keep this handoff and versioned decisions under `review/`; summarize open
review or evidence limitations in the eval's `check-eval.md`.
