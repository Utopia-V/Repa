import { Type } from "typebox";
import { IdSchema as id, object, RevisionSchema as revision } from "../schema.js";
import {
  ContentTargetSchema, ContentReadSchema, ContentInfoSchema, ContentValueSchema,
  WriteBaseSchema, ContentChangeResultSchema, ContentRefSchema, FileLocationSchema,
  ContentRoleSchema, ContentMemberSchema, ResourceRefSchema, ContentOperationSchema,
  ContextStateSchema, ContextBindingSchema, ContextViewSchema,
  ResourceHoldSchema,
} from "./schema.js";

const operation = { operationId: id };
const target = { target: ContentTargetSchema };
const ref = { ref: ContentRefSchema };
const space = { spaceId: id };
const change = ContentChangeResultSchema;

/** 仅登记已接入的公开内容方法；领域数据由相邻 schema 持有。 */
export const contentMethods = {
  "content.list": { params: object({ ...space, path: Type.Optional(Type.String()) }), result: Type.Array(ContentInfoSchema) },
  "content.get": { params: object(target), result: ContentInfoSchema },
  "content.read": { params: object({ ...target,
    offset: Type.Optional(Type.Integer({ minimum: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
    revision: Type.Optional(revision),
  }), result: ContentReadSchema },
  "content.write": { params: object({ ...target, ...operation, value: ContentValueSchema, base: WriteBaseSchema }), result: change },
  "content.edit": { params: object({ ...target, ...operation,
    edits: Type.Array(object({ oldText: Type.String({ minLength: 1 }), newText: Type.String() }), { minItems: 1 }),
  }), result: change },
  "content.applyPatch": { params: object({ ...space, ...operation, patch: Type.String() }), result: change },
  "content.move": { params: object({ ...target, ...operation, destination: FileLocationSchema, base: revision, container: Type.Optional(Type.Boolean()) }), result: change },
  "content.copy": { params: object({ ...target, ...operation, destination: FileLocationSchema, base: revision, container: Type.Optional(Type.Boolean()) }), result: change },
  "material.collect": { params: object({ ...target, ...operation, destination: FileLocationSchema, base: revision }), result: change },
  "content.associate": { params: object({ ...space, ...operation, location: FileLocationSchema, role: ContentRoleSchema, id: Type.Optional(id) }), result: change },
  "content.relink": { params: object({ ...ref, ...operation, location: FileLocationSchema, base: revision }), result: change },
  "content.remove": { params: object({ ...target, ...operation, base: revision, detach: Type.Optional(Type.Boolean()) }), result: change },
  "content.setComposition": { params: object({ ...ref, ...operation, base: revision,
    members: Type.Array(ContentMemberSchema), resources: Type.Array(ResourceRefSchema),
  }), result: change },
  "operation.get": { params: object({ ...space, ...operation }), result: Type.Union([
    ContentOperationSchema, object({ ...operation, status: Type.Union([Type.Literal("unknown"), Type.Literal("pruned")]) }),
  ]) },
  "operation.undo": { params: object({ ...space, ...operation, undoOperationId: id }), result: change },
  "operation.reconcile": { params: object({ ...space, ...operation }), result: ContentOperationSchema },
  "operation.prune": { params: object({ ...space, operationIds: Type.Array(id) }), result: Type.Array(id) },
  "resource.hold": { params: object({ ...space, id, targets: Type.Optional(Type.Array(ContentTargetSchema)), resources: Type.Optional(Type.Array(ResourceRefSchema)) }), result: ResourceHoldSchema },
  "resource.hold.get": { params: object({ ...space, id }), result: ResourceHoldSchema },
  "resource.hold.renew": { params: object({ ...space, id }), result: ResourceHoldSchema },
  "resource.release": { params: object({ ...space, id }), result: Type.Null() },
  "resource.collect": { params: object(space), result: object({ removed: Type.Integer({ minimum: 0 }), bytes: Type.Integer({ minimum: 0 }) }) },
  "context.get": { params: object(space), result: ContextStateSchema },
  "context.set": { params: object({ ...space, ...operation, base: revision, binding: ContextBindingSchema }), result: change },
  "context.preview": { params: object(space), result: ContextViewSchema },
};
export type ContentMethod = keyof typeof contentMethods;
