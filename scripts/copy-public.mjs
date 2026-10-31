import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { Resvg } from "@resvg/resvg-js";
import { loadEventConfig, renderSocialPreview } from "../dist/server/event.js";

const event = await loadEventConfig();
if (event.branding.socialImage === "/social-preview.png") {
	const logo = await readFile(`public${event.branding.mark}`);
	const svg = renderSocialPreview(
		event,
		logo,
		event.branding.mark.endsWith(".svg") ? "image/svg+xml" : "image/png",
	);
	const image = new Resvg(svg, {
		font: { loadSystemFonts: true, defaultFontFamily: "DejaVu Sans" },
	}).render();
	await writeFile("public/social-preview.svg", svg);
	await writeFile("public/social-preview.png", image.asPng());
}
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
