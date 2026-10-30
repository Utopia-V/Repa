// Python Worker 的入口。运行逻辑在 @repa/python-runner 里；这个文件让开发服务器按固定路径、生产构建按 workers/ 目录给它加 CSP 响应头，原因见运行器包的 worker.ts。
import "@repa/python-runner/worker";
