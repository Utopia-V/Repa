import assert from "node:assert/strict";
import test from "node:test";
import { readOnlyCommand } from "../src/agent/read-only-command.js";

test("名单内的简单命令及其管道、&& 与 ; 组合不必确认", () => {
  for (const command of [
    "ls -la",
    "cat README.md",
    "pwd",
    "node --version",
    "node -v",
    "git --version",
    "ls -la docs && cat 'docs/说明 文档.md'",
    "cat notes.txt | head -n 20 | wc -l",
    "cd packages/base; ls *.ts",
    "echo \"第一步完成\"",
    "du -sh . && stat package.json && which node",
    "tail -n 50 log.txt",
    "cd space && ls -la .agents 2>/dev/null && ls .agents/plugins 2>/dev/null",
  ]) {
    assert.equal(readOnlyCommand(command), true, command);
  }
});

test("任何一段不在名单里，或用了 2>/dev/null 以外的重定向、命令替换、变量、换行等写法，照常询问", () => {
  for (const command of [
    "",
    "rm -rf build",
    "ls && rm file",
    "cat a | sh",
    "ls; npm install",
    "echo hi > out.txt",
    "cat < in.txt",
    "cat $(which node)",
    "echo `whoami`",
    "echo $HOME",
    "echo \"$HOME\"",
    "ls\nrm file",
    "ls || rm file",
    "ls &",
    "ls |& head",
    "(cd /tmp && ls)",
    "echo {a,b}",
    "cat <<EOF",
    "ls \\; rm x",
    "ls 'unterminated",
    "ls;",
    "FOO=1 ls",
    "sudo ls",
    "/bin/ls",
    "./ls",
    "node script.js",
    "node --version --eval x",
    "find . -delete",
    "grep -r x .",
    "git status",
    "sed -i s/a/b/ file",
    "tail -f log.txt",
    "tail -nF 5 log.txt",
    "tail --follow=name log.txt",
    "tail *.log",
    "ls # comment",
    "ls 2>errors.txt",
    "ls 2>/dev/null>out.txt",
    "ls 2>/dev/null&",
    "ls 2>/dev/null && rm file",
  ]) {
    assert.equal(readOnlyCommand(command), false, command);
  }
});
