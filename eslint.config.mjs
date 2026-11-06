// 只放能机械判断的硬规则，每条报错写明该怎么改；判断性的约定留在 repa-code-style。
// 规则的来由见 .agents/notes/proposed/process/2026-11-06-mechanical-checks.md。
import tseslint from "typescript-eslint";

const CODE_STYLE = ".agents/skills/repa-code-style/SKILL.md";

const NO_ANY = `不用 any：外部输入先当 unknown，在入口按 schema 解析校验后再用；SDK 泛型确实表达不了时，把适配限制在边界并注明原因（${CODE_STYLE}）。`;
const NO_NON_NULL = `不用非空断言 !：用条件判断收窄类型，或在边界校验后得到确定的类型（${CODE_STYLE}）。`;
const WEB_BACKEND = "前端只经 @repa/base/client 与 @repa/base/protocol 接入后端，组件层不自行实现协议、持久化或模型调用（apps/web/AGENTS.md）。";
const WEB_NODE = "前端代码在浏览器里运行，不能引入 Node 内置模块；需要宿主能力时经 src/lib/host.ts。";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/.vite/**", "**/coverage/**", "prototypes/**", ".scratch/**"],
  },
  {
    files: ["packages/*/src/**/*.ts", "packages/*/test/**/*.ts", "apps/*/src/**/*.{ts,tsx}", "apps/*/test/**/*.{ts,tsx}", "scripts/**/*.ts"],
    languageOptions: { parser: tseslint.parser },
    plugins: { "@typescript-eslint": tseslint.plugin },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "no-restricted-syntax": ["error", { selector: "TSAnyKeyword", message: NO_ANY }],
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-ignore": true,
          "ts-nocheck": true,
          "ts-expect-error": "allow-with-description",
          minimumDescriptionLength: 10,
        },
      ],
    },
  },
  {
    // 非空断言只在源码里禁止：这条规则防的是用 ! 代替边界校验；测试里的 ! 表达“这里必有值，没有就该失败”。
    files: ["packages/*/src/**/*.ts", "apps/*/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: "TSAnyKeyword", message: NO_ANY },
        { selector: "TSNonNullExpression", message: NO_NON_NULL },
      ],
    },
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { regex: "^@repa/base(?!/(client|protocol)$)", message: WEB_BACKEND },
            { regex: "^node:", message: WEB_NODE },
          ],
        },
      ],
    },
  },
);
