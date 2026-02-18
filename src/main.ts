import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { OpenApi } from "./OpenApi.js"
import * as Flag from "effect/unstable/cli/Flag"
import * as Command from "effect/unstable/cli/Command"

const spec = Flag.fileParse("spec").pipe(
  Flag.withAlias("s"),
  Flag.withDescription("The OpenAPI spec file to generate the client from"),
)

const name = Flag.string("name").pipe(
  Flag.withAlias("n"),
  Flag.withDescription("The name of the generated client"),
  Flag.withDefault("Client"),
)

const root = Command.make("openapigen", { spec, name }).pipe(
  Command.withHandler(({ spec, name }) =>
    OpenApi.use((_) => _.generate(spec as any, { name })).pipe(
      Effect.flatMap(Console.log),
    ),
  ),
)

const run = Command.run(root, {
  version: "0.0.0",
})

const Env = Layer.mergeAll(NodeServices.layer, OpenApi.Live)

run.pipe(Effect.provide(Env), NodeRuntime.runMain)
