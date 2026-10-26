import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { accessEmail } from "../src/access";

const TEAM = "acme.cloudflareaccess.com";
const AUD = "aud-123";
let keys: CryptoKeyPair;

const b64url = (b: Uint8Array | string) =>
  Buffer.from(typeof b === "string" ? b : b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function sign(payload: Record<string, unknown>, kid = "k1") {
  const h = b64url(JSON.stringify({ alg: "RS256", kid }));
  const p = b64url(JSON.stringify(payload));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}

const valid = () => ({ aud: [AUD], iss: `https://${TEAM}`, exp: Math.floor(Date.now() / 1000) + 600, email: "tim@example.com" });
const req = (token?: string) => new Request("https://guard.example.com/", { headers: token ? { "cf-access-jwt-assertion": token } : {} });

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
});

afterEach(() => vi.unstubAllGlobals());

const serveCerts = async () => {
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  vi.stubGlobal("fetch", async () => Response.json({ keys: [{ ...jwk, kid: "k1" }] }));
};

describe("accessEmail", () => {
  it("returns the email from a valid token", async () => {
    await serveCerts();
    expect(await accessEmail(req(await sign(valid())), TEAM, AUD)).toBe("tim@example.com");
  });

  it("rejects a missing token", async () => {
    expect(await accessEmail(req(), TEAM, AUD)).toBeNull();
  });

  it("rejects a token for another application", async () => {
    await serveCerts();
    expect(await accessEmail(req(await sign({ ...valid(), aud: ["other"] })), TEAM, AUD)).toBeNull();
  });

  it("rejects an expired token", async () => {
    await serveCerts();
    expect(await accessEmail(req(await sign({ ...valid(), exp: 1 })), TEAM, AUD)).toBeNull();
  });

  it("rejects a tampered token", async () => {
    await serveCerts();
    const [h, , s] = (await sign(valid())).split(".");
    const forged = `${h}.${b64url(JSON.stringify({ ...valid(), email: "attacker@example.com" }))}.${s}`;
    expect(await accessEmail(req(forged), TEAM, AUD)).toBeNull();
  });
});
