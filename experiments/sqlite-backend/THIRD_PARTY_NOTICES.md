# Third-party source

The unchanged JavaScript files under vendor/kovey are from kovey/dsh-memory,
commit 73e0a3b47fb047cc9fe3cd8269a5f267c6cda45c (package version 0.3.2).
Upstream package.json declares Apache-2.0. The selected revision does not include
a root LICENSE or NOTICE file; this is recorded rather than silently attributing
another project's notices. Distribution must include the Apache-2.0 license text.

Only the SQLite schema, record/FTS helpers, CJK segmentation and their local
logging dependency are used. Upstream plugin entry, hooks, sync, automatic text
import/export, model routing and remote embedding are not loaded. Local lifecycle
and policy code are separate. Original comments are retained; source-map comments
refer to upstream development artifacts and do not load them at runtime.
