/**
 * The resolver a webhook delivery's connection uses (lib/api/webhooks.deps.ts).
 * Kept apart, with no Next in it, so it's tested on its own.
 */

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";

import { isPrivateAddress } from "@/lib/api/webhooks";

/**
 * The resolver a delivery's connection uses: the host's address is checked
 * in the same lookup the socket connects with, so a name that answers with
 * a public address for a check and a private one for the connection (DNS
 * rebinding) can't get past it.
 */
export const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, "", 0);
    const list = addresses as LookupAddress[];
    if (list.length === 0 || list.some((a) => isPrivateAddress(a.address))) {
      return callback(new Error("The URL's host points at a private address."), "", 0);
    }
    if (options.all) return callback(null, list as never);
    callback(null, list[0].address, list[0].family);
  });
};
