/** Keyless assembled snapshot for safe filesystem mutation behavior. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import * as FsObservationPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { expect, it } from 'vitest'

const expectedPath = join(
  dirname(fileURLToPath(import.meta.url)),
  'snapshots/fs-mutation-safety/result.expected.json',
)

const signal = new AbortController().signal

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

it('fs-mutation-safety uses progressive matching, provider backup, and explicit escapes', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-fs-mutation-snapshot-'))
  const backups = join(workspace, '.backups')
  const chapter = join(workspace, 'chapter.txt')
  const escaped = join(workspace, 'escaped.txt')
  const ctx = new Context()
  const fibers: Array<Awaited<ReturnType<Context['plugin']>>> = []
  let callIndex = 0
  const session = { header: { cwd: workspace } }
  try {
    await writeFile(chapter, 'title:\u3000\uff21\uff22\uff23\uff01\nending\n')
    fibers.push(await ctx.plugin(SystemPrompt))
    fibers.push(await ctx.plugin(ToolRuntime))
    fibers.push(await ctx.plugin(LocalFileSystem, { cwd: workspace, backupRoot: backups }))
    ;(ctx.fs as LocalFileSystem).internals.backupName = () => 'snapshot.bak'
    fibers.push(await ctx.plugin(FsObservationPolicy))
    fibers.push(await ctx.plugin(ToolFs))

    const call = (name: string, args: unknown) => ctx.tools.execute({
      signal,
      callId: CallId(`fs-mutation-snapshot-${++callIndex}`),
      name,
      arguments: args,
      agent: { session } as never,
    })

    expect((await call('read', { file_path: 'chapter.txt' })).isError).toBe(false)
    const edit = await call('edit', {
      file_path: 'chapter.txt',
      old_string: 'title: ABC!',
      new_string: 'title: SAFE!',
    })
    const write = await call('write', {
      file_path: 'escaped.txt',
      content: String.raw`line one\nline two\tend`,
      content_format: 'escaped',
    })
    expect(edit.isError).toBe(false)
    expect(write.isError).toBe(false)

    const editValue = edit.value as {
      path: string
      before: string
      after: string
      match_strategy: string
      backup: { path: string; bytes: number }
    }
    const writeValue = write.value as {
      path: string
      operation: string
      before: string | null
      after: string
      backup: null
    }
    const backupDirectory = dirname(editValue.backup.path)
    const normalize = (value: string): string => value
      .replaceAll(editValue.backup.path, '<backup-target>/snapshot.bak')
      .replaceAll(backupDirectory, '<backup-target>')
      .replaceAll(workspace, '<workspace>')
      .replaceAll('<workspace>\\', '<workspace>/')
    const snapshot = {
      edit: {
        value: {
          ...editValue,
          path: normalize(editValue.path),
          backup: { ...editValue.backup, path: normalize(editValue.backup.path) },
        },
        text: normalize(text(edit)),
      },
      write: {
        value: { ...writeValue, path: normalize(writeValue.path) },
        text: normalize(text(write)),
      },
      files: {
        chapter: await readFile(chapter, 'utf8'),
        escaped: await readFile(escaped, 'utf8'),
        backup: await readFile(editValue.backup.path, 'utf8'),
      },
    }
    await expect(`${JSON.stringify(snapshot, null, 2)}\n`).toMatchFileSnapshot(expectedPath)
  } finally {
    await Promise.allSettled(fibers.reverse().map(fiber => fiber.dispose()))
    await rm(workspace, { recursive: true, force: true })
  }
})
