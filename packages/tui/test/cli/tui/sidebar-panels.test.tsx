/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { DEFAULT_THEMES, resolveTheme } from "../../../src/theme"
import { View as GoalView } from "../../../src/feature-plugins/sidebar/goal"
import { View as SubagentsView } from "../../../src/feature-plugins/sidebar/subagents"

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  testSetup?.renderer.destroy()
  testSetup = undefined
})

const theme = resolveTheme(DEFAULT_THEMES.opencode, "dark")

async function renderFrame(node: () => any) {
  testSetup = await testRender(node, { width: 40, height: 12 })
  await testSetup.renderOnce()
  await testSetup.renderOnce()
  return testSetup
    .captureCharFrame()
    .split("\n")
    .map((line: string) => line.trimEnd())
    .join("\n")
    .trimEnd()
}

describe("sidebar panels", () => {
  test("Goals panel renders active goals", async () => {
    const api = {
      theme: { current: theme },
      state: {
        session: {
          goal: () => [
            { content: "Ship the release", status: "active" },
            { content: "Write the tests", status: "active" },
          ],
        },
      },
    } as any

    const frame = await renderFrame(() => <GoalView api={api} session_id="ses_root" />)
    console.log("GOALS FRAME:\n" + frame)

    expect(frame).toContain("Goals")
    expect(frame).toContain("Ship the release")
    expect(frame).toContain("Write the tests")
  })

  test("Subagents panel renders running and idle children", async () => {
    const api = {
      theme: { current: theme },
      state: {
        session: {
          children: () => [
            { id: "ses_a", title: "@reviewer subagent", status: "running" },
            { id: "ses_b", title: "@docs subagent", status: "idle" },
          ],
        },
      },
    } as any

    const frame = await renderFrame(() => <SubagentsView api={api} session_id="ses_root" />)
    console.log("SUBAGENTS FRAME:\n" + frame)

    expect(frame).toContain("Subagents")
    expect(frame).toContain("@reviewer subagent")
    expect(frame).toContain("@docs subagent")
  })
})
