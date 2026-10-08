# Replay evidence contracts

## Streamed tool calls

Capture reconstruction and candidate replay share the same response decoder.
For Chat Completions tool-call streams:

- A supplied index must be a non-negative safe integer. Each index owns one
  stable call identity and name; different indexes cannot reuse an identity.
  Indexed fragments may arrive in parallel or interleave. Calls retain their
  first-observed order.
- An indexless call starts with an explicit identity and name. Later fragments
  carrying its identity can continue that call without repeating start metadata
  (the name). Repeated starts with the same identity are rejected even when the
  first call's arguments are unfinished. An anonymous fragment can
  continue only one unambiguously open call and cannot introduce a name.
- Starting a new identity seals prior indexless calls whose arguments are
  complete JSON objects or arrays. A sealed identity cannot reopen. Overlapping
  unfinished calls require explicit identities on their fragments. Scalar JSON
  is never used to infer a boundary because a valid scalar can still be a prefix.
- Tool-call streams require both a choice finish and the stream completion
  marker, with an identity, name, and argument fragments for every call.
  Missing evidence or a length-truncated choice is incomplete. Output after a
  choice finish is rejected; subsequent metadata-only events, including usage,
  remain supported.

Legacy `function_call` streams also require a nonempty name, an observed argument
fragment, non-length termination, and the completion marker. An explicit empty
argument fragment is malformed argument JSON; an absent fragment is incomplete
stream evidence. The decoder does not invent a candidate call identity for the
legacy format.

Ambiguous boundaries, conflicting or duplicate identities, malformed stream
events, and invalid fragment shapes produce `inference_stream_decode_error` in
candidate replay, with a specific `diagnostic` code and message. Incomplete
streams produce `inference_stream_incomplete`. Neither returns executable
candidate calls. A completed, unambiguously assembled call with malformed JSON
arguments remains `invalid_tool_call`, including duplicate argument keys; it is
not a stream dependency.

Reconstruction records `capture_stream_decode_error` or
`capture_stream_incomplete` as technical causes. It retains the raw response and
diagnostic in the affected turn and does not use rejected output to infer a
parent. Partial captured exchanges remain evidence with unusable fixtures.
Partitioned summaries omit raw response bodies; verified task details retain them.
Original capture files and replay response journals retain the original bytes.
Existing successful indexed, Messages, Responses, and non-streaming response
formats keep their ordinary decoding behavior. Previously guessed indexless
streams may now require inspection rather than yielding a corrupted call.

Upgrading or inspecting a run does not rewrite its saved reconstruction. Run
`migrate --resume` with the saved scope to reconstruct the captures with this
decoder. A changed task digest requires a new replay id. Replay decodes saved
raw model responses again when reusing completed request receipts.

## Owned request and tool inputs

At each harness API invocation, the CLI validates and snapshots model or mock
tool inputs before queuing work. Request limits and protocol fields are applied
before taking the owned JSON snapshot. The transmitted body, journaled body,
and request digest describe that same JSON value, even when the harness later
edits its conversation. Candidate arguments, effective arguments, and tool
schemas receive the same ownership protection. Returned outputs remain isolated
from saved outputs.

New journals use schema version 2 to identify the explicit tool environment and
validate operation order. The digest algorithm is unchanged. Historical version
1 journals remain usable only with their original settings and exact recorded
outputs; they cannot be reused for a new tool environment or offline execution.
Valid unchanged runs resume from completed entries without sending those
requests again. Changed inputs and damaged digests remain rejected. No migration
or automatic repair rewrites old damaged journals; preserve them and use a new
replay id for a new run after inspection.
