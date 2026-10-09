import type { BackendPluginRegistration } from "../capabilities/types.js";
import { learningContextCodec, prepareLearningBackground } from "./background.js";
import { learningContentFormat } from "./content-format.js";
import { LearningContext } from "./context.js";
import { createLearningPlugin } from "./plugin.js";
import { LEARNING_PLUGIN_ID } from "./settings.js";

export const learningPluginRegistration: BackendPluginRegistration = {
  id: LEARNING_PLUGIN_ID,
  enabled: true,
  factory: createLearningPlugin,
  formats: [learningContentFormat],
  backgrounds: [{
    codec: learningContextCodec,
    selection: { contract: { id: "repa.context.preview", version: "1" }, implementationId: "official" },
    input: {},
    enabled: settings => settings.learningContext,
    prepare: prepareLearningBackground,
    preview: {
      implementationId: "official",
      read: async content => prepareLearningBackground(await new LearningContext(content).preview()),
    },
  }],
};
