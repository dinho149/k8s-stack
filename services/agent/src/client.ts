export class PlatformClient {
  constructor(
    readonly base: string,
    private token: string,
    readonly subject?: string,
  ) {}
  async request(path: string, method = 'GET', body?: unknown, idempotency?: string): Promise<any> {
    const response = await fetch(new URL(path, this.base), {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...(this.subject ? { 'X-Dogfood-Subject': this.subject } : {}),
        ...(idempotency ? { 'Idempotency-Key': idempotency } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new Error(
        `Platform request rejected (${response.status}): ${(await response.text()).slice(0, 500)}`,
      );
    return response.json();
  }
}
export function redact(text: string): string {
  return text.replace(
    /(?:Bearer\s+\S+|(?:password|token|secret|api[_-]?key)\s*[=:]\s*[^\s,;]+)/gi,
    '[REDACTED]',
  );
}
