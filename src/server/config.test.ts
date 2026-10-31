import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv } from "ajv";
import { fullFormats } from "ajv-formats/dist/formats.js";
import { describe, expect, it } from "vitest";
import { parseEventConfig, readAdminDids, readPolicyConfig } from "./config.js";
import { artworkIssues, launchIssues, launchReport } from "./preflight.js";

const deletion = "1955-11-05T23:59:59-08:00";
const admin = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";

describe("launch-only checks", () => {
	const example = parseEventConfig(JSON.parse(readFileSync("event.json", "utf8")));
	const launchEvent = {
		...example,
		name: "Time travelers meetup",
		community: "An independent meetup",
		tagline: "Meet local friends.",
		description: "Community get-together",
		origin: "https://meetup.community.org",
		startAt: "2015-10-21T18:00:00-07:00",
		endAt: "2015-10-21T21:00:00-07:00",
		venue: {
			name: "Community hall",
			address: "1640 Riverside Drive",
			url: "https://venue.community.org/",
		},
	};
	const launchEnv = { ADMIN_DIDS: admin, ARTWORK_DELETE_AT: "2015-10-21T23:59:59-07:00" };
	const now = Date.parse("2015-10-21T12:00:00-07:00");
	it("flags the historical example for launch without rejecting it as development config", () => {
		const event = parseEventConfig(JSON.parse(readFileSync("event.json", "utf8")));
		expect(parseEventConfig(event)).toEqual(event);
		const issues = launchIssues(event, {}, Date.parse("2015-10-21T00:00:00Z"));
		expect(issues.map((issue) => issue.code)).toEqual(
			expect.arrayContaining([
				"placeholder-url",
				"sample-copy",
				"event-ended",
				"no-organizer",
				"missing-retention",
			]),
		);
	});
	it("allows a ready config while reminding the organizer about separate retention", () => {
		const issues = launchIssues(launchEvent, launchEnv, now);
		expect(issues.filter((issue) => issue.level === "error")).toEqual([]);
		expect(issues.map((issue) => issue.code)).toEqual(["sample-copy", "retention-scope"]);
		expect(launchReport(issues).exitCode).toBe(0);
	});
	it("makes blockers fail the command while warnings remain nonblocking", () => {
		const report = launchReport([
			{ level: "error", code: "no-organizer", message: "Configure organizer access." },
			{ level: "warning", code: "retention-scope", message: "Review separate retention." },
		]);
		expect(report.exitCode).toBe(1);
		expect(report.lines).toContain("Pre-launch check: 1 blocker(s), 1 warning(s).");
		expect(launchReport([]).exitCode).toBe(0);
	});
	it.each([
		[{ ADMIN_DIDS: "invalid" }, "invalid-organizer"],
		[{ APP_ORIGIN: "http://127.0.0.1:3000" }, "https-required"],
		[{ APP_ORIGIN: "not a URL" }, "invalid-url"],
		[{ ARTWORK_DELETE_AT: "2015-10-21T01:00:00-07:00" }, "retention-expired"],
		[{ ARTWORK_DELETE_AT: launchEvent.startAt }, "retention-before-event-end"],
		[{ ARTWORK_DELETE_AT: "invalid timestamp" }, "invalid-policy"],
		[{ BUTTON_CUTOFF: "2015-10-21T23:59:59-07:00" }, "invalid-policy"],
		[{ RESPONSE_CUTOFF: "2015-10-21T01:00:00-07:00" }, "cutoff-passed"],
		[{ RESPONSE_CUTOFF: "2015-10-21T23:59:59-07:00" }, "cutoff-after-event"],
		[{ APP_ORIGIN: "https://other.community.org" }, "origin-mismatch"],
	])("reports launch-policy problems without exposing environment values: %j", (changes, code) => {
		const issues = launchIssues(
			launchEvent,
			{ ...launchEnv, ...changes, CLOUDFLARE_ORIGIN_SECRET: "do-not-log-this" },
			now,
		);
		expect(issues.some((issue) => issue.code === code)).toBe(true);
		expect(JSON.stringify(issues)).not.toContain("do-not-log-this");
	});
	it("accepts the built-in artwork and detects metadata size mismatches", async () => {
		expect(await artworkIssues(example, "public")).toEqual([]);
		const issues = await artworkIssues(
			{ ...example, branding: { ...example.branding, socialImageWidth: 100 } },
			"public",
		);
		expect(issues.map((issue) => issue.code)).toEqual(["artwork-dimensions"]);
	});
	it("reports missing and invalid image files without reading runtime data", async () => {
		const directory = mkdtempSync(join(tmpdir(), "meetup-preflight-"));
		try {
			writeFileSync(join(directory, "favicon.svg"), "not an image");
			writeFileSync(join(directory, "favicon-32.png"), "invalid PNG");
			writeFileSync(join(directory, "icon-192.png"), "");
			const issues = await artworkIssues(example, directory);
			expect(issues.map((issue) => issue.code)).toEqual(
				expect.arrayContaining(["invalid-artwork", "missing-artwork"]),
			);
		} finally {
			rmSync(directory, { recursive: true });
		}
	});
});

describe("public event configuration", () => {
	const event = JSON.parse(readFileSync("event.json", "utf8"));
	const schema = JSON.parse(readFileSync("event.schema.json", "utf8"));
	const ajv = new Ajv({ strictTypes: false, allErrors: true });
	for (const [name, format] of Object.entries(fullFormats)) ajv.addFormat(name, format);
	const validate = ajv.compile(schema);
	it("validates the checked-in example", () => {
		expect(event.$schema).toBe("./event.schema.json");
		expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
		expect(parseEventConfig(event)).toEqual(event);
	});
	it("accepts config files without editor metadata", () => {
		const { $schema: _schema, ...plain } = event;
		expect(validate(plain)).toBe(true);
		expect(parseEventConfig(plain)).toEqual(plain);
	});
	it("keeps actual timezone validity and cross-field date ordering in runtime validation", () => {
		for (const input of [
			{ ...event, endAt: event.startAt },
			{ ...event, timeZone: "Invalid/Zone" },
			{ ...event, locale: "invalid_locale" },
		]) {
			expect(validate(input)).toBe(true);
			expect(() => parseEventConfig(input)).toThrow();
		}
	});
	it("provides descriptions and valid autocomplete examples for every leaf field", () => {
		const properties = [
			schema.properties,
			schema.properties.venue.properties,
			schema.properties.branding.properties,
		];
		for (const fields of properties) {
			for (const field of Object.values(fields) as Record<string, unknown>[]) {
				expect(typeof field.description).toBe("string");
				if (field.type === "object") continue;
				expect(Array.isArray(field.examples)).toBe(true);
				const validateField = ajv.compile({ ...field, definitions: schema.definitions });
				for (const example of field.examples as unknown[])
					expect(validateField(example), JSON.stringify(validateField.errors)).toBe(true);
			}
		}
	});
	it.each([
		{ ...event, venuee: event.venue },
		{ ...event, venue: { ...event.venue, adress: "1640 Riverside Drive" } },
		{ ...event, branding: { ...event.branding, colour: "#0560ff" } },
		{ ...event, ADMIN_DIDS: admin },
		{ ...event, $schema: 123 },
	])("rejects unknown keys and invalid schema metadata in the editor and app", (input) => {
		expect(validate(input)).toBe(false);
		expect(() => parseEventConfig(input)).toThrow();
	});
	it("marks every event and nested config field as required", () => {
		for (const field of schema.required) {
			const incomplete = { ...event };
			delete incomplete[field];
			expect(validate(incomplete), field).toBe(false);
			expect(() => parseEventConfig(incomplete), field).toThrow();
		}
		for (const section of ["venue", "branding"]) {
			for (const field of schema.properties[section].required) {
				const incomplete = { ...event, [section]: { ...event[section] } };
				delete incomplete[section][field];
				expect(validate(incomplete), `${section}.${field}`).toBe(false);
				expect(() => parseEventConfig(incomplete), `${section}.${field}`).toThrow();
			}
		}
	});
	it.each([
		{ name: " " },
		{ description: "line\nbreak" },
		{ origin: "https://example.com/path" },
		{ origin: "https://user:password@example.com" },
		{ startAt: "1955-11-05" },
		{ startAt: "1955-02-30T18:00:00Z" },
		{ startAt: "1955-11-05T24:00:00Z" },
		{ venue: { ...event.venue, url: "javascript:alert(1)" } },
		{ venue: { ...event.venue, url: "https://user:password@example.com/" } },
		{ branding: { ...event.branding, color: "blue" } },
		{ branding: { ...event.branding, mark: "/../private.svg" } },
		{ branding: { ...event.branding, favicon: "/favicon.png" } },
		{ branding: { ...event.branding, icon192: "/icon.svg" } },
		{ branding: { ...event.branding, socialImageWidth: 0 } },
		{ branding: { ...event.branding, socialImageHeight: 1.5 } },
	])("keeps shared schema constraints aligned with runtime validation: %j", (changes) => {
		const input = { ...event, ...changes };
		expect(validate(input)).toBe(false);
		expect(() => parseEventConfig(input)).toThrow();
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
