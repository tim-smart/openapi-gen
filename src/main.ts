import * as Options from "@effect/cli/Options"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as NodeContext from "@effect/platform-node/NodeContext"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as Command from "@effect/cli/Command"
import { OpenApi } from "./OpenApi.js"

const spec = Options.fileParse("spec").pipe(
  Options.withAlias("s"),
  Options.withDescription("The OpenAPI spec file to generate the client from"),
)

const convert = Options.boolean("convert").pipe(
  Options.withAlias("c"),
  Options.withDescription("Convert from OpenAPI 2 to OpenAPI 3 first"),
)

const root = Command.make("openapigen", { spec, convert }).pipe(
  Command.withHandler(
    Effect.fnUntraced(function* ({ spec, convert }) {
      if (convert) {
        spec = yield* OpenApi.convert(spec as any)
      }
      return yield* OpenApi.generate(spec as any).pipe(
        Effect.flatMap(Console.log),
      )
    }),
  ),
)

const run = Command.run(root, {
  name: "openapigen",
  version: "0.0.0",
})

const Env = Layer.mergeAll(NodeContext.layer, OpenApi.Live)

run(process.argv).pipe(Effect.provide(Env), NodeRuntime.runMain)
