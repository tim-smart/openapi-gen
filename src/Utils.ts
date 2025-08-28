import * as String from "effect/String"
import * as Option from "effect/Option"
import { flow } from "effect/Function"

export const camelize = (self: string): string => {
  let str = ""
  let hadSymbol = false
  for (let i = 0; i < self.length; i++) {
    const charCode = self.charCodeAt(i)
    if (
      (charCode >= 65 && charCode <= 90) ||
      (charCode >= 97 && charCode <= 122)
    ) {
      str += hadSymbol ? self[i].toUpperCase() : self[i]
      hadSymbol = false
    } else if (charCode >= 48 && charCode <= 57) {
      if (str.length > 0) {
        str += self[i]
        hadSymbol = true
      }
    } else if (str.length > 0) {
      hadSymbol = true
    }
  }
  return str
}

export const identifier = (operationId: string) =>
  String.capitalize(camelize(operationId))

export const nonEmptyString = flow(
  Option.fromNullable<unknown>,
  Option.filter(String.isString),
  Option.map(String.trim),
  Option.filter(String.isNonEmpty),
)

export const toComment = Option.match({
  onNone: () => "",
  onSome: (description: string) => `/**
* ${description.replace(/\*\//g, " * /").split("\n").join("\n* ")}
*/\n`,
})

// Decode an OpenAPI $ref JSON Pointer fragment into path tokens.
// Handles RFC3986 percent-decoding and RFC6901 JSON Pointer escapes (~0/~1).
export const decodeRefTokens = (ref: string): ReadonlyArray<string> => {
  if (!ref) return []
  let fragment = ref.startsWith("#") ? ref.slice(1) : ref
  if (fragment.startsWith("/")) fragment = fragment.slice(1)
  if (fragment.length === 0) return []
  return fragment.split("/").map((raw) => {
    let token = raw
    try {
      token = decodeURIComponent(raw)
    } catch {
      // leave as-is if not a valid percent-encoded sequence
    }
    // Unescape JSON Pointer tokens per RFC6901
    return token.replace(/~1/g, "/").replace(/~0/g, "~")
  })
}

export const refLastToken = (ref: string): string => {
  const tokens = decodeRefTokens(ref)
  return tokens.length > 0 ? tokens[tokens.length - 1] : ref
}
