# Recover

Reconstruct workflow state only from committed durable facts.

- Identify the latest published Candidate, Reports, decisions, and open Ticket.
- Stop and finalize operational resources, discard or quarantine unpublished output, and publish interruption evidence for an open Ticket.
- Surface cleanup failures separately so they can be retried.
- Never resume a worker conversation, trust terminal output, import unreported work, replay an ambiguous prompt, or issue replacement work automatically.

Recovery is complete when committed state is reconciled and control returns to the planner.
