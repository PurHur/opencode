import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Exit } from "effect"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "@/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { AgentCreateTool } from "@/tool/agent-create"
import { ToolRegistry } from "@/tool/registry"
import { TaskTool } from "@/tool/task"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = LayerNode.compile(
  LayerNode.group([
    Agent.node,
    BackgroundJob.node,
    Config.node,
    CrossSpawnSpawner.node,
    Database.node,
    EventV2Bridge.node,
    FSUtil.node,
    Ripgrep.node,
    RuntimeFlags.node,
    Session.node,
    SessionProjector.node,
    SessionRunState.node,
    SessionStatus.node,
    ToolRegistry.node,
    Truncate.node,
  ]),
)

const it = testEffect(layer)

const run = Effect.fn("AgentCreateTest.run")(function* (
  params: {
    name: string
    description: string
    prompt: string
    model?: string
    persist?: boolean
  },
  asked: unknown[] = [],
) {
  const tool = yield* AgentCreateTool
  const def = yield* tool.init()
  return yield* def.execute(params, {
    sessionID: SessionID.create(),
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: (input) =>
      Effect.sync(() => {
        asked.push(input)
      }),
  })
})

const taskDescription = Effect.fn("AgentCreateTest.taskDescription")(function* () {
  const agents = yield* Agent.Service
  const registry = yield* ToolRegistry.Service
  const build = yield* agents.get("build")
  const tools = yield* registry.tools({ ...ref, agent: build })
  return tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
})

describe("agent.register", () => {
  it.instance("registers a subagent that get and list expose", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const info = yield* agents.register({
        name: "haiku-writer",
        description: "Writes haikus",
        prompt: "You write haikus.",
      })

      expect(info.mode).toBe("subagent")
      expect(info.native).toBe(false)
      expect(yield* agents.get("haiku-writer")).toBeDefined()
      expect((yield* agents.list()).map((item) => item.name)).toContain("haiku-writer")
    }),
  )

  it.instance(
    "derives permissions from defaults and user config",
    () =>
      Effect.gen(function* () {
        const agents = yield* Agent.Service
        const info = yield* agents.register({ name: "reviewer", description: "Reviews", prompt: "Review." })

        expect(Permission.evaluate("edit", "*", info.permission).action).toBe("allow")
        expect(Permission.evaluate("bash", "*", info.permission).action).toBe("deny")
        expect(Permission.evaluate("external_directory", Truncate.GLOB, info.permission).action).toBe("allow")
      }),
    { config: { permission: { bash: "deny" } } },
  )

  it.instance("rejects a name that collides with an existing agent", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const error = yield* agents.register({ name: "explore", description: "Nope", prompt: "Nope." }).pipe(Effect.flip)

      expect(error.message).toContain('Agent "explore" already exists')
    }),
  )

  it.instance("rejects a second registration of the same runtime agent", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      yield* agents.register({ name: "dup-agent", description: "First", prompt: "First." })
      const error = yield* agents
        .register({ name: "dup-agent", description: "Second", prompt: "Second." })
        .pipe(Effect.flip)

      expect(error.message).toContain('Agent "dup-agent" already exists')
    }),
  )

  it.instance("rejects names that are not kebab-case", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      for (const name of ["Bad_Name", "trailing-", "-leading", "has space", "UPPER", ""]) {
        const error = yield* agents.register({ name, description: "d", prompt: "p" }).pipe(Effect.flip)
        expect(error.message).toContain("Invalid agent name")
      }
      expect((yield* agents.list()).map((item) => item.name)).not.toContain("Bad_Name")
    }),
  )

  it.instance("unregister removes only runtime agents", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      yield* agents.register({ name: "temp-agent", description: "Temp", prompt: "Temp." })

      expect(yield* agents.unregister("temp-agent")).toBe(true)
      expect(yield* agents.get("temp-agent")).toBeUndefined()
      expect(yield* agents.unregister("explore")).toBe(false)
      expect(yield* agents.get("explore")).toBeDefined()
    }),
  )
})

describe("tool.agent_create", () => {
  it.instance("registers the agent and asks for permission first", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const asked: unknown[] = []
      const result = yield* run(
        { name: "code-reviewer", description: "Reviews diffs", prompt: "You review diffs." },
        asked,
      )

      expect(asked).toEqual([
        {
          permission: "agent_create",
          patterns: ["code-reviewer"],
          always: ["*"],
          metadata: { name: "code-reviewer", description: "Reviews diffs", persist: false },
        },
      ])
      expect(result.metadata.name).toBe("code-reviewer")
      expect(result.metadata.persisted).toBeUndefined()
      expect(result.output).toContain('subagent_type: "code-reviewer"')

      const info = yield* agents.get("code-reviewer")
      expect(info.description).toBe("Reviews diffs")
      expect(info.prompt).toBe("You review diffs.")
      expect(info.mode).toBe("subagent")
    }),
  )

  it.instance("parses the optional provider/model override", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      yield* run({ name: "fast-agent", description: "Fast", prompt: "Be fast.", model: "anthropic/claude-3" })

      const info = yield* agents.get("fast-agent")
      expect(String(info.model?.providerID)).toBe("anthropic")
      expect(String(info.model?.modelID)).toBe("claude-3")
    }),
  )

  it.instance("appears in the task tool description on the next step", () =>
    Effect.gen(function* () {
      const before = yield* taskDescription()
      expect(before).not.toContain("- doc-writer:")

      yield* run({ name: "doc-writer", description: "Writes docs", prompt: "You write docs." })

      const after = yield* taskDescription()
      expect(after).toContain("- doc-writer: Writes docs")
    }),
  )

  it.instance("fails without registering when the name is invalid", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const exit = yield* run({ name: "Not Kebab", description: "d", prompt: "p" }).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect((yield* agents.list()).map((item) => item.name)).not.toContain("Not Kebab")
    }),
  )

  it.instance("persist writes an agent markdown file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const result = yield* run({
        name: "persisted-agent",
        description: "Sticks around",
        prompt: "You persist.",
        model: "anthropic/claude-3",
        persist: true,
      })

      const file = path.join(test.directory, ".opencode", "agent", "persisted-agent.md")
      expect(result.metadata.persisted).toBe(file)

      const content = yield* Effect.promise(() => Bun.file(file).text())
      expect(content).toContain("description: Sticks around")
      expect(content).toContain("mode: subagent")
      expect(content).toContain("model: anthropic/claude-3")
      expect(content).toContain("You persist.")
    }),
  )
})
