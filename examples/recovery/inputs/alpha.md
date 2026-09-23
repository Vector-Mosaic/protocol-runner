# Review item alpha

Claim: a completion message is enough to establish that an assigned output exists.

Observation: a worker returned `completed`, but the required output file was
absent. The invocation's contract required both the file and a completion report.

Question: what can the coordinator conclude, and what remains unresolved?
