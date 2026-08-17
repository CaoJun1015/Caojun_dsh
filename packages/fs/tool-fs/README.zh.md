# @deepseek-ai/dsh-tool-fs

[English](README.md) | 中文

**面向模型的文件系统工具**（`read`、`read_image`、`write`、`edit`）及其**执行器**。这是文件系统栈的消费方层：拥有工具名称、JSON Schema、参数校验、提示词段、**读取窗口逻辑**和结果格式化。它**直接**通过 `ctx.fs` 提供方约定（[`@deepseek-ai/dsh-fs`](../fs)）读取／写入／编辑。新鲜度／观察策略由独立插件（[`@deepseek-ai/dsh-fs-observation-policy`](../fs-observation-policy)）通过 `fs/*` 事件门禁贡献；工具不与其方法耦合。使用施加沙箱限制的提供方时，逐会话执行需要共享沙箱策略服务，工具还会为文件系统变更提供升权路径。

```ts ignore-check
// Default deployment: a ctx.fs provider, the policy plugin, then the tools.
await ctx.plugin(LocalFileSystem, { cwd: process.cwd() }) // @deepseek-ai/dsh-fs-local
await ctx.plugin(FsPolicy)                             // @deepseek-ai/dsh-fs-observation-policy (policy gate)
await ctx.plugin(LocalAttachmentStore, { dshHome })       // optional — enables durable read_image results
await ctx.plugin(ToolFs)                                  // this package — read/write/edit, plus read_image with attachments
```

`@deepseek-ai/dsh-fs-observation-policy` 是**可选的**：省略时，工具直接使用裸提供方（无条件写入/覆盖/编辑，无已观察状态）。加载这些工具的部署也应加载该插件，从而提供写入/编辑前读取行为。

`read_image` 只在持久 `ctx.attachments` 服务已挂载时注册：没有它，部署无法持久提交图像字节，工具就不会出现。执行时还要求确切路由的模型声明 `image` 输入（通过 `ctx.llm.resolveModelInfo` 从会话最新请求 header 解析，缺失时回退到 agent 选项）；未知或纯文本路由在任何文件系统 I/O 之前就得到拒绝结果，因此文本路由的持久历史不会出现图像块。

## 配置

所有键均为可选；默认值是随产品交付的读取上限。

| 键 | 默认值 | 含义 |
|---|---|---|
| `readLimit` | `2000` | 一次 `read` 调用返回的默认和最大行数（工具 schema 将其声明为 `limit` 默认值）。 |
| `readMaxLineLength` | `2000` | 每行截断前保留的字符数（后缀会说明上限）。 |
| `readMaxBytes` | `51200` | 一次 `read` 调用所选行的字节上限；溢出时以「已达上限」footer 结束窗口。 |
| `readStreamMinSize` | `10485760` | 大于等于该大小或大小未知的文件采用流式读取，而不是整体加载到内存。 |
| `editMatchMode` | `progressive` | 安全累计匹配；设为 `exact` 时只使用 LF 规范化精确匹配。 |
| `editCandidateLimit` | `3` | 编辑未命中时返回的近似候选上限。 |
| `editCandidateMaxDistance` | `3` | 候选按 Unicode code point 计算的最大编辑距离。 |
| `editCandidatePreviewChars` | `160` | 每个候选预览最多显示的 Unicode code point 数。 |
| `backupBeforeMutation` | `true` | 修改现有文件前要求提供方创建备份。 |

## 工具（schema 见[文件系统工具 schema Agent Note](../../../.agents/notes/implemented/feature/2026-06-17-filesystem-tool-schemas.md)）

| 工具 | 参数 | 行为 |
|---|---|---|
| `read` | `file_path`、`offset?`、`limit?` | 带行号的 UTF-8 内容和分页 footer。`offset` 从 1 开始；`limit` 默认为配置的 `readLimit`（2000），上限也为该值。 |
| `read_image` | `file_path` | 通过有界字节 seam 读取 PNG/JPEG/WebP/GIF 文件，经 `ctx.attachments.saveImage` 持久保存，并在小型元数据信封旁返回图像块。只有确切路由的模型声明图像输入时才会成功。 |
| `write` | `file_path`、`content`、`content_format?` | 创建或完整替换文件。format 默认为 `text`；`escaped` 严格额外解码一层转义。现有文件默认先备份。 |
| `edit` | `file_path`、非空 `old_string`、`new_string`、`old_string_format?`、`new_string_format?`、`replace_all?` | 默认执行唯一安全渐进匹配。format 默认为 `text`，`escaped` 必须显式选择。发布前备份现有文件。 |

字段名使用 snake_case，与 Claude Code 和现有 harness 工具 schema 一致。

规范成功值分别为：`read` → `{ path, offset, lines, totalLines }`，`read_image` → `{ path, image }`，`write` → `{ path, operation, before, after, backup }`，`edit` → `{ path, before, after, match_strategy, backup }`。创建或禁用备份时 `backup` 为 `null`；可恢复时为 `{ path, bytes }`，提供方版本 token 保持内部状态。原生渲染器保留下方读取和变更确认；只有派生出的展示元数据会持久化到 `tool/result`。

## 工具就是执行器；策略是事件门禁

工具**不**注入策略服务，也不检查任何缓存。每个工具通过 `ctx.fs.resolve(path, { cwd, signal })` 解析路径；它会传入调用 agent（智能体）的会话 cwd（`exec.agent.session.header.cwd`），使相对路径以会话工作区为基准解析并与 `dsh-tool-bash` 一致，同时把工具取消转发到解析过程（见[每会话 cwd Agent Note](../../../.agents/notes/implemented/architecture/2026-07-02-fs-per-session-cwd.md)）。随后执行：

- **read**：一次 `ctx.fs.stat`（用于类型、大小路由和版本），随后调用 `readText`/`streamText`，构建行窗口，再发出 `fs/observed`，使用普通 `ctx.emit`。（1 次 stat。）
- **read_image**：在任何 I/O 之前校验参数、扩展名、附件可用性、部署接受的媒体类型和图像路由；随后一次 `ctx.fs.stat`（目标缺失时与 `read` 一样记录 `absent` 观察）、以 `imageLimits.maxImageBytes` 与 `imageLimits.maxMessageImageBytes` 中较小者为上限的有界 `ctx.fs.readBytes`（结果是携带一张图像的一条消息）、`attachments.saveImage`（内容寻址，因此在 `tool/result` 事件追加时图像块引用的对象已持久提交），最后发出 `fs/observed`。（1 次 stat。）
- **write**：严格解析所选文本 format，取得可选 intent，再调用 `ctx.fs.writeText(target, content, { intent?, backup, signal, sandboxPolicy? })` 并发出 `fs/observed`。非法转义在路径解析或备份前失败。（0 次 stat。）
- **edit**：严格解析两个文本 format，取得可选版本，再调用 `ctx.fs.editText(target, edit, { version?, backup, signal, sandboxPolicy? })` 并发出 `fs/observed`。匹配与诊断由提供方共享实现负责。（0 次 stat。）

工具在每次分派中把 `exec`（工具执行上下文）作为不透明 `actor` 传入。默认 thunk 返回 `undefined`（不受约束的裸提供方）。加载 `@deepseek-ai/dsh-fs-observation-policy` 后，它会占用单个决策槽：返回 `createIfAbsent`/`replaceIfVersion`/`{ version }` 或抛出 `FS_NOT_OBSERVED`，并在 `fs/observed` 时记录。后端错误（`FsError`）和抛出的 `FS_NOT_OBSERVED` 会流经 `ToolRuntime.execute()`，变成 `isError` 工具结果，并附带 `{ name, code }`。

当 `ctx.fs.sandboxMode` 表明提供方施加沙箱限制时，write/edit 会公开 `sandbox_permissions` 与 `justification`，并通过 `ctx.approval` 处理获批后的重试。策略归属方会贡献与具体能力无关的常驻策略；工具结果仍保留针对具体操作的拒绝与重试引导。

## `fs/observed` 发后即忘

`fs/observed` 在 read/read_image/write/edit 已经成功之后，通过普通 `ctx.emit` 发出。监听器的约定是同步且只有副作用的记录器（`@deepseek-ai/dsh-fs-observation-policy` 使用 `WeakMap.set`）；工具不保护这次发出，因此监听器抛出会作为工具的 `isError` 结果出现。异步或可能失败的观察不属于该事件。

`read` 允许并发调度，因为它唯一会改变状态的操作是同步记录版本。稍后的 `write` 或 `edit` 会在目标锁内重新检查版本，因此即使记录器发生竞态，系统也会安全地拒绝操作；两个变更工具仍保持互斥。见[并行工具调用 Agent Note](../../../.agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.md)。

包根目录只导出 Cordis 插件约定（`name`、`inject`、`Config` 和 `apply`）。读取渲染（行窗口与输出格式化）位于 `src/read-render.ts`（不依赖 Cordis，单独进行单元测试）；`src/read.ts`/`read-image.ts`/`write.ts`/`edit.ts` 是工具执行器，`src/index.ts` 负责组合。

## 模型体验

### 系统提示词

#### 模型看到的内容

该插件注册作用域内的每个请求都会收到下方独立注册的 read、write 与 edit 指导。作用域工具限制可以隐藏 schema，而不移除这些段。

##### Read 指导

```markdown
Use the read tool — not shell commands like cat — to inspect text files. Results include line numbers. Use offset and limit to continue reading large files.
```

##### Write 指导

```markdown
Use the write tool to create files or completely replace file contents. Existing files are overwritten, so read an existing file first (the default fs-observation-policy requires it) and prefer edit for targeted changes. content_format defaults to text, which uses the JSON-decoded string unchanged: JSON "\n" is a newline, while "\\n" is a literal backslash plus n. Select escaped only to decode one additional layer of \\, \n, \r, or \t.
```

##### Edit 指导

```markdown
Use the edit tool for targeted changes to existing UTF-8 text files. It replaces literal old_string with new_string; by default old_string must identify exactly one match. Progressive matching may ignore outer search whitespace, per-line trailing whitespace, or full-width ASCII differences, but it never uses approximate candidates for replacement. String formats default to text, which uses JSON-decoded strings unchanged: JSON "\n" is a newline, while "\\n" is a literal backslash plus n. Select escaped only to decode one additional layer. If several matches remain, provide more context or set replace_all to true. Read the file first (the default fs-observation-policy requires it), unless you just created or edited it in this session.
```

#### Token 影响

插件启用期间，每个请求支付固定指导成本；即使限制隐藏了一个或多个工具也一样。

#### KV Cache 影响

只要插件作用域和指导文本不变，前缀就保持稳定。工具限制不会移除该段，但插件启用或 dispose（资源释放）可能从该段开始使复用失效。

### 工具 schema

#### 模型看到的内容

模型会看到已生成的 [`read`、`read_image`、`write` 和 `edit` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-fs)，参数使用 snake_case。`read_image` 只在持久附件存储已挂载时出现；schema 本身与路由无关，严格门禁在执行时拒绝。作用域工具限制可以为某个 agent 移除任一定义。

#### Token 影响

该工具视图中的每个请求都支付固定 schema 成本。

#### KV Cache 影响

只要可见工具定义和顺序不变，前缀就保持稳定。注册生命周期或作用域限制可能从首个变化的 schema token 开始使复用失效。

### 读取结果

#### 模型看到的内容

成功读取结果精确为 `<path><displayPath></path>`、换行、`<type>file</type>`、换行、`<content>`、形如 `<lineNumber>: <text>` 的编号行、一个空行、一条 footer 和 `</content>`。footer 精确为 `(Output capped. Showing lines <start>-<end>. Use offset=<next> to continue.)`、`(Showing lines <start>-<end> of <total>. Use offset=<next> to continue.)` 或 `(End of file - total <total> lines)`。长行结尾精确为 `... (line truncated to <max> chars)`。读取缺失目标仍返回 `FS_NOT_FOUND`，但会为调用会话记录确认缺失；外部删除的文件被重新读取后，重试的 `write` 可以通过提供方的不替换防护安全地重新创建该文件。

#### Token 影响

读取输出受 `readLimit`、`readMaxLineLength` 和 `readMaxBytes` 限制；保留的调用与结果会反复发送，直到上下文压缩（compaction）。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 图像读取结果

#### 模型看到的内容

成功的 `read_image` 返回 `<path><displayPath></path>`、`<type>image</type>` 和写明媒体类型、尺寸与字节数的 `<content>` 信封，随后是作为原生图像块的图像本身。会话日志只存储持久的 `sha256:` 附件引用；路由到的提供方在每次请求时重新读取并校验字节摘要。

#### Token 影响

图像在之后每次请求中都会计费，直到压缩。每次调用都独立受附件存储的 `maxImageBytes`/`maxImagePixels` 约束；重复成功调用会在历史中累积，内容寻址只去重存储的字节，不去重每次请求的 token 成本。

#### KV Cache 影响

仅追加；新可见内容跟在可复用请求前缀之后，不会使既有 KV 缓存条目失效。

### 写入与编辑结果

#### 模型看到的内容

写入返回正常包络；覆写产生备份时在其后追加 `<backup path="<path>" bytes="<n>" />`。编辑在适用时追加 `Backup: <path> (<n> bytes).`，非精确策略成功时还会警告所用策略。完整写入或替换文本仍保留在 assistant 工具调用参数中。

#### Token 影响

成功文本很少，但大型变更参数和所有结果会反复发送，直到上下文压缩。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 工具错误

#### 模型看到的内容

失败会规范化为 `Error: <message>`。非法 `escaped` 输入会指明参数，并在任何文件系统副作用前拒绝未知序列或末尾孤立反斜杠。`FS_EDIT_NOT_FOUND` 与 `FS_AMBIGUOUS_EDIT` 保留结构化错误码，并包含路径、已尝试策略，以及不超过配置数量的行号、距离和有界预览候选；没有合格候选时会明确说明。带防护变更失败保留恢复指令和结构化错误码。

#### Token 影响

只有失败调用会添加这些保留 token。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与暂缓事项

- **未交付面向模型的目录列表工具**：`ctx.fs.listDir` 服务于 skill（技能）发现等提供方代码，同级 [`dsh-tool-fs-search`](../tool-fs-search/) 包则提供基于 ripgrep 的 `glob` 与 `grep`，而不是扩展文件系统 seam。
- **`read` 只处理 UTF-8 文本文件**：图像使用独立的、按扩展名路由的 `read_image` 工具；PDF、音频和视频仍延期处理。目录目标为 `FS_NOT_REGULAR_FILE`。
- **路由门禁与并发模型切换存在竞态**：`read_image` 在执行时检查最新路由的模型；在该检查与下一次请求之间提交的切换，可能让图像块落在拒绝图像内容的路由上。Web 宿主已拒绝把含图像的会话切到纯文本模型；其他前端拥有各自的等价防护。
- **媒体类型按扩展名声明**：扩展名选择声明类型，附件存储的魔数校验保持权威；扩展名错误但格式正确的图像会得到改名修复提示，而不是被嗅探接受。
- **工具结果卡片没有内嵌图像预览**：UI 表面以通用形式渲染图像结果（持久引用而非像素）；内嵌渲染延后到 UI 包处理。
- **没有超时接口**：`read`/`write`/`edit` 不接受超时参数，也不声明 `timeout-policy` 预算；取消只通过 `exec.signal` 传递（见[提供方理由](../README.md#no-timeouts-on-file-io)）。
