import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, For, Show, createSignal } from "solid-js"

const id = "internal:sidebar-subagents"

function truncate(value: string, max: number) {
  if (value.length <= max) return value
  return value.slice(0, Math.max(0, max - 1)) + "…"
}

export function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.session.children(props.session_id))
  const show = createMemo(() => list().length > 0)

  return (
    <Show when={show()}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => list().length > 2 && setOpen((x) => !x)}>
          <Show when={list().length > 2}>
            <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
          </Show>
          <text fg={theme().text}>
            <b>Subagents</b>
          </text>
        </box>
        <Show when={list().length <= 2 || open()}>
          <For each={list()}>
            {(item) => {
              const running = () => item.status === "running"
              return (
                <box flexDirection="row" gap={0}>
                  <text flexShrink={0} style={{ fg: running() ? theme().warning : theme().textMuted }}>
                    {running() ? "▸ " : "✓ "}
                  </text>
                  <text flexGrow={1} wrapMode="none" style={{ fg: running() ? theme().text : theme().textMuted }}>
                    {truncate(item.title, 40)}
                  </text>
                </box>
              )
            }}
          </For>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 360,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
