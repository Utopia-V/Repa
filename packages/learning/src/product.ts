import {
  RepaApplication,
  startRepaServer,
  type ApplicationOptions,
  type RepaServer,
  type ServerOptions,
} from "repa";
import { bundledLearningPackages } from "./composition.js";
import { learningPluginRegistration } from "./contributions.js";
import { learningPromptDefaults } from "./settings.js";

/** 官方学习产品装配领域能力；通用底座只接收已装配的注册与默认值。 */
export function learningApplicationOptions(options: ApplicationOptions = {}): ApplicationOptions {
  const customBundles = options.bundledPackages;
  const customPrompts = options.promptDefaults;
  return {
    ...options,
    plugins: [learningPluginRegistration, ...options.plugins ?? []],
    bundledPackages: configuration => [
      ...bundledLearningPackages(configuration.disabled),
      ...(typeof customBundles === "function" ? customBundles(configuration) : customBundles ?? []),
    ],
    promptDefaults: configuration => ({
      ...learningPromptDefaults(configuration),
      ...customPrompts?.(configuration),
    }),
  };
}

export function createLearningApplication(options: ApplicationOptions = {}): RepaApplication {
  return new RepaApplication(learningApplicationOptions(options));
}

export function startLearningServer(options: ServerOptions = {}): Promise<RepaServer> {
  return startRepaServer({ ...options, ...learningApplicationOptions(options) });
}
