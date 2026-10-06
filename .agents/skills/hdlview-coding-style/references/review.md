# Final review for agents

Use this as a review aid, not a required report or a new file for every task.

- [ ] The requested behavior and relevant failures are handled completely.
- [ ] Each added abstraction, dependency, option, and fallback has a current use.
- [ ] No avoidable duplicate state, validation, error logging, or indirection remains.
- [ ] Names and control flow are clear; comments contribute information code cannot.
- [ ] Boundaries validate external input; errors stay visible; types and checks
      have not been weakened to make the change pass.
- [ ] Resources, cancellation, and async results have clear ownership and cleanup.
- [ ] Applicable HDLView identity, snapshot, stage, and performance invariants hold.
- [ ] Tests cover meaningful behavior/invariants at an appropriate level; no tests
      were added merely to mirror implementation or satisfy a quota.
- [ ] The diff contains no unrelated edits, abandoned code, or accidental API/format
      changes. Necessary documentation and callers are updated.
- [ ] Relevant checks actually ran, or the exact blocker is reported. The final
      response states the change, verification, and material limits concisely.
