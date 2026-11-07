# Third-party source

vendor/kovey/cjk.js is unchanged JavaScript from kovey/dsh-memory 0.3.2,
commit 73e0a3b47fb047cc9fe3cd8269a5f267c6cda45c, path
dist/store/sqlite/cjk.js. Its original comments are retained. Upstream
package.json declares Apache-2.0. A root LICENSE request at that commit
returned 404; this project does not claim upstream supplied a license file.

The Apache-2.0 standard text is included in licenses/Apache-2.0.txt from the
SPDX license-list-data project (Git blob 137069b823873b8bcf42979bcf8e9371052d26a2).
It is license text, not a fabricated upstream NOTICE. The upstream package
manifest is retained as licenses/kovey-package.json to preserve the declaration.

Only the standalone CJK query/segmentation module is loaded. The original
plugin entry, store registry, sync, embedding, hooks, logging and importing
chains are excluded. This project's backend, source gate and lifecycle are
separate implementations. The sourceMappingURL comment names an upstream
development map and does not load one at runtime.
