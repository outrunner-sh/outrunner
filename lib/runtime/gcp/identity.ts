import { createECDH, createHash, createHmac, createPrivateKey, sign } from "node:crypto";
import { gcpNames, type GcpConnection } from "./config.ts";

/** Domain-separated P-256 signing key, stable across server instances. No
 * cloud credential is kept or sent to the sandbox. Rotating the encryption
 * key requires rerunning connect to update the customer's pinned public JWK. */
function signingKey() {
  const raw = process.env.CREDENTIALS_ENCRYPTION_KEY ?? "";
  const root = /^[a-f0-9]+$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64url");
  if (root.length !== 32) throw new Error("GCP setup needs a valid CREDENTIALS_ENCRYPTION_KEY on this deployment.");
  const seed = createHmac("sha256", root).update("outrunner:gcp-oidc:p256:v1").digest();
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(seed);
  const point = ecdh.getPublicKey();
  const jwk = { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") };
  const kid = createHash("sha256").update(JSON.stringify(jwk)).digest("hex").slice(0, 24);
  return { jwk: { ...jwk, kid, use: "sig", alg: "ES256" }, privateKey: createPrivateKey({ key: { ...jwk, d: seed.toString("base64url") }, format: "jwk" }) };
}
export function gcpIssuer(): string {
  const url = new URL(process.env.RUNTIME_BASE_URL ?? "");
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/") {
    throw new Error("GCP setup needs RUNTIME_BASE_URL to be the deployment's public HTTPS origin.");
  }
  return `${url.origin}/api/gcp/identity`;
}
export function gcpJwks() { return { keys: [signingKey().jwk] }; }
export function gcpAssertion(c: GcpConnection, now = Date.now()): string {
  if (c.state === "revoked") throw new Error("This Google Cloud connection has been disconnected.");
  const { jwk, privateKey } = signingKey();
  const iat = Math.floor(now / 1000);
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const unsigned = `${encode({ alg: "ES256", typ: "JWT", kid: jwk.kid })}.${encode({ iss: gcpIssuer(), sub: c.id, aud: gcpNames(c).audience, iat, exp: iat + 300 })}`;
  return `${unsigned}.${sign("sha256", Buffer.from(unsigned), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}
