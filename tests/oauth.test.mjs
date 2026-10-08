import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import {
  buildAuthorizeUrl,
  createLoopbackReceiver,
  createPkce,
  deriveCodeChallenge,
  exchangeAuthorizationCode,
  refreshAccessToken,
} from "../dist/auth/oauth.js";

test("PKCE challenge derivation follows RFC 7636", () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  assert.equal(
    deriveCodeChallenge(verifier),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

test("generated PKCE values form a valid pair", () => {
  const first = createPkce();
  const second = createPkce();

  assert.ok(first.verifier.length >= 43 && first.verifier.length <= 128);
  assert.equal(deriveCodeChallenge(first.verifier), first.challenge);
  assert.notEqual(first.verifier, second.verifier);
});

test("authorization URL contains the public-client PKCE contract", () => {
  const url = new URL(
    buildAuthorizeUrl({
      authorizeUrl: "https://auth.example.test/authorize",
      clientId: "synthetic-client",
      redirectUri: "http://127.0.0.1:43123/callback",
      codeChallenge: "synthetic-challenge",
      state: "synthetic-state",
    }),
  );

  assert.equal(url.origin + url.pathname, "https://auth.example.test/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "synthetic-client");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "synthetic-state");
  assert.equal(url.searchParams.has("client_secret"), false);
});

test("loopback receiver accepts one matching callback", async () => {
  const receiver = await createLoopbackReceiver({
    expectedState: "matching-state",
    port: 0,
    timeoutMs: 1_000,
  });

  try {
    const callback = receiver.waitForCallback();
    const response = await fetch(
      `${receiver.redirectUri}?code=synthetic-code&state=matching-state`,
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await callback, { code: "synthetic-code" });
  } finally {
    await receiver.close();
  }
});

test("loopback receiver ignores invalid states before a matching callback", async () => {
  const receiver = await createLoopbackReceiver({
    expectedState: "expected-state",
    port: 0,
    timeoutMs: 1_000,
  });

  try {
    const callback = receiver.waitForCallback();
    const missingStateResponse = await fetch(
      `${receiver.redirectUri}?code=synthetic-code`,
    );
    const mismatchedStateResponse = await fetch(
      `${receiver.redirectUri}?code=synthetic-code&state=other-state`,
    );
    const matchingStateResponse = await fetch(
      `${receiver.redirectUri}?code=synthetic-code&state=expected-state`,
    );

    assert.equal(missingStateResponse.status, 400);
    assert.equal(mismatchedStateResponse.status, 400);
    assert.equal(matchingStateResponse.status, 200);
    assert.deepEqual(await callback, { code: "synthetic-code" });
  } finally {
    await receiver.close();
  }
});

test("loopback receiver rejects a callback without a code", async () => {
  const receiver = await createLoopbackReceiver({
    expectedState: "matching-state",
    port: 0,
    timeoutMs: 1_000,
  });

  try {
    const callback = assert.rejects(
      receiver.waitForCallback(),
      /did not return an authorization code/i,
    );
    const response = await fetch(
      `${receiver.redirectUri}?state=matching-state`,
    );

    assert.equal(response.status, 400);
    await callback;
  } finally {
    await receiver.close();
  }
});

test("loopback receiver times out with an actionable error", async () => {
  const receiver = await createLoopbackReceiver({
    expectedState: "matching-state",
    port: 0,
    timeoutMs: 10,
  });

  try {
    await assert.rejects(receiver.waitForCallback(), /timed out.*login/i);
  } finally {
    await receiver.close();
  }
});

test("loopback receiver reports an occupied port", async () => {
  const blocker = createServer();
  blocker.listen(0, "127.0.0.1");
  await once(blocker, "listening");
  const address = blocker.address();
  assert.ok(address && typeof address !== "string");

  try {
    await assert.rejects(
      createLoopbackReceiver({
        expectedState: "matching-state",
        port: address.port,
        timeoutMs: 1_000,
      }),
      /could not start.*close the process/i,
    );
  } finally {
    await new Promise((resolve, reject) =>
      blocker.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("authorization code exchange sends no client secret", async () => {
  const accessToken = ["synthetic", "access"].join("-");
  const refreshToken = ["synthetic", "refresh"].join("-");
  let receivedBody;
  let receivedHeaders;

  const result = await exchangeAuthorizationCode(
    {
      tokenUrl: "https://auth.example.test/authenticate",
      clientId: "synthetic-client",
      code: "synthetic-code",
      codeVerifier: "synthetic-verifier",
      redirectUri: "http://127.0.0.1:43123/callback",
    },
    async (_input, init) => {
      receivedBody = JSON.parse(init.body);
      receivedHeaders = new Headers(init.headers);
      return Response.json({
        access_token: accessToken,
        refresh_token: refreshToken,
      });
    },
  );

  assert.deepEqual(result, { accessToken, refreshToken });
  assert.equal(receivedHeaders.get("content-type"), "application/json");
  assert.deepEqual(receivedBody, {
    grant_type: "authorization_code",
    client_id: "synthetic-client",
    code: "synthetic-code",
    code_verifier: "synthetic-verifier",
    redirect_uri: "http://127.0.0.1:43123/callback",
  });
});

test("token exchange failures do not echo the response body", async () => {
  const responseBody = "sensitive upstream detail";

  await assert.rejects(
    exchangeAuthorizationCode(
      {
        tokenUrl: "https://auth.example.test/authenticate",
        clientId: "synthetic-client",
        code: "synthetic-code",
        codeVerifier: "synthetic-verifier",
        redirectUri: "http://127.0.0.1:43123/callback",
      },
      async () => new Response(responseBody, { status: 400 }),
    ),
    (error) => {
      assert.doesNotMatch(error.message, new RegExp(responseBody));
      return true;
    },
  );
});

test("token exchange reports transport failures without sensitive input", async () => {
  const sensitiveCode = "synthetic-code-that-must-not-appear";

  await assert.rejects(
    exchangeAuthorizationCode(
      {
        tokenUrl: "https://auth.example.test/authenticate",
        clientId: "synthetic-client",
        code: sensitiveCode,
        codeVerifier: "synthetic-verifier",
        redirectUri: "http://127.0.0.1:43123/callback",
      },
      async () => {
        throw new Error("network failed");
      },
    ),
    (error) => {
      assert.match(error.message, /could not reach the sign-in service/i);
      assert.doesNotMatch(error.message, new RegExp(sensitiveCode));
      return true;
    },
  );
});

test("token exchange rejects an invalid successful response", async () => {
  await assert.rejects(
    exchangeAuthorizationCode(
      {
        tokenUrl: "https://auth.example.test/authenticate",
        clientId: "synthetic-client",
        code: "synthetic-code",
        codeVerifier: "synthetic-verifier",
        redirectUri: "http://127.0.0.1:43123/callback",
      },
      async () => Response.json({ refresh_token: "synthetic-refresh" }),
    ),
    /invalid response/i,
  );
});

test("refresh exchange uses the public-client refresh grant", async () => {
  const accessToken = ["synthetic", "access", "new"].join("-");
  const refreshToken = ["synthetic", "refresh", "old"].join("-");
  let receivedBody;
  let receivedHeaders;

  const result = await refreshAccessToken(
    {
      tokenUrl: "https://auth.example.test/authenticate",
      clientId: "synthetic-client",
      refreshToken,
    },
    async (_input, init) => {
      receivedBody = JSON.parse(init.body);
      receivedHeaders = new Headers(init.headers);
      return Response.json({ access_token: accessToken });
    },
  );

  assert.deepEqual(result, { accessToken });
  assert.equal(receivedHeaders.get("content-type"), "application/json");
  assert.deepEqual(receivedBody, {
    grant_type: "refresh_token",
    client_id: "synthetic-client",
    refresh_token: refreshToken,
  });
});
