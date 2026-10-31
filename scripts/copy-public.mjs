import { copyFile, mkdir } from "node:fs/promises";
import { loadEventConfig } from "../dist/server/event.js";

const event = await loadEventConfig();
await mkdir("dist/public", { recursive: true });
for (const file of new Set([
	"index.html",
	"style.css",
	...[
		event.branding.mark,
		event.branding.favicon,
		event.branding.favicon32,
		event.branding.appleTouchIcon,
		event.branding.icon192,
		event.branding.icon512,
		event.branding.socialImage,
	].map((path) => path.slice(1)),
]))
	await copyFile(`public/${file}`, `dist/public/${file}`);
