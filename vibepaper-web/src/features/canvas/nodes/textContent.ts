export function textNodeContent(
  generatedText: unknown,
  params: Record<string, unknown> | undefined,
): string {
  for (const value of [generatedText, params?.lastOutputText, params?.content, params?.text]) {
    if (value != null && String(value).trim()) return String(value)
  }
  return ''
}
