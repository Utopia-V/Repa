// 插件模板。把 repa-plugin.json 和这个文件复制到空间的 .agents/plugins/<id>/，再改标了“改：”的地方。
// 这个文件不经构建直接运行：Node 只去掉类型标注，所以不能用 enum、namespace 这类需要转换的写法。

// 只能导入 Node 内置模块、本文件夹里的文件（写出真实扩展名，例如 "./feed.ts"）和 "@repa/base/plugin"。
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";

import { Type } from "@repa/base/plugin";
// 只是类型的名字要用 import type，否则加载时报“没有导出这个名字”。
import type { Plugin, Tool } from "@repa/base/plugin";

// 改：插件 id，与文件夹名、repa-plugin.json 里的 id 三者相同。
const ID = "example";

// 改：工具的参数。顶层用 Type.Object，每个字段写 description，模型照着它填参数。
const AddParameters = Type.Object({
  text: Type.String({ description: "要记下的一行文字" }),
}, { additionalProperties: false });

// 模块顶层只定义代码。读文件、联网、启动定时器都放进 open：同一版本再次打开时不再执行顶层代码。
export default {
  id: ID,
  async open(host) {
    // 插件自己的数据放在 host.space.dataDir，用 node:fs 读写；它在不同会话之间保留。
    const file = path.join(host.space.dataDir, "items.txt");

    // 改：换成你的工具。name 以字母开头，只含字母、数字和下划线，加上插件名作前缀免得和别的插件重名。
    const add: Tool = {
      name: "example_add",
      description: "记下一行文字，返回已经记下的条数。",
      parameters: AddParameters,
      async execute(input) {
        // 宿主已经按 parameters 校验过 input。
        const { text } = input as { text: string };
        await appendFile(file, `${text.replace(/\n/g, " ")}\n`, "utf8");
        const count = (await readFile(file, "utf8")).split("\n").filter((line) => line !== "").length;
        // 返回给模型的文字，写成分行的必要内容；出错时 throw new Error("说明")，模型会读到这句说明。
        return { text: `已记下，共 ${count} 条。` };
      },
    };

    return {
      // 改：告诉模型什么时候用这些工具，一两句。
      instructions: () => "使用者要记下一行文字时，调用 example_add。",
      tools: () => [add],
      async close() {
        // 收回 open 里启动的定时器和连接，等后台工作结束。插件卸载后，这里只能写自己的数据目录。
      },
    };
  },
} satisfies Plugin;
