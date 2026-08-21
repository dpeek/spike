# Remediation evidence

## Closed findings

- `symlink-refusal-after-side-effects`: root creation used recursive `mkdir`, which follows an existing ancestor symlink. `prepareDataRoot` now walks the absolute selected path, lstat-validates every existing component, and creates only one missing lexical component at a time before revalidating it. Focused tests cover direct root, ancestor, `projects`, exchange, and runtime boundaries and assert no outside publication.
- `registration-slug-not-validated`: registration reads parsed the schema but did not associate metadata with the selected path. Reads now reject a frontmatter slug different from `projects/<slug>/project.md` before returning the record. Focused malformed, wrong-type, and mismatched cases pass.
- `unsafe-cutover-instructions`: the workflow now provides an unset-versus-blank shell selector matching production, requires legacy status capture before upgrade, copies contents to the exact Project root, and names count/ID/status/revision equivalence checks before deletion.
- `required-tests-and-check-fail`: removed the unused Worker `mkdir` import; converted the Plan fixture to initialize and activate an isolated central Project root; expanded Project focused regressions.

## Verification

- `/opt/spike/node_modules/@typescript/typescript-linux-arm64/lib/tsc --noEmit` passed. (The repository mount makes `bun run typecheck` fail to execute its local binary with EACCES.)
- `bun test src/project.test.ts src/plan.test.ts` passed: 9 tests, 31 expectations.
- Full default test invocation still has pre-existing, unmigrated scenario/CLI fixtures that assume repository `.spike` paths, and direct execution of `bin/spike` is blocked by this checkout's noexec mount. These require remaining fixture migration and were not represented as passing verification.
