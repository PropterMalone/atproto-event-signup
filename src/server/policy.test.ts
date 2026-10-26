import { describe, expect, it } from "vitest";
import { approvedAvatarUrl, parseResponse, safeHandle, validateOrigin } from "./policy.js";

describe("strict boundaries", () => {
	it("accepts only individual response fields", () => {
		expect(parseResponse({ attendance: "coming", button: null })).toEqual({
			attendance: "coming",
			button: null,
		});
		expect(parseResponse({ attendance: null, button: "pfp", replaceArtwork: true })).toEqual({
			attendance: null,
			button: "pfp",
			replaceArtwork: true,
		});
		expect(parseResponse({ attendance: "cant", button: null, futureMeetups: true })).toMatchObject({
			futureMeetups: true,
		});
		for (const bad of [
			{ attendance: null, button: null, futureMeetups: "yes" },
			{ attendance: null, button: null, email: "x@test.invalid" },
			{ attendance: null, button: null, partySize: 2 },
			null,
			[],
			{},
			{ attendance: "yes", button: null },
			{ attendance: null, button: false },
			{ attendance: "maybe", button: null, did: "forged" },
			{ attendance: null, button: null, replaceArtwork: "yes" },
		])
			expect(parseResponse(bad)).toBeNull();
	});
	it("accepts only explicit top or bottom text positions and leaves omitted old fields absent", () => {
		for (const position of ["top", "bottom"])
			expect(parseResponse({ attendance: null, button: "handle", position })).toMatchObject({
				position,
			});
		for (const position of [null, false, 1, "middle", "TOP", {}, ["top"]])
			expect(parseResponse({ attendance: null, button: "handle", position })).toBeNull();
		expect(parseResponse({ attendance: null, button: "handle" })).not.toHaveProperty("position");
	});
	it("permits only fixed HTTPS Bluesky avatar CDN paths", () => {
		expect(approvedAvatarUrl("https://cdn.bsky.app/img/avatar/plain/did:plc:abc/x@jpeg")).toBe(
			true,
		);
		for (const url of [
			"",
			"bad",
			"https://127.0.0.1/x",
			"http://cdn.bsky.app/img/avatar/x",
			"https://cdn.bsky.app.evil.test/img/avatar/x",
			"https://a@cdn.bsky.app/img/avatar/x",
			"https://cdn.bsky.app:444/img/avatar/x",
			"https://cdn.bsky.app/other",
			"https://cdn.bsky.app/img/avatar/x?q=1",
			"https://cdn.bsky.app/img/avatar/x#x",
		])
			expect(approvedAvatarUrl(url)).toBe(false);
	});
	it("validates origins and handles without accepting endpoints or credentials", () => {
		expect(validateOrigin("https://dcbsky.com")).toBe("https://dcbsky.com");
		expect(validateOrigin("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
		for (const origin of [
			"invalid",
			"http://example.com",
			"https://dcbsky.com/",
			"https://dcbsky.com/x",
			"https://a@dcbsky.com",
			"https://dcbsky.com?x",
		])
			expect(() => validateOrigin(origin)).toThrow();
		expect(safeHandle("@alice.bsky.social")).toBe("alice.bsky.social");
		for (const h of [
			"did:plc:xyz",
			"http://example.com",
			"alice",
			"a".repeat(254),
			"-x.test",
			"x..test",
		])
			expect(safeHandle(h)).toBeNull();
	});
});
