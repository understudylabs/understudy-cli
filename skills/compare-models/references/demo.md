# Synthetic runner-to-UI walkthrough

Use a separate empty scratch application directory. This example makes no
network or model calls, needs no credentials, and uses only invented inputs,
model names, costs and timing. Node.js 22+ and Git must be available. Install
matching `build-evals` and `compare-models` skills together.

Run the existing eval demo initializer, then copy the comparison's synthetic
adapter into that private eval **before** validation and any baseline run:

```sh
node <skills-root>/build-evals/scripts/eval.mjs init --name parcel --mode low --demo
cp <skills-root>/compare-models/templates/demo-adapter.mjs .understudy/evals/parcel/adapter.mjs
chmod 600 .understudy/evals/parcel/adapter.mjs
node <skills-root>/build-evals/scripts/eval.mjs validate --eval .understudy/evals/parcel
node <skills-root>/build-evals/scripts/eval.mjs run --eval .understudy/evals/parcel --run baseline --model synthetic/incumbent
node <skills-root>/build-evals/scripts/eval.mjs run --eval .understudy/evals/parcel --run fast --model synthetic/fast
node <skills-root>/build-evals/scripts/eval.mjs run --eval .understudy/evals/parcel --run careful --model synthetic/careful
node <skills-root>/compare-models/scripts/compare.mjs --name parcel-models \
  --baseline .understudy/evals/parcel/results/baseline \
  --candidate .understudy/evals/parcel/results/fast \
  --candidate .understudy/evals/parcel/results/careful
```

Open `.understudy/comparisons/parcel-models/report.html`. The incumbent has two
boundary errors; the fast fixture has priority-price errors. The careful fixture
returns correct prices but contains one fallback and one unknown cost. Those
limitations must remain visible even though its price checks pass.

Exercise candidate selection, case details and regression/unresolved filters.
Inspect outputs and grader reasons side by side. Explain why the fastest fixture
is not automatically the recommended option and why missing cost/fallback limits
the careful fixture's conclusion. These are tests of the workflow and report,
not evidence about any actual model. All generated artifacts stay in the private
scratch application's `.understudy/` directory.
