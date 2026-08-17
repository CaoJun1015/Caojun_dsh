/**
 * Pure, provider-independent matching for filesystem literal edits.
 * @module @deepseek-ai/dsh-fs/edit-match
 */

import { FsError } from './types.ts'
import type {
  FsEditCandidate,
  FsEditMatchOptions,
  FsEditMatchStrategy,
  FsEditRequest,
} from './types.ts'

const DEFAULT_EXACT_OPTIONS: FsEditMatchOptions = {
  mode: 'exact',
  candidateLimit: 3,
  candidateMaxDistance: 3,
  candidatePreviewChars: 160,
}

interface NormalizedText {
  text: string
  /** UTF-16 source boundary for every normalized UTF-16 boundary. */
  sourceBoundaries: number[]
}

interface MatchSpan {
  start: number
  end: number
}

/** Result of applying one authoritative literal edit. */
export interface FsAppliedTextEdit {
  /** LF-normalized text after replacement. */
  content: string
  /** Number of non-overlapping replacements. */
  replacements: number
  /** First cumulative strategy that produced matches. */
  matchStrategy: FsEditMatchStrategy
}

function trimmedRange(value: string): { start: number; end: number } {
  const leading = value.match(/^\s*/u)?.[0].length ?? 0
  const trailing = value.match(/\s*$/u)?.[0].length ?? 0
  return { start: leading, end: Math.max(leading, value.length - trailing) }
}

function isLineTrailingWhitespace(value: string): boolean {
  return /[^\S\r\n]/u.test(value)
}

function normalizeFullWidth(character: string): string {
  const code = character.codePointAt(0)
  if (code === 0x3000) return ' '
  if (code !== undefined && code >= 0xff01 && code <= 0xff5e) {
    return String.fromCodePoint(code - 0xfee0)
  }
  return character
}

function normalizeForStrategy(
  source: string,
  strategy: FsEditMatchStrategy,
  searchText: boolean,
): NormalizedText {
  const trim = searchText && strategy !== 'exact'
  const range = trim ? trimmedRange(source) : { start: 0, end: source.length }
  const stripLineTrailing = strategy === 'lineTrailingWhitespace' || strategy === 'fullWidthAscii'
  const normalizeWidth = strategy === 'fullWidthAscii'
  let text = ''
  const sourceBoundaries = [range.start]

  for (let index = range.start; index < range.end;) {
    const character = source[index]
    if (character === undefined) break
    if (stripLineTrailing && isLineTrailingWhitespace(character)) {
      let cursor = index + 1
      while (cursor < range.end && isLineTrailingWhitespace(source[cursor] ?? '')) cursor += 1
      const next = source[cursor]
      if (cursor === range.end || next === '\n' || (next === '\r' && source[cursor + 1] === '\n')) {
        sourceBoundaries[sourceBoundaries.length - 1] = cursor
        index = cursor
        continue
      }
    }
    if (character === '\r' && source[index + 1] === '\n') {
      text += '\n'
      sourceBoundaries.push(index + 2)
      index += 2
      continue
    }
    const codePoint = source.codePointAt(index)
    const raw = codePoint === undefined ? character : String.fromCodePoint(codePoint)
    const replacement = normalizeWidth ? normalizeFullWidth(raw) : raw
    text += replacement
    for (let unit = 1; unit <= replacement.length; unit += 1) {
      sourceBoundaries.push(index + Math.min(unit, raw.length))
    }
    index += raw.length
  }
  return { text, sourceBoundaries }
}

function findSpans(content: NormalizedText, needle: string): MatchSpan[] {
  const spans: MatchSpan[] = []
  let offset = 0
  while (offset <= content.text.length - needle.length) {
    const found = content.text.indexOf(needle, offset)
    if (found < 0) break
    spans.push({
      start: content.sourceBoundaries[found] ?? 0,
      end: content.sourceBoundaries[found + needle.length] ?? content.sourceBoundaries.at(-1) ?? 0,
    })
    offset = found + needle.length
  }
  return spans
}

function lineAt(content: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset; index += 1) {
    if (content[index] === '\n') line += 1
  }
  return line
}

function boundedPreview(value: string, limit: number): string {
  const codePoints = Array.from(value)
  if (codePoints.length <= limit) return value
  if (limit === 1) return '…'
  return `${codePoints.slice(0, limit - 1).join('')}…`
}

function boundedLevenshtein(left: string, right: string, maxDistance: number): number | undefined {
  const a = Array.from(left)
  const b = Array.from(right)
  if (Math.abs(a.length - b.length) > maxDistance) return undefined
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let row = 1; row <= a.length; row += 1) {
    const current = new Array<number>(b.length + 1).fill(maxDistance + 1)
    current[0] = row
    const start = Math.max(1, row - maxDistance)
    const end = Math.min(b.length, row + maxDistance)
    let rowMinimum = current[0] ?? maxDistance + 1
    for (let column = start; column <= end; column += 1) {
      current[column] = Math.min(
        (previous[column] ?? maxDistance + 1) + 1,
        (current[column - 1] ?? maxDistance + 1) + 1,
        (previous[column - 1] ?? maxDistance + 1) + (a[row - 1] === b[column - 1] ? 0 : 1),
      )
      rowMinimum = Math.min(rowMinimum, current[column] ?? maxDistance + 1)
    }
    if (rowMinimum > maxDistance) return undefined
    previous = current
  }
  const distance = previous[b.length]
  return distance !== undefined && distance <= maxDistance ? distance : undefined
}

function closeCandidates(
  content: string,
  oldString: string,
  options: FsEditMatchOptions,
): FsEditCandidate[] {
  if (options.candidateLimit === 0 || options.candidateMaxDistance < 0) return []
  const normalizedContent = normalizeForStrategy(content, 'fullWidthAscii', false).text
  const normalizedNeedle = normalizeForStrategy(oldString, 'fullWidthAscii', true).text
  if (normalizedNeedle.length === 0) return []
  const lines = normalizedContent.split('\n')
  const sourceLines = content.replaceAll('\r\n', '\n').split('\n')
  const windowSize = normalizedNeedle.split('\n').length
  const candidates: FsEditCandidate[] = []
  for (let index = 0; index + windowSize <= lines.length; index += 1) {
    const candidate = lines.slice(index, index + windowSize).join('\n')
    const distance = boundedLevenshtein(normalizedNeedle, candidate, options.candidateMaxDistance)
    if (distance === undefined) continue
    candidates.push({
      line: index + 1,
      distance,
      preview: boundedPreview(sourceLines.slice(index, index + windowSize).join('\n'), options.candidatePreviewChars),
    })
  }
  return candidates
    .sort((left, right) => left.distance - right.distance || left.line - right.line)
    .slice(0, options.candidateLimit)
}

function strategiesFor(mode: FsEditMatchOptions['mode']): FsEditMatchStrategy[] {
  return mode === 'exact'
    ? ['exact']
    : ['exact', 'trimmed', 'lineTrailingWhitespace', 'fullWidthAscii']
}

function validateOptions(options: FsEditMatchOptions): void {
  for (const [name, value] of Object.entries({
    candidateLimit: options.candidateLimit,
    candidateMaxDistance: options.candidateMaxDistance,
    candidatePreviewChars: options.candidatePreviewChars,
  })) {
    if (!Number.isSafeInteger(value) || value < 0 || (name === 'candidatePreviewChars' && value === 0)) {
      throw new RangeError(`${name} must be a ${name === 'candidatePreviewChars' ? 'positive' : 'non-negative'} safe integer`)
    }
  }
}

/**
 * Apply a safe literal edit using the first cumulative strategy with matches.
 * Approximate candidates are diagnostic only and never select replacement text.
 * @param content - current file text; CRLF is normalized for matching and output.
 * @param request - literal replacement and matching policy.
 * @param displayPath - backend path included in structured failures.
 * @returns edited LF-normalized text, replacement count, and authoritative strategy.
 */
export function applyTextEdit(
  content: string,
  request: FsEditRequest,
  displayPath: string,
): FsAppliedTextEdit {
  const options = request.matchOptions ?? DEFAULT_EXACT_OPTIONS
  validateOptions(options)
  const normalizedNewString = normalizeForStrategy(request.newString, 'exact', false).text
  const attemptedStrategies: FsEditMatchStrategy[] = []
  let selected: { strategy: FsEditMatchStrategy; spans: MatchSpan[] } | undefined

  for (const strategy of strategiesFor(options.mode)) {
    attemptedStrategies.push(strategy)
    const needle = normalizeForStrategy(request.oldString, strategy, true).text
    if (needle.length === 0) break
    const normalizedContent = normalizeForStrategy(content, strategy, false)
    const spans = findSpans(normalizedContent, needle)
    if (spans.length > 0) {
      selected = { strategy, spans }
      break
    }
  }

  if (selected === undefined) {
    const candidates = closeCandidates(content, request.oldString, options)
    const suffix = candidates.length === 0 ? '; no nearby candidates were found' : `; ${candidates.length} nearby candidate(s) are available`
    throw new FsError(`old_string was not found in "${displayPath}"${suffix}`, 'FS_EDIT_NOT_FOUND', {
      details: { path: displayPath, attemptedStrategies, candidates },
    })
  }

  if (!request.replaceAll && selected.spans.length !== 1) {
    const candidates = selected.spans.slice(0, options.candidateLimit).map(span => ({
      line: lineAt(content, span.start),
      distance: 0,
      preview: boundedPreview(content.slice(span.start, span.end), options.candidatePreviewChars),
    }))
    throw new FsError(
      `old_string matched ${selected.spans.length} times in "${displayPath}"; provide a more specific old_string or set replace_all to true`,
      'FS_AMBIGUOUS_EDIT',
      {
        details: {
          path: displayPath,
          attemptedStrategies,
          candidates,
          matchCount: selected.spans.length,
        },
      },
    )
  }

  const spans = request.replaceAll ? selected.spans : selected.spans.slice(0, 1)
  let output = ''
  let cursor = 0
  for (const span of spans) {
    output += content.slice(cursor, span.start)
    output += normalizedNewString
    cursor = span.end
  }
  output += content.slice(cursor)
  return {
    content: output.replaceAll('\r\n', '\n'),
    replacements: spans.length,
    matchStrategy: selected.strategy,
  }
}
