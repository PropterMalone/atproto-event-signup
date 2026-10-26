import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeOAuthClient, OAuthResolverError } from "@atproto/oauth-client-node";
import { afterEach, expect, it, vi } from "vitest";
import { createOAuth } from "./oauth.js";
import { Store } from "./store.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const run of cleanup.splice(0)) await run();
});
it("uses the real SDK's wrapped missing-handle error without any network calls", async () => {
	const network = vi.fn(() => {
		throw Error("Unexpected network call");
	});
	const client = new NodeOAuthClient({
		clientMetadata: {
			client_id:
				"http://localhost?redirect_uri=http%3A%2F%2F127.0.0.1%3A3000%2Foauth%2Fcallback&scope=atproto",
			redirect_uris: ["http://127.0.0.1:3000/oauth/callback"],
			application_type: "web",
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			scope: "atproto",
			dpop_bound_access_tokens: true,
			token_endpoint_auth_method: "none",
		},
		fetch: network,
		handleResolver: { resolve: async () => null },
		stateStore: { get: async () => undefined, set: async () => {}, del: async () => {} },
		sessionStore: { get: async () => undefined, set: async () => {}, del: async () => {} },
	});
	await expect(client.authorize("synthetic.test", { scope: "atproto" })).rejects.toBeInstanceOf(
		OAuthResolverError,
	);
	await expect(client.authorize("synthetic.test", { scope: "atproto" })).rejects.toMatchObject({
		cause: {
			name: "IdentityResolverError",
			message: 'Handle "synthetic.test" does not resolve to a DID',
		},
	});
	expect(network).not.toHaveBeenCalled();
});
it("limits login and callback together to four operations without a pending queue or slot leaks", async () => {
	const dir = await mkdtemp(join(tmpdir(), "dcbsky-limit-"));
	const db = new Store(join(dir, "app.sqlite"));
	cleanup.push(async () => {
		db.close();
		await rm(dir, { recursive: true });
	});
	const active: Array<() => void> = [];
	const authorize = vi.spyOn(NodeOAuthClient.prototype, "authorize").mockImplementation(
		() =>
			new Promise<URL>((resolve) => {
				active.push(() => resolve(new URL("https://example.com/authorize")));
			}),
	);
	const callback = vi
		.spyOn(NodeOAuthClient.prototype, "callback")
		.mockRejectedValue(new Error("SDK callback rejected"));
	const oauth = await createOAuth("http://127.0.0.1:3000", dir, db);
	const pending = Array.from({ length: 4 }, () => oauth.authorize("example.com", "binding"));
	const burst = Array.from({ length: 20 }, (_, i) =>
		i % 2 ? oauth.authorize("example.com", "binding") : oauth.complete(new URLSearchParams()),
	);
	const results = Promise.allSettled(burst);
	expect(authorize).toHaveBeenCalledTimes(4);
	const rejected = await results;
	expect(callback).not.toHaveBeenCalled();
	expect(
		rejected.every(
			(result) =>
				result.status === "rejected" &&
				result.reason.message === "OAuth is busy; try again shortly",
		),
	).toBe(true);
	active.shift()?.();
	await pending[0];
	const replacement = oauth.authorize("example.com", "binding");
	await expect(oauth.complete(new URLSearchParams())).rejects.toThrow("OAuth is busy");
	expect(authorize).toHaveBeenCalledTimes(5);
	for (const resolve of active.splice(0)) resolve();
	await Promise.all([...pending, replacement]);
	for (let i = 0; i < 8; i++) {
		await expect(oauth.complete(new URLSearchParams())).rejects.toThrow("SDK callback rejected");
	}
	expect(callback).toHaveBeenCalledTimes(8);
});
it("constructs the real official SDK in local and confidential HTTPS mode, retains keys and publishes no private fields", async () => {
	const dir = await mkdtemp(join(tmpdir(), "dcbsky-sdk-"));
	const db = new Store(join(dir, "app.sqlite"));
	cleanup.push(async () => {
		db.close();
		await rm(dir, { recursive: true });
	});
	const local = await createOAuth("http://127.0.0.1:3000", dir, db);
	expect(local.metadata).toMatchObject({ scope: "atproto", token_endpoint_auth_method: "none" });
	const before = await readFile(join(dir, "oauth-key.json"), "utf8");
	const production = await createOAuth("https://dcbsky.com", dir, db);
	expect(production.metadata).toMatchObject({
		client_id: "https://dcbsky.com/client-metadata.json",
		scope: "atproto",
		token_endpoint_auth_method: "private_key_jwt",
	});
	expect(production.jwks).not.toHaveProperty("keys.0.d");
	expect(production.jwks).toHaveProperty("keys.0.x");
	expect(await readFile(join(dir, "oauth-key.json"), "utf8")).toBe(before);
	await writeFile(join(dir, "oauth-key.json"), "corrupt");
	await expect(createOAuth("https://dcbsky.com", dir, db)).rejects.toThrow();
	expect(await readFile(join(dir, "oauth-key.json"), "utf8")).toBe("corrupt");
});
