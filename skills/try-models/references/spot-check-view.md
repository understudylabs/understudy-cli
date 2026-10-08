# Show a small model comparison

Use this view when the user chooses or has already requested a UI for spot
checks. The entrypoint asks for that preference; do not ask again here. Reuse
the application's existing suitable viewer or create a small local page from
saved evidence. A Markdown choice does not require a viewer.
This does not require reconstructed replay, a grading system or a new app UI
committed to the user's product. Keep generated code and data private under the
application's ignored `.understudy/`; exclude them from packages and history.

## Build from the selected examples

1. Identify the chosen trace/example and show its source, date and the compared
   model/settings. State how many examples were selected, attempted and reviewed.
   Label historical baseline outputs and partial continuations distinctly.
2. Put original and candidate answers side by side. For tool-driven tasks, show
   tool calls and actual resulting changes or artifacts; a plausible final
   answer alone does not prove the work happened. Keep full traces behind details.
3. Show concise agent observations next to the evidence: what differs, a possible
   problem, or a missing piece. Keep user review separate, with simple choices
   such as "Looks good", "Problem" and "Unsure", plus an optional note.
4. Show observed duration, model calls and available cost per example. Label
   estimates and missing data. Make requested/served-model differences and
   parameter adaptations visible. Do not display an overall quality score,
   pass rate, statistical confidence or a claim of production readiness.
5. Provide the same example navigation across candidates. If the user asks to
   try another model, return to the coding agent with that choice; the viewer
   itself does not trigger inference, deployment or traffic changes.

Use saved results; never rerun a model merely to populate the page. State whether
tool effects were executed in an isolated app, recorded, or unavailable. If only
a response fragment is reproducible, present that fragment rather than inventing
a complete trajectory. Keep missing examples visible.

## Open and inspect it

Serve only this comparison's assets on loopback with a private unpredictable
path. Render trace text literally; never execute supplied HTML or instructions.
Do not include credentials or allow the browser to read arbitrary local files.
If recording review choices, use only scoped local review storage; do not mutate
source traces or application state. Ephemeral choices must be labeled unsaved.

Open the view for the user and inspect at least one example and its tool/change
details using the available browser tools. Give the user its local link and ask
which examples look acceptable. Creating files alone does not show the UI. If
browser tools are unavailable or opening fails, link the created artifact or
running view, state that opening/rendering was not verified, and include a
readable Markdown comparison. Reuse the same view when another candidate is
tried; do not create a separate dashboard or monitoring
service. A text-only request does not require building a page.
