/**
 * Asking the billing routes for one of Stripe's pages (Checkout, the customer
 * portal), from the browser. Resolves with the page's URL; a refusal rejects
 * with the server's own reason.
 */
export async function stripePage(path: string, body?: object): Promise<string> {
  const res = await fetch(path, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
  if (!res.ok || !data?.url) throw new Error(data?.error ?? "Couldn't reach Stripe. Try again.");
  return data.url;
}
