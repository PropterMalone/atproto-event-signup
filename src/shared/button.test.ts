import { expect, it } from "vitest";
import {
	buttonApproval,
	defaultButtonLabel,
	normalizeButtonLabel,
	renderButton,
} from "./button.js";

it("places upright text near the outer edge and binds its position into approval", () => {
	const art = { avatar: "", style: "handle" as const, label: "@Friend" };
	const bottom = renderButton({ ...art, position: "bottom" }, "bottom");
	const top = renderButton({ ...art, position: "top" }, "top");
	expect(bottom).toContain('d="M 4.5 29 A 24.5 24.5 0 0 0 53.5 29"');
	expect(top).toContain('d="M 4.5 29 A 24.5 24.5 0 0 1 53.5 29"');
	for (const svg of [top, bottom]) {
		expect(svg).toContain('font-size="3.2" font-weight="600"');
		expect(svg).toContain('stroke-width="0.3"');
		expect(svg).not.toContain("textLength");
		expect(svg).not.toContain("rotate");
	}
	expect(renderButton(art, "bottom")).toBe(bottom);
	expect(buttonApproval("source", "handle", art.label, "top")).not.toBe(
		buttonApproval("source", "handle", art.label, "bottom"),
	);
	expect(JSON.parse(buttonApproval("source", "handle", art.label, "top"))).toEqual([
		3,
		"source",
		"handle",
		art.label,
		"top",
		"white",
	]);
	const legacy = renderButton({ ...art, rendererVersion: 1 }, "old");
	expect(legacy).toContain("A 21.5 21.5");
	expect(legacy).toContain('stroke-width="0.9"');
	expect(legacy).toContain('data-renderer="1"');
});

it("shortens only the exact terminal hosting suffix and adds one @", () => {
	expect(defaultButtonLabel("@Friend.BSKY.SOCIAL")).toBe("@Friend");
	expect(defaultButtonLabel("friend.bsky.social.example")).toBe("@friend.bsky.social.example");
	expect(defaultButtonLabel("custom.example")).toBe("@custom.example");
});
it("normalizes Unicode and rejects empty, controls, invalid Unicode and unreadably long names", () => {
	expect(normalizeButtonLabel("  Cafe\u0301 👋  ")).toBe("Café 👋");
	for (const name of [
		"",
		"  ",
		"bad\nname",
		"bad\u202ename",
		"\ud800",
		"a".repeat(41),
		"界".repeat(30),
	])
		expect(normalizeButtonLabel(name)).toBeNull();
	expect(normalizeButtonLabel('@A "&<👋')).toBe('@A "&<👋');
});
it("uses escaped curved white outlined text, local raster only, and unique safe ids", () => {
	const art = { avatar: "data:image/png;base64,AA==", style: "handle" as const, label: '@A "&<👋' };
	const first = renderButton(art, "first");
	expect(first).toContain("<textPath");
	expect(first).toContain("@A &quot;&amp;&lt;👋");
	expect(first).toContain('paint-order="stroke fill"');
	expect(first).toContain('fill="white" stroke="black"');
	expect(first).not.toEqual(renderButton(art, "second"));
	expect(renderButton({ ...art, style: "pfp" }, "pfp")).not.toContain("<text");
	expect(renderButton({ ...art, avatar: "https://evil.test/pic.svg" }, "unsafe")).not.toContain(
		"evil.test",
	);
	expect(buttonApproval("source", "handle", art.label)).not.toBe(
		buttonApproval("source", "handle", "Other"),
	);
});
