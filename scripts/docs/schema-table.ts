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
  title?: string;
  $id?: string;
  $ref?: string;
}

interface Field {
  name: string;
  schema: Schema;
  optional: boolean;
}

// 目录要能被整篇读完，字段只展开 a 和 a.b 两层。
const DEPTH = 2;

export function schemaType(schema: Schema): string {
  if ("const" in schema) return JSON.stringify(schema.const);
  const variants = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(variants)) return variants.map((item: Schema) => schemaType(item)).join(" | ");
  if (Array.isArray(schema.enum)) return schema.enum.map((item: unknown) => JSON.stringify(item)).join(" | ");
  if (schema.type === "array") return `Array<${schemaType(schema.items ?? {})}>`;
  if (schema.type === "object" || schema.properties) return "object";
  return typeof schema.type === "string" ? schema.type : typeof schema.$ref === "string" ? schema.$ref : "unknown";
}

function variants(schema: Schema): Schema[] | undefined {
  const branches = schema.anyOf ?? schema.oneOf;
  return Array.isArray(branches) ? branches : undefined;
}

function isObject(schema: Schema): boolean {
  return !variants(schema) && (schema.type === "object" || schema.properties !== undefined || schema.patternProperties !== undefined);
}

// 对象的下一层字段：具名字段按名称排序，模式字段写成 a[模式]；根对象的字段不加前缀。
function fields(schema: Schema, name: string): Field[] {
  if (!isObject(schema)) return [];
  const prefix = name === "$" ? "" : `${name}.`;
  return [
    ...Object.entries(schema.properties ?? {}).sort(([a], [b]) => a.localeCompare(b, "en"))
      .map(([key, child]) => ({ name: `${prefix}${key}`, schema: child, optional: !schema.required?.includes(key) })),
    ...Object.entries(schema.patternProperties ?? {}).map(([key, child]) => ({ name: `${name}[${key}]`, schema: child, optional: true })),
  ];
}

// 数组不单占一层：字段 a 是数组时整行写成 a[]，类型写元素的类型，说明合并数组和元素各自的说明。
function unwrap(field: Field): { name: string; schema: Schema; notes: string[] } {
  let { name, schema } = field;
  const notes = [schema.description];
  while (schema.type === "array" && schema.items && !Array.isArray(schema.items)) {
    schema = schema.items;
    name = `${name}[]`;
    notes.push(schema.description);
  }
  return { name, schema, notes: notes.filter((note): note is string => typeof note === "string" && note !== "") };
}

// 表里没有列出字段的对象，包括第二层以下的对象和联合的分支。
function hiddenObjects(schema: Schema): Schema[] {
  const branches = variants(schema);
  if (branches) return branches.flatMap(hiddenObjects);
  if (schema.type === "array" && schema.items && !Array.isArray(schema.items)) return hiddenObjects(schema.items);
  return Object.keys(schema.properties ?? {}).length || Object.keys(schema.patternProperties ?? {}).length ? [schema] : [];
}

// 字段没有列出的对象按 schema 名或 $id 指过去；没有名字时指向源码。
function pointer(schema: Schema): string | undefined {
  const hidden = hiddenObjects(schema);
  if (!hidden.length) return undefined;
  const names = hidden.map((object) => object.title ?? object.$id);
  if (names.every((name): name is string => typeof name === "string" && name !== "")) return `字段见 ${[...new Set(names)].join("、")}`;
  return "嵌套对象，字段见源码";
}

export function schemaTable(schema: TSchema): string {
  const rows: string[] = ["| 字段 | 类型 | 可选 | 说明 |", "| --- | --- | --- | --- |"];
  const visit = (field: Field, depth: number): void => {
    const { name, schema: current, notes } = unwrap(field);
    const children = depth < DEPTH ? fields(current, name) : [];
    const hint = children.length ? undefined : pointer(current);
    rows.push(`| ${cell(name)} | ${cell(schemaType(current))} | ${field.optional ? "是" : "否"} | ${cell([...notes, ...(hint ? [hint] : [])].join("；"))} |`);
    for (const child of children) visit(child, depth + 1);
  };
  const root = unwrap({ name: "$", schema: schema as Schema, optional: false });
  // 根是对象或对象数组时不写根这一行，直接列字段；根是联合、null 等没有字段可列时，用一行写出它的类型。
  if (isObject(root.schema)) {
    for (const field of fields(root.schema, root.name)) visit(field, 1);
  } else {
    visit({ name: "$", schema: schema as Schema, optional: false }, DEPTH);
  }
  return rows.join("\n");
}
