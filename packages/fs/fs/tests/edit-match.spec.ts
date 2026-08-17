import { describe, expect, it } from 'vitest'
import { applyTextEdit, FsError } from '@deepseek-ai/dsh-fs'
import type { FsEditMatchOptions } from '@deepseek-ai/dsh-fs'

const progressive: FsEditMatchOptions = {
  mode: 'progressive',
  candidateLimit: 3,
  candidateMaxDistance: 3,
  candidatePreviewChars: 160,
}

function edit(content: string, oldString: string, newString = 'X', replaceAll = false) {
  return applyTextEdit(content, { oldString, newString, replaceAll, matchOptions: progressive }, 'story.md')
}

describe('applyTextEdit', () => {
  it('uses the first cumulative strategy that has matches', () => {
    expect(edit('before target after', 'target')).toMatchObject({ content: 'before X after', matchStrategy: 'exact' })
    expect(edit('before target after', '  target\n')).toMatchObject({ content: 'before X after', matchStrategy: 'trimmed' })
    expect(edit('one  \ntwo', 'one\ntwo')).toMatchObject({ content: 'X', matchStrategy: 'lineTrailingWhitespace' })
    expect(edit('ＡＢＣ　１２３', 'ABC 123')).toMatchObject({ content: 'X', matchStrategy: 'fullWidthAscii' })
  })

  it('normalizes CRLF at the exact level and preserves lone carriage returns', () => {
    expect(edit('one\r\ntwo', 'one\ntwo')).toMatchObject({ content: 'X', matchStrategy: 'exact' })
    expect(() => edit('one\rtwo', 'one\ntwo')).toThrow(expect.objectContaining({ code: 'FS_EDIT_NOT_FOUND' }))
  })

  it('never resolves an ambiguous fallback unless replaceAll is requested', () => {
    expect(() => edit('Ａ Ａ', 'A')).toThrow(expect.objectContaining({
      code: 'FS_AMBIGUOUS_EDIT',
      details: expect.objectContaining({ matchCount: 2, attemptedStrategies: ['exact', 'trimmed', 'lineTrailingWhitespace', 'fullWidthAscii'] }),
    }))
    expect(edit('Ａ Ａ', 'A', 'B', true)).toMatchObject({ content: 'B B', replacements: 2, matchStrategy: 'fullWidthAscii' })
  })

  it('keeps exact mode exact', () => {
    expect(() => applyTextEdit('ＡＢＣ', {
      oldString: 'ABC',
      newString: 'X',
      replaceAll: false,
      matchOptions: { ...progressive, mode: 'exact' },
    }, 'story.md')).toThrow(expect.objectContaining({
      code: 'FS_EDIT_NOT_FOUND',
      details: expect.objectContaining({ attemptedStrategies: ['exact'] }),
    }))
  })

  it('ranks Unicode-code-point candidates for equal-line-count windows', () => {
    let caught: FsError | undefined
    try {
      edit('unrelated\n你好世界\nsecond line\n你好世间\nsecond lime', '你好世界\nsecond lime')
    } catch (error: unknown) {
      if (error instanceof FsError) caught = error
    }
    expect(caught).toMatchObject({
      code: 'FS_EDIT_NOT_FOUND',
      details: {
        candidates: [
          { line: 2, distance: 1, preview: '你好世界\nsecond line' },
          { line: 4, distance: 1, preview: '你好世间\nsecond lime' },
        ],
      },
    })
  })

  it('enforces candidate and preview limits', () => {
    expect(() => applyTextEdit('cat\ncap\ncan', {
      oldString: 'car',
      newString: 'X',
      replaceAll: false,
      matchOptions: { ...progressive, candidateLimit: 2, candidatePreviewChars: 2 },
    }, 'story.md')).toThrow(expect.objectContaining({
      details: expect.objectContaining({
        candidates: [
          expect.objectContaining({ line: 1, preview: 'c…' }),
          expect.objectContaining({ line: 2, preview: 'c…' }),
        ],
      }),
    }))
  })

  it('rejects an empty search without producing a candidate', () => {
    expect(() => edit('content', '   ')).toThrow(expect.objectContaining({
      code: 'FS_EDIT_NOT_FOUND',
      details: expect.objectContaining({ candidates: [] }),
    }))
  })
})
