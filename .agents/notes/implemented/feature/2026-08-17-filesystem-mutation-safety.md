# Agent Note: Filesystem mutation safety

Status: implemented

English | [中文](2026-08-17-filesystem-mutation-safety.zh.md)

## Problem

Long text files made strict edit matching and unprotected overwrite failure modes disproportionately costly. Small differences in outer whitespace, per-line trailing whitespace, line endings, or full-width punctuation could reject an otherwise clear edit, while an accidental overwrite had no provider-owned recovery copy. Guessing whether literal backslash sequences were intended as transport escapes could fix prose while corrupting source code, regular expressions, or Windows paths.

The safety behavior must work across local, sandboxed, and E2B filesystems. It cannot depend on a Git repository, modify unrelated repository state, or let diagnostic similarity silently select text for mutation.

## Decision

`@deepseek-ai/dsh-fs` owns one pure edit matcher shared by local and E2B providers. Progressive mode tries cumulative LF-normalized exact, trimmed-search, per-line trailing-whitespace, and full-width ASCII/U+3000 strategies in that order, and uses only the first level that finds matches. A non-`replaceAll` edit still requires one match. Bounded Unicode-code-point Levenshtein candidates are error diagnostics only.

Mutation calls carry explicit `FsWriteOptions` or `FsEditOptions`, including a required-or-disabled backup policy. Providers create byte-preserving backups inside the target lock after initial validation and before atomic publication, recheck the source version after backup, and fail without changing the target when backup storage fails. Local storage uses private hashed target directories, unpredictable names, owner-only permissions, and three-version retention by default. E2B uses equivalent private storage inside the remote sandbox. The sandbox provider performs its fresh-target containment check before inherited backup or mutation work.

Tool strings default to `text`, which preserves the JSON-decoded value. `escaped` explicitly requests one strict additional decoding layer and accepts only `\\`, `\n`, `\r`, and `\t`. Unknown sequences and a trailing backslash fail before any filesystem side effect. `write`, `edit`, and `str_replace_editor` expose the corresponding format fields; mutation results expose backup path and bytes but not the internal source version.

## Alternatives considered

**Automatic Git commits or side refs after every mutation.** Rejected because a filesystem provider may run outside a repository, a session may contain unrelated dirty work, and an implicit commit changes user-visible repository history. Provider-owned backups cover the mutation at the capability that performs it and remain available when Git is absent. Users can still commit explicitly at workflow boundaries.

**Approximate matching as an automatic fallback.** Rejected because edit distance does not establish intent. Candidates give the model actionable context without allowing a near match to change the wrong passage.

**Heuristic escape repair.** Rejected because the same literal `\n` is valid prose, source code, regex, and path content. An explicit format field makes transport intent inspectable and keeps default text lossless.

**Sibling `.bak` files.** Rejected because they pollute project directories, collide with user files, expose predictable names, and mix recovery data with source control. Provider-owned private roots give retention and permissions one owner.

## Consequences

Fallback matching is more tolerant without weakening uniqueness, and failed edits provide bounded candidates with stable structured codes. Existing-file write/edit operations are recoverable by default, while creation and failed matching produce no backup. Backup retention cleanup occurs after publication and can temporarily exceed the configured count when cleanup fails.

The backup source-version recheck narrows external modification races but does not provide a cross-process compare-and-swap publication. E2B recovery lasts only for the remote sandbox lifetime. Explicit escaped mode adds schema and prompt cost, but the default preserves code and paths exactly and invalid escapes cannot create backups or change targets.
