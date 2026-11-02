# Steer → Background Tool

[![CI](https://github.com/Enter-tainer/dsh-steer-background-tool/actions/workflows/ci.yml/badge.svg)](https://github.com/Enter-tainer/dsh-steer-background-tool/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.17-339933?logo=node.js&logoColor=white)](package.json)

一个 DSH（DeepSeek Harness）Host 插件：**当你在 Agent 正在跑工具调用时插话（steer），把这个仍在运行的工具调用立刻转入后台任务**，让你的消息不再排在长任务后面干等。

---

## 安装

本插件以 DSH **bundle** 形式发布：`package.json` 里声明 `dsh.bundle.patch`，由 `cordis.patch.yml` 往插件树里插入一行。

```bash
git clone https://github.com/Enter-tainer/dsh-steer-background-tool.git
```

然后在 Harness 的 **Plugin Manager** 里以本地路径安装这个目录（或先 `pnpm pack` 再安装生成的 `.tgz`）。安装后该行即为 `active`，无需重启即可生效。

改配置见 [§3 配置](#3-配置)；卸载见 [§8 卸载](#8-卸载)。

---

## 1. 为什么会有这个过程

### 卡住的根因

Agent 的一轮（turn）由若干 **step** 组成：一个 step = 一次模型请求 + 它要的那些工具调用。

而用户插话（steer）只会在**下一个 step 的 `preStep`** 被取走。所以当某个 step 正在 `await` 一个跑 10 分钟的工具时，**下一步根本不会开始 —— 消息就卡在工具后面**。

> 插话延迟 = 工具延迟。这是结构性的，不是 bug。

### 两条"看起来能用、实际不能用"的路

| 方案                        | 为什么不行                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **取消工具**                | 副作用丢一半，已经跑的工作白费                                                                                  |
| **不管工具、直接结束 step** | 协议不允许。transcript 是严格的 `tool_use` / `tool_result` 配对，调度器给每个已启动的调用**一定会提交一个结果** |

### 所以为什么是"转后台 + 合成结果"

把**已经在跑**的调用挂到 `ctx.jobs` 上，然后**立刻**给这个 tool call 一个合成结果：

```
模型请求 ──> step 开始 ──┬── 工具调用 #1 开始跑（很长）
                         │
                     你插话 ──> 工具 #1 立刻转后台 job
                         │        step 不再等它 ──> 合成结果 "已转后台，job id = X"
                         ▼
                     下一个 step 立刻开始，你的消息马上被取走
                         │
                     工具 #1 仍在后台继续跑（没被取消、没被重跑）
                         ▼
                     跑完后 job 以真实输出 settle ──> 模型收到完成通知
```

**工作本身没被取消也没被重跑**：同一个 promise 继续跑，副作用保住、不会做两遍。

### 为什么必须让模型"知道"

模型必须收到一个合成结果（协议要求），而且必须被告知三件事，否则它会做错事：

1. **没失败、没取消** —— 否则它会降级处理或重试
2. **别用同样参数再调一次** —— 否则副作用做两遍
3. **后面用 `job_output <id>` 取结果** —— 否则它以为输出永久丢失

因此插件同时做三件事：合成结果里写明这三点、注册一段 system-prompt 指引、并在 job settle 时依赖 `@deepseek-ai/dsh-tool-jobs` 的完成通知。

---

## 2. 实现要点

### 2.1 `tools/execute` 提前返回

在 tool dispatch 外面套一层，正常情况纯透传；一旦插话到达，就 `Promise.race([真实调用, 转后台信号])`，让 step 立刻拿到合成结果。

### 2.2 合成结果必须是 **schema 合法的 success**

这一点很关键：调度器的 `normalizeDispatchResult` 会把**成功结果**用 `tool.output.schema` 重新校验、并用 `tool.output.render` **重新渲染**，你给的 `content` 会被丢弃。若 `value` 不合法，整个结果会退化成 schema 错误。

所以插件会从工具自己的 output schema 反推一个最小合法值（支持 `const` / `enum` / `oneOf` / `object` / `array` / 基本类型），并在返回前**预跑**一遍 `render` 和 `presentationMeta`：

- 成功 → 得到一张**正常的成功卡片**，正文在 `tools/post-execute` 里换成"已转后台"的说明
- 失败（schema 太复杂/预跑不过）→ 退回 `isError: true`，失败态的 `content` 是原样透传的，信息不会丢（代价是红色卡片）

### 2.3 真实输出怎么拿回来（踩过的坑）

**踩坑**：一旦提前返回，调度器会把这次调用记账并 `Object.freeze(exec)`；而被抛弃的 `dispatchToolBody` 在 `finally` 里还要写 `exec.signal` → 抛 `TypeError`。**所以那条 promise 即使工具成功也会 reject，真实值拿不到。**

解法：在工具定义上套一个**纯透传的 wrapper**（`definition.execute` 的引用本身未被冻结），把工具自己的 promise 记下来。它不受 `exec` 冻结影响，真实值从这里取，再用 `tool.output.render` 渲染成 job 输出。插件卸载/停用时会把 `execute` 还原。

### 2.4 插话识别

`agent/inbox/inserted` 是唯一能"知道用户插话了"的时机。steer 与 follow-up 在 message 结构上**完全一样**，只能靠落在哪个队列区分：

- 在 `inbox.nextStep` → steer（本插件默认处理）
- 在 `inbox.nextTurn` → follow-up（`alsoFollowup: true` 时也处理）

同时排除插件自己的通知（`source.kind !== 'user'`、或带 `form` 的 notice），避免被自己的消息触发。

### 2.5 可被杀死

`job_kill` 的取消会通过 `AbortController` → `AbortSignal.any([调用方信号, 本插件信号])` 传到工具自己的 `exec.signal`，**后台任务不是"跑野了的孤儿"，仍然可以中止**。调用方原有的取消语义也完整保留。

---

## 3. 配置

在 `cordis.patch.yml` 里按 id 覆盖即可（`config` 是整体替换）：

```yaml
- id: steer-background-tool
  name: '@local/steer-background-tool'
  config:
    excludeTools: ['bash'] # 这些工具不转后台
    minInFlightMs: 2000 # 只转"已经跑了 2s 以上"的调用
```

| 配置项             | 默认    | 说明                                                   |
| ------------------ | ------- | ------------------------------------------------------ |
| `enabled`          | `true`  | 总开关                                                 |
| `minInFlightMs`    | `0`     | 小于该运行时长的调用不转后台（快速调用本来就不值得转） |
| `maxJobsPerSteer`  | `4`     | 一次插话最多转几个调用                                 |
| `outputLimitBytes` | `65536` | 单个 job 面向模型的输出上限                            |
| `excludeTools`     | `[]`    | 永不转后台的工具名                                     |
| `guidance`         | `true`  | 是否注册 system-prompt 指引段                          |
| `alsoFollowup`     | `false` | 是否对排队到"下一轮"的 follow-up 也生效                |

---

## 4. 验证情况

### 真实 harness 端到端（在本机 Harness 上实测）

用真实的 `agent.steer()`（GUI 插话走的就是这条路径）驱动，覆盖：

| 场景                               | 结果                                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| 普通工具调用（无插话）             | 原样透传，无 job、结果不变                                                                      |
| 25s 命令 + 2s 时插话               | 立刻返回"已转后台"通知；命令在后台跑完，`job_output` 拿到完整真实输出（结束时间戳证明跑满 25s） |
| 一个 step 内两个并行调用同时被插话 | 两个都转后台，两个 job                                                                          |
| 工具非零退出（`exit 3`）           | job `completed`，输出含 `[exit code: 3]`（工具调用本身是成功的）                                |
| 工具真的抛异常                     | job `failed`，带真实错误信息                                                                    |
| `job_kill`                         | job `killed`；**宿主日志证明 abort 真的传到工具**（60s 任务在 3.3s 被中断）                     |
| 没有在跑的工具时插话               | 不产生任何 job，消息正常送达                                                                    |
| 子 Agent 的工具调用                | 独立转后台（`owner` = 子 Agent），子 Agent 收到插话，互不干扰                                   |
| 结果落库形态                       | 会话日志为 `isError: false` + `error: null` → **成功卡片**，不是失败卡片                        |
| system-prompt 指引                 | 会话日志中出现该段文本 → 确实进入了模型 prompt                                                  |
| `excludeTools: ['bash']`           | 仅 bash 不转后台（前台跑满拿到真实输出），其它工具仍正常转后台                                  |

### 单元测试（随包提供）

```bash
pnpm test        # = node --test，20 个场景
```

20 个场景全部通过，覆盖真实环境不易构造的分支：`excludeTools` / `minInFlightMs` / `maxJobsPerSteer` / follow-up 与 notice 的区分 / 嵌套子调用跳过 / `jobs.start` 失败时回退前台 / 各类 schema 的占位值合成与回退 / kill 与调用方取消 / `exec.signal` 还原 / 卸载还原。

### 校验脚本的负向测试

`scripts/validate.mjs` 与 `scripts/check-pack.mjs` 都验证过"坏输入必须失败"：故意把 `exports["./icon"]` 指向不存在的文件、往 `files` 塞不存在的路径、从产物里删掉 `icon.svg` 并塞进 `test/` 目录时，两者都非零退出并给出精确定位 —— 只会在成功时通过的校验器没有价值。

---

## 5. 开发与 CI

工具链是 **Rust 写的**（[oxc](https://oxc.rs)）：`oxlint` 负责 lint、`oxfmt` 负责格式化，都是 Rust 实现、毫秒级完成；两者与 DSH 上游自身使用的 lint 器一致。测试用 Node 内置的 `node:test`，**运行时零依赖**（`index.js` 没有任何 import）。

```bash
pnpm install

pnpm run validate    # bundle 契约校验：package.json / locale / icon / patch / 入口导出
pnpm run lint        # oxlint --deny-warnings
pnpm run format      # oxfmt（原地写入）；format:check 只检查
pnpm run test        # node --test
pnpm run check       # validate + lint + format:check + test

pnpm pack
node scripts/check-pack.mjs /tmp/packed/package   # 校验打包产物本身
```

CI（[`.github/workflows/ci.yml`](.github/workflows/ci.yml)）分三个 job：

| job                            | 内容                                                                        |
| ------------------------------ | --------------------------------------------------------------------------- |
| `check`（Node 22 / 24）        | `validate + lint + format:check + test`，用 pnpm 装真依赖                   |
| `runtime`（Node 20 / 22 / 24） | **不装任何依赖**，只跑 `validate + test`，证明没有任何构建步骤              |
| `package`                      | `pnpm pack` 后检查 tarball 内容，并解包用 `scripts/check-pack.mjs` 再验一遍 |

`runtime` 单独拆出来的原因：pnpm 11 自身要求 Node ≥ 22.13，而插件的运行时下限是 Node 20；把"运行时兼容"和"工具链兼容"分开测，两者都不会被对方的下限绑架。`package` job 负责抓 `files` 漏配这类"仓库里有、装出来没有"的问题。

两个校验脚本都做过**负向测试**：故意改坏路径时它们必须非零退出（见 §4）。

---

## 6. 已知限制

- **合成卡片是通用卡片**：bash 这类工具有专用卡片，转后台后走通用成功卡片（正文是本插件写的说明），观感与正常 bash 卡片不同。
- **后台期间 `job_list` 会短暂看到两条**：bash 工具自己也会开一个 `kind: 'bash'` 的 job 用于输出泵；它 settle 后就消失。这不是重复上报。
- **改完 `index.js` 需要重新加载插件**：进程会保留旧的模块代次，HMR 对本插件不生效。用 Plugin Manager 关/开该行（或重启）即可；源码已在仓库里，重装打包无必要。
- **本插件的 `tools/execute` 属于"提前返回"用法**：上游文档描述的 wrapper 契约是"必须等到 quiescence"。这里刻意提前返回以解锁插话，并用 §2.3 的 wrapper 保住真实结果、§2.5 保住可取消性。升级 Harness 后建议重跑 `test/unit.mjs` 与一次真机插话验证。

---

---

## 7. 相关实现（有没有人做过类似的）

**有，而且不少 —— 但触发点不同。** "长工具不该阻塞对话"是共识；差异在**什么时候**把调用让到后台。

| 实现                                                                                                           | 触发                                              | 机制                                                                                                                               | 与本案的差异                                                                                                       |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Claude Code `Ctrl+B`                                                                                           | 手动按键                                          | 把 Bash 命令 / 子 Agent 转后台                                                                                                     | 手动，不是"插话即触发"；`Esc` 走的是**中断**当前工具调用（保留已完成的工作），不是保活转后台                       |
| Claude Code `CLAUDE_AUTO_BACKGROUND_TASKS`                                                                     | 时间（约 2 分钟）                                 | 子 Agent 到点自动转后台                                                                                                            | 只针对 subagent，不针对任意工具调用                                                                                |
| QwenPaw / AgentScope 双 deadline                                                                               | 时间（`offload_deadline` ≈ 超时 × 0.5）+ 手动 API | `ToolCoordinator` 把调用 offload，前台立刻拿到一个引导模型继续的 tool result，工具在后台继续跑；`kill_deadline` 管执行上限         | 时间/手动触发，默认 `keep_foreground`，没有把"用户插话"当作信号                                                    |
| [`@argszero/cordis-plugin-steer-preempt`](https://www.npmjs.com/package/@argszero/cordis-plugin-steer-preempt) | **用户插话（同一生态）**                          | 只针对 `job_output(wait: true)`：换掉派生的 `AbortSignal` 让阻塞的等待提前返回，再把错误结果替换成 `STEER_PREEMPTED`；**不杀 job** | 解决的是"已经被后台任务阻塞住的等待"，不会把工具调用本身转后台。**与本插件互补**：它管阻塞读取，本插件管前台长调用 |
| [OpenAI Codex CLI #14602](https://github.com/openai/codex/pull/14602)                                          | 中断时                                            | 把正在跑的 unified-exec 进程保成 background terminal，避免中断丢进程                                                               | 偏终端进程生命周期管理                                                                                             |
| persistent-terminal 类 MCP server                                                                              | 外部服务                                          | 命令跑在外部持久终端，Agent 轮询输出                                                                                               | 需要额外常驻进程，不是 harness 内建的 job 机制                                                                     |

上游也记录过这个痛点：同生态的 `steer-preempt` 引用了 DSH 的 discussion #6030（插话要等到 step 边界）和 #6285（阻塞读取拿不到新输出）。

所以更准确的说法是：**"插话把正在跑的工具调用转成后台任务"这个具体触发点，在 DSH 生态里此前没有**；最接近的同生态实现处理的是另一半问题。

## 8. 卸载

Plugin Manager 里移除 `@local/steer-background-tool` 即可（或 `remove_bundle`）。插件卸载会还原它套在工具定义上的 wrapper。
