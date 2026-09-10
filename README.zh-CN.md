# Claude Code 的 ZCode 插件

[English](README.md) · [Русский](README.ru.md) · **简体中文**

![version](https://img.shields.io/badge/version-0.5.0-blue)
![license](https://img.shields.io/badge/license-MIT-green)
![node](https://img.shields.io/badge/node-%3E%3D18.18-brightgreen)
![dependencies](https://img.shields.io/badge/dependencies-0-lightgrey)

在 Claude Code 中把编码和代码审查交给 **[ZCode](https://zcode.z.ai/cn)**——
由 [Z.ai](https://z.ai) 推出、基于 GLM 模型（GLM-5.3、GLM-5.3-Flash、
GLM-5-Turbo）的智能编程环境。

Claude 仍是编排者：负责规划、分派任务并检查结果。ZCode 负责写代码，或对
diff 给出第二意见。思路与
[`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) 相同，
只是用 ZCode/GLM 取代了 Codex/GPT。

```text
/zcode:code 为注册表单添加输入校验，并编写测试
/zcode:review main
```

## 功能

- **`/zcode:code`**：ZCode 直接在工作区中实现任务，运行项目测试，并报告改动内容。
- **`/zcode:review`**：将 git diff（工作区、分支、提交或路径）发送给 ZCode，
  审查重点是正确性与安全性。
- **写入范围**：通过 `--allow` / `--deny` glob 限制 ZCode 文件工具可以改动的文件。
- **实时进度**：每次工具调用输出一行（`Read src/index.mjs`、`Bash npm test`），
  另有心跳检测，用来区分"模型在长时间思考"与"连接已断开"。
- **改动汇总**：`code` 执行结束后，基于 git 列出新建、修改和删除的文件，并把
  ZCode 自己的写入与其他改动区分开。
- **安全停止**：回合超时、`--idle-after-write` 和 `--max-tool-calls`，各自对应
  独立的退出码。
- **零依赖**：纯 Node.js，无需 `npm install`。插件不会读取、存储或打印你的 API 密钥。

## 环境要求

- 支持插件的 **[Claude Code](https://claude.com/claude-code)**。
- **ZCode.app**，可从 [zcode.z.ai](https://zcode.z.ai/cn) 下载。`zcode` CLI
  随应用一起提供，无需另行安装。也可以使用 `PATH` 上单独安装的 `zcode`。
- **Node.js 18.18+**。
- **Z.ai API 密钥**，通过环境变量 `ZAI_API_KEY` 提供。

在 macOS 上开发和测试。

## 安装

在 Claude Code 中把本仓库添加为插件市场，然后安装插件：

```text
/plugin marketplace add dan646/zcode-plugin-cc
/plugin install zcode@zcode-plugin-cc
/reload-plugins
```

如需从本地克隆安装，改为传入路径：
`/plugin marketplace add /path/to/zcode-plugin-cc`。

## 配置

1. 在启动 Claude Code **之前**导出密钥。ZCode 以子进程方式运行并继承环境变量，
   插件只负责原样传递。

   ```bash
   export ZAI_API_KEY="your-key"
   ```

2. 如果尚未授权，请执行一次 ZCode 登录：

   ```bash
   zcode login
   ```

   如果 `zcode` 不在 `PATH` 上，可以运行应用内置的 CLI：
   `node /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs login`。

3. 检查一切是否就绪：

   ```text
   /zcode:setup
   ```

   ```text
   ZCode CLI: /usr/local/bin/node /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs
   Provider configured: yes
   Current model: zai/glm-5.3-flash
   ```

`/zcode:setup` 只做诊断：它不会运行 `zcode login`，也不会接触凭据，只会告诉你
下一步该做什么。

## 使用方法

### 分派任务

```text
/zcode:code 在 src/utils 中添加 slugify() 辅助函数，并编写测试
```

ZCode 是一个独立进程，**看不到你在 Claude Code 中的对话**，只能看到任务文本
以及它自己在工作目录中读取的内容（它会自动读取 `AGENTS.md` / `CLAUDE.md`）。
请把任务写得足够完整、能够独立理解。

限制 ZCode 可写入的位置：

```text
/zcode:code --allow 'app/**' --allow 'tests/**' --deny 'app/secrets/**' 添加邮箱校验
```

### 审查改动

```text
/zcode:review               # 工作区 vs HEAD（已暂存 + 未暂存）
/zcode:review main          # 当前分支自从 main 分叉以来引入的改动
/zcode:review a1b2c3d       # 某个提交之后的改动
/zcode:review src/billing   # 某个路径下的工作区改动
```

分支或提交是用于比较的**基准**，与拉取请求的方式一致。`/zcode:review main`
审查的是你的分支，而不是 `main`。

新增的未跟踪文件会列给 ZCode，但不会出现在 `git diff` 中。如果希望以 diff
形式审查其内容，请先 `git add`。

### 查看状态

```text
/zcode:status
```

显示 CLI 路径、是否已配置提供商、当前模型以及目录中的模型列表。

## 命令

| 命令 | 作用 |
|---|---|
| `/zcode:setup` | 诊断就绪状态：定位 CLI，并检查是否已配置模型提供商。 |
| `/zcode:code <任务>` | 在工作目录中实现任务。 |
| `/zcode:review [基准\|路径]` | 审查 diff。默认比较工作区与 `HEAD`。 |
| `/zcode:status` | 显示 CLI 路径、提供商状态、当前模型和模型目录。 |

## 参数

| 参数 | 适用于 | 说明 |
|---|---|---|
| `--model <id>` | 全部 | 本次会话使用的模型，例如 `glm-5.3` 或 `zai/glm-5.3`。默认：`code` → `glm-5.3-flash`，`review` → `glm-5.3`。 |
| `--cwd <path>` | 全部 | 工作目录，默认为当前目录。 |
| `--json` | `setup`、`status` | 机器可读输出。 |
| `--timeout <秒>` | `code`、`review` | 回合超时。默认：`code` 2700 秒（45 分钟），`review` 1800 秒（30 分钟）。 |
| `--idle-after-write <秒>` | `code`、`review` | 首次写入后，若这么久没有新的写入则停止。默认关闭。 |
| `--max-tool-calls <n>` | `code`、`review` | 工具调用超过 `n` 次后停止。默认关闭。 |
| `--mode <build\|edit\|plan\|yolo>` | `code`、`review` | ZCode 本回合自身的工作模式。 |
| `--allow <glob>` | `code` | 可重复。仅允许文件工具作用于匹配的路径。 |
| `--deny <glob>` | `code` | 可重复。禁止匹配的路径，优先于 `--allow`。 |
| `--no-stream` | `code`、`review` | 隐藏模型的流式文本；保留工具调用、心跳和汇总。 |
| `--quiet` | `code`、`review` | 隐藏所有进度，只输出最终回答和用量信息。 |

进度输出到 **stderr**，ZCode 的最终回答输出到 **stdout**，因此可以放心地用管道处理。

### 为什么超时这么长

`code` 和 `review` 是多轮、会调用工具的回合，而不是一次请求。在一个真实项目
（docker 中的 Laravel 应用）上实测，一个工作单元耗时 20–30 分钟：前 10–15
分钟模型在思考、完全没有输出，之后内容会一次性涌出。默认值覆盖了这个区间的
上限，并为一轮修正留出余量。你自己设置的 `--timeout` 始终优先。

### 安全停止

- **`--idle-after-write <秒>`**：在首次被接受的 `Write`/`Edit` 之后，如果这么久
  都没有新的写入，就停止回合。请把它设置得**比项目中最慢的测试或 lint 还长**：
  协议中没有"命令已结束"事件，因此等待长时间 `Bash` 的模型和空闲的模型看起来
  完全一样。没有任何写入的回合不会被此参数停止。
- **`--max-tool-calls <n>`**：声明的工具调用超过 `n` 次后停止，被写入范围拒绝的
  调用也计入其中。

回合被停止时，stderr 会输出一行，包含原因、阈值、工具调用次数以及距上次写入的
时间；stdout 会输出模型未完成文本的末尾部分，并明确标注为未完成。

## 写入范围：`--allow` 与 `--deny`

模式相对于 `--cwd`，支持 `**`、`*` 和 `?`，例如 `app/**`、`*.md`、
`database/migrations/*.php`。

- 只要有一个 `--allow`，任何输入中带有 `file_path`、`notebook_path` 或 `path`
  的工具都只能作用于匹配的路径。
- `--deny` 优先于 `--allow`。
- 启用写入范围后，`--cwd` 之外的路径一律拒绝。
- 在 macOS 上匹配不区分大小写，因此 `Resources/JS/…` 无法绕过对
  `resources/js/**` 的禁止。
- 回合开始时会打印当前生效的范围，被拒绝的尝试会在汇总中列出。

> [!WARNING]
> 写入范围**不是 `Bash` 的沙箱**。Shell 命令仍然被允许，以便 ZCode 运行测试和
> lint，而 shell 命令可能在范围之外修改文件——从 shell 文本中无法可靠地解析出
> 写入目标。

写入范围只能与 `--mode build` 或 `--mode plan` 配合使用。不传 `--mode` 时，插件会
显式选择 `build`。`edit` 和 `yolo` 会在回合开始前被拒绝：在这两种模式下 ZCode
会自行批准写入，写入范围无法生效。

## `--mode` 不是写入权限开关

`--mode` 通过 `session/setMode` 设置 **ZCode 本回合自身的行为**：

| 模式 | 行为 |
|---|---|
| `build` | ZCode 的默认工作模式。 |
| `edit` | 只编辑已有文件。 |
| `plan` | 提出方案，不改动文件。 |
| `yolo` | 跳过 ZCode 内部的确认。 |

它并不决定插件是否授予写入权限。`review` 以及未设置写入范围的 `code` 总是授予
写入权限，因为 ZCode 需要用工具读取被审查的代码。`--mode plan` 只是让 ZCode
*选择*不做修改，并不能保证只读运行。

## 输出

回合进行中，进度会输出到 stderr：

```text
[zcode] prompt_started
[zcode] tool: Read src/index.mjs
[zcode] tool: Write tests/slug.test.mjs
[zcode] tool: Bash npm test
```

`--cwd` 内的路径显示为相对路径，主目录下 `--cwd` 之外的路径缩写为 `~/…`。工具参数
会被截断，形似密钥的 `"apiKey"` 字段会被清除。

**心跳。** 如果服务器 30 秒内没有发送任何事件，插件会调用 `session/usage` 探测
并输出一行状态；只要回合保持静默，探测就会持续进行：

```text
[zcode] 12m30s · жив · запросов 4 (+1) · токенов 210k (+48k) · последняя запись 2m10s назад
[zcode] 18m00s · жив · без прогресса 5m — модель думает · записей ещё не было
```

第二行**不是错误**：服务器仍在响应，只是模型已经思考了 5 分钟。插件绝不会因此
中止回合。如果连续 3 次探测都没有响应，说明连接确实已断开，回合会立即以
`stopped responding` 错误结束，而不是一直等到超时。

**改动汇总。** `code` 回合结束后：

```text
[zcode] изменённые файлы:
[zcode]   src/slug.mjs (создан)
[zcode]   tests/slug.test.mjs (создан)
```

> [!NOTE]
> 进度和汇总信息目前以俄语输出（例如 `жив` = 存活，`запросов` = 请求数，
> `токенов` = token 数，`изменённые файлы` = 已修改文件，`создан` = 已创建）。
> 最终回答使用 ZCode 回复时的语言。

## 退出码

| 退出码 | 含义 |
|---|---|
| `0` | 成功。 |
| `1` | 命令错误：找不到 CLI、未配置提供商、缺少任务、不是 git 仓库或没有可审查的改动。 |
| `2` | ZCode 回合失败（`turn.failed`）。 |
| `3` | 回合被停止（超时、`--idle-after-write`、`--max-tool-calls`），且**没有**写入文件。 |
| `4` | 回合在写入文件**之后**被停止。工作可能只完成了一部分，请检查 diff。 |

## 故障排查

**`Could not locate the ZCode CLI`**：CLI 的查找顺序为：`$ZCODE_CLI` →
`/Applications/ZCode.app` 内置的 CLI → `PATH` 上的 `zcode`。请安装 ZCode.app、
把 `zcode` 加入 `PATH`，或将 `ZCODE_CLI` 设为 `zcode` / `zcode.cjs` 的绝对路径。
该路径必须指向文件本身，而不是 `.app` 应用包。

**`Provider configured: no`**：在已导出 `ZAI_API_KEY` 的情况下执行一次
`zcode login`，然后重新运行 `/zcode:setup`。

**`session/setModel` 提示未知模型**：新执行的 `zcode login` 可能只注册了
`glm-5.1` / `glm-4.7`，而没有默认的 `glm-5.3` 系列。用 `/zcode:status` 查看模型
目录，然后显式传入可用的模型：`--model glm-5.1`。

**`ZCode app-server stopped responding`**：连续多次心跳探测未获响应，说明连接
确实已断开，而不只是模型在思考。请确认 ZCode 仍在运行，然后重试。

**`review`: "is not inside a git repository"**：在仓库内启动 Claude Code，或通过
`--cwd` 指定仓库。

**`review`: "No changes to review"**：工作区与 `HEAD` 一致，且没有未跟踪文件。
请检查 `--cwd`。

**`ZCode turn failed`**（退出码 2）：stderr 中会显示 `code` 和 `retryable`。
如果 `retryable: true`，重试即可。如果一直失败，请确认 `ZAI_API_KEY` 在启动
Claude Code 之前已设置，且密钥有效。

## 工作原理

```text
/zcode:<命令>   （Claude Code 中的斜杠命令）
      │
      ▼
scripts/zcode-companion.mjs        参数解析、输出、退出码
      │
      ▼
lib/session.mjs                    runTurn()：单个回合、心跳、停止规则
      │
      ▼
lib/protocol.mjs                   ZCode Protocol 客户端
      │   通过 stdio 传输的逐行 JSON
      ▼
zcode app-server                   运行 GLM 的 ZCode 智能体
```

插件启动 `zcode app-server`，并通过 ZCode Protocol 与其通信：基于 stdio 的逐行
JSON（不是 JSON-RPC 2.0）。它会创建会话、设置模型和模式、发送来自 `prompts/`
的自包含提示词，根据写入范围答复 `interaction/requestPermission` 请求，并把事件
转为进度输出。协议笔记见
[`docs/zcode-protocol-recon.md`](docs/zcode-protocol-recon.md)（俄语）。

## 开发

测试使用 Node 内置的测试运行器，无需安装任何包：

```bash
npm test
```

```text
.claude-plugin/marketplace.json   插件市场清单
plugins/zcode/
  .claude-plugin/plugin.json      插件清单
  commands/                       斜杠命令（setup、code、review、status）
  prompts/                        发送给 ZCode 的提示词模板
  scripts/zcode-companion.mjs     入口脚本
  scripts/lib/                    协议、会话、diff、写入范围、CLI 查找
tests/                            单元测试和模拟 app-server
probes/                           针对真实 ZCode 的手动脚本
docs/                             协议笔记
```

## 免责声明

这是一个非官方的社区项目，与 Z.ai 或 Anthropic 无关，也未获得其认可。ZCode、
GLM 和 Claude 是其各自所有者的商标。

## 作者

Daniyar Yergaliyev · Instagram [@ergalievdk](https://www.instagram.com/ergalievdk)

## 请我喝杯咖啡

如果这个插件帮你节省了时间，欢迎通过 Tron 网络（TRC-20）的 USDT 请我喝杯咖啡：

```text
TBzXtk9M6k6VM4j1WWnTaSgokRrGGr8cAp
```

<img src="docs/images/usdt-trc20-qr.png" alt="USDT TRC-20 二维码" width="220">

> [!IMPORTANT]
> 请仅向此地址发送 **TRC-20（Tron）网络上的 USDT**。通过其他网络或以其他代币
> 发送的资金可能会丢失。

## 许可证

[MIT](LICENSE)
