import { expect, test, describe } from "bun:test"
import { detectRepetitionLoop } from "../../src/session/processor"

describe("detectRepetitionLoop", () => {
  test("ignores short text", () => {
    expect(detectRepetitionLoop("hello world ".repeat(10))).toBe(false)
  })

  test("ignores long but non-repeating prose", () => {
    // varied text over the min length, no back-to-back short-unit loop
    let text = ""
    for (let i = 0; i < 400; i++) text += `Step ${i}: analyze file number ${i} for a distinct issue.\n`
    expect(text.length).toBeGreaterThan(6000)
    expect(detectRepetitionLoop(text)).toBe(false)
  })

  test("detects a short unit repeated back-to-back at the tail", () => {
    const prefix = "Here is a normal analysis of the situation. ".repeat(120) // >6000 chars
    const loop = "/home/ai/eth && python3 audit.py ".repeat(60) // the real failure shape
    expect(detectRepetitionLoop(prefix + loop)).toBe(true)
  })

  test("detects the observed nested-path runaway", () => {
    const prefix = "The user wants me to edit a file at ".padEnd(6100, ".")
    let loop = ""
    for (let i = 0; i < 80; i++) loop += "agent-workspace-11-1"
    expect(detectRepetitionLoop(prefix + loop)).toBe(true)
  })

  test("detects a single repeated line", () => {
    const prefix = "x".repeat(6000)
    const loop = "```\n1330:     }\n```\n".repeat(40)
    expect(detectRepetitionLoop(prefix + loop)).toBe(true)
  })

  test("does not fire when repetition is small / not at the tail", () => {
    const loop = "abc".repeat(5) // only 15 chars of repetition
    const text = "y".repeat(6000) + loop + " and then the analysis continued normally with fresh content here."
    expect(detectRepetitionLoop(text)).toBe(false)
  })
})
