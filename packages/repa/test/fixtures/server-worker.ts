import path from "node:path";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { startRepaServer } from "../../src/server.js";

const agentDir = process.argv[2]!;
const faux = fauxProvider({
  api: "repa-crash-test",
  provider: "repa-crash-test",
  models: [
    {
      id: "test",
      name: "test",
      reasoning: false,
      input: ["text"],
      contextWindow: 16384,
      maxTokens: 512,
    },
  ],
  tokensPerSecond: 0,
});
faux.setResponses([
  fauxAssistantMessage(fauxToolCall("fixture_question", {}), {
    stopReason: "toolUse",
  }),
  fauxAssistantMessage("ANSWERED"),
]);
const modelRuntime = await ModelRuntime.create({
  authPath: path.join(agentDir, "auth.json"),
  modelsPath: null,
  allowModelNetwork: false,
  refreshOnCreate: false,
});
modelRuntime.registerNativeProvider(faux.provider);
const server = await startRepaServer({
  agentDir,
  trustExtensions: true,
  modelOverride: { modelRuntime, model: faux.getModel() },
});
process.send?.(server.connection);
process.on("SIGTERM", () => {
  void server.close();
});
await server.closed;
