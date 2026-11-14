/**
 * 询问模式下哪些 bash 命令不必确认：只由下面几个只读命令组成、用 `&&`、`;`、`|` 连接的简单命令。
 *
 * 这是减少打扰的手段，不是安全边界。通用 Agent 的 read、ls、find、grep 本来就能读空间外的文件而不询问，
 * 这里放行的是同一类事情：看目录、看文件、查版本。判断按命令文字进行，不写完整的 shell 解析器，
 * 只认得出一小部分写法，认不出的一律照常询问。重定向、命令替换、变量、子 shell、花括号、here-doc、
 * 反斜杠、`||`、后台 `&`、换行都在字符这一层被拒绝；双引号里只要出现 `$`、反引号、`\`、`!` 也拒绝。
 * 唯一认得的重定向是丢掉错误输出的 `2>/dev/null`，它不写任何文件，模型查看目录时常顺手带上。
 * Windows 上 Pi 的 bash 工具运行的同样是 bash（Git Bash 等），按同一套写法判断。
 *
 * 名单只放没有写入能力、也不会执行别的命令的命令：GNU 与 BSD 的这些命令都没有写文件的选项。
 * tail 的 -f／-F／--follow／--retry 会一直等下去，带这些选项或带通配符（文件名可能被展开成选项）时照常询问。
 * find、grep 有专门的工具；sed、sort、awk、xargs、git、file 等带写入或执行别的命令的选项，没有放进来。
 * 命令名必须原样是名单里的词：带路径、带环境变量前缀、sudo 都照常询问。
 */

const READ_ONLY = new Set(["ls", "cat", "pwd", "head", "tail", "wc", "which", "stat", "du", "echo", "cd"]);

// 只接受 `--version`（node 另有 -v）且没有别的参数的版本查询。npm 不放：它启动时可能检查更新、写缓存。
const VERSION_QUERIES: Record<string, readonly string[]> = {
  node: ["--version", "-v"],
  git: ["--version"],
  python: ["--version"],
  python3: ["--version"],
};

// 不加引号时可以出现在词里的字符；通配符 * 和 ? 只用于展开文件名，读到的仍是文件。
const WORD = /[\p{L}\p{N}_\-./,:=+@%~*?]/u;

// 单独成词的 2>/dev/null，前面是空白，后面是空白、命令末尾或连接符。
const DISCARD_ERRORS = /(?<=[ \t])2>\/dev\/null(?=$|[ \t;|&])/g;

/** 命令只由名单里的只读命令组成时返回 true；拿不准的都返回 false，照常询问。 */
export function readOnlyCommand(command: string): boolean {
  const segments = split(command.replace(DISCARD_ERRORS, ""));
  return segments !== undefined && segments.every(allowed);
}

interface Word {
  text: string;
  glob: boolean;
}

/** 按 `&&`、`;`、`|` 切成简单命令，每段是词的列表；出现认不出的字符或空段时返回 undefined。 */
function split(command: string): Word[][] | undefined {
  const segments: Word[][] = [];
  let words: Word[] = [];
  let word: Word | undefined;
  const endWord = () => {
    if (word !== undefined) words.push(word);
    word = undefined;
  };
  const endSegment = (): boolean => {
    endWord();
    if (words.length === 0) return false;
    segments.push(words);
    words = [];
    return true;
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i] ?? "";
    if (char === " " || char === "\t") {
      endWord();
    } else if (char === ";" || char === "|") {
      if (command[i + 1] === "|" || command[i + 1] === "&") return undefined;
      if (!endSegment()) return undefined;
    } else if (char === "&") {
      if (command[i + 1] !== "&") return undefined;
      i++;
      if (!endSegment()) return undefined;
    } else if (char === "'" || char === "\"") {
      const close = command.indexOf(char, i + 1);
      if (close < 0) return undefined;
      const quoted = command.slice(i + 1, close);
      if (quoted.includes("\n") || quoted.includes("\r")) return undefined;
      if (char === "\"" && /[$`\\!]/.test(quoted)) return undefined;
      word = { text: (word?.text ?? "") + quoted, glob: word?.glob ?? false };
      i = close;
    } else if (WORD.test(char)) {
      word = { text: (word?.text ?? "") + char, glob: (word?.glob ?? false) || char === "*" || char === "?" };
    } else {
      return undefined;
    }
  }
  return endSegment() ? segments : undefined;
}

function allowed(words: Word[]): boolean {
  const [name, ...args] = words;
  if (name === undefined || name.glob) return false;
  const versions = VERSION_QUERIES[name.text];
  if (versions !== undefined) {
    const [flag] = args;
    return args.length === 1 && flag !== undefined && !flag.glob && versions.includes(flag.text);
  }
  if (!READ_ONLY.has(name.text)) return false;
  if (name.text === "tail") return args.every(arg => !arg.glob && !follows(arg.text));
  return true;
}

/** tail 会一直等待新内容的选项：短选项组里的 f／F，以及 --follow、--retry 及其缩写。 */
function follows(arg: string): boolean {
  if (arg.startsWith("--")) return arg.length > 2 && (arg.startsWith("--f") || arg.startsWith("--r"));
  return arg.startsWith("-") && /[fF]/.test(arg);
}
