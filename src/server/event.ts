import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ical from "ical-generator";
import { escapeXml } from "../shared/button.js";
import { type EventConfig, parseEventConfig } from "./config.js";

export async function loadEventConfig(
	path = process.env.EVENT_CONFIG ?? "event.json",
): Promise<EventConfig> {
	return parseEventConfig(JSON.parse(await readFile(resolve(path), "utf8")));
}

export function calendarDate(value: string): string {
	return new Date(value)
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "Z");
}

export function renderEventPage(
	template: string,
	event: EventConfig,
	origin = event.origin,
): string {
	const start = new Date(event.startAt);
	const end = new Date(event.endAt);
	const date = new Intl.DateTimeFormat(event.locale, {
		timeZone: event.timeZone,
		weekday: "long",
		day: "numeric",
		month: "long",
		year: "numeric",
	});
	const time = new Intl.DateTimeFormat(event.locale, {
		timeZone: event.timeZone,
		timeStyle: "short",
	});
	const timeZone =
		new Intl.DateTimeFormat(event.locale, { timeZone: event.timeZone, timeZoneName: "short" })
			.formatToParts(start)
			.find((part) => part.type === "timeZoneName")?.value ?? event.timeZone;
	const dateLabel =
		date.format(start) === date.format(end)
			? date.format(start)
			: `${date.format(start)} \u2013 ${date.format(end)}`;
	const timeLabel = `${time.format(start)}\u2013${time.format(end)} ${timeZone}`;
	const location = `${event.venue.name}, ${event.venue.address}`;
	const description = `${event.description} ${dateLabel}, ${timeLabel} at ${location}.`;
	const calendar = new URL("https://calendar.google.com/calendar/render");
	calendar.search = new URLSearchParams({
		action: "TEMPLATE",
		text: event.name,
		dates: `${calendarDate(event.startAt)}/${calendarDate(event.endAt)}`,
		ctz: event.timeZone,
		location,
		details: `${event.tagline} ${event.description} ${origin}/`,
	}).toString();
	const values: Record<string, string> = {
		locale: event.locale,
		eventName: event.name,
		community: event.community,
		tagline: event.tagline,
		description,
		publicUrl: `${origin}/`,
		dateLabel,
		timeLabel,
		startAt: event.startAt,
		googleCalendarUrl: calendar.toString(),
		calendarLabel: `Add ${event.name} to Google Calendar: ${dateLabel}, ${timeLabel}`,
		venueName: event.venue.name,
		venueAddress: event.venue.address,
		venueUrl: event.venue.url,
		venueLabel: `${location}. Visit website (opens in a new tab)`,
		brandColor: event.branding.color,
		brandMark: event.branding.mark,
		brandMarkAlt: event.branding.markAlt,
		favicon: event.branding.favicon,
		favicon32: event.branding.favicon32,
		appleTouchIcon: event.branding.appleTouchIcon,
		socialImage: new URL(event.branding.socialImage, origin).toString(),
		socialImageAlt: `${event.branding.socialImageAlt}. ${event.name}. ${description} ${event.tagline}`,
		socialImageWidth: String(event.branding.socialImageWidth),
		socialImageHeight: String(event.branding.socialImageHeight),
	};
	return template.replace(/\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g, (_match, key: string) => {
		const value = values[key];
		if (value === undefined) throw Error(`Unknown event template field: ${key}`);
		return escapeXml(value);
	});
}

export function eventCalendar(event: EventConfig, origin = event.origin): string {
	const calendar = ical({
		name: event.name,
		prodId: { company: "Bluesky Meetup", product: "Event Signup", language: "EN" },
	});
	calendar.createEvent({
		id: event.calendarUid,
		start: new Date(event.startAt),
		end: new Date(event.endAt),
		summary: event.name,
		description: `${event.tagline} ${event.description}`,
		location: `${event.venue.name}, ${event.venue.address}`,
		url: `${origin}/`,
	});
	return calendar.toString();
}

export function eventManifest(event: EventConfig): string {
	return JSON.stringify({
		name: event.branding.name,
		short_name: event.branding.shortName,
		start_url: "/",
		display: "browser",
		background_color: "#ffffff",
		theme_color: event.branding.color,
		icons: [
			{ src: event.branding.icon192, sizes: "192x192", type: "image/png" },
			{ src: event.branding.icon512, sizes: "512x512", type: "image/png" },
		],
	});
}
