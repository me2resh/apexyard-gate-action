import { createSign } from "node:crypto";
import { createClient as defaultCreateClient } from "./github.js";

function base64url(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function nowSeconds(clock) {
  if (typeof clock !== "function") throw new Error("bad clock");
  const value = clock();
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) throw new Error("bad clock");
  return Math.floor(milliseconds / 1000);
}

export class AppTokenError extends Error {
  constructor(step) {
    super(`${step} failed`);
    this.name = "AppTokenError";
    this.step = step;
  }
}

export function createAppJwt({ appId, appKey, clock = Date.now }) {
  const rawIssuer = typeof appId === "number" ? String(appId) : appId;
  const issuer = typeof rawIssuer === "string" ? rawIssuer.trim() : rawIssuer;
  if (typeof issuer !== "string" || !/^[0-9]+$/.test(issuer)) throw new Error("bad app id");
  if (typeof appKey !== "string" || appKey.length === 0) throw new Error("bad app key");
  const now = nowSeconds(clock);
  const header = base64url({ alg: "RS256", typ: "JWT" });
  const payload = base64url({ iat: now - 60, exp: now + (9 * 60), iss: issuer });
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(appKey).toString("base64url");
  return `${unsigned}.${signature}`;
}

export async function createAppToken({ appId, appKey, owner, repo }, deps = {}) {
  const clientFactory = deps.createClient ?? defaultCreateClient;
  const maskToken = deps.maskToken ?? ((token) => console.log(`::add-mask::${token}`));
  let jwt;
  try {
    jwt = createAppJwt({ appId, appKey, clock: deps.clock ?? Date.now });
  } catch {
    throw new AppTokenError("JWT creation");
  }
  try {
    maskToken(jwt);
  } catch {
    throw new AppTokenError("JWT masking");
  }

  let client;
  let installationId;
  try {
    client = clientFactory({ token: jwt, fetchImpl: deps.fetchImpl });
    installationId = await client.getInstallation(owner, repo);
    if (!Number.isSafeInteger(installationId) || installationId < 1) throw new Error("bad installation");
  } catch {
    throw new AppTokenError("installation lookup");
  }

  let token;
  try {
    token = await client.createInstallationToken(installationId, repo);
    if (typeof token !== "string" || token.length === 0 || /\s/.test(token)) {
      throw new Error("bad token");
    }
  } catch {
    throw new AppTokenError("token request");
  }

  try {
    maskToken(token);
  } catch {
    throw new AppTokenError("token masking");
  }
  return token;
}
