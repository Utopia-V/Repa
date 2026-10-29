import type { TSchema } from "typebox";

import { cell } from "./generation.js";

interface Schema {
  type?: string;
  const?: unknown;
  enum?: unknown[];
  anyOf?: Schema[];
  oneOf?: Schema[];
  items?: Schema;
  properties?: Record<string, Schema>;
  patternProperties?: Record<string, Schema>;
  required?: string[];
  description?: string;
  $ref?: string;
}

export function schemaType(schema: Schema): string {
  if ("const" in schema) return JSON.stringify(schema.const);
  const variants = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(variants)) return variants.map((item: Schema) => schemaType(item)).join(" | ");
  if (Array.isArray(schema.enum)) return schema.enum.map((item: unknown) => JSON.stringify(item)).join(" | ");
  if (schema.type === "array") return `Array<${schemaType(schema.items ?? {})}>`;
  if (schema.type === "object" || schema.properties) return "object";
  return typeof schema.type === "string" ? schema.type : typeof schema.$ref === "string" ? schema.$ref : "unknown";
}

export function schemaTable(schema: TSchema): string {
  const rows: string[] = ["| 字段 | 类型 | 可选 | 说明 |", "| --- | --- | --- | --- |"];
  const visit = (current: Schema, name: string, optional: boolean): void => {
    rows.push(`| ${cell(name)} | ${cell(schemaType(current))} | ${optional ? "是" : "否"} | ${cell(String(current.description ?? ""))} |`);
    const properties = current.properties;
    for (const [key, child] of Object.entries(properties ?? {}).sort(([a], [b]) => a.localeCompare(b, "en"))) {
      visit(child, name === "$" ? key : `${name}.${key}`, !current.required?.includes(key));
    }
    if (current.type === "array" && current.items && !Array.isArray(current.items)) visit(current.items, `${name}[]`, false);
    for (const [index, variant] of (current.anyOf ?? current.oneOf ?? []).entries()) {
      visit(variant, `${name}（变体 ${index + 1}）`, false);
    }
    for (const [key, child] of Object.entries(current.patternProperties ?? {})) {
      visit(child, `${name}[${key}]`, true);
    }
  };
  visit(schema as Schema, "$", false);
  return rows.join("\n");
}
