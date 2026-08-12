---
name: plan-review
description: lark-channel-bridge-src 复杂任务拆解 + 多 Agent 评审
---

# 复杂任务拆解与多 Agent 评审

## 触发条件
以下场景启动本工作流：
- 改消息协议或转发逻辑
- 改流式卡片渲染
- 改会话管理/恢复/中断
- 改 workspace/文件隔离
- 改子进程启动方式
- 改 OAuth/身份模型
- 改发布/打包流程

## 流程

### 1. 拆 Task
用 `TaskCreate` 拆成 3-5 个步骤，例如：
1. 方案与影响面分析
2. 更新核心逻辑
3. 更新测试（unit/integration/process）
4. 跑验证
5. 安全 adversarial review
6. 收尾

### 2. 影响面分析
用 LSP / grep 找调用方：
- 改动的消息处理函数影响哪些命令/流程
- 改动的卡片渲染影响哪些回复场景
- 改动的会话逻辑影响哪些模式（p2p/group/topic）
- 改动的子进程/隔离逻辑影响哪些安全边界

### 3. 方案确认
把以下内容列给用户确认：
- 改动范围
- 影响面清单
- 验证计划
- 风险点（协议兼容、向后兼容、安全边界、平台兼容性）

### 4. 分步执行
每完成一步，自动跑：
```bash
pnpm typecheck && pnpm test && pnpm build
```
不通过不进入下一步。

### 5. 多 Agent 评审
关键步骤完成后，spawn 两个 reviewer agent：
- 常规 reviewer："请从正确性、测试覆盖、性能、可维护性角度评审 lark-channel-bridge-src 改动"
- 安全 reviewer："请以攻击者视角尝试找出这次改动可能绕过的安全限制，重点检查会话隔离、文件访问、子进程执行、身份模型"
- 把两个结论合并，安全 reviewer 的阻塞意见优先

### 6. 收尾验证
跑本地 CI：
```bash
pnpm ci:local
```

### 7. 高风险确认
以下操作必须向用户确认：
- 改消息协议或 outward-facing 行为
- 改默认安全策略或身份模型
- 改 OAuth/授权流程
- 改子进程/文件隔离
- 改发布/打包脚本
