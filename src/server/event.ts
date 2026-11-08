import { createHash } from "node:crypto";
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
	const venuePending = event.venue.name === "TBA";
	const venueName = venuePending ? "Venue to be announced soon" : event.venue.name;
	const venueAddress = venuePending ? "" : event.venue.address;
	const location = venueAddress ? `${venueName}, ${venueAddress}` : venueName;
	const websitePending = event.venue.url === "TBA";
	const venueLabel = venuePending
		? location
		: websitePending
			? `${location}. Website to be announced.`
		: `${location}. Visit website (opens in a new tab)`;
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
		comingSoon: String(event.comingSoon ?? false),
		locale: event.locale,
		eventName: event.name,
		community: event.community,
		tagline: event.tagline,
		eventDescription: event.description,
		description,
		publicUrl: `${origin}/`,
		dateLabel,
		timeLabel,
		startAt: event.startAt,
		googleCalendarUrl: calendar.toString(),
		calendarLabel: `Add ${event.name} to Google Calendar: ${dateLabel}, ${timeLabel}`,
		venueName,
		venueAddress,
		venueUrl: event.venue.url,
		venueLabel,
		venueWebsite: venuePending ? "" : websitePending ? "Website to be announced" : "Visit website",
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
	const venueStart = websitePending
		? `<div class="event-detail venue-card" role="group" aria-label="${escapeXml(venueLabel)}">`
		: `<a class="event-detail venue-card" href="${escapeXml(event.venue.url)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeXml(venueLabel)}">`;
	const markup = template
		.replaceAll("{{venueStart}}", venueStart)
		.replaceAll("{{venueEnd}}", websitePending ? "</div>" : "</a>")
		.replaceAll(
			"{{venueArrow}}",
			websitePending ? "" : '<span class="venue-arrow" aria-hidden="true">\u2197</span>',
		);
	return markup.replace(/\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g, (_match, key: string) => {
		const value = values[key];
		if (value === undefined) throw Error(`Unknown event template field: ${key}`);
		return escapeXml(value);
	});
}

export function eventCalendar(event: EventConfig, origin = event.origin): string {
	if (!event.calendarUid && !event.comingSoon)
		throw Error("Event config calendarUid is required when registration is open");
	const uid =
		event.calendarUid ||
		`draft-${createHash("sha256")
			.update(JSON.stringify([event.origin, event.startAt, event.name]))
			.digest("hex")
			.slice(0, 32)}@${new URL(event.origin).hostname}`;
	const calendar = ical({
		name: event.name,
		prodId: { company: "Bluesky Meetup", product: "Event Signup", language: "EN" },
	});
	calendar.createEvent({
		id: uid,
		start: new Date(event.startAt),
		end: new Date(event.endAt),
		summary: event.name,
		description: `${event.tagline} ${event.description}`,
		location:
			event.venue.name === "TBA"
				? "Venue to be announced soon"
				: `${event.venue.name}, ${event.venue.address}`,
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

export function renderSocialPreview(
	event: EventConfig,
	logo: string | Buffer,
	logoType = "image/svg+xml",
): string {
	const start = new Date(event.startAt);
	const end = new Date(event.endAt);
	const date = new Intl.DateTimeFormat(event.locale, {
		timeZone: event.timeZone,
		weekday: "short",
		month: "short",
		day: "numeric",
		year: "numeric",
	}).format(start);
	const time = new Intl.DateTimeFormat(event.locale, {
		timeZone: event.timeZone,
		timeStyle: "short",
	});
	const zone =
		new Intl.DateTimeFormat(event.locale, { timeZone: event.timeZone, timeZoneName: "short" })
			.formatToParts(start)
			.find((part) => part.type === "timeZoneName")?.value ?? event.timeZone;
	const venuePending = event.venue.name === "TBA";
	const venueDisplay = venuePending
		? "Venue to be announced soon"
		: `${event.venue.name} \u00b7 ${event.venue.address}`;
	const prefix = `${event.branding.name} `;
	const titles = event.name.startsWith(prefix)
		? [event.branding.name, event.name.slice(prefix.length)]
		: [event.name];
	function text(
		value: string,
		x: number,
		y: number,
		size: number,
		color: string,
		weight = 400,
	): string {
		const fitted = Math.min(size, Math.floor(1040 / Math.max(1, Array.from(value).length * 0.65)));
		return `<text x="${x}" y="${y}" fill="${color}" font-size="${fitted}" font-weight="${weight}">${escapeXml(value)}</text>`;
	}
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${event.branding.socialImageWidth}" height="${event.branding.socialImageHeight}" viewBox="0 0 1200 630">
<title>${escapeXml(event.name)}</title>
<desc>${escapeXml(`${event.tagline} ${date}, ${time.format(start)} to ${time.format(end)} ${zone}. ${venueDisplay}.`)}</desc>
<rect width="1200" height="630" fill="#fff"/>
<rect width="16" height="630" fill="${event.branding.color}"/>
<image x="80" y="60" width="170" height="150" href="data:${logoType};base64,${Buffer.from(logo).toString("base64")}"/>
<g font-family="DejaVu Sans, Arial, sans-serif">
<text x="1120" y="99" text-anchor="end" fill="${event.branding.color}" font-size="25" font-weight="600">${escapeXml(new URL(event.origin).host)}</text>
${event.comingSoon ? '<text x="1120" y="151" text-anchor="end" fill="#526176" font-size="24">Signups coming soon</text>' : ""}
${text(titles[0] ?? event.name, 76, 287, 76, "#10233f", 700)}
${titles[1] ? text(titles[1], 76, 374, 76, "#10233f", 700) : ""}
${text(event.tagline, 80, 430, 30, "#526176")}
${text(`${date} \u00b7 ${time.format(start)}\u2013${time.format(end)} ${zone}`, 80, 515, 33, event.branding.color, 700)}
${text(venueDisplay, 80, 562, 28, "#10233f")}
</g>
</svg>`;
}
