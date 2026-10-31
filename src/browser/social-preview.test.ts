// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { parseEventConfig } from "../server/config.js";
import { calendarDate, eventCalendar, eventManifest, renderEventPage } from "../server/event.js";

const window = new Window({
	settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true },
});
const DOMParser = window.DOMParser;
const event = parseEventConfig(JSON.parse(readFileSync("event.json", "utf8")));

function landingPage(config = event, origin = config.origin) {
	return new DOMParser().parseFromString(
		renderEventPage(readFileSync("public/index.html", "utf8"), config, origin),
		"text/html",
	);
}

describe("public social preview", () => {
	it("has absolute public card metadata with matching image descriptions", () => {
		const page = landingPage();
		const meta = (key: string) =>
			page.querySelector(`meta[property="${key}"], meta[name="${key}"]`)?.getAttribute("content");
		expect(meta("og:type")).toBe("website");
		expect(meta("og:url")).toBe(`${event.origin}/`);
		expect(meta("og:title")).toBe(event.name);
		expect(meta("og:description")).toContain(event.description);
		expect(meta("og:description")).toContain(event.venue.address);
		expect(meta("og:image")).toBe(new URL(event.branding.socialImage, event.origin).toString());
		expect(meta("og:image:type")).toBe("image/png");
		expect(meta("og:image:width")).toBe(String(event.branding.socialImageWidth));
		expect(meta("og:image:height")).toBe(String(event.branding.socialImageHeight));
		expect(meta("og:image:alt")).toContain(event.branding.socialImageAlt);
		expect(meta("og:image:alt")).toContain(event.name);
		expect(meta("twitter:card")).toBe("summary_large_image");
		for (const key of ["title", "description", "image", "image:alt"])
			expect(meta(`twitter:${key}`)).toBe(meta(`og:${key}`));
	});
	it.each([
		["1955-11-05T18:00:00Z", "1955-11-05T21:00:00Z", "18:00", "GMT"],
		["2015-10-21T18:00:00+01:00", "2015-10-21T21:00:00+01:00", "18:00", "BST"],
	])("keeps film dates consistent in London across page, metadata, calendars and manifest: %s", (startAt, endAt, clock, zone) => {
		const london = parseEventConfig({
			...event,
			name: "Hill Valley friends & neighbors",
			community: "Hill Valley community",
			tagline: "Meet in Hill Valley.",
			description: "An independent local meetup.",
			origin: "https://meetup.example.com",
			startAt,
			endAt,
			timeZone: "Europe/London",
			locale: "en-GB",
			calendarUid: "hill-valley-unique@example.com",
			venue: {
				name: "Doc Brown's house",
				address: "1640 Riverside Drive",
				url: "https://venue.example.com/",
			},
			branding: {
				...event.branding,
				name: "Hill Valley friends",
				shortName: "Hill Valley",
				color: "#008866",
				mark: "/hill-valley.svg",
				markAlt: "Hill Valley mark",
				socialImage: "/hill-valley.png",
				socialImageAlt: "Hill Valley meetup",
			},
		});
		const page = landingPage(london);
		expect(page.querySelector("h1")?.textContent).toBe(london.name);
		expect(page.querySelector("title")?.textContent).toBe(london.name);
		expect(page.querySelector(".eyebrow")?.textContent).toBe(london.community);
		expect(page.querySelector(".invitation")?.textContent).toBe(london.tagline);
		expect(page.querySelector("time")?.textContent).toContain(clock);
		expect(page.querySelector("time")?.textContent).toContain(zone);
		expect(page.querySelector("time")?.getAttribute("datetime")).toBe(startAt);
		expect(page.querySelector(".venue-card")?.getAttribute("href")).toBe(london.venue.url);
		expect(page.querySelector(".venue-card")?.textContent).toContain(london.venue.address);
		expect(page.querySelector(".community-mark")?.getAttribute("src")).toBe(london.branding.mark);
		expect(page.querySelector('meta[property="og:image"]')?.getAttribute("content")).toBe(
			"https://meetup.example.com/hill-valley.png",
		);
		expect(page.documentElement.getAttribute("style")).toContain(london.branding.color);
		expect(page.documentElement.outerHTML).not.toContain(event.name);
		expect(page.documentElement.outerHTML).not.toContain("{{");
		const google = new URL(
			page.querySelector('a[href^="https://calendar.google.com"]')?.getAttribute("href") ?? "",
		);
		expect(google.searchParams.get("text")).toBe(london.name);
		expect(google.searchParams.get("ctz")).toBe(london.timeZone);
		expect(google.searchParams.get("dates")).toBe(
			`${calendarDate(startAt)}/${calendarDate(endAt)}`,
		);
		expect(google.searchParams.get("location")).toBe(
			`${london.venue.name}, ${london.venue.address}`,
		);
		const calendar = eventCalendar(london);
		expect(calendar).toContain(`DTSTART:${calendarDate(startAt)}`);
		expect(calendar).toContain(`DTEND:${calendarDate(endAt)}`);
		expect(calendar).toContain(`UID:${london.calendarUid}`);
		expect(calendar).toContain(`SUMMARY:${london.name}`);
		expect(calendar).toContain("URL;VALUE=URI:https://meetup.example.com/");
		expect(JSON.parse(eventManifest(london))).toMatchObject({
			name: london.branding.name,
			short_name: london.branding.shortName,
			theme_color: london.branding.color,
		});
	});
	it("escapes config text and attribute values without introducing active markup", () => {
		const unsafe = {
			...event,
			name: '<script>alert("test")</script>',
			venue: { ...event.venue, name: '" onmouseover="alert(1)' },
		};
		const page = landingPage(unsafe);
		expect(page.querySelector("h1")?.textContent).toBe(unsafe.name);
		expect(page.querySelectorAll("script")).toHaveLength(1);
		expect(page.querySelector("[onmouseover]")).toBeNull();
		expect(() => renderEventPage("{{unknown}}", event)).toThrow("Unknown event template field");
	});
	it("uses the runtime origin in all public URLs and calendar details", () => {
		const origin = "http://127.0.0.1:3000";
		const page = landingPage(event, origin);
		expect(page.querySelector('meta[property="og:url"]')?.getAttribute("content")).toBe(
			`${origin}/`,
		);
		expect(page.querySelector('meta[property="og:image"]')?.getAttribute("content")).toBe(
			`${origin}${event.branding.socialImage}`,
		);
		expect(eventCalendar(event, origin)).toContain(`URL;VALUE=URI:${origin}/`);
	});
	it("keeps the original independent-community mark geometry and blue", () => {
		const preview = new DOMParser().parseFromString(
			readFileSync("public/social-preview.svg", "utf8"),
			"image/svg+xml",
		);
		const favicon = new DOMParser().parseFromString(
			readFileSync("public/favicon.svg", "utf8"),
			"image/svg+xml",
		);
		expect(preview.documentElement.getAttribute("viewBox")).toBe("0 0 1200 630");
		expect(preview.querySelector("#community-mark")?.getAttribute("fill")).toBe("#0560FF");
		for (const selector of ["#butterfly path", "#butterfly circle", "use", "g > path"])
			expect(
				Array.from(preview.querySelectorAll(selector), (element) => element.outerHTML),
			).toEqual(Array.from(favicon.querySelectorAll(selector), (element) => element.outerHTML));
	});
});
