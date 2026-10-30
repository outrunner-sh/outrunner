import { z } from "zod";

import { ProvideSecretsRequest } from "@/lib/runtime/agent-protocol";

// Older clients send the opt-in checkbox. Accept it, but always persist
// supplied values to the project; never forward this field to the agent.
export const SecretAnswer = ProvideSecretsRequest.extend({ save: z.boolean().optional() })
  .strict()
  .transform(({ keys, values, skipped }) => ({ keys, values, skipped }));

/** Validate/deliver first: an expired request must not change the project.
 * A persistence failure still leaves the agent with the supplied values. */
export async function provideAndSaveSecrets(
  answer: ProvideSecretsRequest,
  deps: {
    provide(answer: ProvideSecretsRequest): Promise<void>;
    save(values: Record<string, string>): Promise<void>;
    saveError(error: unknown): string;
  },
): Promise<{ result: "provided"; saved?: boolean; saveError?: string }> {
  await deps.provide(answer);
  const values = answer.values ?? {};
  if (answer.skipped || Object.keys(values).length === 0) return { result: "provided" };
  try {
    await deps.save(values);
    return { result: "provided", saved: true };
  } catch (error) {
    return { result: "provided", saved: false, saveError: deps.saveError(error) };
  }
}
