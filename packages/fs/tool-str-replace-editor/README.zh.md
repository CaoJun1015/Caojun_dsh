# @deepseek-ai/dsh-tool-str-replace-editor

[English](README.md) | 中文

基于 `ctx.fs`、面向模型的独立 `str_replace_editor`。它可与持久 Bash、一次性 Bash、沙箱 Bash 或其他终端接口组合。

## 配置

| 键 | 默认值 | 含义 |
|---|---:|---|
| `maxOutputChars` | `16000` | 文件和目录查看结果保留的前缀字符数。 |
| `description` | 编辑器命令指南 | 面向模型的工具描述。 |
| `editMatchMode` | `progressive` | 安全累计匹配；设为 `exact` 时只使用 LF 规范化精确匹配。 |
| `editCandidateLimit` | `3` | 匹配失败时返回的近似候选上限。 |
| `editCandidateMaxDistance` | `3` | 候选按 Unicode code point 计算的最大编辑距离。 |
| `editCandidatePreviewChars` | `160` | 每个预览最多包含的 Unicode code point 数。 |
| `backupBeforeMutation` | `true` | create/replace/insert 修改现有目标前要求提供方创建备份。 |

## 工具

schema 提供针对绝对路径的 `view`、`create`、`str_replace` 与 `insert`。`file_text_format`、`old_str_format` 与 `new_str_format` 默认为 `text`，保留 JSON 解析后的字符串；`escaped` 严格额外解码一层 `\\`、`\n`、`\r` 和 `\t`。文件查看使用从 1 开始的行号并保留制表符。替换委托给 `ctx.fs.editText`，与 `edit` 使用相同的唯一渐进策略和候选诊断，错误只使用公开的 `old_str` 词汇。create、replace 与 insert 默认要求提供方为现有文件创建备份，成功结果公开恢复路径和字节数。插入遵循所选的零基边界，不会隐式补尾换行。

## 模型体验

### 工具 schema

#### 模型看到的内容

生成的 [`str_replace_editor` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-str-replace-editor)，其中包含配置的 `description`。本插件不贡献独立系统提示词段。

#### Token 影响

`str_replace_editor` 可见时产生固定的 schema 成本。

#### KV Cache 影响

配置的描述与 schema 不变时前缀稳定。

### 工具结果

#### 模型看到的内容

查看操作返回带行号文本或浅层目录列表。调用会提供文件位置，创建/替换调用还会向展示层提供 diff 卡片。修改现有文件时，确认结果包含备份恢复路径；降级匹配会说明所用策略。长查看结果保留前缀并追加截断提示。

#### Token 影响

随数据变化，并受 `maxOutputChars` 与固定截断提示约束。

#### KV Cache 影响

工具结果以追加方式位于可复用请求前缀之后。

## 已知限制与暂缓事项

- 操作面向 UTF-8 文本，不支持二进制文件。
- `str_replace` 刻意拒绝零匹配或多匹配，且没有 `replace_all` 参数。
- 每个修改操作都会经过 `fs/write-intent` 或 `fs/edit-intent`，解析当前会话的沙箱策略，并交由挂载的文件系统与策略插件实施约束。
