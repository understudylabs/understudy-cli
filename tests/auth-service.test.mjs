import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import {
  accessTokenNeedsRefresh,
  getOAuthOrganizationId,
  getValidAccessToken,
  loginWithOAuth,
} from "../dist/auth/service.js";

function syntheticJwt(expiresAtSeconds, claims = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ exp: expiresAtSeconds, ...claims }),
  ).toString("base64url");
  return [header, payload, "synthetic-signature"].join(".");
}

function createStore(credentials) {
  const writes = [];
  return {
    store: {
      read: async () => credentials,
      write: async (next) => writes.push(next),
      clear: async () => undefined,
    },
    writes,
  };
}

test("access tokens refresh shortly before expiry", () => {
  const now = 2_000_000_000_000;

  assert.equal(
    accessTokenNeedsRefresh(syntheticJwt(now / 1_000 + 3_600), now),
    false,
  );
  assert.equal(
    accessTokenNeedsRefresh(syntheticJwt(now / 1_000 + 10), now),
    true,
  );
  assert.equal(accessTokenNeedsRefresh("not-a-jwt", now), true);
});

test("OAuth organization is read from the current access token", () => {
  const accessToken = syntheticJwt(Date.now() / 1_000 + 3_600, {
    org_id: "synthetic-organization",
  });

  assert.equal(
    getOAuthOrganizationId(accessToken),
    "synthetic-organization",
  );
});

test("OAuth organization fails safely when the token has no organization", () => {
  const accessToken = syntheticJwt(Date.now() / 1_000 + 3_600);

  assert.throws(
    () => getOAuthOrganizationId(accessToken),
    /sign in again and choose an organization/i,
  );
});

test("a current access token is returned without a network request", async () => {
  const accessToken = syntheticJwt(Date.now() / 1_000 + 3_600);
  const harness = createStore({
    version: 1,
    method: "oauth",
    accessToken,
    refreshToken: ["synthetic", "refresh"].join("-"),
  });

  const result = await getValidAccessToken({
    store: harness.store,
    fetchImplementation: async () => {
      throw new Error("network should not be called");
    },
  });

  assert.equal(result, accessToken);
  assert.deepEqual(harness.writes, []);
});

test("an expiring access token is refreshed and the rotation is stored", async () => {
  const oldAccessToken = syntheticJwt(Date.now() / 1_000 - 60);
  const newAccessToken = syntheticJwt(Date.now() / 1_000 + 3_600);
  const oldRefreshToken = ["synthetic", "refresh", "old"].join("-");
  const newRefreshToken = ["synthetic", "refresh", "new"].join("-");
  const harness = createStore({
    version: 1,
    method: "oauth",
    accessToken: oldAccessToken,
    refreshToken: oldRefreshToken,
  });
  let body;

  const result = await getValidAccessToken({
    store: harness.store,
    fetchImplementation: async (_input, init) => {
      body = JSON.parse(init.body);
      return Response.json({
        access_token: newAccessToken,
        refresh_token: newRefreshToken,
      });
    },
  });

  assert.equal(result, newAccessToken);
  assert.equal(body.grant_type, "refresh_token");
  assert.equal(body.refresh_token, oldRefreshToken);
  assert.equal("client_secret" in body, false);
  assert.deepEqual(harness.writes, [
    {
      version: 1,
      method: "oauth",
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    },
  ]);
});

test("an expired session without a refresh token requires login", async () => {
  const harness = createStore({
    version: 1,
    method: "oauth",
    accessToken: syntheticJwt(Date.now() / 1_000 - 60),
  });

  await assert.rejects(
    getValidAccessToken({ store: harness.store }),
    /Run `understudy login`/,
  );
});

for (const browserOpened of [true, false]) {
  test(
    `OAuth login exchanges the callback and stores the session when browser open is ${browserOpened}`,
    async () => {
      const accessToken = syntheticJwt(Date.now() / 1_000 + 3_600);
      const refreshToken = "synthetic-refresh";
      const callbackPort = await reserveAvailablePort();
      const harness = createStore(null);
      const output = [];
      let tokenRequestBody;

      await loginWithOAuth({
        store: harness.store,
        loopbackPort: callbackPort,
        output: (message) => output.push(message),
        openBrowser: async (authorizationUrl) => {
          const authorize = new URL(authorizationUrl);
          const redirectUri = authorize.searchParams.get("redirect_uri");
          const state = authorize.searchParams.get("state");
          assert.ok(redirectUri);
          assert.ok(state);

          const callbackResponse = await fetch(
            `${redirectUri}?code=synthetic-code&state=${state}`,
          );
          assert.equal(callbackResponse.status, 200);
          assert.match(await callbackResponse.text(), /authorization received/i);
          return browserOpened;
        },
        fetchImplementation: async (_input, init) => {
          tokenRequestBody = JSON.parse(init.body);
          return Response.json({
            access_token: accessToken,
            refresh_token: refreshToken,
          });
        },
      });

      assert.deepEqual(harness.writes, [
        {
          version: 1,
          method: "oauth",
          accessToken,
          refreshToken,
        },
      ]);
      assert.equal(tokenRequestBody.grant_type, "authorization_code");
      assert.equal("client_secret" in tokenRequestBody, false);
      assert.match(
        output[0],
        browserOpened ? /opening your browser/i : /open this URL/i,
      );
      assert.match(output[0], /https:\/\/api\.workos\.com\/user_management\/authorize/);
      assert.match(output[1], /waiting for sign-in/i);

      const afterLogin = createServer();
      try {
        afterLogin.listen(callbackPort, "127.0.0.1");
        await once(afterLogin, "listening");
      } finally {
        await closeServer(afterLogin);
      }
    },
  );
}

async function listenOnAvailablePort(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function reserveAvailablePort() {
  const server = createServer();
  const port = await listenOnAvailablePort(server);
  await closeServer(server);
  return port;
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
