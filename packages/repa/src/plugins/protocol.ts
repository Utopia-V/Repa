import { Type } from "typebox";
import { object, IdSchema } from "../schema.js";
import { CapabilityScopeSchema } from "../capabilities/schema.js";
import { BackgroundRequestSchema } from "../requests/schema.js";
import { PluginPackageSchema } from "./schema.js";

const scope = { scope: CapabilityScopeSchema };
const source = Type.String({ minLength: 1 });
export const packageMethods = {
  "package.list": { params: object(scope), result: Type.Array(PluginPackageSchema) },
  "package.install": { params: object({ ...scope, requestId: IdSchema, source }), result: BackgroundRequestSchema },
  "package.update": { params: object({ ...scope, requestId: IdSchema, source: Type.Optional(source) }), result: BackgroundRequestSchema },
  "package.remove": { params: object({ ...scope, requestId: IdSchema, source }), result: BackgroundRequestSchema },
};
export type PackageMethod = keyof typeof packageMethods;
