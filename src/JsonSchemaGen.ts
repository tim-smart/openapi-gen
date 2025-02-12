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
        if (!schema.$ref.startsWith("#")) {
          return
        }
        const path = schema.$ref.slice(2).split("/")
        const name = identifier(path[path.length - 1])
        if (store.has(name)) {
          return
        }
        let current: JsonSchema.JsonSchema = {
          ...root,
          ...context,
        }
        for (const key of path) {
          if (!current) return
          current = (current as any)[key] as JsonSchema.JsonSchema
        }
        refStore.set(schema.$ref, current)
        addRefs(current, name)
        store.set(name, current)
        if (!asStruct) {
          classes.add(name)
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
        ;(schema as any).allOf.forEach((s: any) =>
          addRefs(s, childName ? childName + "Enum" : undefined),
        )
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
          const fullSchema =
            "$ref" in schema ? refStore.get(schema.$ref)! : schema
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
      const sources = pipe(
        (schema as any).allOf as Array<JsonSchema.JsonSchema>,
        Arr.filterMap((_) => toSource(S, _, currentIdentifier + "Enum")),
      )
      if (sources.length === 0) {
        return Option.none()
      } else if (sources.length === 1) {
        return Option.some(sources[0])
      }
      const first = sources[0]
      const modifiers: Array<string> = []
      for (let i = 1; i < sources.length; i++) {
        modifiers.push(sources[i])
      }
      return Option.some(`${first}${pipeSource(modifiers)}`)
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
        return `${S}.optionalWith(${source}, { nullable: true, default: () => null })`
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
