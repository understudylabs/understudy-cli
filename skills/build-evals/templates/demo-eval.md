# Synthetic parcel quote demonstration

This is wholly invented, local, and free of network calls. Its responsibility is
quoting a parcel price from weight and service. The manifest declares a synthetic
workload with invented organization/project/workload identifiers; it represents
no real Understudy resource. Eight task instances exercise the same responsibility:

- Up to and including 500 grams costs 4 units.
- Above 500 grams costs 7 units.
- Priority adds 3 units.

The eight cases combine weights 250, 500, 501, and 1000 grams with standard and priority service. The application adapter deliberately uses a strict `< 500` comparison. Both 500-gram cases therefore overcharge by 3 units and fail correctness while retaining valid output format. The other six cases pass. This is a measurement demonstration, not a customer result.

The four controls independently cover acceptable output, an acceptable additional field, a wrong quote in valid JSON, and an invalid string price. `validate` must accept all controls before the suite runs. `run` executes the local adapter; `grade` grades the saved historical demo outputs; `regrade` reuses a recorded run without calling the adapter. Reports retain every case and attempt.

The demo's zero costs are known zero because no inference occurs. Real missing
costs must remain unknown. For an application eval, first understand its code and
resolve the actual Understudy organization/project/workload. Set the manifest's
workload source to `understudy` with the returned identity, verify task/request
membership, and replace these examples, requirements, adapter, and controls with
authorized evidence. A real workload with synthetic cases still retains its real
workload identity. Keep this directory excluded from history and packages.

New failure examples should become a later version of this workload's eval.
The measured boundary bug is evidence for a later application change; this demo
does not apply that change or modify workload configuration.
