import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Context } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { and, eq } from "drizzle-orm"
import { GoalTable } from "@opencode-ai/core/session/sql"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { Goal as GoalSchema } from "@opencode-ai/schema/goal"
import type { ProjectV2 } from "@opencode-ai/core/project"

export const ID = GoalSchema.ID
export type ID = GoalSchema.ID

export const Info = GoalSchema.Info
export type Info = GoalSchema.Info

export const Status = GoalSchema.Status
export type Status = GoalSchema.Status

export const Event = GoalSchema.Event

export interface Input {
  readonly content: string
  readonly priority?: number
  readonly note?: string
}

export interface Interface {
  /** Goals for the active project + directory, active ones first, oldest first. */
  readonly list: () => Effect.Effect<Info[]>
  readonly add: (items: ReadonlyArray<Input>) => Effect.Effect<Info[]>
  readonly setStatus: (id: string, status: Status) => Effect.Effect<Info | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Goal") {}

type Row = typeof GoalTable.$inferSelect
type Scope = { projectID: ProjectV2.ID; directory: string }

function toInfo(row: Row): Info {
  return {
    id: ID.make(row.id),
    projectID: row.project_id,
    directory: row.directory,
    content: row.content,
    status: row.status,
    ...(row.priority === null ? {} : { priority: row.priority }),
    ...(row.note === null ? {} : { note: row.note }),
    time: {
      created: row.time_created,
      updated: row.time_updated,
      ...(row.time_completed === null ? {} : { completed: row.time_completed }),
    },
  }
}

const order = (status: Status) => (status === "active" ? 0 : 1)

function sort(rows: Row[]): Info[] {
  return rows
    .map(toInfo)
    .toSorted(
      (a, b) =>
        order(a.status) - order(b.status) ||
        (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER) ||
        a.time.created - b.time.created ||
        a.id.localeCompare(b.id),
    )
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const { db } = yield* Database.Service

    const scope: Effect.Effect<Scope> = Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      return { projectID: ctx.project.id, directory: ctx.directory }
    })

    const select = Effect.fnUntraced(function* (input: Scope) {
      const rows = yield* db
        .select()
        .from(GoalTable)
        .where(and(eq(GoalTable.project_id, input.projectID), eq(GoalTable.directory, input.directory)))
        .all()
        .pipe(Effect.orDie)
      return sort(rows)
    })

    const publish = Effect.fnUntraced(function* (input: Scope) {
      const goals = yield* select(input)
      yield* events.publish(Event.Updated, {
        projectID: input.projectID,
        directory: input.directory,
        goals,
      })
      return goals
    })

    const list = Effect.fn("Goal.list")(function* () {
      return yield* select(yield* scope)
    })

    const add = Effect.fn("Goal.add")(function* (items: ReadonlyArray<Input>) {
      const ctx = yield* scope
      if (items.length === 0) return yield* select(ctx)
      const now = Date.now()
      const values = items.map((item) => ({
        id: ID.create(),
        project_id: ctx.projectID,
        directory: ctx.directory,
        content: item.content,
        status: "active" as const,
        priority: item.priority ?? null,
        note: item.note ?? null,
        time_created: now,
        time_updated: now,
      }))
      yield* db.insert(GoalTable).values(values).run().pipe(Effect.orDie)
      yield* publish(ctx)
      const created = new Set(values.map((value) => value.id))
      return (yield* select(ctx)).filter((goal) => created.has(goal.id))
    })

    const setStatus = Effect.fn("Goal.setStatus")(function* (id: string, status: Status) {
      const ctx = yield* scope
      const now = Date.now()
      yield* db
        .update(GoalTable)
        .set({
          status,
          time_updated: now,
          time_completed: status === "active" ? null : now,
        })
        .where(
          and(eq(GoalTable.id, id), eq(GoalTable.project_id, ctx.projectID), eq(GoalTable.directory, ctx.directory)),
        )
        .run()
        .pipe(Effect.orDie)
      const goals = yield* publish(ctx)
      return goals.find((goal) => goal.id === id)
    })

    return Service.of({ list, add, setStatus })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [EventV2Bridge.node, Database.node] })

export * as Goal from "./goal"
