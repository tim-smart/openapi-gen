import * as Options from "@effect/cli/Options"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as NodeContext from "@effect/platform-node/NodeContext"
import * as Command from "@effect/cli/Command"
import * as CliConfig from "@effect/cli/CliConfig"
import * as FileSystem from "@effect/platform/FileSystem"
import * as FetchHttpClient from "@effect/platform/FetchHttpClient"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { OpenApi } from "./OpenApi.js"
import * as Yaml from "yaml"
import type { OpenAPISpec } from "@effect/platform/OpenApi"
import * as HttpClient from "@effect/platform/HttpClient"

const spec = Options.text("spec").pipe(
  Options.withAlias("s"),
  Options.withDescription(
    "The OpenAPI spec file path or URL to generate the client from",
  ),
)

const name = Options.text("name").pipe(
  Options.withAlias("n"),
  Options.withDescription("The name of the generated client"),
  Options.withDefault("Client"),
)

const typeOnly = Options.boolean("type-only").pipe(
  Options.withAlias("t"),
  Options.withDescription("Generate a type-only client without schemas"),
)

const isUrl = (str: string): boolean =>
  str.startsWith("http://") || str.startsWith("https://")

const root = Command.make("openapigen", { spec, typeOnly, name }).pipe(
  Command.withHandler((args) => main(args).pipe(Effect.flatMap(Console.log))),
)

const fileParsers: Record<string, (content: string) => unknown> = {
  json: (content: string) => JSON.parse(content),
  yaml: (content: string) => Yaml.parse(content),
  yml: (content: string) => Yaml.parse(content),
}

export const main = ({
  spec: specInput,
  typeOnly,
  name,
}: {
  spec: string
  typeOnly: boolean
  name: string
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const http = yield* HttpClient.HttpClient
    const extension = specInput.split(".").pop()?.toLowerCase() ?? ""

    const parser = fileParsers[extension]

    if (!parser)
      return yield* Effect.fail(`Unsupported file format: ${extension}`)

    const specRawContent = isUrl(specInput)
      ? yield* http
          .get(specInput)
          .pipe(Effect.andThen((response) => response.text))
      : yield* fs.readFileString(specInput)

    const parsedSpec = yield* Effect.try({
      try: () => parser(specRawContent),
      catch: (error: unknown) =>
        new Error(`Failed to parse spec file: ${error}`),
    })

    return yield* OpenApi.generate(parsedSpec as unknown as OpenAPISpec, {
      name,
      typeOnly,
    })
  })

export const run = Command.run(root, {
  name: "openapigen",
  version: "0.0.0",
})

export const Env = Layer.mergeAll(
  NodeContext.layer,
  NodeFileSystem.layer,
  FetchHttpClient.layer,
  OpenApi.Live,
  CliConfig.layer({
    showBuiltIns: false,
  }),
)
