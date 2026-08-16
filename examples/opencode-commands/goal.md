---
description: Manage persistent project goals (add / list / complete / abandon)
agent: build
---

Manage the project's goals using the `goal` tool, based on this request: $ARGUMENTS

Rules for interpreting $ARGUMENTS:
- starts with "add " (or is plain text)  -> call goal with action:"add", content:<the rest>
- "list" or empty                        -> call goal with action:"list"
- "complete <id>"                        -> call goal with action:"complete", id:<id>
- "abandon <id>"                         -> call goal with action:"abandon", id:<id>

Call the `goal` tool exactly once with the right action, then briefly confirm what
changed (for "list", show the current goals). Do not do anything else.
