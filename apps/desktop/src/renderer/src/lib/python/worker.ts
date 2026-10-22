// Python Worker 的入口。运行逻辑在学习包里；这个文件让开发服务器按固定路径、生产构建按 workers/ 目录给它加 CSP 响应头，原因见学习包的 worker.ts。
import "@repa/learning/python-runner/worker";
