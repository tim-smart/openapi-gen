import type {
  OpenAPISpec,
  OpenAPISpecMethodName,
  OpenAPISpecPathItem,
} from "@effect/platform/OpenApi"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { JsonSchemaGen } from "./JsonSchemaGen.js"
import type * as JsonSchema from "@effect/platform/OpenApiJsonSchema"
import type { DeepMutable } from "effect/Types"
import { camelize, identifier } from "./Utils.js"

const methodNames: ReadonlyArray<OpenAPISpecMethodName> = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]

interface ParsedOperation {
  readonly id: string
  readonly method: OpenAPISpecMethodName
  readonly params?: string
  readonly urlParams: ReadonlyArray<string>
  readonly headers: ReadonlyArray<string>
  readonly cookies: ReadonlyArray<string>
  readonly payload?: string
  readonly pathIds: ReadonlyArray<string>
  readonly pathTemplate: string
  readonly successSchemas: ReadonlyMap<number, string>
  readonly errorSchemas: ReadonlyMap<number, string>
}

export const make = Effect.gen(function* () {
  const generate = (spec: OpenAPISpec) =>
    Effect.gen(function* () {
      const gen = yield* JsonSchemaGen
      const components = spec.components?.schemas
        ? { schemas: spec.components.schemas }
        : { schemas: {} }
      const context = { components }
      const operations: Array<ParsedOperation> = []

      const handlePath = (path: string, methods: OpenAPISpecPathItem) =>
        methodNames
          .filter((method) => !!methods[method])
          .forEach((method) => {
            const { ids: pathIds, path: pathTemplate } = processPath(path)
            const operation = methods[method]!
            const op: DeepMutable<ParsedOperation> = {
              id: camelize(operation.operationId!),
              method,
              pathIds,
              pathTemplate,
              urlParams: [],
              headers: [],
              cookies: [],
              successSchemas: new Map(),
              errorSchemas: new Map(),
            }
            const schemaId = identifier(operation.operationId!)
            const validParameters =
              operation.parameters?.filter(
                (_) => _.in !== "path" && _.in !== "cookie",
              ) ?? []
            if (validParameters.length > 0) {
              const schema: JsonSchema.Object = {
                type: "object",
                properties: {},
                required: [],
              }
              validParameters.forEach((parameter) => {
                if (parameter.in === "path") {
                  return
                }
                const paramSchema = parameter.schema
                const added: Array<string> = []
                if ("properties" in paramSchema) {
                  const required = paramSchema.required ?? []
                  Object.entries(paramSchema.properties).forEach(
                    ([name, propSchema]) => {
                      const adjustedName = `${parameter.name}[${name}]`
                      schema.properties[adjustedName] = propSchema
                      if (required.includes(name)) {
                        schema.required.push(adjustedName)
                      }
                      added.push(adjustedName)
                    },
                  )
                } else {
                  schema.properties[parameter.name] = parameter.schema
                  parameter.required && schema.required.push(parameter.name)
                  added.push(parameter.name)
                }
                if (parameter.in === "query") {
                  op.urlParams.push(...added)
                } else if (parameter.in === "header") {
                  op.headers.push(...added)
                } else if (parameter.in === "cookie") {
                  op.cookies.push(...added)
                }
              })
              op.params = gen.addSchema(
                `${schemaId}Params`,
                schema,
                context,
                true,
              )
            }
            if (operation.requestBody?.content?.["application/json"]?.schema) {
              op.payload = gen.addSchema(
                `${schemaId}Request`,
                operation.requestBody.content["application/json"].schema,
                context,
              )
            } else if (
              operation.requestBody?.content?.["multipart/form-data"]
            ) {
              op.payload = "FormData"
            }
            Object.entries(operation.responses ?? {}).forEach(
              ([status, response]) => {
                if (response.content?.["application/json"]?.schema) {
                  const schemaName = gen.addSchema(
                    `${schemaId}${status}`,
                    response.content["application/json"].schema,
                    context,
                    true,
                  )
                  const statusNumber = Number(status)
                  if (statusNumber < 400) {
                    op.successSchemas.set(statusNumber, schemaName)
                  } else {
                    op.errorSchemas.set(statusNumber, schemaName)
                  }
                }
              },
            )
            operations.push(op)
          })

      Object.entries(spec.paths).forEach(([path, methods]) =>
        handlePath(path, methods),
      )

      const imports = [
        'import type * as HttpClient from "@effect/platform/HttpClient"',
        'import * as HttpClientError from "@effect/platform/HttpClientError"',
        'import * as HttpClientRequest from "@effect/platform/HttpClientRequest"',
        'import * as HttpClientResponse from "@effect/platform/HttpClientResponse"',
        'import * as Effect from "effect/Effect"',
        'import type { ParseError } from "effect/ParseResult"',
        'import * as S from "effect/Schema"',
      ].join("\n")
      const schemas = yield* gen.generate("S")
      const clientInterface = operationsToInterface("Client", operations)
      const clientImpl = operationsToImpl("Client", operations)
      return `${imports}\n\n${schemas}\n\n${clientImpl}\n\n${clientInterface}`
    }).pipe(JsonSchemaGen.with)

  return { generate } as const
})

export class OpenApi extends Effect.Tag("OpenApi")<
  OpenApi,
  Effect.Effect.Success<typeof make>
>() {
  static Live = Layer.effect(OpenApi, make)
}

const processPath = (path: string) => {
  const ids: Array<string> = []
  path = path.replace(/{([^}]+)}/g, (_, name) => {
    const id = camelize(name)
    ids.push(id)
    return "${" + id + "}"
  })
  return { path: "`" + path + "`", ids } as const
}

const operationsToInterface = (
  name: string,
  operations: ReadonlyArray<ParsedOperation>,
) => `export interface ${name} {
  ${operations.map(operationToMethod).join("\n  ")}
}`

const operationToMethod = (operation: ParsedOperation) => {
  const args: Array<string> = []
  if (operation.pathIds.length > 0) {
    args.push(...operation.pathIds.map((id) => `${id}: string`))
  }
  let options: Array<string> = []
  if (operation.params && !operation.payload) {
    args.push(`options: typeof ${operation.params}.Encoded`)
  } else if (operation.params) {
    options.push(`readonly params: typeof ${operation.params}.Encoded`)
  }
  if (operation.payload) {
    const type =
      operation.payload === "FormData"
        ? "globalThis.FormData"
        : `typeof ${operation.payload}.Encoded`
    if (!operation.params) {
      args.push(`options: ${type}`)
    } else {
      options.push(`readonly payload: ${type}`)
    }
  }
  if (options.length > 0) {
    args.push(`options: { ${options.join("; ")} }`)
  }
  let success = "void"
  if (operation.successSchemas.size > 0) {
    success = Array.from(operation.successSchemas.values())
      .map((schema) => `typeof ${schema}.Type`)
      .join(" | ")
  }
  const errors = ["HttpClientError.HttpClientError", "ParseError"]
  if (operation.errorSchemas.size > 0) {
    errors.push(
      ...Array.from(operation.errorSchemas.values()).map(
        (schema) => `typeof ${schema}.Type`,
      ),
    )
  }
  return `readonly "${operation.id}": (${args.join(", ")}) => Effect.Effect<${success}, ${errors.join(" | ")}>`
}

const operationsToImpl = (
  name: string,
  operations: ReadonlyArray<ParsedOperation>,
) => `export const make = (
  httpClient: HttpClient.HttpClient, 
  options: {
    readonly transformClient?: ((client: HttpClient.HttpClient) => Effect.Effect<HttpClient.HttpClient>) | undefined
  } = {}
): ${name} => {
  const unexpectedStatus = (request: HttpClientRequest.HttpClientRequest, response: HttpClientResponse.HttpClientResponse) =>
    Effect.flatMap(
      Effect.orElseSucceed(response.text, () => "Unexpected status code"),
      (description) =>
        Effect.fail(new HttpClientError.ResponseError({
          request,
          response,
          reason: "StatusCode",
          description
        }))
    )
  const applyClientTransform = (client: HttpClient.HttpClient): Effect.Effect<HttpClient.HttpClient> => 
    options.transformClient ? options.transformClient(client) : Effect.succeed(client)
  const decodeError = <A, I, R>(response: HttpClientResponse.HttpClientResponse, schema: S.Schema<A, I, R>) => Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)(response), Effect.fail)
  return {
    ${operations.map(operationToImpl).join(",\n  ")}
  }
}`

const operationToImpl = (operation: ParsedOperation) => {
  const args: Array<string> = [...operation.pathIds]
  const hasOptions = operation.params || operation.payload
  if (hasOptions) {
    args.push("options")
  }
  const params = `${args.join(", ")}`

  const pipeline: Array<string> = []

  if (operation.params) {
    const varName = operation.payload ? "options.params" : "options"
    if (operation.urlParams.length > 0) {
      const props = operation.urlParams.map(
        (param) => `"${param}": ${varName}["${param}"]`,
      )
      pipeline.push(`HttpClientRequest.setUrlParams({ ${props.join(", ")} })`)
    }
    if (operation.headers.length > 0) {
      const props = operation.headers.map(
        (param) => `"${param}": ${varName}["${param}"]`,
      )
      pipeline.push(`HttpClientRequest.setHeaders({ ${props.join(", ")} })`)
    }
  }

  const payloadVarName = operation.params ? "options.payload" : "options"
  if (operation.payload === "FormData") {
    pipeline.push(
      `HttpClientRequest.bodyFormData(${payloadVarName})`,
      "Effect.succeed",
    )
  } else if (operation.payload) {
    pipeline.push(
      `(req) => Effect.orDie(HttpClientRequest.bodyJson(req, ${payloadVarName}))`,
    )
  } else {
    pipeline.push("Effect.succeed")
  }

  const decodes: Array<string> = []
  operation.successSchemas.forEach((schema, status) => {
    decodes.push(
      `"${status}": r => HttpClientResponse.schemaBodyJson(${schema})(r)`,
    )
  })
  operation.errorSchemas.forEach((schema, status) => {
    decodes.push(`"${status}": r => decodeError(r, ${schema})`)
  })
  decodes.push(`orElse: (response) => unexpectedStatus(request, response)`)

  pipeline.push(`Effect.flatMap(request => Effect.flatMap(applyClientTransform(httpClient), (httpClient) => Effect.flatMap(httpClient.execute(request), HttpClientResponse.matchStatus({
      ${decodes.join(",\n      ")}
    }))))`)

  pipeline.push(`Effect.scoped`)
  return (
    `"${operation.id}": (${params}) => ` +
    `HttpClientRequest.make("${operation.method.toUpperCase()}")(${operation.pathTemplate})` +
    `.pipe(\n    ${pipeline.join(",\n    ")}\n  )`
  )
}
