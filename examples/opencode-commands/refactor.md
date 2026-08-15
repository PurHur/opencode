---
description: Plan, apply, and verify a refactor as one workflow
agent: general
---

Carry out this refactor: $ARGUMENTS

Use the `workflow` tool with the simple string-list form — pass `steps` as a plain
list of strings so the results flow forward as a pipeline. A plain list runs each
step after the previous one and feeds it the previous result, which is exactly what a
refactor wants: plan, then apply, then verify. For example:

```json
{
  "description": "refactor pipeline",
  "steps": [
    "Locate every place affected by the refactor and write a concrete step-by-step plan with file paths",
    "Apply the plan from the previous step, editing the files; report exactly what changed",
    "Verify the result: run the build and tests, and report any failures with file:line"
  ]
}
```

Fill the step prompts in with the specifics of the requested refactor. Keep the steps
few and concrete — each step is a fresh subagent with no memory of the others, so
state the target, the constraints, and the expected output in the text. Because this
is a pipeline, use the default `concurrency`. When the workflow finishes, read the
per-step states; if the apply or verify step errored, report what failed instead of
claiming success.
