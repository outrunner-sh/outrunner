/** Retry only a provider's quota rejection, before any successful stream is
 * delivered. Auth, network, server and tool errors must not replay a turn. */
export async function quotaExhausted(response: Response): Promise<boolean> {
  if (response.status === 429 || response.status === 402) return true;
  if (![400, 403].includes(response.status)) return false;
  const reader = response.clone().body?.getReader();
  if (!reader) return false;
  let text = "";
  try {
    while (text.length < 16_384) {
      const part = await reader.read();
      if (part.done) break;
      text += new TextDecoder().decode(part.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  return (
    /"(?:code|type)"\s*:\s*"(?:insufficient_quota|usage_limit_reached|billing_hard_limit_reached|credit_balance_too_low)"/i.test(
      text,
    ) || /credit balance is too low/i.test(text)
  );
}

/** A short, bounded per-process cooldown avoids probing an exhausted account
 * on every request. A different worker can safely try it again. */
export class QuotaCooldown {
  private until = new Map<string, number>();
  ready(key: string) {
    return (this.until.get(key) ?? 0) <= Date.now();
  }
  exhaust(key: string, response: Response) {
    const retry = response.headers.get("retry-after");
    const seconds = retry ? Number(retry) : NaN;
    const ms = Number.isFinite(seconds)
      ? seconds * 1000
      : retry
        ? Date.parse(retry) - Date.now()
        : 60_000;
    if (this.until.size >= 10_000)
      this.until.delete(this.until.keys().next().value!);
    this.until.set(
      key,
      Date.now() +
        Math.max(1000, Math.min(3_600_000, Number.isFinite(ms) ? ms : 60_000)),
    );
  }
}
