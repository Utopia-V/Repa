import { Type } from "typebox";

export default function fixtureExtension(pi) {
  pi.registerTool({
    name: "fixture_question",
    label: "Fixture Question",
    description: "Ask for a value through the host UI.",
    parameters: Type.Object({}),
    async execute(_id, _parameters, signal, _onUpdate, ctx) {
      const answer = await ctx.ui.input("FIXTURE_QUESTION", undefined, {
        signal,
      });
      return { content: [{ type: "text", text: answer ?? "CANCELLED" }] };
    },
  });
  pi.registerTool({
    name: "fixture_media",
    label: "Fixture Media",
    description: "Return a deterministic image and structured tool details.",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [
          { type: "text", text: "FIXTURE_MEDIA" },
          {
            type: "image",
            mimeType: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=",
          },
        ],
        details: { answer: 42, sequence: [1, 2] },
      };
    },
  });
  pi.registerTool({
    name: "fixture_echo",
    label: "Fixture Echo",
    description:
      "Echo deterministic text for the Repa Application acceptance test.",
    parameters: Type.Object({ message: Type.String() }),
    async execute(_toolCallId, parameters) {
      return {
        content: [{ type: "text", text: `fixture:${parameters.message}` }],
        details: { message: parameters.message },
      };
    },
  });
}
