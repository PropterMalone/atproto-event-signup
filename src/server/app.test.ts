import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAuthResolverError } from "@atproto/oauth-client-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buttonApproval, defaultButtonLabel } from "../shared/button.js";
import { type AppConfig, createApp } from "./app.js";
import { readAdminDids } from "./config.js";
import type { OAuthBoundary } from "./oauth.js";
import { Store } from "./store.js";

const admin = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
let db: Store;
let directory: string;
let server: Server;
let origin: string;
let config: AppConfig;
let binding = "";
let identity = "did:plc:alice";
let avatar = "data:image/png;base64,AA==";
const oauth: OAuthBoundary = {
	metadata: { scope: "atproto" },
	jwks: { keys: [] },
	authorize: async (_handle, value) => {
		binding = value;
		return new URL("https://auth.test/authorize");
	},
	complete: async (params) => {
		if (params.has("error")) throw new Error("private credentials");
		return {
			profile: { did: identity, handle: "alice.test", avatar },
			binding,
		};
	},
};
beforeEach(async () => {
	directory = mkdtempSync(join(tmpdir(), "dcbsky-http-"));
	db = new Store(join(directory, "test.sqlite"));
	config = {
		origin: "",
		adminDids: new Set([admin]),
		responseCutoff: null,
		buttonCutoff: null,
		artworkDeleteAt: null,
		printFaceDiameter: 58,
		printCutDiameter: 70,
		publicDirectory: directory,
	};
	server = createServer(createApp(db, oauth, config));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw Error("no port");
	origin = `http://127.0.0.1:${address.port}`;
	config.origin = origin;
	identity = "did:plc:alice";
	avatar = "data:image/png;base64,AA==";
});
afterEach(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	db.close();
	rmSync(directory, { recursive: true });
});
async function request(
	path: string,
	method = "GET",
	body?: unknown,
	cookie = "",
	csrf = "",
	sentOrigin = origin,
) {
	if (path === "/api/response" && ["PUT", "DELETE"].includes(method) && cookie) {
		const current = await state(cookie);
		const fields = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
		const source =
			fields.artworkSource ??
			(fields.replaceArtwork
				? current.preview.profile
				: (current.preview.saved ?? current.preview.profile));
		const label =
			fields.label ??
			current.response?.artwork?.label ??
			defaultButtonLabel(current.profile.handle);
		body = {
			expectedVersion: current.responseVersion,
			artworkSource: source,
			artworkApproval: buttonApproval(
				source,
				fields.button as string,
				label,
				(fields.position ?? current.response?.artwork?.position ?? "bottom") as "top" | "bottom",
				(fields.color ?? current.response?.artwork?.color ?? "white") as "white" | "black",
			),
			...fields,
		};
	}
	return fetch(origin + path, {
		method,
		redirect: "manual",
		headers: {
			cookie,
			origin: sentOrigin,
			"content-type": "application/json",
			"x-csrf-token": csrf,
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}
async function login(did = "did:plc:alice") {
	identity = did;
	const start = await request("/oauth/login", "POST", { handle: "alice.test" });
	expect(start.status).toBe(303);
	const bindCookie = start.headers.get("set-cookie")?.split(";")[0] ?? "";
	const callback = await request("/oauth/callback?code=valid", "GET", undefined, bindCookie);
	expect(callback.status).toBe(303);
	return callback.headers.get("set-cookie")?.split(";")[0] ?? "";
}
async function state(cookie: string) {
	return (await request("/api/me", "GET", undefined, cookie)).json();
}
describe("HTTP identity and privacy", () => {
	it("grants no operator privileges when ADMIN_DIDS is unset", async () => {
		config.adminDids = readAdminDids({});
		const cookie = await login(admin);
		expect((await state(cookie)).admin).toBe(false);
		for (const path of ["/api/admin", "/api/admin/print", "/api/admin/futurecontacts"])
			expect((await request(path, "GET", undefined, cookie)).status).toBe(403);
	});
	it("serves a signed-out social preview with security headers and no session", async () => {
		config.publicDirectory = join(process.cwd(), "public");
		const image = await request("/social-preview.png");
		expect(image.status).toBe(200);
		expect(image.headers.get("content-type")).toBe("image/png");
		expect(image.headers.get("set-cookie")).toBeNull();
		expect(image.headers.get("x-content-type-options")).toBe("nosniff");
		expect(image.headers.get("content-security-policy")).toContain("img-src 'self' data:");
		const bytes = Buffer.from(await image.arrayBuffer());
		expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
		expect(bytes.readUInt32BE(16)).toBe(1200);
		expect(bytes.readUInt32BE(20)).toBe(630);
	});
	it.each([
		"/social-preview.svg",
		"/social-preview.png/../favicon.ico",
		"/social-preview.png%2f..%2f.env",
		"/%2e%2e%2f.env",
		"/public/social-preview.png",
		"/scripts/copy-public.mjs",
		"/.env",
		"/app.sqlite",
	])("does not expose files through preview-related or private paths: %s", async (path) => {
		config.publicDirectory = join(process.cwd(), "public");
		expect((await request(path)).status).toBe(404);
	});
	it.each([
		["alice", "alice.bsky.social"],
		[" @Alice ", "alice.bsky.social"],
		["@alice.bsky.social", "alice.bsky.social"],
		["friend.custom.example", "friend.custom.example"],
	])("normalizes %s before the OAuth boundary", async (input, expected) => {
		const spy = vi.spyOn(oauth, "authorize");
		try {
			expect((await request("/oauth/login", "POST", { handle: input })).status).toBe(303);
			expect(spy).toHaveBeenCalledWith(expected, expect.any(String));
		} finally {
			spy.mockRestore();
		}
	});
	it("returns a typo suggestion without starting OAuth", async () => {
		const spy = vi.spyOn(oauth, "authorize");
		try {
			const result = await request("/oauth/login", "POST", { handle: "alice.bluesky.social" });
			expect(result.status).toBe(400);
			expect(await result.json()).toEqual({
				error:
					"Did you mean alice.bsky.social? Bluesky usernames end in .bsky.social, not .bluesky.social.",
			});
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});
	it("distinguishes missing handles from upstream failures without exposing exception details", async () => {
		const spy = vi.spyOn(oauth, "authorize");
		try {
			const missing = new Error('Handle "alice.test" does not resolve to a DID');
			missing.name = "IdentityResolverError";
			spy.mockRejectedValueOnce(
				new OAuthResolverError("Failed to resolve identity: alice.test", { cause: missing }),
			);
			const result = await request("/oauth/login", "POST", { handle: "alice.test" });
			expect(result.status).toBe(400);
			expect(await result.json()).toEqual({
				error: "Couldn’t find that Bluesky handle. Check the spelling and try again.",
			});
			for (const error of [
				new Error("private-token-state"),
				Object.assign(new Error("Unexpected provider response"), { name: "HandleResolverError" }),
				Object.assign(new Error("Resolver unavailable"), { name: "IdentityResolverError" }),
			]) {
				spy.mockRejectedValueOnce(error);
				const unavailable = await request("/oauth/login", "POST", { handle: "alice.test" });
				expect(unavailable.status).toBe(503);
				expect(await unavailable.json()).toEqual({
					error: "Service temporarily unavailable. Try again.",
				});
			}
		} finally {
			spy.mockRestore();
		}
	});
	it("binds saved text color to approval, rejects stale or invalid edits, and enforces cutoff", async () => {
		const cookie = await login();
		const me = await state(cookie);
		const input = {
			attendance: "coming",
			button: "handle",
			label: "Friend",
			position: "top",
			color: "black",
		};
		expect((await request("/api/response", "PUT", input, cookie, me.csrf)).status).toBe(200);
		const saved = await state(cookie);
		expect(saved.response.artwork).toMatchObject({ color: "black", rendererVersion: 3 });
		for (const color of [null, "red", "BLACK", ["white"]])
			expect(
				(await request("/api/response", "PUT", { ...input, color }, cookie, me.csrf)).status,
			).toBe(400);
		expect(
			(
				await request(
					"/api/response",
					"PUT",
					{
						...input,
						color: "white",
						artworkApproval: buttonApproval(
							saved.preview.saved,
							"handle",
							"Friend",
							"top",
							"black",
						),
					},
					cookie,
					me.csrf,
				)
			).status,
		).toBe(409);
		expect(
			(
				await request(
					"/api/response",
					"PUT",
					{
						...input,
						artworkApproval: JSON.stringify([2, saved.preview.saved, "handle", "Friend", "top"]),
					},
					cookie,
					me.csrf,
				)
			).status,
		).toBe(409);
		expect(
			(
				await request(
					"/api/response",
					"PUT",
					{ ...input, color: "white", expectedVersion: "stale" },
					cookie,
					me.csrf,
				)
			).status,
		).toBe(409);
		const operator = await login(admin);
		const html = await (await request("/api/admin/print", "GET", undefined, operator)).text();
		expect(html).toContain('fill="black" stroke="white" stroke-width="0.3"');
		expect(html).toContain("A 24.5 24.5 0 0 1");
		config.buttonCutoff = 1;
		expect(
			(await request("/api/response", "PUT", { ...input, color: "white" }, cookie, me.csrf)).status,
		).toBe(409);
		expect(
			(
				await request(
					"/api/response",
					"PUT",
					{ attendance: "maybe", button: "handle", futureMeetups: true },
					cookie,
					me.csrf,
				)
			).status,
		).toBe(200);
		expect((await state(cookie)).response.artwork).toEqual(saved.response.artwork);
	});
	it("binds printed label approval, rejects invalid names and blocks label edits after cutoff", async () => {
		const cookie = await login();
		const me = await state(cookie);
		const input = { attendance: "coming", button: "handle", label: "@Friend", futureMeetups: true };
		expect(
			(await request("/api/response", "PUT", { ...input, artworkApproval: null }, cookie, me.csrf))
				.status,
		).toBe(409);
		expect(
			(await request("/api/response", "PUT", { ...input, label: "bad\nname" }, cookie, me.csrf))
				.status,
		).toBe(400);
		expect((await request("/api/response", "PUT", input, cookie, me.csrf)).status).toBe(200);
		const approved = await state(cookie);
		expect(approved.response.artwork).toMatchObject({
			label: "@Friend",
			rendererVersion: 3,
			position: "bottom",
			color: "white",
		});
		expect(
			(
				await request(
					"/api/response",
					"PUT",
					{
						...input,
						label: "Other",
						artworkApproval: buttonApproval(approved.preview.saved, "handle", "@Friend"),
					},
					cookie,
					me.csrf,
				)
			).status,
		).toBe(409);
		config.buttonCutoff = 1;
		expect(
			(await request("/api/response", "PUT", { ...input, label: "Other" }, cookie, me.csrf)).status,
		).toBe(409);
		expect(
			(
				await request(
					"/api/response",
					"PUT",
					{ ...input, attendance: "maybe", futureMeetups: false },
					cookie,
					me.csrf,
				)
			).status,
		).toBe(200);
		expect((await state(cookie)).response.artwork).toEqual(approved.response.artwork);
		expect((await state(cookie)).futureMeetups).toBe(false);
		expect(
			(
				await request(
					"/api/response",
					"PUT",
					{ attendance: "cant", button: null, futureMeetups: true },
					cookie,
					me.csrf,
				)
			).status,
		).toBe(200);
		expect((await state(cookie)).response.artwork).toBeNull();
		expect((await state(cookie)).futureMeetups).toBe(true);
	});
	it("binds position approval, rejects malformed edits and preserves approved position past cutoff", async () => {
		const cookie = await login();
		const me = await state(cookie);
		const input = { attendance: "coming", button: "handle", label: "Friend", position: "top" };
		expect((await request("/api/response", "PUT", input, cookie, me.csrf)).status).toBe(200);
		const approved = await state(cookie);
		expect(approved.response.artwork.position).toBe("top");
		const body = {
			...input,
			position: "bottom",
			artworkApproval: buttonApproval(approved.preview.saved, "handle", "Friend", "top"),
		};
		expect((await request("/api/response", "PUT", body, cookie, me.csrf)).status).toBe(409);
		expect(
			(await request("/api/response", "PUT", { ...input, position: "middle" }, cookie, me.csrf))
				.status,
		).toBe(400);
		expect(
			(
				await request(
					"/api/response",
					"PUT",
					{
						...input,
						artworkApproval: JSON.stringify([1, approved.preview.saved, "handle", "Friend"]),
					},
					cookie,
					me.csrf,
				)
			).status,
		).toBe(409);
		expect(
			(
				await request(
					"/api/response",
					"PUT",
					{ ...input, expectedVersion: "stale" },
					cookie,
					me.csrf,
				)
			).status,
		).toBe(409);
		config.buttonCutoff = 1;
		expect(
			(await request("/api/response", "PUT", { ...input, position: "bottom" }, cookie, me.csrf))
				.status,
		).toBe(409);
		expect(
			(
				await request(
					"/api/response",
					"PUT",
					{ attendance: "maybe", button: "handle", futureMeetups: true },
					cookie,
					me.csrf,
				)
			).status,
		).toBe(200);
		expect((await state(cookie)).response.artwork).toEqual(approved.response.artwork);
		const operator = await login(admin);
		const html = await (await request("/api/admin/print", "GET", undefined, operator)).text();
		expect(html).toContain("A 24.5 24.5 0 0 1");
		expect(html).not.toContain(me.csrf);
		expect(html).not.toContain("did:plc:alice");
	});
	it("leaves local preview available but refuses export until paper cut size is explicit", async () => {
		const cookie = await login(admin);
		config.printCutDiameter = null;
		expect((await request("/api/me", "GET", undefined, cookie)).status).toBe(200);
		expect((await request("/api/admin/print", "GET", undefined, cookie)).status).toBe(409);
	});
	it("saves nonattending future contacts, permits independent changes past cutoffs, and protects the list", async () => {
		expect((await request("/api/admin/futurecontacts")).status).toBe(401);
		const cookie = await login();
		let me = await state(cookie);
		expect(me.futureMeetups).toBe(false);
		expect((await request("/api/admin/futurecontacts", "GET", undefined, cookie)).status).toBe(403);
		expect(
			(
				await request(
					"/api/response",
					"PUT",
					{ attendance: "cant", button: null, futureMeetups: true },
					cookie,
					me.csrf,
				)
			).status,
		).toBe(200);
		me = await state(cookie);
		expect(me.futureMeetups).toBe(true);
		expect(me.response.attendance).toBe("cant");
		const operator = await login(admin);
		const listing = await (
			await request("/api/admin/futurecontacts", "GET", undefined, operator)
		).json();
		expect(listing.contacts).toEqual([
			{ did: "did:plc:alice", handle: "alice.test", optedAt: expect.any(Number) },
		]);
		expect(listing.count).toBe(1);
		config.responseCutoff = 1;
		config.buttonCutoff = 1;
		config.artworkDeleteAt = 1;
		const pref = (futureMeetups: boolean, expectedVersion = me.responseVersion, extra = {}) =>
			request(
				"/api/preferences",
				"PUT",
				{ futureMeetups, expectedVersion, ...extra },
				cookie,
				me.csrf,
			);
		expect((await pref(false, me.responseVersion, { email: "no@test.invalid" })).status).toBe(400);
		expect(
			(
				await request(
					"/api/preferences",
					"PUT",
					{ futureMeetups: false, expectedVersion: me.responseVersion },
					cookie,
				)
			).status,
		).toBe(403);
		expect((await pref(false)).status).toBe(200);
		expect((await pref(true)).status).toBe(409);
		me = await state(cookie);
		expect(me.futureMeetups).toBe(false);
		expect(me.response.attendance).toBe("cant");
		expect((await pref(true)).status).toBe(200);
		me = await state(cookie);
		expect((await request("/api/response", "DELETE", {}, cookie, me.csrf)).status).toBe(200);
		me = await state(cookie);
		expect(me.response).toBeNull();
		expect(me.futureMeetups).toBe(true);
		expect(
			(
				await request(
					"/api/response",
					"PUT",
					{ attendance: null, button: null, futureMeetups: true },
					cookie,
					me.csrf,
				)
			).status,
		).toBe(200);
		me = await state(cookie);
		expect(
			(
				await request(
					"/api/signup",
					"DELETE",
					{ expectedVersion: me.responseVersion },
					cookie,
					me.csrf,
				)
			).status,
		).toBe(200);
		expect((await state(cookie)).futureMeetups).toBe(false);
		expect((await pref(true)).status).toBe(409);
		expect(
			(await (await request("/api/admin/futurecontacts", "GET", undefined, operator)).json()).count,
		).toBe(0);
	});
	it("blocks new artwork after deletion even while attendance and button cutoffs remain open", async () => {
		const cookie = await login();
		config.artworkDeleteAt = 1;
		expect(config.buttonCutoff).toBeNull();
		expect(config.responseCutoff).toBeNull();
		const me = await state(cookie);
		expect(
			(
				await request(
					"/api/response",
					"PUT",
					{ attendance: "coming", button: "pfp" },
					cookie,
					me.csrf,
				)
			).status,
		).toBe(409);
		expect(
			(
				await request(
					"/api/response",
					"PUT",
					{ attendance: "coming", button: null },
					cookie,
					me.csrf,
				)
			).status,
		).toBe(200);
		expect((await state(cookie)).response.artwork).toBeNull();
	});
	it("preserves approved artwork during preference-only changes after deadlines and save quota", async () => {
		const cookie = await login();
		let me = await state(cookie);
		for (let i = 0; i < 30; i++)
			expect(
				(
					await request(
						"/api/response",
						"PUT",
						{ attendance: "coming", button: "handle" },
						cookie,
						me.csrf,
					)
				).status,
			).toBe(200);
		config.responseCutoff = 1;
		config.buttonCutoff = 1;
		me = await state(cookie);
		const before = me.response;
		for (const futureMeetups of [true, false]) {
			expect(
				(
					await request(
						"/api/preferences",
						"PUT",
						{ futureMeetups, expectedVersion: me.responseVersion },
						cookie,
						me.csrf,
					)
				).status,
			).toBe(200);
			me = await state(cookie);
			expect(me.response).toEqual(before);
			expect(me.futureMeetups).toBe(futureMeetups);
		}
		const stale = me.responseVersion;
		config.artworkDeleteAt = 1;
		me = await state(cookie);
		expect(me.response.artwork).toBeNull();
		expect(
			(
				await request(
					"/api/preferences",
					"PUT",
					{ futureMeetups: true, expectedVersion: stale },
					cookie,
					me.csrf,
				)
			).status,
		).toBe(409);
		expect(
			(
				await request(
					"/api/preferences",
					"PUT",
					{ futureMeetups: true, expectedVersion: me.responseVersion },
					cookie,
					me.csrf,
				)
			).status,
		).toBe(200);
	});
	it("requires verified login and CSRF, isolates accounts, rejects impersonation, and authorizes every admin route", async () => {
		expect(
			(await request("/api/response", "PUT", { attendance: "coming", button: null })).status,
		).toBe(401);
		expect((await request("/api/admin")).status).toBe(401);
		expect((await request("/api/admin/print")).status).toBe(401);
		const alice = await login();
		const a = await state(alice);
		expect(a.admin).toBe(false);
		expect(
			(await request("/api/response", "PUT", { attendance: "coming", button: null }, alice)).status,
		).toBe(403);
		expect(
			(
				await request(
					"/api/response",
					"PUT",
					{ attendance: "coming", button: null },
					alice,
					a.csrf,
					"https://evil.test",
				)
			).status,
		).toBe(403);
		expect(
			(
				await request(
					"/api/response",
					"PUT",
					{ attendance: "coming", button: null, did: admin },
					alice,
					a.csrf,
				)
			).status,
		).toBe(400);
		expect(
			(
				await request(
					"/api/response",
					"PUT",
					{ attendance: "coming", button: "handle" },
					alice,
					a.csrf,
				)
			).status,
		).toBe(200);
		for (const path of ["/api/admin", "/api/admin/print"])
			expect((await request(path, "GET", undefined, alice)).status).toBe(403);
		const bob = await login("did:plc:bob");
		expect((await state(bob)).response).toBeNull();
		expect((await state(alice)).response.attendance).toBe("coming");
		const operator = await login(admin);
		const listing = await (await request("/api/admin", "GET", undefined, operator)).json();
		expect(listing.counts).toEqual({ coming: 1, maybe: 0, cant: 0, buttons: 1, futureMeetups: 0 });
		const print = await request("/api/admin/print", "GET", undefined, operator);
		expect(print.status).toBe(200);
		expect(await print.text()).not.toContain("did:plc:alice");
		expect((await request("/api/response", "DELETE", undefined, alice, a.csrf)).status).toBe(200);
		expect((await state(alice)).response).toBeNull();
		expect((await request("/api/logout", "POST", {}, alice, a.csrf)).status).toBe(200);
		expect((await state(alice)).profile).toBeNull();
	});
	it("binds callback to initiating browser, consumes state once, sanitizes failures, bounds payloads", async () => {
		expect((await request("/oauth/callback?code=forged")).status).toBe(400);
		const start = await request("/oauth/login", "POST", { handle: "alice.test" });
		const cookie = start.headers.get("set-cookie")?.split(";")[0] ?? "";
		expect((await request("/oauth/callback?code=valid", "GET", undefined, cookie)).status).toBe(
			303,
		);
		expect((await request("/oauth/callback?code=valid", "GET", undefined, cookie)).status).toBe(
			400,
		);
		const again = await request("/oauth/login", "POST", { handle: "alice.test" });
		const bad = await request(
			"/oauth/callback?error=denied",
			"GET",
			undefined,
			again.headers.get("set-cookie")?.split(";")[0],
		);
		expect(bad.status).toBe(400);
		expect(await bad.text()).not.toContain("private credentials");
		expect((await request("/oauth/login", "POST", { handle: "http://127.0.0.1" })).status).toBe(
			400,
		);
		expect((await request("/oauth/login", "POST", { handle: "x".repeat(5000) })).status).toBe(413);
		expect(
			(await request("/oauth/login", "POST", { handle: "alice.test" }, "", "", "https://evil.test"))
				.status,
		).toBe(403);
		const malformed = await fetch(`${origin}/oauth/login`, {
			method: "POST",
			headers: { origin, "content-type": "application/json" },
			body: "{",
		});
		expect(malformed.status).toBe(400);
		expect((await request("/private/test")).status).toBe(404);
		expect((await request("/.env")).status).toBe(404);
	});
	it("rejects cross-browser callback binding, expired state, and rotates the prior session", async () => {
		const original = await login();
		const a = await request("/oauth/login", "POST", { handle: "alice.test" });
		const aCookie = a.headers.get("set-cookie")?.split(";")[0] ?? "";
		const b = await request("/oauth/login", "POST", { handle: "alice.test" });
		const bCookie = b.headers.get("set-cookie")?.split(";")[0] ?? "";
		expect(
			(await request("/oauth/callback?code=browser-b", "GET", undefined, aCookie)).status,
		).toBe(400);
		expect(
			(await request("/oauth/callback?code=browser-a", "GET", undefined, aCookie)).status,
		).toBe(400);
		const rotated = await request(
			"/oauth/callback?code=browser-b",
			"GET",
			undefined,
			`${bCookie}; ${original}`,
		);
		expect(rotated.status).toBe(303);
		const fresh = rotated.headers.get("set-cookie")?.split(";")[0] ?? "";
		expect(fresh).not.toBe(original);
		expect((await state(original)).profile).toBeNull();
		expect((await state(fresh)).profile.did).toBe("did:plc:alice");
		expect((await request("/oauth/callback?code=replay", "GET", undefined, bCookie)).status).toBe(
			400,
		);
		const expired = await request("/oauth/login", "POST", { handle: "alice.test" });
		const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600001);
		try {
			expect(
				(
					await request(
						"/oauth/callback?code=expired",
						"GET",
						undefined,
						expired.headers.get("set-cookie")?.split(";")[0],
					)
				).status,
			).toBe(400);
		} finally {
			clock.mockRestore();
		}
	});
	it("removes declined, opted-out and deleted artwork from operator exports", async () => {
		const cookie = await login();
		const a = await state(cookie);
		const operator = await login(admin);
		const save = (attendance: string, button: string | null) =>
			request("/api/response", "PUT", { attendance, button }, cookie, a.csrf);
		const count = async () =>
			(await (await request("/api/admin", "GET", undefined, operator)).json()).counts.buttons;
		expect((await save("coming", "handle")).status).toBe(200);
		expect(await count()).toBe(1);
		expect((await save("cant", "handle")).status).toBe(200);
		expect(await count()).toBe(0);
		expect(
			await (await request("/api/admin/print", "GET", undefined, operator)).text(),
		).not.toContain("data:image/png");
		expect((await save("maybe", "pfp")).status).toBe(200);
		expect(await count()).toBe(1);
		expect((await save("maybe", null)).status).toBe(200);
		expect(await count()).toBe(0);
		expect((await save("coming", "handle")).status).toBe(200);
		expect((await request("/api/response", "DELETE", {}, cookie, a.csrf)).status).toBe(200);
		expect(await count()).toBe(0);
	});
	it("enforces configured cutoffs but permits opt-out and cancellation", async () => {
		const cookie = await login();
		const a = await state(cookie);
		await request(
			"/api/response",
			"PUT",
			{ attendance: "coming", button: "handle" },
			cookie,
			a.csrf,
		);
		config.buttonCutoff = 1;
		expect(
			(
				await request(
					"/api/response",
					"PUT",
					{ attendance: "maybe", button: "pfp" },
					cookie,
					a.csrf,
				)
			).status,
		).toBe(409);
		expect(
			(await request("/api/response", "PUT", { attendance: "maybe", button: null }, cookie, a.csrf))
				.status,
		).toBe(200);
		config.responseCutoff = 1;
		expect(
			(
				await request(
					"/api/response",
					"PUT",
					{ attendance: "coming", button: null },
					cookie,
					a.csrf,
				)
			).status,
		).toBe(409);
		expect((await request("/api/response", "DELETE", undefined, cookie, a.csrf)).status).toBe(200);
	});
	it("rejects unseen artwork and stale tabs after replacement, withdrawal, deletion and recreation", async () => {
		const cookie = await login();
		const first = await state(cookie);
		const initial = {
			attendance: "coming",
			button: "handle",
			expectedVersion: first.responseVersion,
			artworkSource: first.preview.profile,
		};
		expect(
			(
				await request(
					"/api/response",
					"PUT",
					{ ...initial, artworkSource: "forged" },
					cookie,
					first.csrf,
				)
			).status,
		).toBe(409);
		expect((await request("/api/response", "PUT", initial, cookie, first.csrf)).status).toBe(200);
		const tab = await state(cookie);
		const stale = {
			...initial,
			expectedVersion: tab.responseVersion,
			artworkSource: tab.preview.saved,
		};
		avatar = "data:image/png;base64,AQ==";
		const second = await login();
		const secondState = await state(second);
		const replacement = { ...stale, replaceArtwork: true, artworkSource: tab.preview.profile };
		expect(
			(await request("/api/response", "PUT", replacement, second, secondState.csrf)).status,
		).toBe(409);
		expect(
			(
				await request(
					"/api/response",
					"PUT",
					{ ...replacement, artworkSource: secondState.preview.profile },
					second,
					secondState.csrf,
				)
			).status,
		).toBe(200);
		expect((await state(second)).response.artwork.avatar).toBe(avatar);
		expect((await request("/api/response", "PUT", stale, cookie, tab.csrf)).status).toBe(409);
		const changed = await state(cookie);
		expect(
			(
				await request(
					"/api/response",
					"PUT",
					{ ...stale, expectedVersion: changed.responseVersion },
					cookie,
					tab.csrf,
				)
			).status,
		).toBe(409);
		expect(
			(
				await request(
					"/api/response",
					"PUT",
					{ attendance: "coming", button: null },
					cookie,
					tab.csrf,
				)
			).status,
		).toBe(200);
		expect((await request("/api/response", "PUT", stale, cookie, tab.csrf)).status).toBe(409);
		const beforeDelete = await state(cookie);
		expect((await request("/api/response", "DELETE", {}, cookie, tab.csrf)).status).toBe(200);
		expect((await request("/api/response", "PUT", initial, cookie, tab.csrf)).status).toBe(409);
		expect(
			(
				await request(
					"/api/response",
					"PUT",
					{ ...initial, expectedVersion: beforeDelete.responseVersion },
					cookie,
					tab.csrf,
				)
			).status,
		).toBe(409);
		expect((await state(cookie)).response).toBeNull();
		expect(
			(
				await request(
					"/api/response",
					"PUT",
					{ attendance: "cant", button: null },
					cookie,
					tab.csrf,
				)
			).status,
		).toBe(200);
		expect((await request("/api/response", "PUT", initial, cookie, tab.csrf)).status).toBe(409);
		expect((await state(cookie)).response.artwork).toBeNull();
	});
	it("keeps opt-out, decline and deletion available after a session exhausts its save quota", async () => {
		const cookie = await login();
		const a = await state(cookie);
		for (let i = 0; i < 30; i++)
			expect(
				(
					await request(
						"/api/response",
						"PUT",
						{ attendance: "coming", button: "handle" },
						cookie,
						a.csrf,
					)
				).status,
			).toBe(200);
		expect(
			(
				await request(
					"/api/response",
					"PUT",
					{ attendance: "coming", button: "pfp" },
					cookie,
					a.csrf,
				)
			).status,
		).toBe(429);
		const other = await login("did:plc:bob");
		const b = await state(other);
		expect(
			(
				await request(
					"/api/response",
					"PUT",
					{ attendance: "coming", button: "pfp" },
					other,
					b.csrf,
				)
			).status,
		).toBe(200);
		expect(
			(
				await request(
					"/api/response",
					"PUT",
					{ attendance: "coming", button: null },
					cookie,
					a.csrf,
				)
			).status,
		).toBe(200);
		expect(
			(await request("/api/response", "PUT", { attendance: "cant", button: null }, cookie, a.csrf))
				.status,
		).toBe(200);
		expect((await request("/api/response", "DELETE", {}, cookie, a.csrf)).status).toBe(200);
	});
	it("does not let health polling starve authenticated withdrawal", async () => {
		const cookie = await login();
		const a = await state(cookie);
		for (let i = 0; i < 185; i++) expect((await request("/health")).status).toBe(200);
		expect(
			(
				await request(
					"/api/response",
					"DELETE",
					{ expectedVersion: a.responseVersion },
					cookie,
					a.csrf,
				)
			).status,
		).toBe(200);
	});
	it("separates tunnel visitors only with a loopback origin secret and ignores forged forwarded headers", async () => {
		Object.assign(config, { trustedProxy: { secret: "s".repeat(32) } });
		const attempt = (ip: string, secret = "s".repeat(32)) =>
			fetch(`${origin}/oauth/login`, {
				method: "POST",
				redirect: "manual",
				headers: {
					origin,
					"content-type": "application/json",
					"cf-connecting-ip": ip,
					"x-dcbsky-proxy-secret": secret,
					"x-forwarded-for": ip,
				},
				body: JSON.stringify({ handle: "alice.test" }),
			});
		for (let i = 0; i < 10; i++) expect((await attempt("198.51.100.1")).status).toBe(303);
		expect((await attempt("198.51.100.1")).status).toBe(429);
		expect((await attempt("198.51.100.2")).status).toBe(303);
		for (let i = 0; i < 10; i++) await attempt(`203.0.113.${i}`, "forged");
		expect((await attempt("203.0.113.99", "forged")).status).toBe(429);
	});
	it("rate limits login attempts", async () => {
		for (let i = 0; i < 10; i++) await request("/oauth/login", "POST", { handle: "alice.test" });
		expect((await request("/oauth/login", "POST", { handle: "alice.test" })).status).toBe(429);
	});
});
