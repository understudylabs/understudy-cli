# Show the comparison

Prefer the application's existing eval UI when it shows the same evidence. The
bundled viewer is an offline option for bundled eval runs. A native runner does
not need to export a new schema if its own viewer works; otherwise the coding
agent may build a small local page reading its saved results.

The user should be able to see:

- which workload, frozen cases, checks, model configurations and observation
  windows were compared, with the source paths and limits;
- each run's API format and disclosed adaptations; label comparisons across
  different protocols as model-plus-adapter results;
- planned versus observed results, passes/failures, unscored and missing attempts;
- a chosen candidate beside the incumbent, matched by case and repetition;
- the input, both actual outputs, grading reasons and relevant tool/state evidence;
- filters for regressions, improvements and unresolved evidence;
- declared model versus serving receipts, including fallback and mixed-model runs;
- latency and cost with units, basis and missing coverage; judge cost separately.

Explain concrete failures before an aggregate winner. Label reference prices as
estimates and synthetic demonstrations as synthetic. Do not hide failed attempts,
pick the best repetition or label a fallback answer as a candidate success.

Keep evidence local and owner-only, excluded from Git and application packages.
Treat all case text, model outputs and tool contents as untrusted display data.
Escape HTML; use text rendering, no raw HTML or executable Markdown from results.
Use no third-party scripts, fonts, analytics or remote assets. Opening a private
local file is sufficient; if serving is required, bind only to loopback and
serve the report directory rather than the repository or home directory.

Open the viewer using the coding host's file/browser tools. Check at least one
case selection, candidate switch, regression filter and unresolved-evidence row.
Verify both outputs and their reasons are readable, and missing values appear
as unknown instead of zero. Check a narrow viewport if the viewer will be shared
on smaller screens. Include a working local report link in the final answer.
If the host cannot open or inspect it, say exactly which checks remain unverified
and give the user a local opening command. Do not claim it was shown merely
because the file exists.
