/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { testRender, type JSX } from "@opentui/solid"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { ArgsProvider } from "../../../src/context/args"
import { KVProvider } from "../../../src/context/kv"
import { ProjectProvider } from "../../../src/context/project"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncProvider } from "../../../src/context/sync"
import { PermissionProvider } from "../../../src/context/permission"
import { ExitProvider } from "../../../src/context/exit"
import { ThemeProvider } from "../../../src/context/theme"
import { RouteProvider } from "../../../src/context/route"
import { TuiConfigProvider } from "../../../src/config"
import { Workflow } from "../../../src/routes/session"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"
import { TestTuiContexts } from "../../fixture/tui-environment"

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  testSetup?.renderer.destroy()
  testSetup = undefined
})

const metadata = {
  description: "combine words",
  steps: { a: "done", b: "running", c: "pending" },
  sessions: { a: "ses_a", b: "ses_b" },
}

const input = {
  description: "combine words",
  steps: [
    { id: "a", prompt: "Reply ALPHA" },
    { id: "b", agent: "reviewer", prompt: "Reply BRAVO", depends_on: ["a"] },
    { id: "c", prompt: "Combine {{a}} {{b}}", depends_on: ["a", "b"] },
  ],
}

const part = {
  id: "prt_workflow",
  sessionID: "ses_root",
  messageID: "msg_root",
  type: "tool" as const,
  callID: "call_workflow",
  tool: "workflow",
  state: { status: "running" as const, input, metadata, title: "combine words", time: { start: 0 } },
}

describe("TUI workflow renderer", () => {
  test("renders a live workflow block with per-step status", async () => {
    await using tmp = await tmpdir()
    const state = path.join(tmp.path, "state")
    await mkdir(state, { recursive: true })
    await Bun.write(path.join(state, "kv.json"), "{}")
    const resolvedConfig = createTuiResolvedConfig({ keybinds: {}, leader_timeout: 1000 })
    const events = createEventSource()
    // Child-session hydration from WorkflowStep.onMount — return empty payloads.
    const calls = createFetch((url) => {
      if (url.pathname.startsWith("/session/ses_")) {
        if (url.pathname.endsWith("/message")) return json([])
        if (url.pathname.endsWith("/todo")) return json([])
        if (url.pathname.endsWith("/diff")) return json({ files: [] })
        return json({ id: url.pathname.split("/")[2], parentID: "ses_root", directory })
      }
      return undefined
    })

    function Harness() {
      return (
        <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
          <TuiConfigProvider config={resolvedConfig}>
            <ArgsProvider>
              <KVProvider>
                <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
                  <PermissionProvider>
                    <ProjectProvider>
                      <ExitProvider exit={() => {}}>
                        <SyncProvider>
                          <RouteProvider>
                            <ThemeProvider mode="dark">
                              <Workflow input={input} metadata={metadata} tool="workflow" part={part as any} />
                            </ThemeProvider>
                          </RouteProvider>
                        </SyncProvider>
                      </ExitProvider>
                    </ProjectProvider>
                  </PermissionProvider>
                </SDKProvider>
              </KVProvider>
            </ArgsProvider>
          </TuiConfigProvider>
        </TestTuiContexts>
      )
    }

    testSetup = await testRender(() => <Harness />, { width: 72, height: 16 })
    for (let i = 0; i < 6; i++) {
      await testSetup.renderOnce()
      await Bun.sleep(20)
    }
    const frame = testSetup
      .captureCharFrame()
      .split("\n")
      .map((line: string) => line.trimEnd())
      .join("\n")
      .trimEnd()

    console.log("FRAME:\n" + frame)

    expect(frame).toContain("Workflow — combine words")
    expect(frame).toContain("b @reviewer")
    expect(frame).toContain("[✓]")
    expect(frame).toContain("[•]")
    expect(frame).toContain("[○]")
    // Summary now carries the live running count alongside the done tally.
    expect(frame).toContain("1/3 done · 1 running")
  })

  test("renders a completed all-done workflow with a duration", async () => {
    await using tmp = await tmpdir()
    const state = path.join(tmp.path, "state")
    await mkdir(state, { recursive: true })
    await Bun.write(path.join(state, "kv.json"), "{}")
    const resolvedConfig = createTuiResolvedConfig({ keybinds: {}, leader_timeout: 1000 })
    const events = createEventSource()
    const calls = createFetch((url) => {
      if (url.pathname.startsWith("/session/ses_")) {
        if (url.pathname.endsWith("/message")) return json([])
        if (url.pathname.endsWith("/todo")) return json([])
        if (url.pathname.endsWith("/diff")) return json({ files: [] })
        return json({ id: url.pathname.split("/")[2], parentID: "ses_root", directory })
      }
      return undefined
    })

    const doneMetadata = {
      description: "combine words",
      steps: { a: "done", b: "done", c: "done" },
      sessions: { a: "ses_a", b: "ses_b", c: "ses_c" },
    }
    const donePart = {
      id: "prt_workflow",
      sessionID: "ses_root",
      messageID: "msg_root",
      type: "tool" as const,
      callID: "call_workflow",
      tool: "workflow",
      state: {
        status: "completed" as const,
        input,
        metadata: doneMetadata,
        title: "combine words",
        output: "",
        time: { start: 0, end: 12000 },
      },
    }

    function Harness() {
      return (
        <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
          <TuiConfigProvider config={resolvedConfig}>
            <ArgsProvider>
              <KVProvider>
                <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
                  <PermissionProvider>
                    <ProjectProvider>
                      <ExitProvider exit={() => {}}>
                        <SyncProvider>
                          <RouteProvider>
                            <ThemeProvider mode="dark">
                              <Workflow input={input} metadata={doneMetadata} tool="workflow" part={donePart as any} />
                            </ThemeProvider>
                          </RouteProvider>
                        </SyncProvider>
                      </ExitProvider>
                    </ProjectProvider>
                  </PermissionProvider>
                </SDKProvider>
              </KVProvider>
            </ArgsProvider>
          </TuiConfigProvider>
        </TestTuiContexts>
      )
    }

    testSetup = await testRender(() => <Harness />, { width: 72, height: 16 })
    for (let i = 0; i < 6; i++) {
      await testSetup.renderOnce()
      await Bun.sleep(20)
    }
    const frame = testSetup
      .captureCharFrame()
      .split("\n")
      .map((line: string) => line.trimEnd())
      .join("\n")
      .trimEnd()

    console.log("FRAME (completed):\n" + frame)

    expect(frame).toContain("Workflow — combine words")
    expect(frame).toContain("3/3 done")
    // 12000ms delta rendered via Locale.duration.
    expect(frame).toContain("12.0s")
  })

  test("renders an error step and its skipped dependent", async () => {
    await using tmp = await tmpdir()
    const state = path.join(tmp.path, "state")
    await mkdir(state, { recursive: true })
    await Bun.write(path.join(state, "kv.json"), "{}")
    const resolvedConfig = createTuiResolvedConfig({ keybinds: {}, leader_timeout: 1000 })
    const events = createEventSource()
    const calls = createFetch((url) => {
      if (url.pathname.startsWith("/session/ses_")) {
        if (url.pathname.endsWith("/message")) return json([])
        if (url.pathname.endsWith("/todo")) return json([])
        if (url.pathname.endsWith("/diff")) return json({ files: [] })
        return json({ id: url.pathname.split("/")[2], parentID: "ses_root", directory })
      }
      return undefined
    })

    const failMetadata = {
      description: "combine words",
      steps: { a: "done", b: "error", c: "skipped" },
      sessions: { a: "ses_a", b: "ses_b" },
    }
    const failPart = {
      id: "prt_workflow",
      sessionID: "ses_root",
      messageID: "msg_root",
      type: "tool" as const,
      callID: "call_workflow",
      tool: "workflow",
      state: {
        status: "completed" as const,
        input,
        metadata: failMetadata,
        title: "combine words",
        output: "",
        time: { start: 0, end: 5000 },
      },
    }

    function Harness() {
      return (
        <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
          <TuiConfigProvider config={resolvedConfig}>
            <ArgsProvider>
              <KVProvider>
                <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
                  <PermissionProvider>
                    <ProjectProvider>
                      <ExitProvider exit={() => {}}>
                        <SyncProvider>
                          <RouteProvider>
                            <ThemeProvider mode="dark">
                              <Workflow input={input} metadata={failMetadata} tool="workflow" part={failPart as any} />
                            </ThemeProvider>
                          </RouteProvider>
                        </SyncProvider>
                      </ExitProvider>
                    </ProjectProvider>
                  </PermissionProvider>
                </SDKProvider>
              </KVProvider>
            </ArgsProvider>
          </TuiConfigProvider>
        </TestTuiContexts>
      )
    }

    testSetup = await testRender(() => <Harness />, { width: 72, height: 16 })
    for (let i = 0; i < 6; i++) {
      await testSetup.renderOnce()
      await Bun.sleep(20)
    }
    const frame = testSetup
      .captureCharFrame()
      .split("\n")
      .map((line: string) => line.trimEnd())
      .join("\n")
      .trimEnd()

    console.log("FRAME (error+skipped):\n" + frame)

    expect(frame).toContain("[✗]")
    expect(frame).toContain("[–]")
    expect(frame).toContain("1 failed")
    expect(frame).toContain("1 skipped")
  })
})
