/**
 * Verifies the Cloudflare Access JWT on a request and returns the signed-in email, or null.
 * The dashboard can kill production Workers, so it trusts nothing but a valid, unexpired token for its own AUD.
 */
export async function accessEmail(req: Request, teamDomain: string, aud: string): Promise<string | null> {
  const token = req.headers.get("cf-access-jwt-assertion");
  if (!token) return null;
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return null;
  try {
    const header = JSON.parse(b64urlText(h));
    const payload = JSON.parse(b64urlText(p));
    const { keys } = await (await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, { cf: { cacheTtl: 3600 } })).json<{ keys: (JsonWebKey & { kid: string })[] }>();
    const jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(s), new TextEncoder().encode(`${h}.${p}`));
    const audOk = Array.isArray(payload.aud) ? payload.aud.includes(aud) : payload.aud === aud;
    const fresh = typeof payload.exp === "number" && payload.exp * 1000 > Date.now();
    return valid && audOk && fresh && payload.iss === `https://${teamDomain}` ? (payload.email ?? null) : null;
  } catch {
    return null;
  }
}

const b64urlBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const b64urlText = (s: string) => new TextDecoder().decode(b64urlBytes(s));
