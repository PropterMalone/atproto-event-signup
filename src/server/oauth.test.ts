import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeOAuthClient, OAuthResolverError } from "@atproto/oauth-client-node";
import { afterEach, expect, it, vi } from "vitest";
import { createOAuth } from "./oauth.js";
import { publicRsvp, RSVP_SCOPE } from "./publication.js";
import { Store } from "./store.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const run of cleanup.splice(0)) await run();
});
it("requests narrow scope only explicitly and safely uses SDK sessions for owned compare-and-swap writes", async () => {
	const dir = await mkdtemp(join(tmpdir(), "rsvp-sdk-"));
	const db = new Store(join(dir, "test.sqlite"));
	cleanup.push(async () => {
		db.close();
		await rm(dir, { recursive: true });
	});
	const oauth = await createOAuth("http://127.0.0.1:3000", dir, db, true);
	const authorize = vi
		.spyOn(NodeOAuthClient.prototype, "authorize")
		.mockResolvedValue(new URL("https://auth.test"));
	await oauth.authorize("alice.test", "binding");
	expect(authorize).toHaveBeenLastCalledWith(
		"alice.test",
		expect.objectContaining({ scope: "atproto" }),
	);
	await oauth.authorize("alice.test", "binding", true);
	expect(authorize).toHaveBeenLastCalledWith(
		"alice.test",
		expect.objectContaining({ scope: `atproto ${RSVP_SCOPE}` }),
	);
	const did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
	const event = {
		uri: `at://${did}/community.lexicon.calendar.event/3mabc23456722`,
		cid: "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	};
	const record = publicRsvp(event, "coming");
	db.setPublication(did, { rkey: "3mabc23456722", event, status: "uncertain", records: [record] });
	const fetchHandler = vi
		.fn()
		.mockResolvedValueOnce(Response.json({ error: "RecordNotFound" }, { status: 400 }))
		.mockResolvedValueOnce(Response.json({ uri: "at://record" }));
	const restore = vi.spyOn(NodeOAuthClient.prototype, "restore").mockResolvedValue({
		did,
		getTokenInfo: async () => ({ scope: `atproto ${RSVP_SCOPE}` }),
		fetchHandler,
	} as never);
	expect(await oauth.rsvp?.(did, "3mabc23456722", record)).toEqual({
		ok: false,
		reason: "reauthorize",
	});
	await db.oauthStore("tokens", 86400000).set(did, {});
	expect(await oauth.rsvp?.(did, "3mabc23456722", record)).toEqual({ ok: true });
	expect(JSON.parse(fetchHandler.mock.calls[1]?.[1].body)).toEqual({
		repo: did,
		collection: "community.lexicon.calendar.rsvp",
		rkey: "3mabc23456722",
		record,
		validate: false,
		swapRecord: null,
	});
	fetchHandler
		.mockReset()
		.mockResolvedValueOnce(
			Response.json({ cid: "othercid", value: { ...record, status: "someone-elses-status" } }),
		);
	expect(await oauth.rsvp?.(did, "3mabc23456722", null)).toEqual({ ok: false, reason: "conflict" });
	expect(fetchHandler).toHaveBeenCalledTimes(1);
	fetchHandler
		.mockReset()
		.mockResolvedValueOnce(Response.json({ cid: "ownedcid", value: record }))
		.mockResolvedValueOnce(Response.json({}));
	expect(await oauth.rsvp?.(did, "3mabc23456722", null)).toEqual({ ok: true });
	expect(JSON.parse(fetchHandler.mock.calls[1]?.[1].body)).toMatchObject({
		repo: did,
		swapRecord: "ownedcid",
	});
	fetchHandler.mockReset().mockImplementationOnce(async () => {
		db.cancel(did, "0");
		return Response.json({ cid: "ownedcid", value: record });
	});
	expect(await oauth.rsvp?.(did, "3mabc23456722", record)).toEqual({
		ok: false,
		reason: "conflict",
	});
	expect(fetchHandler).toHaveBeenCalledTimes(1);
	expect(restore).toHaveBeenCalledWith(did);
});
it.each([
	"extra",
	"array",
	"null",
] as const)("does not mutate foreign RSVP content with a %s subject", async (kind) => {
	const dir = await mkdtemp(join(tmpdir(), "rsvp-subject-"));
	const db = new Store(join(dir, "test.sqlite"));
	cleanup.push(async () => {
		db.close();
		await rm(dir, { recursive: true });
	});
	const did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
	const event = {
		uri: `at://${did}/community.lexicon.calendar.event/3mabc23456722`,
		cid: "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	};
	const record = publicRsvp(event, "coming");
	db.setPublication(did, { rkey: "3mabc23456722", event, status: "uncertain", records: [record] });
	await db.oauthStore("tokens", 86400000).set(did, {});
	const subject =
		kind === "extra"
			? { ...event, annotation: "belongs to another client" }
			: kind === "array"
				? []
				: null;
	const fetchHandler = vi.fn(async (_path: string) =>
		Response.json({ cid: "foreigncid", value: { ...record, subject } }),
	);
	vi.spyOn(NodeOAuthClient.prototype, "restore").mockResolvedValue({
		did,
		getTokenInfo: async () => ({ scope: `atproto ${RSVP_SCOPE}` }),
		fetchHandler,
	} as never);
	const oauth = await createOAuth("http://127.0.0.1:3000", dir, db, true);
	expect(await oauth.rsvp?.(did, "3mabc23456722", null)).toEqual({ ok: false, reason: "conflict" });
	expect(fetchHandler).toHaveBeenCalledTimes(1);
	expect(fetchHandler.mock.calls[0]?.[0]).toContain("/xrpc/com.atproto.repo.getRecord?");
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
