import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { calendarDate, loadEventConfig } from "../dist/server/event.js";

const eventConfig = await loadEventConfig();
const directory = await mkdtemp(join(tmpdir(), "dcbsky-smoke-"));
const port = 31987;
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["dist/server/main.js"], {
	env: { ...process.env, DATA_DIR: directory, PORT: String(port), APP_ORIGIN: origin },
	stdio: ["ignore", "pipe", "pipe"],
});
try {
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(Error("Startup deadline exceeded")), 10000);
		child.once("exit", (code) => {
			clearTimeout(timer);
			reject(Error(`Startup exited ${code}`));
		});
		child.stdout.on("data", (chunk) => {
			if (String(chunk).includes("listening")) {
				clearTimeout(timer);
				resolve();
			}
		});
	});
	assert.deepEqual(await (await fetch(`${origin}/health`)).json(), { ok: true });
	const page = await fetch(origin);
	assert.equal(page.status, 200);
	const pageHtml = await page.text();
	const parser = new Window({
		settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true },
	}).DOMParser;
	const document = new parser().parseFromString(pageHtml, "text/html");
	const meta = (key) =>
		document.querySelector(`meta[property="${key}"], meta[name="${key}"]`)?.getAttribute("content");
	assert.equal(document.querySelector("h1")?.textContent, eventConfig.name);
	assert.equal(meta("og:type"), "website");
	assert.equal(meta("og:title"), eventConfig.name);
	assert.equal(meta("og:url"), `${origin}/`);
	assert.equal(meta("og:image"), `${origin}${eventConfig.branding.socialImage}`);
	assert.equal(meta("og:image:width"), String(eventConfig.branding.socialImageWidth));
	assert.equal(meta("og:image:height"), String(eventConfig.branding.socialImageHeight));
	assert.ok(meta("og:image:alt").includes(eventConfig.branding.socialImageAlt));
	assert.equal(meta("twitter:card"), "summary_large_image");
	assert.ok(!pageHtml.includes("{{"));
	const calendarLink = document
		.querySelector('a[href^="https://calendar.google.com"]')
		?.getAttribute("href");
	assert.ok(calendarLink);
	const googleEvent = new URL(calendarLink);
	assert.equal(googleEvent.searchParams.get("action"), "TEMPLATE");
	assert.equal(googleEvent.searchParams.get("text"), eventConfig.name);
	assert.equal(
		googleEvent.searchParams.get("dates"),
		`${calendarDate(eventConfig.startAt)}/${calendarDate(eventConfig.endAt)}`,
	);
	assert.equal(googleEvent.searchParams.get("ctz"), eventConfig.timeZone);
	assert.equal(
		googleEvent.searchParams.get("location"),
		`${eventConfig.venue.name}, ${eventConfig.venue.address}`,
	);
	for (const asset of ["/app.js", "/style.css"])
		assert.equal((await fetch(origin + asset)).status, 200);
	for (const [path, type] of [
		...[
			...new Set([
				eventConfig.branding.mark,
				eventConfig.branding.favicon,
				eventConfig.branding.favicon32,
				eventConfig.branding.appleTouchIcon,
				eventConfig.branding.icon192,
				eventConfig.branding.icon512,
				eventConfig.branding.socialImage,
			]),
		].map((path) => [path, path.endsWith(".svg") ? "image/svg+xml" : "image/png"]),
		["/site.webmanifest", "application/manifest+json; charset=utf-8"],
	]) {
		const response = await fetch(origin + path);
		assert.equal(response.status, 200, path);
		assert.equal(response.headers.get("content-type"), type, path);
		const body = Buffer.from(await response.arrayBuffer());
		if (type === "image/png")
			assert.deepEqual(body.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), path);
		if (path === eventConfig.branding.socialImage) {
			assert.equal(body.readUInt32BE(16), eventConfig.branding.socialImageWidth);
			assert.equal(body.readUInt32BE(20), eventConfig.branding.socialImageHeight);
			assert.equal(response.headers.get("set-cookie"), null);
			assert.equal(response.headers.get("x-content-type-options"), "nosniff");
			assert.ok(response.headers.get("content-security-policy").includes("img-src 'self' data:"));
		}
		if (path === "/site.webmanifest") {
			const manifest = JSON.parse(body.toString());
			assert.equal(manifest.name, eventConfig.branding.name);
			assert.equal(manifest.short_name, eventConfig.branding.shortName);
			assert.equal(manifest.theme_color, eventConfig.branding.color);
			assert.equal(manifest.display, "browser");
		}
	}
	const calendar = await fetch(`${origin}/happy-hour.ics`);
	assert.equal(calendar.status, 200);
	assert.equal(calendar.headers.get("content-type"), "text/calendar; charset=utf-8");
	const event = await calendar.text();
	assert.ok(event.includes(`DTSTART:${calendarDate(eventConfig.startAt)}`));
	assert.ok(event.includes(`DTEND:${calendarDate(eventConfig.endAt)}`));
	assert.ok(event.includes(`UID:${eventConfig.calendarUid}`));
	assert.ok(event.includes("\r\n"));
	assert.equal((await fetch(`${origin}/favicon.ico`)).status, 404);
	assert.equal((await (await fetch(`${origin}/api/me`)).json()).profile, null);
	for (const path of ["/api/admin", "/api/admin/print", "/api/admin/futurecontacts"])
		assert.equal((await fetch(origin + path)).status, 401);
	for (const path of [
		"/.env",
		"/event.json",
		"/docs/design.md",
		"/private/test",
		"/app.sqlite",
		"/social-preview.svg",
		"/public/social-preview.png",
		"/social-preview.png%2f..%2f.env",
		"/%2e%2e%2f.env",
	])
		assert.equal((await fetch(origin + path)).status, 404);
	const metadata = await (await fetch(`${origin}/client-metadata.json`)).json();
	assert.equal(metadata.scope, "atproto");
	assert.equal(metadata.client_name, eventConfig.name);
	assert.equal((await (await fetch(`${origin}/jwks.json`)).json()).keys[0].d, undefined);
	console.log(
		"Packaged HTTP smoke passed: health, landing/assets, signed-out state, admin denial, private-file denial, minimal OAuth metadata and public-only JWKS.",
	);
} finally {
	child.kill("SIGTERM");
	await new Promise((resolve) => child.once("exit", resolve));
	await rm(directory, { recursive: true, force: true });
}
