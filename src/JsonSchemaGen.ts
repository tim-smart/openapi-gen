import * as Effect from "effect/Effect"
import type * as JsonSchema from "@effect/platform/OpenApiJsonSchema"
import * as Context from "effect/Context"
import * as Option from "effect/Option"
import * as Layer from "effect/Layer"
import * as Arr from "effect/Array"
import { pipe } from "effect/Function"
import { identifier } from "./Utils"

const make = Effect.gen(function* () {
  const store = new Map<string, JsonSchema.JsonSchema>()
  const classes = new Set<string>()
  const enums = new Set<string>()
  const refStore = new Map<string, JsonSchema.JsonSchema>()

  function cleanupSchema(schema: JsonSchema.JsonSchema) {
    if (
      "type" in schema &&
      Array.isArray(schema.type) &&
      schema.type.includes("null")
    ) {
      schema.type = schema.type.filter((_) => _ !== "null")[0]
      schema.nullable = true
    }
    if (
      "type" in schema &&
      "oneOf" in schema &&
      Array.isArray(schema.oneOf) &&
      schema.oneOf.length === 0
    ) {
      delete schema.oneOf
    }
    return schema
  }

  const addSchema = (
    name: string,
    root: JsonSchema.JsonSchema,
    context?: object,
    asStruct = false,
  ): string => {
    cleanupSchema(root)

    function addRefs(
      schema: JsonSchema.JsonSchema,
      childName: string | undefined,
      asStruct = true,
    ) {
      cleanupSchema(schema)
      if ("$ref" in schema) {
        const resolved = resolveRef(schema, {
          ...root,
          ...context,
        })
        if (!resolved) {
          return
        }
        if (store.has(resolved.name)) {
          return
        }
        refStore.set(schema.$ref, resolved.schema)
        addRefs(resolved.schema, resolved.name)
        store.set(resolved.name, resolved.schema)
        if (!asStruct) {
          classes.add(resolved.name)
        }
      } else if ("properties" in schema) {
        Object.entries(schema.properties).forEach(([name, s]) =>
          addRefs(s, childName ? childName + identifier(name) : undefined),
        )
      } else if ("type" in schema && schema.type === "array") {
        if (Array.isArray(schema.items)) {
          schema.items.forEach((s) => addRefs(s, undefined))
        } else if (schema.items) {
          addRefs(schema.items, undefined)
        }
      } else if ("allOf" in schema) {
        if (schema.allOf.length === 1) {
          const resolved = { ...schema, ...schema.allOf[0] }
          delete resolved.allOf
          addRefs(resolved, childName, asStruct)
        } else {
          const resolved = resolveAllOf(schema, {
            ...root,
            ...context,
          })
          if (childName !== undefined) {
            addRefs(resolved, childName + "Enum", asStruct)
            store.set(childName, resolved)
          } else {
            addRefs(resolved, undefined, asStruct)
          }
        }
      } else if ("anyOf" in schema) {
        schema.anyOf.forEach((s) =>
          addRefs(s as any, childName ? childName + "Enum" : undefined),
        )
      } else if ("oneOf" in schema) {
        ;(schema as any).oneOf.forEach((s: any) =>
          addRefs(s, childName ? childName + "Enum" : undefined),
        )
      } else if ("enum" in schema) {
        if (childName !== undefined) {
          store.set(childName, schema)
          enums.add(childName)
        }
      }
    }
    if ("$ref" in root) {
      addRefs(root, undefined, false)
      return identifier(root.$ref.split("/").pop()!)
    } else {
      addRefs(root, "properties" in root ? name : undefined)
      store.set(name, root)
      if (!asStruct) {
        classes.add(name)
      }
    }
    return name
  }

  const topLevelSource = (
    importName: string,
    name: string,
    schema: JsonSchema.JsonSchema,
  ): Option.Option<string> => {
    const isClass = classes.has(name)
    const isEnum = enums.has(name)
    const topLevel = transformer.supportsTopLevel({
      importName,
      schema,
      name,
      isClass,
      isEnum,
    })
    return toSource(importName, schema, name, topLevel).pipe(
      Option.map((source) =>
        transformer.onTopLevel({
          importName,
          schema,
          description: Option.fromNullable(schema.description),
          name,
          source,
          isClass,
          isEnum,
        }),
      ),
    )
  }

  const getSchema = (raw: JsonSchema.JsonSchema): JsonSchema.JsonSchema => {
    if ("$ref" in raw) {
      return refStore.get(raw.$ref) ?? raw
    }
    return raw
  }

  const flattenAllOf = (
    schema: JsonSchema.JsonSchema,
  ): JsonSchema.JsonSchema => {
    if ("allOf" in schema) {
      let out = {} as JsonSchema.JsonSchema
      for (const member of schema.allOf) {
        let s = getSchema(member as any)
        if ("allOf" in s) {
          s = flattenAllOf(s)
        }
        out = mergeSchemas(out, s)
      }
      return out
    }
    return getSchema(schema)
  }

  const transformer = yield* JsonSchemaTransformer

  const toSource = (
    importName: string,
    schema: JsonSchema.JsonSchema,
    currentIdentifier: string,
    topLevel = false,
  ): Option.Option<string> => {
    if ("properties" in schema) {
      const obj = schema as JsonSchema.Object
      const required = obj.required ?? []
      const properties = pipe(
        Object.entries(obj.properties ?? {}),
        Arr.filterMap(([key, schema]) => {
          const fullSchema = getSchema(schema)
          const isOptional = !required.includes(key)
          return toSource(
            importName,
            schema,
            currentIdentifier + identifier(key),
          ).pipe(
            Option.map((source) =>
              transformer.onProperty({
                importName,
                description: Option.fromNullable(schema.description),
                key,
                source,
                isOptional,
                isNullable:
                  ("nullable" in fullSchema && fullSchema.nullable === true) ||
                  ("default" in fullSchema && fullSchema.default === null),
              }),
            ),
          )
        }),
        Arr.join(transformer.propertySeparator),
      )
      return Option.some(
        transformer.onObject({ importName, properties, topLevel }),
      )
    } else if ("type" in schema && (schema.type as any) === "null") {
      return Option.some(transformer.onNull({ importName }))
    } else if ("type" in schema && (schema.type as any) === "object") {
      return Option.some(transformer.onRecord({ importName }))
    } else if ("enum" in schema) {
      if (!topLevel && enums.has(currentIdentifier)) {
        return Option.some(
          transformer.onRef({ importName, name: currentIdentifier }),
        )
      }
      const items = schema.enum.map((_) => JSON.stringify(_))
      return Option.some(
        transformer.onEnum({
          importName,
          items,
        }),
      )
    } else if ("$ref" in schema) {
      if (!schema.$ref.startsWith("#")) {
        return Option.none()
      }
      const name = identifier(schema.$ref.split("/").pop()!)
      return Option.some(transformer.onRef({ importName, name }))
    } else if ("properties" in schema) {
      return toSource(
        importName,
        { type: "object", ...schema } as any,
        currentIdentifier,
        topLevel,
      )
    } else if ("allOf" in schema) {
      if (store.has(currentIdentifier)) {
        return Option.some(
          transformer.onRef({ importName, name: currentIdentifier }),
        )
      }
      const sources = (schema as any).allOf as Array<JsonSchema.JsonSchema>
      if (sources.length === 0) {
        return Option.none()
      } else if (sources.length === 1) {
        return toSource(
          importName,
          sources[0],
          currentIdentifier + "Enum",
          topLevel,
        )
      }
      const flattened = flattenAllOf(schema)
      return toSource(
        importName,
        flattened,
        currentIdentifier + "Enum",
        topLevel,
      )
    } else if ("anyOf" in schema || "oneOf" in schema) {
      const items = pipe(
        "anyOf" in schema
          ? (schema.anyOf as Array<JsonSchema.JsonSchema>)
          : (schema.oneOf as Array<JsonSchema.JsonSchema>),
        Arr.filterMap((_) =>
          toSource(importName, _, currentIdentifier + "Enum").pipe(
            Option.map(
              (source) =>
                ({
                  description: Option.fromNullable(_.description),
                  title: Option.fromNullable(_.title),
                  source,
                }) as const,
            ),
          ),
        ),
      )
      if (items.length === 0) return Option.none()
      else if (items.length === 1) return Option.some(items[0].source)
      return Option.some(transformer.onUnion({ importName, items, topLevel }))
    } else if ("const" in schema) {
      return Option.some(
        transformer.onEnum({
          importName,
          items: [JSON.stringify(schema.const)],
        }),
      )
    } else if ("type" in schema && schema.type) {
      switch (schema.type) {
        case "string": {
          return Option.some(transformer.onString({ importName, schema }))
        }
        case "integer":
        case "number": {
          const minimum =
            typeof schema.exclusiveMinimum === "number"
              ? schema.exclusiveMinimum
              : schema.minimum
          const exclusiveMinimum =
            typeof schema.exclusiveMinimum === "boolean"
              ? schema.exclusiveMinimum
              : typeof schema.exclusiveMinimum === "number"
          const maximum =
            typeof schema.exclusiveMaximum === "number"
              ? schema.exclusiveMaximum
              : schema.maximum
          const exclusiveMaximum =
            typeof schema.exclusiveMaximum === "boolean"
              ? schema.exclusiveMaximum
              : typeof schema.exclusiveMaximum === "number"
          return Option.some(
            transformer.onNumber({
              importName,
              schema,
              minimum,
              exclusiveMinimum,
              maximum,
              exclusiveMaximum,
            }),
          )
        }
        case "boolean": {
          return Option.some(transformer.onBoolean({ importName }))
        }
        case "array": {
          const nonEmpty =
            typeof schema.minItems === "number" &&
            schema.minItems === 1 &&
            schema.maxItems === undefined
          return toSource(
            importName,
            itemsSchema(schema.items),
            currentIdentifier,
          ).pipe(
            Option.map((item) =>
              transformer.onArray({
                importName,
                schema,
                item,
                nonEmpty,
              }),
            ),
          )
        }
      }
    }
    return Option.none()
  }

  const itemsSchema = (
    schema: JsonSchema.Array["items"],
  ): JsonSchema.JsonSchema => {
    if (schema === undefined) {
      return { $id: "/schemas/any" }
    } else if (Array.isArray(schema)) {
      return { anyOf: schema }
    }
    return schema
  }

  const generate = (importName: string) =>
    Effect.sync(() =>
      pipe(
        store.entries(),
        Arr.filterMap(([name, schema]) =>
          topLevelSource(importName, name, schema),
        ),
        Arr.join("\n\n"),
      ),
    )

  return { addSchema, generate } as const
})

export class JsonSchemaGen extends Context.Tag("JsonSchemaGen")<
  JsonSchemaGen,
  Effect.Effect.Success<typeof make>
>() {}

const with_ = Effect.provideServiceEffect(JsonSchemaGen, make)
export { with_ as with }

export class JsonSchemaTransformer extends Context.Tag("JsonSchemaTransformer")<
  JsonSchemaTransformer,
  {
    supportsTopLevel(options: {
      readonly importName: string
      readonly schema: JsonSchema.JsonSchema
      readonly name: string
      readonly isClass: boolean
      readonly isEnum: boolean
    }): boolean

    onTopLevel(options: {
      readonly importName: string
      readonly schema: JsonSchema.JsonSchema
      readonly description: Option.Option<string>
      readonly name: string
      readonly source: string
      readonly isClass: boolean
      readonly isEnum: boolean
    }): string

    onProperty(options: {
      readonly importName: string
      readonly description: Option.Option<string>
      readonly key: string
      readonly source: string
      readonly isOptional: boolean
      readonly isNullable: boolean
      readonly default?: unknown
    }): string

    readonly propertySeparator: string

    onRef(options: {
      readonly importName: string
      readonly name: string
    }): string

    onObject(options: {
      readonly importName: string
      readonly properties: string
      readonly topLevel: boolean
    }): string

    onNull(options: { readonly importName: string }): string

    onBoolean(options: { readonly importName: string }): string

    onRecord(options: { readonly importName: string }): string

    onEnum(options: {
      readonly importName: string
      readonly items: ReadonlyArray<string>
    }): string

    onString(options: {
      readonly importName: string
      readonly schema: JsonSchema.String
    }): string

    onNumber(options: {
      readonly importName: string
      readonly schema: JsonSchema.Number | JsonSchema.Integer
      readonly minimum: number | undefined
      readonly exclusiveMinimum: boolean
      readonly maximum: number | undefined
      readonly exclusiveMaximum: boolean
    }): string

    onArray(options: {
      readonly importName: string
      readonly schema: JsonSchema.Array
      readonly item: string
      readonly nonEmpty: boolean
    }): string

    onUnion(options: {
      readonly importName: string
      readonly topLevel: boolean
      readonly items: ReadonlyArray<{
        readonly description: Option.Option<string>
        readonly title: Option.Option<string>
        readonly source: string
      }>
    }): string
  }
>() {}

export const layerTransformerSchema = Layer.sync(JsonSchemaTransformer, () => {
  const applyAnnotations =
    (
      S: string,
      options: {
        readonly isOptional: boolean
        readonly isNullable: boolean
        readonly default?: unknown
      },
    ) =>
    (source: string): string => {
      // Handle the special case where the `default` value of the property
      // was set to `null`, but the property was not properly marked as `nullable`
      if (options.isNullable && options.default === null) {
        return `${S}.optionalWith(${S}.NullOr(${source}), { default: () => null })`
      }
      const defaultSource =
        options.default !== undefined && options.default !== null
          ? `() => ${JSON.stringify(options.default)} as const`
          : undefined
      if (options.isOptional) {
        return defaultSource
          ? `${S}.optionalWith(${source}, { nullable: true, default: ${defaultSource} })`
          : `${S}.optionalWith(${source}, { nullable: true })`
      }
      const newSource = options.isNullable ? `${S}.NullOr(${source})` : source
      if (defaultSource) {
        return `${newSource}.pipe(${S}.propertySignature, ${S}.withConstructorDefault(${defaultSource}))`
      }
      return newSource
    }

  const pipeSource = (modifers: Array<string>) =>
    modifers.length === 0 ? "" : `.pipe(${modifers.join(", ")})`

  return JsonSchemaTransformer.of({
    supportsTopLevel({ isClass, isEnum }) {
      return isClass || isEnum
    },
    onTopLevel({ importName, schema, name, source, isClass }) {
      const isObject = "properties" in schema
      if (!isObject || !isClass) {
        return `export class ${name} extends ${source} {}`
      }
      return `export class ${name} extends ${importName}.Class<${name}>("${name}")(${source}) {}`
    },
    propertySeparator: ",\n  ",
    onProperty: (options) => {
      const source = applyAnnotations(
        options.importName,
        options,
      )(options.source)
      return `"${options.key}": ${source}`
    },
    onRef({ name }) {
      return name
    },
    onObject({ importName, properties, topLevel }) {
      return `${topLevel ? "" : `${importName}.Struct(`}{\n  ${properties}\n}${topLevel ? "" : ")"}`
    },
    onNull({ importName }) {
      return `${importName}.Null`
    },
    onBoolean({ importName }) {
      return `${importName}.Boolean`
    },
    onRecord({ importName }) {
      return `${importName}.Record({ key: ${importName}.String, value: ${importName}.Unknown })`
    },
    onEnum({ importName, items }) {
      return `${importName}.Literal(${items.join(", ")})`
    },
    onString({ importName, schema }) {
      if (
        schema.format === "binary" ||
        (schema as any).contentEncoding === "binary"
      ) {
        return `${importName}.instanceOf(globalThis.Blob)`
      }
      const modifiers: Array<string> = []
      if ("minLength" in schema) {
        modifiers.push(`${importName}.minLength(${schema.minLength})`)
      }
      if ("maxLength" in schema) {
        modifiers.push(`${importName}.maxLength(${schema.maxLength})`)
      }
      if ("pattern" in schema) {
        modifiers.push(
          `${importName}.pattern(new RegExp(${JSON.stringify(schema.pattern)}))`,
        )
      }
      return `${importName}.String${pipeSource(modifiers)}`
    },
    onNumber({
      importName,
      schema,
      minimum,
      exclusiveMinimum,
      maximum,
      exclusiveMaximum,
    }) {
      const modifiers: Array<string> = []
      if (minimum !== undefined) {
        modifiers.push(
          `${importName}.greaterThan${exclusiveMinimum ? "" : "OrEqualTo"}(${schema.minimum})`,
        )
      }
      if (maximum !== undefined) {
        modifiers.push(
          `${importName}.lessThan${exclusiveMaximum ? "" : "OrEqualTo"}(${schema.maximum})`,
        )
      }
      return `${importName}.${schema.type === "integer" ? "Int" : "Number"}${pipeSource(modifiers)}`
    },
    onArray({ importName, schema, item, nonEmpty }) {
      const modifiers: Array<string> = []
      if ("minItems" in schema && !nonEmpty) {
        modifiers.push(`${importName}.minItems(${schema.minItems})`)
      }
      if ("maxItems" in schema) {
        modifiers.push(`${importName}.maxItems(${schema.maxItems})`)
      }

      return `${importName}.${nonEmpty ? "NonEmpty" : ""}Array(${item})${pipeSource(modifiers)}`
    },
    onUnion({ importName, items }) {
      return `${importName}.Union(${items.map((_) => _.source).join(", ")})`
    },
  })
})

export const layerTransformerTs = Layer.succeed(
  JsonSchemaTransformer,
  JsonSchemaTransformer.of({
    supportsTopLevel() {
      return true
    },
    onTopLevel({ name, source, schema, description }) {
      return source[0] === "{"
        ? "oneOf" in schema
          ? `${toComment(description)}export const ${name} = ${source};
export type ${name} = (typeof ${name})[keyof typeof ${name}];`
          : `${toComment(description)}export interface ${name} ${source}`
        : `${toComment(description)}export type ${name} = ${source}`
    },
    propertySeparator: ";\n  ",
    onProperty(options) {
      return `${toComment(options.description)}readonly "${options.key}"${options.isOptional ? "?" : ""}: ${options.source}${options.isNullable ? " | null" : ""}${options.isOptional ? " | undefined" : ""}`
    },
    onRef({ name }) {
      return name
    },
    onObject({ properties }) {
      return `{\n  ${properties}\n}`
    },
    onNull() {
      return "null"
    },
    onBoolean() {
      return "boolean"
    },
    onRecord() {
      return "Record<string, unknown>"
    },
    onEnum({ items }) {
      return items.join(" | ")
    },
    onString({ schema }) {
      if (
        schema.format === "binary" ||
        (schema as any).contentEncoding === "binary"
      ) {
        return `Blob`
      }
      return "string"
    },
    onNumber() {
      return "number"
    },
    onArray({ item }) {
      return `ReadonlyArray<${item}>`
    },
    onUnion({ items, topLevel }) {
      const useEnum = topLevel && !items.some((_) => Option.isNone(_.title))
      if (!useEnum) {
        return items.map((_) => _.source).join(" | ")
      }
      return `{\n  ${items.map(({ description, title, source }) => `${toComment(description)}${JSON.stringify(Option.getOrNull(title))}: ${source}`).join(",\n  ")}} as const\n`
    },
  }),
)

const toComment = Option.match({
  onNone: () => "",
  onSome: (description: string) => `/** ${description} */\n`,
})

function mergeSchemas(
  self: JsonSchema.JsonSchema,
  other: JsonSchema.JsonSchema,
): JsonSchema.JsonSchema {
  if ("properties" in self && "properties" in other) {
    return {
      ...other,
      ...self,
      properties: {
        ...other.properties,
        ...self.properties,
      },
      required: [...(other.required || []), ...(self.required || [])],
    }
  } else if ("anyOf" in self && "anyOf" in other) {
    return {
      ...other,
      ...self,
      anyOf: [...self.anyOf, ...other.anyOf] as any,
    }
  }
  return {
    ...self,
    ...other,
  } as any
}

function resolveAllOf(
  schema: JsonSchema.JsonSchema,
  context: JsonSchema.JsonSchema,
  resolveRefs = true,
): JsonSchema.JsonSchema {
  if ("$ref" in schema) {
    const resolved = resolveRef(schema, context, resolveRefs)
    if (!resolved) {
      return schema
    }
    return resolved.schema
  } else if ("allOf" in schema) {
    if (schema.allOf.length <= 1) {
      let out = { ...schema }
      delete out.allOf
      if (schema.allOf.length === 0) {
        return out
      }
      Object.assign(out, schema.allOf[0])
      return resolveAllOf(out, context, resolveRefs)
    }
    let out = {} as JsonSchema.JsonSchema
    for (const member of schema.allOf) {
      out = mergeSchemas(out, resolveAllOf(member as any, context, resolveRefs))
    }
    return out
  }
  return schema
}

function resolveRef(
  schema: JsonSchema.Ref,
  context: JsonSchema.JsonSchema,
  recursive = false,
):
  | {
      readonly name: string
      readonly schema: JsonSchema.JsonSchema
    }
  | undefined {
  if (!schema.$ref.startsWith("#")) {
    return
  }
  const path = schema.$ref.slice(2).split("/")
  const name = identifier(path[path.length - 1])

  let current = context
  for (const key of path) {
    if (!current) return
    current = (current as any)[key] as JsonSchema.JsonSchema
  }

  return { name, schema: resolveAllOf(current, context, recursive) } as const
}
