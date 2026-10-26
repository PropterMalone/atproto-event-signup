import { describe, expect, it } from "vitest";
import { readAdminDids, readPolicyConfig } from "./config.js";

const deletion = "2026-11-24T23:59:59-05:00";
const admin = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";

describe("administrator allowlist configuration", () => {
	it("grants nobody access when unset or blank, including HTTPS", () => {
		for (const env of [
			{},
			{ ADMIN_DIDS: "" },
			{ ADMIN_DIDS: " \t\n " },
			{ APP_ORIGIN: "https://example.com", ARTWORK_DELETE_AT: deletion },
		]) {
			expect(readAdminDids(env)).toEqual(new Set());
			expect(readAdminDids(env).has(admin)).toBe(false);
		}
	});
	it("trims and deduplicates only explicitly configured DIDs", () => {
		expect(
			readAdminDids({
				ADMIN_DIDS: ` ${admin}, did:web:example.com, ${admin} ,did:web:sub.example.com `,
			}),
		).toEqual(new Set([admin, "did:web:example.com", "did:web:sub.example.com"]));
	});
	it.each([
		"alice.example.com",
		"did:plc:short",
		"did:plc:aaaaaaaaaaaaaaaaaaaaaaa1",
		"did:plc:AAAAAAAAAAAAAAAAAAAAAAAA",
		"did:key:example",
		"did:web:",
		"did:web:example.com:users:alice",
		"did:web:example.com%3A443",
		"did:web:example.com/path",
		"did:web:example.com?admin=true",
		"did:web:example.com#admin",
		"did:web:user@example.com",
		"did:web:-example.com",
		"did:web:example..com",
		"did:web:example.com.",
		"did:web:localhost",
		"did:web:127.0.0.1",
		"did:web:example.123",
		`${admin},`,
		`,${admin}`,
		`${admin}, ,did:web:example.com`,
	])("rejects malformed or unsupported allowlist entry %s", (value) => {
		expect(() => readAdminDids({ ADMIN_DIDS: value })).toThrow("ADMIN_DIDS");
	});
});
describe("startup policy configuration", () => {
	it("allows HTTPS with attendance and buttons open and an explicit artwork deletion date", () => {
		expect(
			readPolicyConfig({ APP_ORIGIN: "https://dcbsky.com", ARTWORK_DELETE_AT: deletion }),
		).toEqual({
			origin: "https://dcbsky.com",
			responseCutoff: null,
			buttonCutoff: null,
			artworkDeleteAt: Date.parse(deletion),
		});
	});
	it("requires only the artwork deletion date for HTTPS", () => {
		expect(() => readPolicyConfig({ APP_ORIGIN: "https://dcbsky.com" })).toThrow(
			"ARTWORK_DELETE_AT",
		);
		expect(readPolicyConfig({}).artworkDeleteAt).toBeNull();
	});
	it("accepts explicit cutoffs and blank optional cutoffs", () => {
		const value = readPolicyConfig({
			APP_ORIGIN: "https://dcbsky.com",
			RESPONSE_CUTOFF: "",
			BUTTON_CUTOFF: "2026-11-09T12:00:00-05:00",
			ARTWORK_DELETE_AT: deletion,
		});
		expect(value.responseCutoff).toBeNull();
		expect(value.buttonCutoff).toBe(Date.parse("2026-11-09T12:00:00-05:00"));
	});
	it.each([
		"RESPONSE_CUTOFF",
		"BUTTON_CUTOFF",
		"ARTWORK_DELETE_AT",
	])("rejects malformed %s", (name) => {
		for (const value of ["tomorrow", "2026-11-24", "2026-11-24T23:59:59", "24 Nov 2026Z"])
			expect(() => readPolicyConfig({ [name]: value })).toThrow(name);
	});
	it("requires deletion after an explicit button cutoff, not an attendance cutoff", () => {
		expect(() =>
			readPolicyConfig({ BUTTON_CUTOFF: deletion, ARTWORK_DELETE_AT: deletion }),
		).toThrow("after the button cutoff");
		expect(
			readPolicyConfig({ RESPONSE_CUTOFF: "2026-12-01T00:00:00Z", ARTWORK_DELETE_AT: deletion })
				.responseCutoff,
		).not.toBeNull();
	});
	it("accepts past dates so restarts can perform cleanup", () => {
		expect(
			readPolicyConfig({
				APP_ORIGIN: "https://dcbsky.com",
				ARTWORK_DELETE_AT: "2020-01-01T00:00:00Z",
			}).artworkDeleteAt,
		).toBe(Date.parse("2020-01-01T00:00:00Z"));
	});
});
