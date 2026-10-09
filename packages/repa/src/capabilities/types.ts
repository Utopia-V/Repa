import type { Static, TSchema } from "typebox";
import type { BackgroundCodec, PreparedBackground } from "../agent/background.js";
import type { PromptSettings } from "../configuration/schema.js";
import type { ContentFormat } from "../content/formats.js";
import type { ContentStore } from "../content/store.js";
import type { ResourceRef } from "../content/schema.js";
import type { SettingsNamespaceDefinition } from "../configuration/definitions.js";
import type { SpaceSnapshotParticipant } from "../spaces/schema.js";
import type { CapabilityContract, CapabilityDescriptor, CapabilityScope, CapabilitySource, CapabilitySelection } from "./schema.js";

/** 来源、权限和窄服务由应用组装；宿主只提供所选插件自己的空间运行资源。 */
export interface InvocationContext<Services extends object = object, SpaceRuntime = unknown> {
  scope: CapabilityScope;
  source: CapabilitySource;
  signal: AbortSignal;
  content?: ContentStore;
  services?: Services;
  spaceRuntime?: SpaceRuntime;
}

export interface CapabilityDefinition<
  Input extends TSchema = TSchema,
  Output extends TSchema = TSchema,
  Services extends object = object,
  SpaceRuntime = unknown,
  ToolInput extends TSchema = Input,
> {
  contract: CapabilityContract;
  implementationId: string;
  inputSchema: Input;
  outputSchema: Output;
  scopes: readonly CapabilityScope["kind"][];
  /** query 读取当前值，不保存请求；修改、资源交付与长任务使用 inline 或 background。 */
  execution: CapabilityDescriptor["execution"];
  tool?: {
    name: string;
    description: string;
    input?: {
      schema: ToolInput;
      /** 同步补足程序参数，不执行权限判断、资源准备或业务操作。 */
      prepare(input: Static<ToolInput>, scope: CapabilityScope): Static<Input>;
    };
  };
  inputResources?(input: Static<Input>, scope: CapabilityScope): readonly ResourceRef[];
  outputResources?(output: Static<Output>): readonly ResourceRef[];
  invoke(input: Static<Input>, context: InvocationContext<Services, SpaceRuntime>): Static<Output> | Promise<Static<Output>>;
}

export interface CapabilityResourceDeclarations {
  inputResources(input: unknown): readonly ResourceRef[];
  outputResources(output: unknown): readonly ResourceRef[];
}

export interface PluginSpaceContext {
  spaceId: string;
  root: string;
  dataDirectory: string;
  signal: AbortSignal;
}

/** 工厂返回定义，不在加载时打开空间数据库；持久格式及迁移完全属于插件。 */
export interface BackendPlugin<Services extends object = object, SpaceRuntime = unknown> {
  capabilities: readonly CapabilityDefinition<TSchema, TSchema, Services, SpaceRuntime>[];
  settings?: readonly SettingsNamespaceDefinition[];
  openSpace?(context: PluginSpaceContext): SpaceRuntime | Promise<SpaceRuntime>;
  closeSpace?(runtime: SpaceRuntime, context: PluginSpaceContext): void | Promise<void>;
  snapshot?: SpaceSnapshotParticipant;
}

export type BackendPluginFactory = () => BackendPlugin | Promise<BackendPlugin>;

/** 安装级声明不执行后台工厂，关闭能力时仍能识别历史与持久数据。 */
/** 安装级轻量声明；独立于运行能力工厂和空间运行时。 */
export interface PluginContributions {
  backgrounds?: readonly CapabilityBackground[];
  formats?: readonly ContentFormat[];
}

export interface BackendPluginRegistration extends PluginContributions {
  id: string;
  enabled: boolean;
  factory: BackendPluginFactory;
  /** 安装时提供的轻量持久 owner；禁用运行能力后仍可参与空间快照。 */
  snapshot?: SpaceSnapshotParticipant;
}

export interface CapabilityBackground {
  codec: BackgroundCodec;
  selection: CapabilitySelection;
  input: unknown;
  enabled?(settings: PromptSettings): boolean;
  prepare(result: unknown): PreparedBackground | Promise<PreparedBackground>;
  /** 只有声明匹配当前实现时才能静态预览；缺少声明时显示动态来源。 */
  preview?: {
    implementationId: string;
    read(content: ContentStore): PreparedBackground | Promise<PreparedBackground>;
  };
}
