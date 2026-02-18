# openapi-gen

Generate Effect http clients from openapi specification.

## Usage

```bash
npx @tim-smart/openapi-gen --spec <path-to-spec> --name <ClientName> > src/Client.ts
```

## Options

| Option        | Alias | Description                                   | Default  |
| ------------- | ----- | --------------------------------------------- | -------- |
| `--spec`      | `-s`  | The OpenAPI spec file path or URL (json/yaml) | Required |
| `--name`      | `-n`  | The name of the generated client              | `Client` |
| `--type-only` | `-t`  | Generate a type-only client without schemas   | `false`  |

## Example

```bash
npx @tim-smart/openapi-gen --spec ./openapi.yaml > src/Client.ts
```
