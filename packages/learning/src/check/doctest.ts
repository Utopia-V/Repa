/** doctest 写法里的一个例子：要执行的源码，以及交互解释器应当显示的内容。 */
export interface DoctestExample {
  source: string;
  want: string;
}

export interface ParsedDoctest {
  examples: DoctestExample[];
  /** 读不懂的行，例如 >>> 后面没有空格；Python 的 doctest 遇到这些会报错。 */
  problems: string[];
}

/**
 * 按 Python doctest 的约定拆分：>>> 开始一个例子，... 是续行，随后直到空行或下一个 >>> 的内容是期望显示；
 * <BLANKLINE> 表示空行。缩进以 >>> 所在行为准。
 */
export function parseDoctest(text: string): ParsedDoctest {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const examples: DoctestExample[] = [];
  const problems: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const start = /^(\s*)>>>(?: (.*))?$/.exec(line);
    if (!start) {
      if (/^\s*(>>>|\.\.\.)\S/.test(line)) problems.push(`第 ${index + 1} 行：>>> 和 ... 后面要有一个空格`);
      index++;
      continue;
    }
    const indent = start[1] ?? "";
    const source = [start[2] ?? ""];
    index++;
    for (; index < lines.length; index++) {
      const continuation = new RegExp(`^${indent}\\.\\.\\.(?: (.*))?$`).exec(lines[index] ?? "");
      if (!continuation) break;
      source.push(continuation[1] ?? "");
    }
    const want: string[] = [];
    for (; index < lines.length; index++) {
      const wanted = lines[index] ?? "";
      if (wanted.trim() === "" || /^\s*>>>/.test(wanted)) break;
      const stripped = wanted.startsWith(indent) ? wanted.slice(indent.length) : wanted.trimStart();
      want.push(stripped === "<BLANKLINE>" ? "" : stripped);
    }
    examples.push({ source: source.join("\n"), want: want.join("\n") });
  }
  return { examples, problems };
}

/** doctest 的比较：去掉行尾空白和末尾空行后逐字相同。 */
export function sameDoctestOutput(want: string, got: string): boolean {
  const normalize = (text: string) => text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd()).join("\n").replace(/\n+$/, "");
  return normalize(want) === normalize(got);
}
