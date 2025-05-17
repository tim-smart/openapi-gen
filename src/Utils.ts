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
  Option.fromNullable<string | null | undefined>,
  Option.map(String.trim),
  Option.filter(String.isNonEmpty),
)

export const toComment = Option.match({
  onNone: () => "",
  onSome: (description: string) => `/**
* ${description.split("\n").join("\n* ")}
*/\n`,
})
