import { spawn } from "node:child_process";

import { CliError } from "../errors.js";
import type { CredentialStore } from "./credentials.js";
import {
  buildAuthorizeUrl,
  createLoopbackReceiver,
  createOAuthState,
  createPkce,
  exchangeAuthorizationCode,
  loadOAuthConfiguration,
  refreshAccessToken,
} from "./oauth.js";

export type AuthenticationStatus =
  | { method: "none" }
  | { method: "oauth" }
  | { method: "organization_key"; organizationId: string };

interface OAuthLoginOptions {
  store: CredentialStore;
  output?: (message: string) => void;
  openBrowser?: (url: string) => Promise<boolean>;
  fetchImplementation?: typeof fetch;
  loopbackPort?: number;
}

interface AccessTokenOptions {
  store: CredentialStore;
  fetchImplementation?: typeof fetch;
}

export async function getAuthenticationStatus(
  store: CredentialStore,
): Promise<AuthenticationStatus> {
  const stored = await store.read();
  if (!stored) return { method: "none" };
  if (stored.method === "organization_key") {
    return { method: stored.method, organizationId: stored.organizationId };
  }
  return { method: "oauth" };
}

export function accessTokenNeedsRefresh(
  accessToken: string,
  nowMilliseconds = Date.now(),
): boolean {
  const claims = decodeAccessTokenClaims(accessToken);
  if (
    !claims ||
    typeof claims.exp !== "number" ||
    !Number.isFinite(claims.exp)
  ) {
    return true;
  }
  return claims.exp * 1_000 - nowMilliseconds <= 30_000;
}

export function getOAuthOrganizationId(accessToken: string): string {
  const organizationId = decodeAccessTokenClaims(accessToken)?.org_id;
  if (typeof organizationId === "string" && organizationId.trim() !== "") {
    return organizationId;
  }
  throw new CliError(
    "The OAuth session has no active organization. Sign in again and choose an organization.",
  );
}

export async function getValidAccessToken(
  options: AccessTokenOptions,
): Promise<string> {
  const stored = await options.store.read();
  if (!stored) {
    throw new CliError("Not authenticated. Run `understudy login`.");
  }
  if (stored.method !== "oauth") {
    throw new CliError("This operation requires browser OAuth. Run `understudy login`.");
  }
  if (!accessTokenNeedsRefresh(stored.accessToken)) return stored.accessToken;
  if (!stored.refreshToken) {
    throw new CliError(
      "The OAuth session has expired. Run `understudy login` again.",
    );
  }

  const configuration = loadOAuthConfiguration();
  const refreshed = await refreshAccessToken(
    {
      tokenUrl: configuration.tokenUrl,
      clientId: configuration.clientId,
      refreshToken: stored.refreshToken,
    },
    options.fetchImplementation,
  );
  await options.store.write({
    version: 1,
    method: "oauth",
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? stored.refreshToken,
  });
  return refreshed.accessToken;
}

export async function loginWithOAuth(
  options: OAuthLoginOptions,
): Promise<void> {
  const output =
    options.output ?? ((message) => process.stdout.write(`${message}\n`));
  const configuration = loadOAuthConfiguration();
  const pkce = createPkce();
  const state = createOAuthState();
  const receiver = await createLoopbackReceiver({
    expectedState: state,
    port: options.loopbackPort ?? configuration.loopbackPort,
  });

  try {
    const authorizationUrl = buildAuthorizeUrl({
      authorizeUrl: configuration.authorizeUrl,
      clientId: configuration.clientId,
      redirectUri: receiver.redirectUri,
      codeChallenge: pkce.challenge,
      state,
    });
    const opened = await (options.openBrowser ?? openBrowser)(authorizationUrl);
    output(
      opened
        ? `Opening your browser to sign in.\nIf it does not open, use this URL:\n${authorizationUrl}`
        : `Open this URL in your browser to sign in:\n${authorizationUrl}`,
    );
    output("Waiting for sign-in to complete...");

    const callback = await receiver.waitForCallback();
    const tokens = await exchangeAuthorizationCode(
      {
        tokenUrl: configuration.tokenUrl,
        clientId: configuration.clientId,
        code: callback.code,
        codeVerifier: pkce.verifier,
        redirectUri: receiver.redirectUri,
      },
      options.fetchImplementation,
    );
    await options.store.write({
      version: 1,
      method: "oauth",
      accessToken: tokens.accessToken,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    });
  } finally {
    await receiver.close();
  }
}

function openBrowser(url: string): Promise<boolean> {
  const command =
    process.platform === "darwin"
      ? { executable: "open", arguments: [url] }
      : process.platform === "win32"
        ? {
            executable: "rundll32",
            arguments: ["url.dll,FileProtocolHandler", url],
          }
        : { executable: "xdg-open", arguments: [url] };

  return new Promise((resolve) => {
    const child = spawn(command.executable, command.arguments, {
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

function decodeAccessTokenClaims(
  accessToken: string,
): { exp?: unknown; org_id?: unknown } | null {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3 || !parts[1]) return null;
    const claims: unknown = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    );
    return typeof claims === "object" && claims !== null
      ? (claims as { exp?: unknown; org_id?: unknown })
      : null;
  } catch {
    return null;
  }
}
