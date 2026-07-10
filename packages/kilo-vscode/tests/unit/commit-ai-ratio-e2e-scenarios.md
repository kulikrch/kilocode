# Commit AI Ratio E2E Scenarios

These scenarios model user-visible flows around local git commits and the commit AI ratio calculator.

| ID | User flow | Expected outcome |
|---|---|---|
| S01 | User has old commits before feature cutoff, then commits new agent code. | Only the post-cutoff commit is reported. |
| S02 | Another git author creates a commit in the same repository. | Other-author commit is ignored. |
| S03 | Agent writes code through tools and user commits it. | `agent_lines` and `agent_percent` are reported. |
| S04 | Inline completion inserts code and user commits it. | `inline_lines` and `inline_percent` are reported. |
| S05 | User mixes inline completion, agent edits, and manual code in one commit. | Inline and agent portions are split, manual code stays outside AI counts. |
| S06 | Agent generates code, user deletes part of it before committing. | Only generated lines that survive in the commit are counted. |
| S07 | User creates a commit, resets it before the worker runs, edits again, and commits. | Only the final reachable commit is reported. |
| S08 | Worker reports a commit, then user amends it. | The amended commit is reported again because the commit/patch key changed. |
| S09 | User makes two commits with AI records between them. | Each commit uses only records in its own parent-to-commit window. |
| S10 | User reverts an AI commit after it was reported. | Revert deletion commit does not emit an added-code payload. |
| S11 | Same generated line appears twice in one commit. | Both surviving generated lines are counted once each. |
| S12 | User has two workspace repositories open. | Worker reports eligible commits from both repositories. |
| S13 | Disk attribution file is corrupted. | Worker ignores the corrupted file and still reports the commit with zero AI contribution. |
| S14 | Attribution record references a file that is not changed by the commit. | Record is ignored for that commit. |
| S15 | User makes a manual-only commit. | Commit is reported with zero AI percentages. |
| S16 | Worker runs twice without repository changes. | Commit is reported only once. |
