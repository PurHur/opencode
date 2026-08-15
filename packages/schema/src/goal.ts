export * as Goal from "./goal"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { ascending } from "./identifier"
import { ProjectID } from "./project-id"
import { NonNegativeInt, optional, statics } from "./schema"

export const ID = Schema.String.check(Schema.isStartsWith("goal_")).pipe(
  Schema.brand("Goal.ID"),
  statics((schema) => ({ create: () => schema.make("goal_" + ascending()) })),
)
export type ID = typeof ID.Type

export const Status = Schema.Literals(["active", "completed", "abandoned"]).annotate({ identifier: "Goal.Status" })
export type Status = typeof Status.Type

export const Time = Schema.Struct({
  created: NonNegativeInt,
  updated: NonNegativeInt,
  completed: optional(NonNegativeInt),
}).annotate({ identifier: "Goal.Time" })
export interface Time extends Schema.Schema.Type<typeof Time> {}

export const Info = Schema.Struct({
  id: ID,
  projectID: ProjectID,
  directory: Schema.String,
  content: Schema.String.annotate({ description: "What the goal is" }),
  status: Status,
  priority: optional(Schema.Int.annotate({ description: "Lower sorts first" })),
  note: optional(Schema.String),
  time: Time,
}).annotate({ identifier: "Goal" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

const Updated = define({
  type: "goal.updated",
  schema: {
    projectID: ProjectID,
    directory: Schema.String,
    goals: Schema.Array(Info),
  },
})
export const Event = { Updated, Definitions: inventory(Updated) }
