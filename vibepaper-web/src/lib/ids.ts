/** Snowflake / entity ID — always treat as string in the browser. */
export type EntityId = string

export function sid(id: unknown): string {
  if (id == null) return ''
  return String(id)
}

export function isValidEntityId(id: unknown): boolean {
  return /^\d{1,20}$/.test(sid(id))
}

/**
 * Quote JSON integers with ≥16 digits so JSON.parse does not lose Snowflake precision.
 * Backend may still emit numeric Longs until Jackson ToStringSerializer is deployed.
 */
export function parseJsonPreserveIds<T = unknown>(text: string): T {
  return JSON.parse(quoteUnsafeIntegerLiterals(text)) as T
}

/**
 * Quote only JSON number literals that exceed JavaScript's safe integer range.
 *
 * A regex cannot safely distinguish a number token from digits inside a quoted
 * tool result or Skill document. Walking the JSON source keeps those strings
 * byte-for-byte intact, including large numbers embedded in display content.
 */
function quoteUnsafeIntegerLiterals(text: string): string {
  let output = ''
  let index = 0
  let inString = false
  let escaped = false

  while (index < text.length) {
    const char = text[index]
    if (inString) {
      output += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      index += 1
      continue
    }

    if (char === '"') {
      inString = true
      output += char
      index += 1
      continue
    }

    const startsNumber = /\d/.test(char) || (char === '-' && /\d/.test(text[index + 1] ?? ''))
    if (!startsNumber) {
      output += char
      index += 1
      continue
    }

    const start = index
    if (char === '-') index += 1
    const digitsStart = index
    while (/\d/.test(text[index] ?? '')) index += 1
    const digitCount = index - digitsStart
    let isInteger = true

    // Consume the *whole* JSON number token before deciding whether it is a
    // Snowflake-sized integer. Leaving the cursor at a decimal point caused
    // the fractional digits of a coordinate such as `570.398866556266...` to
    // be processed as a separate unsafe integer and turned valid JSON into
    // `570."398866..."`.
    if (text[index] === '.') {
      isInteger = false
      index += 1
      while (/\d/.test(text[index] ?? '')) index += 1
    }
    if (text[index] === 'e' || text[index] === 'E') {
      isInteger = false
      index += 1
      if (text[index] === '+' || text[index] === '-') index += 1
      while (/\d/.test(text[index] ?? '')) index += 1
    }
    const literal = text.slice(start, index)
    output += isInteger && digitCount >= 16 ? JSON.stringify(literal) : literal
  }

  return output
}
