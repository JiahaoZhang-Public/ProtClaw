/**
 * generate-ts.ts
 *
 * Reads JSON Schema files from schemas/ and generates:
 * - src/generated/<name>.ts with Zod schemas + inferred TS types
 * - src/generated/index.ts barrel export
 *
 * Usage:
 *   tsx scripts/generate-ts.ts          # Generate files
 *   tsx scripts/generate-ts.ts --check  # Check if generated files are up-to-date
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const SCHEMAS_DIR = path.resolve(import.meta.dirname, "../schemas");
const GENERATED_DIR = path.resolve(import.meta.dirname, "../src/generated");
const CHECK_MODE = process.argv.includes("--check");

interface JSONSchemaProperty {
  type?: string | string[];
  enum?: unknown[];
  items?: JSONSchemaProperty;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  additionalProperties?: JSONSchemaProperty | boolean;
  description?: string;
  default?: unknown;
  format?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  $ref?: string;
  definitions?: Record<string, JSONSchemaProperty>;
}

interface JSONSchema extends JSONSchemaProperty {
  $schema?: string;
  $id?: string;
  title?: string;
}

function kebabToCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function kebabToPascal(s: string): string {
  const camel = kebabToCamel(s);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

function schemaNameFromFile(filename: string): string {
  return filename.replace(".schema.json", "");
}

function generateZodType(prop: JSONSchemaProperty, indent = ""): string {
  if (prop.$ref) {
    return "z.any()";
  }

  const rawType = Array.isArray(prop.type) ? prop.type : [prop.type];
  const hasNull = rawType.includes("null");
  const types = rawType.filter((t) => t && t !== "null");
  const primaryType = types[0] || "any";

  let zodExpr: string;

  if (prop.enum) {
    const values = prop.enum.filter((v) => v !== null);
    if (values.length > 0 && values.every((v) => typeof v === "string")) {
      zodExpr = `z.enum([${values.map((v) => `"${v}"`).join(", ")}])`;
    } else {
      zodExpr = "z.any()";
    }
  } else {
    switch (primaryType) {
      case "string":
        zodExpr = "z.string()";
        break;
      case "number":
      case "float":
        zodExpr = "z.number()";
        if (prop.minimum !== undefined) zodExpr += `.min(${prop.minimum})`;
        if (prop.maximum !== undefined) zodExpr += `.max(${prop.maximum})`;
        break;
      case "integer":
        zodExpr = "z.number().int()";
        if (prop.minimum !== undefined) zodExpr += `.min(${prop.minimum})`;
        if (prop.maximum !== undefined) zodExpr += `.max(${prop.maximum})`;
        break;
      case "boolean":
        zodExpr = "z.boolean()";
        break;
      case "array":
        if (prop.items) {
          zodExpr = `z.array(${generateZodType(prop.items, indent)})`;
        } else {
          zodExpr = "z.array(z.any())";
        }
        if (prop.minItems !== undefined) zodExpr += `.min(${prop.minItems})`;
        break;
      case "object":
        if (
          prop.properties &&
          Object.keys(prop.properties).length > 0
        ) {
          const required = new Set(prop.required || []);
          const entries = Object.entries(prop.properties)
            .map(([key, val]) => {
              let field = generateZodType(val, indent + "  ");
              if (!required.has(key)) {
                field += ".optional()";
              }
              if (val.default !== undefined) {
                field += `.default(${JSON.stringify(val.default)})`;
              }
              return `${indent}  ${key}: ${field},`;
            })
            .join("\n");
          zodExpr = `z.object({\n${entries}\n${indent}})`;
        } else if (
          prop.additionalProperties &&
          typeof prop.additionalProperties === "object"
        ) {
          zodExpr = `z.record(z.string(), ${generateZodType(prop.additionalProperties, indent)})`;
        } else {
          zodExpr = "z.record(z.string(), z.any())";
        }
        break;
      default:
        zodExpr = "z.any()";
    }
  }

  if (hasNull) {
    zodExpr += ".nullable()";
  }

  return zodExpr;
}

function generateSchemaFile(schema: JSONSchema, name: string): string {
  const pascalName = kebabToPascal(name);
  const schemaVarName = `${pascalName}Schema`;

  const lines: string[] = [
    "// Auto-generated from JSON Schema. Do not edit manually.",
    `// Source: schemas/${name}.schema.json`,
    `// Run \`pnpm codegen\` from packages/contracts to regenerate.`,
    "",
    'import { z } from "zod";',
    "",
  ];

  // Handle definitions (used by container-io)
  if (schema.definitions) {
    for (const [defName, defSchema] of Object.entries(schema.definitions)) {
      const defPascal = kebabToPascal(
        defName.replace(/([A-Z])/g, "-$1").toLowerCase().replace(/^-/, "")
      );
      const defVarName = `${defName}Schema`;
      lines.push(
        `export const ${defVarName} = ${generateZodType(defSchema as JSONSchemaProperty)};`
      );
      lines.push(
        `export type ${defName} = z.infer<typeof ${defVarName}>;`
      );
      lines.push("");
    }
  }

  // Main schema
  if (schema.properties) {
    lines.push(`export const ${schemaVarName} = ${generateZodType(schema)};`);
    lines.push("");
    lines.push(`export type ${pascalName} = z.infer<typeof ${schemaVarName}>;`);
  }

  lines.push("");
  return lines.join("\n");
}

function main(): void {
  const schemaFiles = fs
    .readdirSync(SCHEMAS_DIR)
    .filter((f) => f.endsWith(".schema.json"))
    .sort();

  if (schemaFiles.length === 0) {
    console.error("No schema files found in", SCHEMAS_DIR);
    process.exit(1);
  }

  const generated: Map<string, string> = new Map();
  const exports: string[] = [];

  for (const file of schemaFiles) {
    const name = schemaNameFromFile(file);
    const schemaPath = path.join(SCHEMAS_DIR, file);
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8")) as JSONSchema;

    const content = generateSchemaFile(schema, name);
    const outFile = `${kebabToCamel(name)}.ts`;
    generated.set(outFile, content);
    exports.push(`export * from "./${kebabToCamel(name)}.js";`);
  }

  // Generate barrel export
  const indexContent = [
    "// Auto-generated barrel export. Do not edit manually.",
    "// Run `pnpm codegen` from packages/contracts to regenerate.",
    "",
    ...exports,
    "",
  ].join("\n");
  generated.set("index.ts", indexContent);

  if (CHECK_MODE) {
    let upToDate = true;
    for (const [file, content] of generated) {
      const filePath = path.join(GENERATED_DIR, file);
      if (!fs.existsSync(filePath)) {
        console.error(`Missing: ${file}`);
        upToDate = false;
        continue;
      }
      const existing = fs.readFileSync(filePath, "utf-8");
      if (existing !== content) {
        console.error(`Stale: ${file}`);
        upToDate = false;
      }
    }
    if (!upToDate) {
      console.error(
        "\nGenerated files are out of date. Run `pnpm codegen` to regenerate."
      );
      process.exit(1);
    }
    console.log("All generated files are up to date.");
    return;
  }

  // Write files
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  for (const [file, content] of generated) {
    const filePath = path.join(GENERATED_DIR, file);
    fs.writeFileSync(filePath, content);
    console.log(`  Generated: src/generated/${file}`);
  }
  console.log(`\n${generated.size} files generated.`);
}

main();
