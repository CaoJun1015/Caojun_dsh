/** Strict single-layer decoding for explicitly escaped filesystem tool text. */

/** Model-facing text transport selected by a tool argument. */
export type FsTextFormat = 'text' | 'escaped'

const ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\',
  n: '\n',
  r: '\r',
  t: '\t',
}

/**
 * Decode one explicit escape layer, accepting only backslash, LF, CR, and tab.
 * @param input - already JSON-decoded tool argument.
 * @param parameterName - argument name included in validation failures.
 * @returns one-layer-decoded text.
 */
export function decodeEscapedText(input: string, parameterName: string): string {
  let output = ''
  for (let index = 0; index < input.length; index += 1) {
    const character = input.charAt(index)
    if (character !== '\\') {
      output += character
      continue
    }
    const escaped = input.charAt(index + 1)
    if (escaped === '') {
      throw new Error(`${parameterName} in escaped format ends with an unpaired backslash`)
    }
    const decoded = ESCAPES[escaped]
    if (decoded === undefined) {
      throw new Error(`${parameterName} in escaped format contains unsupported escape \\${escaped} at character ${index + 1}`)
    }
    output += decoded
    index += 1
  }
  return output
}

/**
 * Resolve a tool text argument according to its explicit transport format.
 * @param input - already JSON-decoded tool argument.
 * @param format - text passes through; escaped decodes exactly once.
 * @param parameterName - argument name included in validation failures.
 * @returns resolved text used by the mutation.
 */
export function resolveFsText(input: string, format: FsTextFormat, parameterName: string): string {
  return format === 'text' ? input : decodeEscapedText(input, parameterName)
}
