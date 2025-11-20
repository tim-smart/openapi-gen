import { it, expect } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { main, Env } from "../src/main.js"
import ts from "typescript"

function typecheck(code: string) {
  const fileName = "virtual-file.ts"

  const compilerOptions: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    // add libs as needed, e.g.:
    // lib: ["ES2021", "DOM"],
  }

  const host = ts.createCompilerHost(compilerOptions)

  // Override how the source file is provided so it uses our string
  host.getSourceFile = (name, languageVersion) => {
    if (name === fileName) {
      return ts.createSourceFile(
        name,
        code,
        languageVersion,
        true,
        ts.ScriptKind.TS,
      )
    }
    // For lib files etc., fall back to default behavior
    return ts.sys.readFile(name)
      ? ts.createSourceFile(name, ts.sys.readFile(name)!, languageVersion, true)
      : undefined
  }

  // Avoid hitting the real FS for the virtual file
  host.fileExists = (filePath) =>
    filePath === fileName || ts.sys.fileExists(filePath)
  host.readFile = (filePath) =>
    filePath === fileName ? code : ts.sys.readFile(filePath)

  const program = ts.createProgram([fileName], compilerOptions, host)

  const diagnostics = [
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ]

  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    ...host,
    getCurrentDirectory: () => process.cwd(),
    getCanonicalFileName: (f) => f,
    getNewLine: () => "\n",
  })
}

it.effect(
  "revenuecat spec",
  () =>
    Effect.gen(function* () {
      const tsOutputFile = yield* main({
        spec: "https://www.revenuecat.com/docs/redocusaurus/plugin-redoc-0.yaml",
        typeOnly: false,
        name: "RevenueCat",
      })

      yield* Effect.log(tsOutputFile)

      const typecheckResult = typecheck(tsOutputFile)

      expect(typecheckResult).toBe("")
    }).pipe(Effect.provide(Env)),
  30_000,
)
