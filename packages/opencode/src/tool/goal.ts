import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./goal.txt"
import { Goal } from "../session/goal"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["add", "complete", "abandon", "list"]).annotate({
    description: "add records a new goal, complete/abandon close one by id, list shows every goal",
  }),
  content: Schema.optional(Schema.String).annotate({
    description: "The goal to record. Required for action=add.",
  }),
  id: Schema.optional(Schema.String).annotate({
    description: "The goal id. Required for action=complete and action=abandon.",
  }),
})

type Metadata = {
  goals: Goal.Info[]
}

function render(goals: Goal.Info[]) {
  if (goals.length === 0) return "No goals."
  return goals.map((goal) => `${goal.id} [${goal.status}] ${goal.content}`).join("\n")
}

export const GoalTool = Tool.define<typeof Parameters, Metadata, Goal.Service>(
  "goal",
  Effect.gen(function* () {
    const goals = yield* Goal.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          if (params.action !== "list") {
            yield* ctx.ask({
              permission: "goal",
              patterns: ["*"],
              always: ["*"],
              metadata: {},
            })
          }

          if (params.action === "add") {
            const content = params.content?.trim()
            if (!content) throw new Error("content is required for action=add")
            yield* goals.add([{ content }])
          }

          if (params.action === "complete" || params.action === "abandon") {
            if (!params.id) throw new Error(`id is required for action=${params.action}`)
            const updated = yield* goals.setStatus(params.id, params.action === "complete" ? "completed" : "abandoned")
            if (!updated) throw new Error(`No goal found with id ${params.id}`)
          }

          const all = yield* goals.list()
          const active = all.filter((goal) => goal.status === "active")
          return {
            title: `${active.length} active goals`,
            output: render(all),
            metadata: { goals: all },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
