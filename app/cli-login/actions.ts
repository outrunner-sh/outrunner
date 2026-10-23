"use server";

import { redirect } from "next/navigation";

import { cliCallbackUrl, hashSecret, LOGIN_CODE_TTL_MS, parseCliLoginRequest, randomSecret } from "@/lib/auth/cli-login";
import { getOwner } from "@/lib/auth/owner";
import { saveLoginCode } from "@/lib/db/cli-tokens";

/**
 * The user approved the CLI on /cli-login: keep a one-time code for it and
 * send the browser back to the CLI with the code. The request is checked again
 * here, since the form's fields are the browser's to change.
 */
export async function approveCliLogin(formData: FormData) {
  const request = parseCliLoginRequest({
    port: formData.get("port")?.toString(),
    state: formData.get("state")?.toString(),
    challenge: formData.get("challenge")?.toString(),
    name: formData.get("name")?.toString(),
  });
  if (!request) redirect("/cli-login");
  const owner = await getOwner();
  if (!owner) redirect("/signin");

  const code = randomSecret();
  await saveLoginCode(hashSecret(code), {
    userId: owner.id,
    challenge: request.challenge,
    deviceName: request.deviceName,
    expiresAt: new Date(Date.now() + LOGIN_CODE_TTL_MS).toISOString(),
  });
  redirect(cliCallbackUrl(request, code));
}
