import { describe, expect, it } from 'vitest'
import { decodeEscapedText, resolveFsText } from '@deepseek-ai/dsh-fs'

describe('explicit filesystem text formats', () => {
  it('leaves text format untouched', () => {
    expect(resolveFsText(String.raw`C:\temp\file\n`, 'text', 'content')).toBe(String.raw`C:\temp\file\n`)
  })

  it('decodes the four supported escapes exactly once', () => {
    expect(decodeEscapedText(String.raw`one\ntwo\rthree\tfour\\five`, 'content'))
      .toBe('one\ntwo\rthree\tfour\\five')
    expect(decodeEscapedText(String.raw`\\n`, 'content')).toBe(String.raw`\n`)
  })

  it('rejects unknown and trailing escapes', () => {
    expect(() => decodeEscapedText(String.raw`\q`, 'old_string')).toThrow(
      'old_string in escaped format contains unsupported escape \\q at character 1',
    )
    expect(() => decodeEscapedText('tail\\', 'new_string')).toThrow(
      'new_string in escaped format ends with an unpaired backslash',
    )
  })
})
