import { copyFile, mkdir } from "node:fs/promises";

await mkdir("dist/public", { recursive: true });
for (const file of [
	"index.html",
	"style.css",
	"happy-hour.ics",
	"social-preview.png",
	"favicon.svg",
	"favicon-32.png",
	"apple-touch-icon.png",
	"icon-192.png",
	"icon-512.png",
	"site.webmanifest",
])
	await copyFile(`public/${file}`, `dist/public/${file}`);
