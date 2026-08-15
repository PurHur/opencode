import path from "path"
import matter from "gray-matter"
import { Effect, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { Provider } from "@/provider/provider"
import * as Tool from "./tool"
import DESCRIPTION from "./agent-create.txt"

export const Parameters = Schema.Struct({
  name: Schema.String.annotate({
    description: 'Lowercase kebab-case identifier for the agent, e.g. "code-reviewer"',
  }),
  description: Schema.String.annotate({
    description: "One sentence describing when this agent should be used",
  }),
  prompt: Schema.String.annotate({
    description: "The system prompt for the agent: what it does, what it avoids, what it returns",
  }),
  model: Schema.optional(
    Schema.String.annotate({
      description: 'Optional model override in "provider/model" form. Omit to inherit the current model.',
    }),
  ),
  persist: Schema.optional(
    Schema.Boolean.annotate({
      description: "Write .opencode/agent/<name>.md so the agent survives restarts. Defaults to false.",
    }),
  ),
})

type Metadata = {
  name: string
  persisted?: string
}

export const AgentCreateTool = Tool.define<typeof Parameters, Metadata, Agent.Service | FSUtil.Service>(
  "agent_create",
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const fs = yield* FSUtil.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "agent_create",
            patterns: [params.name],
            always: ["*"],
            metadata: {
              name: params.name,
              description: params.description,
              persist: params.persist === true,
            },
          })

          const info = yield* agents.register({
            name: params.name,
            description: params.description,
            prompt: params.prompt,
            ...(params.model ? { model: Provider.parseModel(params.model) } : {}),
          })

          let persisted: string | undefined
          if (params.persist) {
            const instance = yield* InstanceState.context
            persisted = path.join(instance.directory, ".opencode", "agent", `${info.name}.md`)
            yield* fs.writeWithDirs(
              persisted,
              matter.stringify(params.prompt.trim() + "\n", {
                description: params.description,
                mode: "subagent",
                ...(params.model ? { model: params.model } : {}),
              }),
            )
          }

          return {
            title: `Created agent ${info.name}`,
            output: [
              `Created subagent "${info.name}".`,
              `Invoke it with the task tool using subagent_type: "${info.name}".`,
              ...(persisted ? [`Saved to ${persisted} so it is available in future sessions.`] : []),
            ].join("\n"),
            metadata: {
              name: info.name,
              ...(persisted ? { persisted } : {}),
            },
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
