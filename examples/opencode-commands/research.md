---
description: Research a topic from several angles in parallel, then summarize
agent: general
---

Research this topic thoroughly: $ARGUMENTS

Use the `workflow` tool. Keep it to the simple string-list form — pass `steps` as a
plain list of strings. Fan out the fact-finding into a parallel batch, then join the
findings in a final step. For example:

```json
{
  "description": "research topic",
  "steps": [
    [
      "Find the key facts, definitions, and current state of the topic; cite sources",
      "Find the main alternatives or competing approaches and how they differ",
      "Find common pitfalls, criticisms, and open questions about the topic"
    ],
    "Combine the three findings into one clear summary: what it is, the options, the trade-offs, and a recommendation"
  ]
}
```

Adapt the step prompts to the actual topic above. Keep the steps few and concrete.
Use `concurrency: 3` (or `2` on a small local model). When the workflow finishes,
read the per-step states and present the final summary to the user.
