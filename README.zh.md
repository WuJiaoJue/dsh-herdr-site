<div align="center">

<img src="docs/logo-lockup.png?v=3" width="360" alt="dsh-herdr-site — herdr ⇄ dsh-TUI"/>

# dsh-herdr-site

把 dsh/cc-tui 的 agent 状态上报给 [Herdr](https://herdr.dev)。

English | [简体中文](./README.zh.md)

`v0.1.0` · `MIT` · `DSH profile 插件`

</div>

---

## 这个插件做什么

Herdr 是面向 AI 编码 agent 的终端工作区管理器。它只认内置检测器识别出的
agent（opencode、claude、codex……），dsh/cc-tui 不在名单里，所以 dsh 面板在
Herdr 里只是一个普通终端进程——没有状态、没有面板跳转、不支持 `--wait`。

本插件通过 Herdr 官方的自定义集成协议（`pane report-agent` /
`pane release-agent`）上报 dsh agent 的状态：

- 回合进行中上报 `working`
- 没有活跃 driver 时上报 `idle`
- 模型停在 `ask_user_question` 上等人回答时上报 `blocked`

dsh 本身只有 running/idle 两态，所以 `blocked` 是装这个插件的主要理由：模型
等你回答的那一刻会在 Herdr 里显示出来，而不是看起来像在忙。该状态从会话事件
流（`ask_user_question` 的 `tool/call` / `tool/result`）推导，以 `callId`
关联，重放或乱序的事件流也能保持一致。

状态上报打通后，Herdr 的面板跳转和 `--wait` 对 dsh 面板同样生效。`blocked`
上报还可以附带可选的 `blockMessage`，说明等待原因。

## 实际效果

完整生命周期实录（[asciinema](https://asciinema.org) 录制）：回合进行中面板
显示 `working`，模型停在 `ask_user_question` 上时翻转为 `blocked`，回答后恢复。

![生命周期录屏](docs/herdr-lifecycle.gif)

## 状态映射

| dsh 信号                                        | Herdr 状态 |
|-------------------------------------------------|------------|
| `agent/status = running`（回合进行中）          | `working`  |
| `agent/status = idle`（没有活跃 driver）        | `idle`     |
| `ask_user_question` 挂起（模型等待输入）        | `blocked`  |

## 上报方式

状态通过 Herdr 的自定义集成协议上报：

```
"$HERDR_BIN_PATH" pane report-agent "$HERDR_PANE_ID" \
  --source custom:dsh-herdr-site --agent cc-tui --state <working|idle|blocked> \
  [--message …] [--seq N]
```

fiber 销毁时调用 `pane release-agent`，不会留下过期条目。上报携带单调递增的
序号，重复状态会去重。在 Herdr 面板之外插件是 no-op：不产生任何进程，也不读
取任何内容。

## 兼容性

- **Herdr**：遵循官方自定义集成协议（[Integrate your own agent](https://herdr.dev/docs/integrations/)），
  已在 [herdrdev/herdr](https://github.com/herdrdev/herdr) **v0.8.0** 实测。
  任何实现了 `pane report-agent` / `pane release-agent` 的版本都能用。
- **DSH**：`cc-tui` 与 `dsh-tui` 两个 profile 都能用——插件只挂接会话事件
  总线，不依赖具体 surface 实现。

已知边界：

1. `dsh-tui` profile 没有装配 `ask_user_question` 工具，所以该 profile 下
   不会出现 `blocked`（`working`/`idle` 上报不受影响）。
2. 上报给 Herdr 的 agent 标签固定为 `cc-tui`。

## 安装

前提：已安装可用的 [dsh](https://github.com/deepseek-ai/deepseek-harness)，
且带有 `dsh-cc-tui`/`dsh-base` profile。插件把 profile 自带的包（`^4` 的
`@deepseek-ai/cordis`、`dsh-session`、`dsh-agent`）声明为 peer 依赖，由宿主
profile 提供。

```bash
dsh plugin --profile cc-tui add git+http://192.168.4.77:3000/dsh-plugins/dsh-herdr-site.git
```

包里声明了 `dsh.bundle.patch` 清单，安装器会自动把它加入 profile 的 bundle
层叠栈，`cordis.patch.yml` 会把插件插入该 profile 启动的所有 surface。其他在
用的 profile 同样操作一遍即可（例如 `dsh-tui`）。

确认已生效：

```bash
dsh --profile cc-tui --dump-config | grep -A2 herdr-site
```

也可以从本地检出安装：`dsh plugin --profile cc-tui add /path/to/dsh-herdr-site`

## 配置

可选的 `blockMessage`，随 `blocked` 上报一并发送：

```yaml
# 写在 profile 的 cordis.patch.yml，或通过 --patch overlay
- id: herdr-site
  config:
    blockMessage: '模型等待你的回答'
```

## 构建与测试

```bash
npm install            # 开发依赖：@types/node
npm run build          # 输出 lib/
npm test               # 用桩 herdr CLI 做行为断言
npx tsc --noEmit       # 类型检查
```

git 安装无需构建：`lib/` 已提交入库。pnpm 默认拦截 `prepare` 构建脚本，
如果依赖安装期构建，开箱就会装坏。

`test/smoke.mjs` 在真实 cordis context 上跑编译产物的完整生命周期——
working/blocked/idle 转换、去重、seq 排序、无关 tool 结果、销毁时释放——
并对照桩 `herdr` 二进制逐条断言发出的每一条 CLI 调用。

## 本地开发备注

用普通 `file:` 依赖对着真实 profile 开发有两个坑（都是实际踩过的）：

1. `file:` 依赖在安装时复制内容——每次重新构建后要在 profile 里重跑
   `pnpm install`，否则 profile 一直跑的是旧副本。
2. 当依赖既作为 bundle 层安装、又手工写了 insert 行时，裸包名激活会被静默
   跳过；把 insert 行的 `name:` 指到绝对路径 `lib/index.js` 是可靠的开发期
   接线方式：

   ```yaml
   - insert:
       - id: herdr-site
         name: '/absolute/path/to/dsh-herdr-site/lib/index.js'
         config: {}
   ```

   走这条路的话，还要把包从 profile 的 `dsh.profile.bundles` 列表移除，
   避免两处 insert 冲突。

以上两条都不影响标准 `dsh plugin add` 流程，后者能正确解析自带 patch 里的
裸包名。

## 已知限制

- Herdr 的自动进程检测依然不会把 dsh 进程识别为 agent（那需要更新 Herdr
  内置的检测器）。本插件做的是通过自定义集成路径上报状态，没有检测器也能让
  Herdr 正确显示 working/idle/blocked、面板跳转和 wait。
- 可选的 `--agent-session-id` 引用尚未接线，所以 Herdr 的 pane/agent API
  暂时拿不到关联的 dsh 会话 id。自动会话恢复还要求 Herdr 知道如何启动 dsh，
  这不在本插件范围内。状态上报不受影响。

## 许可证

[MIT](./LICENSE)
