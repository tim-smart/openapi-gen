import type {
  OpenAPISpec,
  OpenAPISpecMethodName,
  OpenAPISpecPathItem,
} from "@effect/platform/OpenApi"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as JsonSchemaGen from "./JsonSchemaGen.js"
import type * as JsonSchema from "@effect/platform/OpenApiJsonSchema"
import type { DeepMutable } from "effect/Types"
import { camelize, identifier } from "./Utils.js"
import { convertObj } from "swagger2openapi"
import * as Context from "effect/Context"

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
  readonly successSchemas: ReadonlyMap<string, string>
  readonly errorSchemas: ReadonlyMap<string, string>
}

export const make = Effect.gen(function* () {
  const convert = Effect.fn("OpenApi.convert")((v2Spec: unknown) =>
    Effect.async<unknown>((resume) => {
      convertObj(v2Spec as any, {}, (err, result) => {
        if (err) {
          resume(Effect.die(err))
        } else {
          resume(Effect.succeed(result.openapi))
        }
      })
    }),
  )

  const generate = Effect.fnUntraced(
    function* (
      spec: OpenAPISpec,
      options: {
        readonly name: string
        readonly typeOnly: boolean
      },
    ) {
      const gen = yield* JsonSchemaGen.JsonSchemaGen
      const components = spec.components
        ? { ...spec.components }
        : { schemas: {} }
      const context = { components }
      const operations: Array<ParsedOperation> = []

      function resolveRef(ref: string) {
        const parts = ref.split("/").slice(1)
        let current: any = spec
        for (const part of parts) {
          current = current[part]
        }
        return current
      }

      const handlePath = (path: string, methods: OpenAPISpecPathItem) =>
        methodNames
          .filter(
            (method) => !!methods[method] && !!methods[method]!.operationId,
          )
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
                if ("$ref" in parameter) {
                  parameter = resolveRef(parameter.$ref as string)
                }
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
                  const statusLower = status.toLowerCase()
                  const statusMajorNumber = Number(status[0])
                  if (statusMajorNumber < 4) {
                    op.successSchemas.set(statusLower, schemaName)
                  } else {
                    op.errorSchemas.set(statusLower, schemaName)
                  }
                }
              },
            )
            operations.push(op)
          })

      Object.entries(spec.paths).forEach(([path, methods]) =>
        handlePath(path, methods),
      )

      const transformer = yield* OpenApiTransformer
      const schemas = yield* gen.generate("S")
      return `${transformer.imports}\n\n${schemas}\n\n${transformer.toImplementation(options.name, operations)}\n\n${transformer.toTypes(options.name, operations)}`
    },
    JsonSchemaGen.with,
    (effect, _, options) =>
      Effect.provide(
        effect,
        options?.typeOnly ? layerTransformerTs : layerTransformerSchema,
      ),
  )

  return { convert, generate } as const
})

export class OpenApi extends Effect.Tag("OpenApi")<
  OpenApi,
  Effect.Effect.Success<typeof make>
>() {
  static Live = Layer.effect(OpenApi, make)
}

export class OpenApiTransformer extends Context.Tag("OpenApiTransformer")<
  OpenApiTransformer,
  {
    readonly imports: string
    readonly toTypes: (
      name: string,
      operations: ReadonlyArray<ParsedOperation>,
    ) => string
    readonly toImplementation: (
      name: string,
      operations: ReadonlyArray<ParsedOperation>,
    ) => string
  }
>() {}

export const layerTransformerSchema = Layer.sync(OpenApiTransformer, () => {
  const operationsToInterface = (
    name: string,
    operations: ReadonlyArray<ParsedOperation>,
  ) => `export interface ${name} {
  readonly httpClient: HttpClient.HttpClient
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
    httpClient,
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
          (param) =>
            `"${param}": ${varName}["${param}"] as UrlParams.Coercible`,
        )
        pipeline.push(`HttpClientRequest.setUrlParams({ ${props.join(", ")} })`)
      }
      if (operation.headers.length > 0) {
        const props = operation.headers.map(
          (param) => `"${param}": ${varName}["${param}"] ?? undefined`,
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

    return (
      `"${operation.id}": (${params}) => ` +
      `HttpClientRequest.make("${operation.method.toUpperCase()}")(${operation.pathTemplate})` +
      `.pipe(\n    ${pipeline.join(",\n    ")}\n  )`
    )
  }

  return OpenApiTransformer.of({
    imports: [
      'import type * as HttpClient from "@effect/platform/HttpClient"',
      'import * as HttpClientError from "@effect/platform/HttpClientError"',
      'import * as HttpClientRequest from "@effect/platform/HttpClientRequest"',
      'import * as HttpClientResponse from "@effect/platform/HttpClientResponse"',
      'import * as UrlParams from "@effect/platform/UrlParams"',
      'import * as Effect from "effect/Effect"',
      'import type { ParseError } from "effect/ParseResult"',
      'import * as S from "effect/Schema"',
    ].join("\n"),
    toTypes: operationsToInterface,
    toImplementation: operationsToImpl,
  })
}).pipe(Layer.merge(JsonSchemaGen.layerTransformerSchema))

export const layerTransformerTs = Layer.sync(OpenApiTransformer, () => {
  const operationsToInterface = (
    name: string,
    operations: ReadonlyArray<ParsedOperation>,
  ) => `export interface ${name} {
  readonly httpClient: HttpClient.HttpClient
  ${operations.map((s) => operationToMethod(name, s)).join("\n  ")}
}

export interface ${name}Error<Tag extends string, E> {
  readonly _tag: Tag
  readonly cause: E
}

class ${name}ErrorImpl extends Data.Error<{ _tag: string; cause: any }> {}

export const ${name}Error = <Tag extends string, E>(
  tag: Tag,
  cause: E,
): ${name}Error<Tag, E> => new ${name}ErrorImpl({ _tag: tag, cause }) as any`

  const operationToMethod = (name: string, operation: ParsedOperation) => {
    const args: Array<string> = []
    if (operation.pathIds.length > 0) {
      args.push(...operation.pathIds.map((id) => `${id}: string`))
    }
    let options: Array<string> = []
    if (operation.params && !operation.payload) {
      args.push(`options: ${operation.params}`)
    } else if (operation.params) {
      options.push(`readonly params: ${operation.params}`)
    }
    if (operation.payload) {
      const type =
        operation.payload === "FormData"
          ? "globalThis.FormData"
          : operation.payload
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
      success = Array.from(operation.successSchemas.values()).join(" | ")
    }
    const errors = ["HttpClientError.HttpClientError"]
    if (operation.errorSchemas.size > 0) {
      for (const schema of operation.errorSchemas.values()) {
        errors.push(`${name}Error<"${schema}", ${schema}>`)
      }
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
  const unexpectedStatus = (response: HttpClientResponse.HttpClientResponse) =>
    Effect.flatMap(
      Effect.orElseSucceed(response.text, () => "Unexpected status code"),
      (description) =>
        Effect.fail(
          new HttpClientError.ResponseError({
            request: response.request,
            response,
            reason: "StatusCode",
            description,
          }),
        ),
    )
  const applyClientTransform = (
    client: HttpClient.HttpClient,
  ): Effect.Effect<HttpClient.HttpClient> =>
    options.transformClient
      ? options.transformClient(client)
      : Effect.succeed(client)
  const decodeSuccess = <A>(response: HttpClientResponse.HttpClientResponse) =>
    response.json as Effect.Effect<A, HttpClientError.ResponseError>
  const decodeVoid = (_response: HttpClientResponse.HttpClientResponse) =>
    Effect.void
  const decodeError =
    <Tag extends string, E>(tag: Tag) =>
    (
      response: HttpClientResponse.HttpClientResponse,
    ): Effect.Effect<
      never,
      ${name}Error<Tag, E> | HttpClientError.ResponseError
    > =>
      Effect.flatMap(
        response.json as Effect.Effect<E, HttpClientError.ResponseError>,
        (cause) => Effect.fail(${name}Error(tag, cause)),
      )
  const onRequest = (
    successCodes: ReadonlyArray<string>,
    errorCodes: Record<string, string>,
  ) => {
    const cases: any = { orElse: unexpectedStatus }
    for (const code of successCodes) {
      cases[code] = decodeSuccess
    }
    for (const [code, tag] of Object.entries(errorCodes)) {
      cases[code] = decodeError(tag)
    }
    if (successCodes.length === 0) {
      cases["2xx"] = decodeVoid
    }
    return (
      request: HttpClientRequest.HttpClientRequest,
    ): Effect.Effect<any, any> =>
      Effect.flatMap(applyClientTransform(httpClient), (httpClient) =>
        Effect.flatMap(
          httpClient.execute(request),
          HttpClientResponse.matchStatus(cases) as any,
        ),
      )
  }
  return {
    httpClient,
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
          (param) =>
            `"${param}": ${varName}["${param}"] as UrlParams.Coercible`,
        )
        pipeline.push(`HttpClientRequest.setUrlParams({ ${props.join(", ")} })`)
      }
      if (operation.headers.length > 0) {
        const props = operation.headers.map(
          (param) => `"${param}": ${varName}["${param}"] ?? undefined`,
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

    const successCodes = Array.from(operation.successSchemas.keys(), (_) =>
      JSON.stringify(_),
    ).join(", ")
    const errorCodes = Object.fromEntries(operation.errorSchemas.entries())
    pipeline.push(
      `Effect.flatMap(onRequest([${successCodes}], ${JSON.stringify(errorCodes)}))`,
    )

    return (
      `"${operation.id}": (${params}) => ` +
      `HttpClientRequest.make("${operation.method.toUpperCase()}")(${operation.pathTemplate})` +
      `.pipe(\n    ${pipeline.join(",\n    ")}\n  )`
    )
  }

  return OpenApiTransformer.of({
    imports: [
      'import type * as HttpClient from "@effect/platform/HttpClient"',
      'import * as HttpClientError from "@effect/platform/HttpClientError"',
      'import * as HttpClientRequest from "@effect/platform/HttpClientRequest"',
      'import * as HttpClientResponse from "@effect/platform/HttpClientResponse"',
      'import * as UrlParams from "@effect/platform/UrlParams"',
      'import * as Data from "effect/Data"',
      'import * as Effect from "effect/Effect"',
    ].join("\n"),
    toTypes: operationsToInterface,
    toImplementation: operationsToImpl,
  })
}).pipe(Layer.merge(JsonSchemaGen.layerTransformerTs))

const processPath = (path: string) => {
  const ids: Array<string> = []
  path = path.replace(/{([^}]+)}/g, (_, name) => {
    const id = camelize(name)
    ids.push(id)
    return "${" + id + "}"
  })
  return { path: "`" + path + "`", ids } as const
}
