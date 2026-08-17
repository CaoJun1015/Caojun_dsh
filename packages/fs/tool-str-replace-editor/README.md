# @deepseek-ai/dsh-tool-str-replace-editor

English | [中文](README.zh.md)

Standalone model-facing `str_replace_editor` over `ctx.fs`. It can be composed with persistent Bash, one-shot Bash, sandboxed Bash, or another terminal surface.

## Config

| Key | Default | Meaning |
|---|---:|---|
| `maxOutputChars` | `16000` | Prefix characters retained for file and directory views. |
| `description` | Editor command guide | Model-facing tool description. |
| `editMatchMode` | `progressive` | Safe cumulative matching, or `exact` for LF-normalized exact-only edits. |
| `editCandidateLimit` | `3` | Maximum nearby candidates returned after a miss. |
| `editCandidateMaxDistance` | `3` | Maximum Unicode-code-point edit distance for candidates. |
| `editCandidatePreviewChars` | `160` | Maximum Unicode code points in each preview. |
| `backupBeforeMutation` | `true` | Require the provider to back up an existing target before create/replace/insert mutation. |

## Tool

The schema provides `view`, `create`, `str_replace`, and `insert` over absolute paths. `file_text_format`, `old_str_format`, and `new_str_format` default to `text`, which preserves JSON-decoded strings; `escaped` strictly decodes one additional layer of `\\`, `\n`, `\r`, and `\t`. File views use one-based line numbers and preserve content tabs. Replacement delegates to `ctx.fs.editText`, uses the same unique progressive strategies and candidate diagnostics as `edit`, and reports errors only in the public `old_str` vocabulary. Create, replace, and insert require provider backups for existing files by default, and success results expose the recovery path and byte count. Insert follows the selected zero-based boundary without adding an implicit trailing newline.

## Model Experience

### Tool schema

#### What the model sees

The generated [`str_replace_editor` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-str-replace-editor), including the configured `description`. The plugin contributes no standalone system-prompt section.

#### Token effect

Fixed schema cost while `str_replace_editor` is visible.

#### KV Cache effect

Prefix-stable while the configured description and schema remain unchanged.

### Tool results

#### What the model sees

Views return numbered text or a shallow directory listing. Calls expose file locations, and create/replace calls expose diff cards to presentation surfaces. Mutation confirmations include a backup recovery path when an existing file changed; fallback replacements identify the strategy used. Long views keep their prefix and append a clipping notice.

#### Token effect

Data-dependent and bounded by `maxOutputChars` plus the fixed clipping notice.

#### KV Cache effect

Append-only tool results follow the reusable request prefix.

## Known Limitations and Deferred Work

- Operations target UTF-8 text; binary files are unsupported.
- `str_replace` intentionally rejects zero or multiple matches and has no `replace_all` argument.
- Every mutation goes through `fs/write-intent` or `fs/edit-intent`, resolves the current session sandbox policy, and delegates enforcement to the mounted filesystem and policy plugins.
