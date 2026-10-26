import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
	assert.match(pageHtml, /DC Bluesky happy hour/);
	assert.match(pageHtml, /property="og:type" content="website"/);
	assert.match(pageHtml, /property="og:url" content="https:\/\/dcbsky\.com\/"/);
	assert.match(
		pageHtml,
		/property="og:image" content="https:\/\/dcbsky\.com\/social-preview\.png"/,
	);
	assert.match(pageHtml, /property="og:image:width" content="1200"/);
	assert.match(pageHtml, /property="og:image:height" content="630"/);
	assert.match(pageHtml, /property="og:image:alt" content="Three blue butterflies/);
	assert.match(pageHtml, /name="twitter:card" content="summary_large_image"/);
	const calendarLink = pageHtml.match(/href="(https:\/\/calendar\.google\.com[^"]+)"/);
	assert.ok(calendarLink);
	const googleEvent = new URL(calendarLink[1].replaceAll("&amp;", "&"));
	assert.equal(googleEvent.searchParams.get("action"), "TEMPLATE");
	assert.equal(googleEvent.searchParams.get("dates"), "20261110T230000Z/20261111T020000Z");
	assert.equal(googleEvent.searchParams.get("ctz"), "America/New_York");
	assert.equal(googleEvent.searchParams.get("location"), "Sudhouse, 1340 U St NW, Washington, DC");
	for (const asset of ["/app.js", "/style.css"])
		assert.equal((await fetch(origin + asset)).status, 200);
	for (const [path, type] of [
		["/social-preview.png", "image/png"],
		["/favicon.svg", "image/svg+xml"],
		["/favicon-32.png", "image/png"],
		["/apple-touch-icon.png", "image/png"],
		["/icon-192.png", "image/png"],
		["/icon-512.png", "image/png"],
		["/site.webmanifest", "application/manifest+json; charset=utf-8"],
	]) {
		const response = await fetch(origin + path);
		assert.equal(response.status, 200, path);
		assert.equal(response.headers.get("content-type"), type, path);
		const body = Buffer.from(await response.arrayBuffer());
		if (type === "image/png")
			assert.deepEqual(body.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), path);
		if (path === "/social-preview.png") {
			assert.equal(body.readUInt32BE(16), 1200);
			assert.equal(body.readUInt32BE(20), 630);
			assert.equal(response.headers.get("set-cookie"), null);
			assert.equal(response.headers.get("x-content-type-options"), "nosniff");
			assert.ok(response.headers.get("content-security-policy").includes("img-src 'self' data:"));
		}
		if (path === "/favicon.svg") assert.match(body.toString(), /#0560FF/i);
		if (path === "/site.webmanifest") {
			const manifest = JSON.parse(body.toString());
			assert.equal(manifest.name, "DC Bluesky");
			assert.equal(manifest.short_name, "DC Bluesky");
			assert.equal(manifest.display, "browser");
		}
	}
	const calendar = await fetch(`${origin}/happy-hour.ics`);
	assert.equal(calendar.status, 200);
	assert.equal(calendar.headers.get("content-type"), "text/calendar; charset=utf-8");
	const event = await calendar.text();
	assert.match(event, /DTSTART:20261110T230000Z/);
	assert.match(event, /DTEND:20261111T020000Z/);
	assert.match(event, /LOCATION:Sudhouse/);
	assert.match(event, /UID:20261110-happy-hour@dcbsky.com/);
	assert.ok(event.includes("\r\n"));
	assert.equal((await fetch(`${origin}/favicon.ico`)).status, 404);
	assert.equal((await (await fetch(`${origin}/api/me`)).json()).profile, null);
	for (const path of ["/api/admin", "/api/admin/print", "/api/admin/futurecontacts"])
		assert.equal((await fetch(origin + path)).status, 401);
	for (const path of [
		"/.env",
		"/docs/design.md",
		"/private/test",
		"/app.sqlite",
		"/social-preview.svg",
		"/public/social-preview.png",
		"/social-preview.png%2f..%2f.env",
		"/%2e%2e%2f.env",
	])
		assert.equal((await fetch(origin + path)).status, 404);
	assert.equal((await (await fetch(`${origin}/client-metadata.json`)).json()).scope, "atproto");
	assert.equal((await (await fetch(`${origin}/jwks.json`)).json()).keys[0].d, undefined);
	console.log(
		"Packaged HTTP smoke passed: health, landing/assets, signed-out state, admin denial, private-file denial, minimal OAuth metadata and public-only JWKS.",
	);
} finally {
	child.kill("SIGTERM");
	await new Promise((resolve) => child.once("exit", resolve));
	await rm(directory, { recursive: true, force: true });
}
