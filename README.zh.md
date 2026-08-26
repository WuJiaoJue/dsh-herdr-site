# dsh-herdr-site

[English](./README.md) | 简体中文

DeepSeek Harness → [Herdr](https://herdr.dev) 自定义 agent 集成。

只有当面板里的 agent 出现在 Herdr 内置检测列表（opencode、claude、codex……）中，
**或者**它通过文档化的第三方协议（`pane report-agent`）主动上报生命周期状态时，
Herdr 才会把该面板当作编码 agent 对待。dsh/cc-tui 不在 Herdr 的列表里，所以没有
这个插件的话，Herdr 只会把 dsh/cc-tui 面板显示成一个不透明的普通终端进程——没有
working/idle/blocked 状态，没有面板跳转，也不支持 `--wait`。

这个插件就是用来补上这一环的。在 Herdr 之外它是严格的 no-op。

## 上报什么

| dsh 信号                                       | Herdr 状态 |
|------------------------------------------------|------------|
| `agent/status = running`（正在驱动一个回合）   | `working`  |
| `agent/status = idle`（没有活跃 driver）       | `idle`     |
| `ask_user_question` 工具挂起（模型等待人类回答）| `blocked`  |

`blocked` 提升很关键：dsh 的 `agent/status` 只有 `idle`/`running` 两态，而
`ask_user_question` 停靠等待期间模型其实一直处于 `running`。不做提升的话，即使
agent 实际上正需要人来决策，Herdr 也只会显示 `working`。我们直接从持久化会话事件流
（`ask_user_question` 的 `tool/call` / `tool/result`）推导这个信号，因此天然支持
重放场景，也不依赖任何 UI provider 钩子。

使用的协议（见 [herdr 文档 —— Integrate your own agent](https://herdr.dev/docs/integrations/)）：

```
"$HERDR_BIN_PATH" pane report-agent "$HERDR_PANE_ID" \
  --source custom:dsh-herdr-site --agent cc-tui --state <working|idle|blocked> \
  [--message …] [--seq N]
……fiber 销毁时调用 `pane release-agent`。
```

## 工作原理

一个接入 profile 的 Cordis 插件（`dsh-herdr-site`）：

1. **no-op 守卫** —— 除非处于 Herdr 面板内（`HERDR_ENV=1` 且存在 pane id），否则立即返回。
   不会在 Herdr 之外 spawn 或读取任何东西。
2. **Agent 状态** —— 通过 `session/event` 订阅会话表面（`agent/status`），
   映射 `running → working`、`idle → idle`。
3. **blocked 提升** —— 跟踪进行中的 `ask_user_question` `tool/call` 条目；只要有挂起的
   调用，任何 `running` 都上报为 `blocked`。列表以 `callId` 为键，由对应的 `tool/result`
   清除，乱序或重放的事件也能保持一致。
4. **去重与排序** —— 每个 pane 维护单调递增的 `--seq`；重复状态被抑制，避免刷屏 Herdr。
5. **释放** —— fiber 销毁时调用 `pane release-agent`，Herdr 不会留下过期的 agent 条目。

## 安装

前提：已安装可用的 [dsh](https://github.com/deepseek-ai/deepseek-harness)，
且带有 `dsh-cc-tui`/`dsh-base` profile —— 本插件把 profile 自带的包
（`^4` 的 `@deepseek-ai/cordis`、`dsh-session`、`dsh-agent`）声明为 peer 依赖，
由宿主 profile 提供。

### 从 git 安装

```bash
dsh plugin --profile cc-tui add git+http://192.168.4.77:3000/dsh-plugins/dsh-herdr-site.git
```

因为包里声明了 `dsh.bundle.patch` 清单，安装器会自动把它加入 profile 的 bundle 层叠栈——
自带的 `cordis.patch.yml` 会把这个插件插入该 profile 启动的所有 surface。其他在用的
profile 同样操作一遍即可（例如 `dsh-tui`）。

确认已生效：

```bash
dsh --profile cc-tui --dump-config | grep -A2 herdr-site
```

### 从本地检出安装

任意本地路径都可以，比如克隆之后：

```bash
dsh plugin --profile cc-tui add /path/to/dsh-herdr-site
```

## 配置

可选的 `blockMessage` 覆盖，随 `blocked` 上报一并发送：

```yaml
# 写在 profile 的 cordis.patch.yml，或通过 --patch overlay
- id: herdr-site
  config:
    blockMessage: '模型等待你的回答'
```

## 构建

```bash
npm install            # 开发依赖：@types/node
npm run build          # 输出 lib/
```

git 安装的说明：`lib/` 已提交入库，所以从 git 安装无需本地构建——pnpm 默认拦截
`prepare` 构建脚本，若依赖构建步骤会导致安装开箱即坏。

## 测试

```bash
npm run build          # 冒烟测试针对 lib/ 运行
npm test               # 用桩 herdr CLI 做行为断言
npx tsc --noEmit       # 类型检查
```

`test/smoke.mjs` 在真实 cordis context 上驱动编译产物跑完整生命周期——
working/blocked/idle 转换、去重、seq 排序、无关 tool 结果、销毁时释放——
并对照桩 `herdr` 二进制逐条断言发出的每一条 CLI 调用。

## 本地开发备注

用普通 `file:` 依赖对着真实 profile 开发有两个坑（都是实际踩过的）：

1. `file:` 依赖在安装时刻复制内容——每次重新构建后要在 profile 里重跑
   `pnpm install`，否则 profile 一直跑的是旧副本。
2. 当依赖既作为 bundle 层安装、又手工写了 insert 行时，实测裸包名激活会被静默跳过；
   把 insert 行的 `name:` 指到绝对路径 `lib/index.js` 是可靠的开发期接线方式：

   ```yaml
   - insert:
       - id: herdr-site
         name: '/absolute/path/to/dsh-herdr-site/lib/index.js'
         config: {}
   ```

   走这条路的话，还要把包从 profile 的 `dsh.profile.bundles` 列表移除，
   避免两处 insert 冲突。

以上两条都不影响「安装」一节描述的标准 `dsh plugin add` 流程，后者能正确解析
自带 patch 里的裸包名。

## 已知限制

- Herdr 的*自动进程检测*依然不会把 dsh 进程识别为 agent（那需要更新 Herdr
  内置的检测器）。本插件做的是状态上报，这正是 Herdr 自定义集成路径所覆盖的；
  配合免检测器的自定义上报，Herdr 能正确显示 working/idle/blocked、面板跳转和 wait。
- 可选的 `--agent-session-id` 引用尚未接线，所以 Herdr 的 pane/agent API 暂时
  拿不到关联的 dsh 会话 id。自动会话恢复还额外要求 Herdr 知道如何启动 dsh——
  这不在本插件范围内。状态上报是无论如何都稳赚的部分。

## 许可证

[MIT](./LICENSE)
