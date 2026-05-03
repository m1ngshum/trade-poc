const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(previous|all)\s+instructions/i,
  /new\s+(task|directive|instruction)/i,
  /system\s+prompt/i,
  /forget\s+(everything|all)/i,
  /you\s+are\s+now\b/i,
  /act\s+as\b/i,
];

const MAX_FIELD_LENGTH = 1000;

export function sanitizeText(value: string): string {
  const truncated = value.slice(0, MAX_FIELD_LENGTH);
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(truncated)) {
      throw new Error(`Prompt injection detected: "${truncated.slice(0, 80)}"`);
    }
  }
  return truncated;
}

export function sanitizePacketStrings(obj: unknown): unknown {
  if (typeof obj === "string") return sanitizeText(obj);
  if (Array.isArray(obj)) return obj.map(sanitizePacketStrings);
  if (obj !== null && typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [
        k,
        sanitizePacketStrings(v),
      ]),
    );
  }
  return obj;
}
