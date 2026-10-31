import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseEventConfig, readAdminDids, readPolicyConfig } from "./config.js";

const deletion = "1955-11-05T23:59:59-08:00";
const admin = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";

describe("public event configuration", () => {
	const event = JSON.parse(readFileSync("event.json", "utf8"));
	it("validates the checked-in example", () => {
		expect(parseEventConfig(event)).toEqual(event);
	});
	it.each([
		null,
		[],
		"event",
		{ ...event, venue: null },
		{ ...event, branding: [] },
	])("rejects malformed event objects", (input) => {
		expect(() => parseEventConfig(input)).toThrow("Event config");
	});
	it.each([
		{ name: "" },
		{ description: "line\nbreak" },
		{ origin: "https://example.com/path" },
		{ startAt: "1955-11-05" },
		{ startAt: "1955-11-05T18:00:00" },
		{ endAt: event.startAt },
		{ startAt: "1955-02-30T18:00:00Z" },
		{ startAt: "1955-11-05T24:00:00Z" },
		{ timeZone: "Invalid/Zone" },
		{ locale: "invalid_locale" },
		{ venue: { ...event.venue, url: "javascript:alert(1)" } },
		{ venue: { ...event.venue, url: "https://user:password@example.com" } },
		{ branding: { ...event.branding, color: "red" } },
		{ branding: { ...event.branding, mark: "/../private.svg" } },
		{ branding: { ...event.branding, mark: "https://example.com/mark.svg" } },
		{ branding: { ...event.branding, socialImage: "/social.svg" } },
		{ branding: { ...event.branding, favicon: "/favicon.png" } },
		{ branding: { ...event.branding, icon192: "/icon.svg" } },
		{ branding: { ...event.branding, socialImageWidth: 0 } },
		{ branding: { ...event.branding, socialImageHeight: 1.5 } },
	])("rejects invalid event values: %j", (changes) => {
		expect(() => parseEventConfig({ ...event, ...changes })).toThrow();
	});
});

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
			readPolicyConfig({
				APP_ORIGIN: "https://hill-valley.example.com",
				ARTWORK_DELETE_AT: deletion,
			}),
		).toEqual({
			origin: "https://hill-valley.example.com",
			responseCutoff: null,
			buttonCutoff: null,
			artworkDeleteAt: Date.parse(deletion),
		});
	});
	it("requires only the artwork deletion date for HTTPS", () => {
		expect(() => readPolicyConfig({ APP_ORIGIN: "https://hill-valley.example.com" })).toThrow(
			"ARTWORK_DELETE_AT",
		);
		expect(readPolicyConfig({}).artworkDeleteAt).toBeNull();
	});
	it("accepts explicit cutoffs and blank optional cutoffs", () => {
		const value = readPolicyConfig({
			APP_ORIGIN: "https://hill-valley.example.com",
			RESPONSE_CUTOFF: "",
			BUTTON_CUTOFF: "1955-11-05T12:00:00-08:00",
			ARTWORK_DELETE_AT: deletion,
		});
		expect(value.responseCutoff).toBeNull();
		expect(value.buttonCutoff).toBe(Date.parse("1955-11-05T12:00:00-08:00"));
	});
	it.each([
		"RESPONSE_CUTOFF",
		"BUTTON_CUTOFF",
		"ARTWORK_DELETE_AT",
	])("rejects malformed %s", (name) => {
		for (const value of ["tomorrow", "1955-11-05", "1955-11-05T23:59:59", "5 Nov 1955Z"])
			expect(() => readPolicyConfig({ [name]: value })).toThrow(name);
	});
	it("requires deletion after an explicit button cutoff, not an attendance cutoff", () => {
		expect(() =>
			readPolicyConfig({ BUTTON_CUTOFF: deletion, ARTWORK_DELETE_AT: deletion }),
		).toThrow("after the button cutoff");
		expect(
			readPolicyConfig({ RESPONSE_CUTOFF: "2015-10-21T00:00:00Z", ARTWORK_DELETE_AT: deletion })
				.responseCutoff,
		).not.toBeNull();
	});
	it("accepts past dates so restarts can perform cleanup", () => {
		expect(
			readPolicyConfig({
				APP_ORIGIN: "https://hill-valley.example.com",
				ARTWORK_DELETE_AT: "1955-11-05T23:59:59Z",
			}).artworkDeleteAt,
		).toBe(Date.parse("1955-11-05T23:59:59Z"));
	});
});
