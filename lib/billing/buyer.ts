/**
 * Who buys a plan, and for which org: the org the user is looking at
 * (billing is the org's), which only its admins may change. A personal org's
 * one admin is its owner.
 */

import type { Owner } from "@/lib/auth/owner";
import type { CheckoutBuyer } from "@/lib/billing/checkout";
import { getOrgContext } from "@/lib/orgs/server";

export type BuyerOrRefusal = { buyer: CheckoutBuyer } | { refusal: string; status: number };

export async function billingBuyer(owner: Owner): Promise<BuyerOrRefusal> {
  const org = (await getOrgContext().catch(() => undefined))?.active;
  if (!org) return { refusal: "Couldn't load your orgs. Reload the page to try again.", status: 503 };
  if (org.role !== "admin") {
    return { refusal: `Only ${org.name}'s admins change its plan. Ask one of them.`, status: 403 };
  }
  return {
    buyer: { orgId: org.id, orgName: org.name, userId: owner.id, githubLogin: owner.githubLogin, email: owner.email },
  };
}
