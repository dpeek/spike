# Change 010 remediation verification

Closed accepted findings:

- Remediation Tickets embed one complete canonical serialization of the exact authorizing review Report. Issuance rejects reports above the 64 KiB context limit before Ticket or input-ref effects.
- The configured implementation adapter now owns PID-backed stop, finalize, and forget lifecycle operations. Recovery waits for the worker terminal state and late dispatch completion cannot recreate runtime state.
- Real-Git scenarios cover canonical report context and oversize refusal, replacement/fresh-review behavior, partial/blocked/interrupted terminal distinctions, churn warnings, warning-only status, live recovery, and unchanged main/Goal refs/worktree assertions.

Verification run:

```text
bun test test/scenario/application.test.ts
12 pass, 0 fail

bun run check
150 pass, 0 fail
```
