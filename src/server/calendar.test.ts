import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { fullFormats } from "ajv-formats/dist/formats.js";
import { describe, expect, it } from "vitest";
import { type EventConfig, parseEventConfig } from "./config.js";
import { eventCalendar, renderEventPage } from "./event.js";
import { launchIssues } from "./preflight.js";

const example: EventConfig = {
	name: "Hill Valley Bluesky meetup",
	community: "Hill Valley community",
	tagline: "Meet local friends.",
	description: "Community meetup.",
	origin: "https://meetup.example.com",
	startAt: "1955-11-05T18:00:00-08:00",
	endAt: "1955-11-05T21:00:00-08:00",
	timeZone: "America/Los_Angeles",
	locale: "en-US",
	venue: {
		name: "Doc Brown's house",
		address: "1640 Riverside Drive",
		url: "https://venue.example.com/",
	},
	branding: {
		name: "Hill Valley Bluesky",
		shortName: "Hill Valley",
		color: "#0560ff",
		mark: "/favicon.svg",
		markAlt: "Bluesky logo",
		favicon: "/favicon.svg",
		favicon32: "/favicon-32.png",
		appleTouchIcon: "/apple-touch-icon.png",
		icon192: "/icon-192.png",
		icon512: "/icon-512.png",
		socialImage: "/social-preview.png",
		socialImageAlt: "Event card",
		socialImageWidth: 1200,
		socialImageHeight: 630,
	},
};
const ajv = new Ajv({ strictTypes: false });
for (const [name, format] of Object.entries(fullFormats)) ajv.addFormat(name, format);
const validate = ajv.compile(JSON.parse(readFileSync("event.schema.json", "utf8")));

describe("conditional calendar UID", () => {
	it("accepts a TBA venue website only while coming soon", () => {
		const venue = { name: "TBA", address: "TBA", url: "TBA" };
		const input = { ...example, comingSoon: true, venue };
		expect(validate(input)).toBe(true);
		expect(parseEventConfig(input).venue.url).toBe("TBA");
		for (const comingSoon of [false, undefined]) {
			const open = { ...example, comingSoon, calendarUid: "19551105-meetup@example.com", venue };
			expect(validate(open)).toBe(false);
			expect(() => parseEventConfig(open)).toThrow();
		}
		const html = renderEventPage(
			readFileSync("public/index.html", "utf8"),
			parseEventConfig(input),
		);
		expect(html).toContain('class="event-detail venue-card" role="group"');
		expect(html).not.toContain("Website to be announced");
		expect(html).toContain("Venue to be announced soon");
		expect(html).not.toContain("1640 Riverside Drive");
		expect(html).not.toContain('href="TBA"');
		expect(html).not.toContain('class="venue-arrow"');
		const issues = launchIssues(input, {}, Date.parse("1955-11-05T12:00:00-08:00"));
		expect(issues).toContainEqual(expect.objectContaining({ code: "venue-tba", level: "warning" }));
		expect(issues.some((issue) => issue.code === "invalid-url")).toBe(false);
	});
	it.each([
		undefined,
		"",
	])("accepts an omitted or empty UID when coming soon: %s", (calendarUid) => {
		const input = {
			...example,
			comingSoon: true,
			...(calendarUid === undefined ? {} : { calendarUid }),
		};
		expect(validate(input)).toBe(true);
		expect(parseEventConfig(input)).toEqual(input);
		const event = parseEventConfig(input);
		const uid = (origin?: string) => eventCalendar(event, origin).match(/\r\nUID:([^\r\n]+)/)?.[1];
		expect(uid()).toMatch(/^draft-[a-f0-9]{32}@meetup\.example\.com$/);
		expect(uid()).toBe(uid("http://127.0.0.1:3000"));
		expect(eventCalendar(event)).toContain("DTSTART:19551106T020000Z");
	});
	it.each([false, undefined])("requires a nonempty UID when comingSoon is %s", (comingSoon) => {
		for (const calendarUid of [undefined, "", " "]) {
			const input = {
				...example,
				...(comingSoon === undefined ? {} : { comingSoon }),
				...(calendarUid === undefined ? {} : { calendarUid }),
			};
			expect(validate(input)).toBe(false);
			expect(() => parseEventConfig(input)).toThrow("calendarUid");
		}
	});
	it.each([true, false])("honors an explicit UID in either mode: %s", (comingSoon) => {
		const input = { ...example, comingSoon, calendarUid: "19551105-meetup@example.com" };
		expect(validate(input)).toBe(true);
		expect(eventCalendar(parseEventConfig(input))).toContain(`UID:${input.calendarUid}`);
	});
	it("rejects malformed UIDs even while coming soon", () => {
		for (const calendarUid of [null, 1, " ", "line\nbreak"]) {
			const input = { ...example, comingSoon: true, calendarUid };
			expect(validate(input)).toBe(false);
			expect(() => parseEventConfig(input)).toThrow("calendarUid");
		}
	});
});
