// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

const window = new Window({
	settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true },
});
const DOMParser = window.DOMParser;

function landingPage() {
	return new DOMParser().parseFromString(readFileSync("public/index.html", "utf8"), "text/html");
}

describe("public social preview", () => {
	it("has absolute public card metadata with matching image descriptions", () => {
		const page = landingPage();
		const meta = (key: string) =>
			page.querySelector(`meta[property="${key}"], meta[name="${key}"]`)?.getAttribute("content");
		expect(meta("og:type")).toBe("website");
		expect(meta("og:url")).toBe("https://dcbsky.com/");
		expect(meta("og:title")).toBe("DC Bluesky happy hour");
		expect(meta("og:description")).toBe(
			"Come meet the pocket friends. Tuesday, November 10, 6–9 p.m. at Sudhouse, 1340 U St NW, Washington, DC.",
		);
		expect(meta("og:image")).toBe("https://dcbsky.com/social-preview.png");
		expect(meta("og:image:type")).toBe("image/png");
		expect(meta("og:image:width")).toBe("1200");
		expect(meta("og:image:height")).toBe("630");
		expect(meta("og:image:alt")).toBe(
			"Three blue butterflies above two bars, inspired by the DC flag. DC Bluesky happy hour. Tuesday, November 10, 2026, 6–9 p.m. at Sudhouse, 1340 U St NW. Come meet the pocket friends.",
		);
		expect(meta("twitter:card")).toBe("summary_large_image");
		for (const key of ["title", "description", "image", "image:alt"])
			expect(meta(`twitter:${key}`)).toBe(meta(`og:${key}`));
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
