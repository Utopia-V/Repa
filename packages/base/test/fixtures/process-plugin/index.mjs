// 进程测试用的最小插件：构建后的 CLI 不经 tsx 直接加载，所以用纯 JavaScript 写。
export default {
  id: "fixture",
  async open() {
    return {
      agents: () => [{
        id: "helper",
        description: "进程测试用的 Agent",
        instructions: () => "只回答测试中的问题。",
        tools: [],
        direct: true,
      }],
    };
  },
};
