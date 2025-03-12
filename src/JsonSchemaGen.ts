import * as Effect from "effect/Effect"
import type * as JsonSchema from "@effect/platform/OpenApiJsonSchema"
import * as Context from "effect/Context"
import * as Option from "effect/Option"
import * as Arr from "effect/Array"
import { pipe } from "effect/Function"
import { identifier } from "./Utils"

const make = Effect.gen(function* () {
  const store = new Map<string, JsonSchema.JsonSchema>()
  const classes = new Set<string>()
  const enums = new Set<string>()
  const refStore = new Map<string, JsonSchema.JsonSchema>()

  const addSchema = (
    name: string,
    root: JsonSchema.JsonSchema,
    context?: object,
    asStruct = false,
  ): string => {
    function addRefs(
      schema: JsonSchema.JsonSchema,
      childName: string | undefined,
      asStruct = true,
    ) {
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
    S: string,
    name: string,
    schema: JsonSchema.JsonSchema,
  ): Option.Option<string> => {
    const isClass = classes.has(name)
    const isEnum = enums.has(name)
    return toSource(S, schema, name, isClass || isEnum).pipe(
      Option.map((source) => {
        const isObject = "properties" in schema
        if (!isObject || !isClass) {
          return `export class ${name} extends ${source} {}`
        }
        return `export class ${name} extends ${S}.Class<${name}>("${name}")(${source}) {}`
      }),
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

  const toSource = (
    S: string,
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
          return toSource(S, schema, currentIdentifier + identifier(key)).pipe(
            Option.map(
              applyAnnotations(S, {
                isOptional,
                isNullable:
                  ("nullable" in fullSchema && fullSchema.nullable === true) ||
                  ("default" in fullSchema && fullSchema.default === null),
                default: fullSchema.default,
              }),
            ),
            Option.map((source) => `"${key}": ${source}`),
          )
        }),
        Arr.join(",\n  "),
      )
      return Option.some(
        `${topLevel ? "" : `${S}.Struct(`}{\n  ${properties}\n}${topLevel ? "" : ")"}`,
      )
    } else if ("type" in schema && (schema.type as any) === "null") {
      return Option.some(`${S}.Null`)
    } else if ("type" in schema && (schema.type as any) === "object") {
      return Option.some(
        `${S}.Record({ key: ${S}.String, value: ${S}.Unknown })`,
      )
    } else if ("enum" in schema) {
      if (!topLevel && enums.has(currentIdentifier)) {
        return Option.some(currentIdentifier)
      }
      const items = schema.enum.map((_) => JSON.stringify(_)).join(", ")
      return Option.some(`${S}.Literal(${items})`)
    } else if ("type" in schema && schema.type) {
      switch (schema.type) {
        case "string": {
          const modifiers: Array<string> = []
          if ("minLength" in schema) {
            modifiers.push(`${S}.minLength(${schema.minLength})`)
          }
          if ("maxLength" in schema) {
            modifiers.push(`${S}.maxLength(${schema.maxLength})`)
          }
          if ("pattern" in schema) {
            modifiers.push(
              `${S}.pattern(new RegExp(${JSON.stringify(schema.pattern)}))`,
            )
          }
          return Option.some(`${S}.String${pipeSource(modifiers)}`)
        }
        case "integer":
        case "number": {
          const modifiers: Array<string> = []
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
          if (minimum !== undefined) {
            modifiers.push(
              `${S}.greaterThan${exclusiveMinimum ? "" : "OrEqualTo"}(${schema.minimum})`,
            )
          }
          if (maximum !== undefined) {
            modifiers.push(
              `${S}.lessThan${exclusiveMaximum ? "" : "OrEqualTo"}(${schema.maximum})`,
            )
          }
          return Option.some(
            `${S}.${schema.type === "integer" ? "Int" : "Number"}${pipeSource(modifiers)}`,
          )
        }
        case "boolean": {
          return Option.some(`${S}.Boolean`)
        }
        case "array": {
          const modifiers: Array<string> = []
          const nonEmpty =
            typeof schema.minItems === "number" &&
            schema.minItems === 1 &&
            schema.maxItems === undefined
          if ("minItems" in schema && !nonEmpty) {
            modifiers.push(`${S}.minItems(${schema.minItems})`)
          }
          if ("maxItems" in schema) {
            modifiers.push(`${S}.maxItems(${schema.maxItems})`)
          }
          return toSource(S, itemsSchema(schema.items), currentIdentifier).pipe(
            Option.map(
              (source) =>
                `${S}.${nonEmpty ? "NonEmpty" : ""}Array(${source})${pipeSource(modifiers)}`,
            ),
          )
        }
      }
    } else if ("$ref" in schema) {
      if (!schema.$ref.startsWith("#")) {
        return Option.none()
      }
      const name = identifier(schema.$ref.split("/").pop()!)
      return Option.some(name)
    } else if ("properties" in schema) {
      return toSource(
        S,
        { type: "object", ...schema } as any,
        currentIdentifier,
        topLevel,
      )
    } else if ("allOf" in schema) {
      if (store.has(currentIdentifier)) {
        return Option.some(currentIdentifier)
      }
      const sources = (schema as any).allOf as Array<JsonSchema.JsonSchema>
      if (sources.length === 0) {
        return Option.none()
      } else if (sources.length === 1) {
        return toSource(S, sources[0], currentIdentifier + "Enum", topLevel)
      }
      const flattened = flattenAllOf(schema)
      return toSource(S, flattened, currentIdentifier + "Enum", topLevel)
    } else if ("anyOf" in schema || "oneOf" in schema) {
      const sources = pipe(
        "anyOf" in schema
          ? (schema.anyOf as Array<JsonSchema.JsonSchema>)
          : (schema.oneOf as Array<JsonSchema.JsonSchema>),
        Arr.filterMap((_) => toSource(S, _, currentIdentifier + "Enum")),
      )
      if (sources.length === 0) return Option.none()
      else if (sources.length === 1) return Option.some(sources[0])
      return Option.some(`${S}.Union(${sources.join(", ")})`)
    } else if ("const" in schema) {
      return Option.some(`${S}.Literal(${JSON.stringify(schema.const)})`)
    }
    return Option.none()
  }

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

  const pipeSource = (modifers: Array<string>) =>
    modifers.length === 0 ? "" : `.pipe(${modifers.join(", ")})`

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
>() {
  static with = Effect.provideServiceEffect(JsonSchemaGen, make)
}

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
