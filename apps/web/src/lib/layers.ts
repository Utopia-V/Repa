// 弹层可能不在同一棵 React 树里（比如全局的命令确认框压在设置弹窗上），Esc 只该关最上面一层。
const open: symbol[] = [];

export function pushLayer(id: symbol): () => void {
  open.push(id);
  return () => {
    const index = open.lastIndexOf(id);
    if (index >= 0) open.splice(index, 1);
  };
}

export function isTopLayer(id: symbol): boolean {
  return open.at(-1) === id;
}
