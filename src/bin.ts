import * as Effect from "effect/Effect"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import { run, Env } from "./main.js"

run(process.argv).pipe(Effect.provide(Env), NodeRuntime.runMain)
