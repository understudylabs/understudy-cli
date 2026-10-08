import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";

import { CliError } from "../errors.js";

const oauthDefaults = {
  authorizeUrl: "https://api.workos.com/user_management/authorize",
  tokenUrl: "https://api.workos.com/user_management/authenticate",
  clientId: "client_01KQQB57XEY30W98QHMQ47SZB9",
  loopbackHost: "127.0.0.1",
  loopbackPort: 47_891,
  timeoutMs: 300_000,
} as const;

interface OAuthConfiguration {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  loopbackPort: number;
}

interface PkcePair {
  verifier: string;
  challenge: string;
}

interface LoopbackReceiver {
  readonly redirectUri: string;
  waitForCallback(): Promise<{ code: string }>;
  close(): Promise<void>;
}

interface LoopbackOptions {
  expectedState: string;
  port?: number;
  timeoutMs?: number;
}

interface AuthorizeUrlOptions {
  authorizeUrl: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
}

interface ExchangeCodeOptions {
  tokenUrl: string;
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

interface RefreshTokenOptions {
  tokenUrl: string;
  clientId: string;
  refreshToken: string;
}

type TokenRequestBody =
  | {
      grant_type: "authorization_code";
      client_id: string;
      code: string;
      code_verifier: string;
      redirect_uri: string;
    }
  | {
      grant_type: "refresh_token";
      client_id: string;
      refresh_token: string;
    };

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).nullish(),
});

export function loadOAuthConfiguration(): OAuthConfiguration {
  return {
    authorizeUrl: oauthDefaults.authorizeUrl,
    tokenUrl: oauthDefaults.tokenUrl,
    clientId: oauthDefaults.clientId,
    loopbackPort: oauthDefaults.loopbackPort,
  };
}

export function deriveCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function createPkce(): PkcePair {
  const verifier = randomBytes(64).toString("base64url");
  return { verifier, challenge: deriveCodeChallenge(verifier) };
}

export function createOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export function buildAuthorizeUrl(options: AuthorizeUrlOptions): string {
  const url = new URL(options.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", options.state);
  url.searchParams.set("provider", "authkit");
  return url.toString();
}

export async function createLoopbackReceiver(
  options: LoopbackOptions,
): Promise<LoopbackReceiver> {
  let resolveCallback!: (result: { code: string }) => void;
  let rejectCallback!: (error: Error) => void;
  let settled = false;
  const callback = new Promise<{ code: string }>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const settle = (result: { code: string } | Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (result instanceof Error) rejectCallback(result);
    else resolveCallback(result);
  };

  const server = createServer((request, response) => {
    const url = new URL(
      request.url ?? "/",
      `http://${oauthDefaults.loopbackHost}`,
    );
    if (request.method !== "GET" || url.pathname !== "/callback") {
      sendHtml(response, 404, "Not found.");
      return;
    }

    if (url.searchParams.get("state") !== options.expectedState) {
      sendHtml(
        response,
        400,
        "Sign-in was rejected. Return to the terminal and retry.",
      );
      return;
    }

    const code = url.searchParams.get("code");
    if (!code) {
      sendHtml(response, 400, "Sign-in did not return an authorization code.");
      settle(
        new CliError("OAuth sign-in did not return an authorization code."),
      );
      return;
    }

    sendHtml(
      response,
      200,
      "Authorization received. Return to the terminal to finish signing in.",
    );
    settle({ code });
  });

  const timeout = setTimeout(
    () =>
      settle(
        new CliError(
          "OAuth sign-in timed out. Run `understudy login` to retry.",
        ),
      ),
    options.timeoutMs ?? oauthDefaults.timeoutMs,
  );
  timeout.unref();

  try {
    await listen(server, options.port ?? oauthDefaults.loopbackPort);
  } catch {
    clearTimeout(timeout);
    server.close();
    throw new CliError(
      `Could not start the OAuth callback on ${oauthDefaults.loopbackHost}:${
        options.port ?? oauthDefaults.loopbackPort
      }. Close the process using that port and retry.`,
    );
  }

  const address = server.address() as AddressInfo;
  const redirectUri = `http://${oauthDefaults.loopbackHost}:${address.port}/callback`;

  return {
    redirectUri,
    waitForCallback: () => callback,
    close: () => closeServer(server, timeout),
  };
}

export async function exchangeAuthorizationCode(
  options: ExchangeCodeOptions,
  fetchImplementation: typeof fetch = fetch,
): Promise<{ accessToken: string; refreshToken?: string }> {
  return exchangeToken(
    options.tokenUrl,
    {
      grant_type: "authorization_code",
      client_id: options.clientId,
      code: options.code,
      code_verifier: options.codeVerifier,
      redirect_uri: options.redirectUri,
    },
    fetchImplementation,
  );
}

export async function refreshAccessToken(
  options: RefreshTokenOptions,
  fetchImplementation: typeof fetch = fetch,
): Promise<{ accessToken: string; refreshToken?: string }> {
  return exchangeToken(
    options.tokenUrl,
    {
      grant_type: "refresh_token",
      client_id: options.clientId,
      refresh_token: options.refreshToken,
    },
    fetchImplementation,
  );
}

async function exchangeToken(
  tokenUrl: string,
  body: TokenRequestBody,
  fetchImplementation: typeof fetch,
): Promise<{ accessToken: string; refreshToken?: string }> {
  let response: Response;
  try {
    response = await fetchImplementation(tokenUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new CliError("Could not reach the sign-in service. Try again shortly.");
  }

  if (!response.ok) {
    throw new CliError(
      `The sign-in service rejected the token request (${response.status}). Retry login.`,
    );
  }

  try {
    const parsed = tokenResponseSchema.parse(await response.json());
    return {
      accessToken: parsed.access_token,
      ...(parsed.refresh_token ? { refreshToken: parsed.refresh_token } : {}),
    };
  } catch {
    throw new CliError(
      "The sign-in service returned an invalid response. Retry login.",
    );
  }
}

function sendHtml(
  response: import("node:http").ServerResponse,
  status: number,
  message: string,
): void {
  const body = `<!doctype html><html><body><p>${message}</p></body></html>`;
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function listen(server: Server, port: number): Promise<void> {
  const listening = once(server, "listening").then(() => undefined);
  server.listen(port, oauthDefaults.loopbackHost);
  return listening;
}

function closeServer(server: Server, timeout: NodeJS.Timeout): Promise<void> {
  clearTimeout(timeout);
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
