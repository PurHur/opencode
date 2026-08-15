---
description: Audit the changed files across several dimensions, then report
agent: general
---

Audit the code that has changed on this branch.

The changed files are:

!`git diff --name-only HEAD`

Use the `workflow` tool with the simple string-list form (pass `steps` as a plain
list of strings). Fan the audit out into a parallel batch of independent dimensions,
then consolidate into one prioritized report. For example:

```json
{
  "description": "audit changed files",
  "steps": [
    [
      "Review the changed files for correctness bugs and logic errors; list file:line and severity",
      "Review the changed files for security issues (input handling, secrets, auth); list file:line and severity",
      "Review the changed files for missing or weak test coverage; list what is untested"
    ],
    "Merge the three reviews into one prioritized report, highest severity first, each finding with a concrete fix"
  ]
}
```

Put the actual changed file paths into the step prompts so each subagent knows what
to read. Keep the steps few and concrete, and use `concurrency: 3` (or `2` on a small
local model). After the workflow finishes, check the per-step states and present the
consolidated report.

Extra focus (optional): $ARGUMENTS
