// @vitest-environment happy-dom
import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { buttonApproval } from "../shared/button.js";
import type { ClientState } from "../shared/types.js";

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.replaceChildren();
	vi.resetModules();
});

async function setup(version: number) {
	const html = await readFile("public/index.html", "utf8");
	document.body.innerHTML = html.split("<body>")[1]?.split("</body>")[0] ?? "";
	const state: ClientState = {
		profile: {
			did: "did:plc:synthetic",
			handle: "current.test",
			avatar: "data:image/png;base64,AA==",
		},
		csrf: "synthetic",
		responseVersion: "v1",
		futureMeetups: false,
		preview: { profile: "current", saved: "saved" },
		response: {
			did: "did:plc:synthetic",
			handle: "old.test",
			attendance: "coming",
			updatedAt: 1,
			artwork: {
				avatar: "data:image/png;base64,AQ==",
				handle: "old.test",
				style: "handle",
				label: "Friend",
				rendererVersion: version,
				approvedAt: 1,
				...(version === 2 ? { position: "top" as const } : {}),
			},
		},
		admin: false,
		policy: { responseCutoff: null, buttonCutoff: null, artworkDeleteAt: null },
	};
	const calls: { path: string; body: Record<string, unknown> }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (path, init) => {
			if (init?.method === "PUT") {
				const body = JSON.parse(init.body);
				calls.push({ path, body });
				if (path === "/api/response" && state.response?.artwork) {
					state.response.artwork = {
						...state.response.artwork,
						position: body.position,
						color: body.color,
						rendererVersion: 3,
						approvedAt: 2,
					};
				}
				return new Response("{}");
			}
			return new Response(JSON.stringify(state));
		}),
	);
	await import("./main.js");
	await vi.waitFor(() => expect(document.getElementById("status")?.textContent).toBe(""));
	return {
		state,
		calls,
		position: document.getElementById("text-position") as HTMLSelectElement,
		form: document.getElementById("response") as HTMLFormElement,
	};
}
it("preserves version 2 on unrelated saves and previews, approves and reloads Top black text", async () => {
	const { calls, position, form } = await setup(2);
	const color = document.getElementById("text-color") as HTMLSelectElement;
	expect(color.value).toBe("white");
	expect(document.querySelector('label[for="text-color"]')?.textContent).toBe("Text color");
	expect(document.querySelector("#preview svg")?.getAttribute("data-renderer")).toBe("2");
	(document.getElementById("future-meetups") as HTMLInputElement).checked = true;
	form.dispatchEvent(new Event("submit", { cancelable: true }));
	await vi.waitFor(() => expect(calls).toHaveLength(1));
	expect(calls[0]?.path).toBe("/api/preferences");
	await vi.waitFor(() =>
		expect(document.getElementById("status")?.textContent).toContain("Signup saved"),
	);
	expect(document.querySelector("#preview svg")?.getAttribute("data-renderer")).toBe("2");
	color.value = "black";
	color.dispatchEvent(new Event("change", { bubbles: true }));
	expect(position.value).toBe("top");
	expect(document.querySelector("#preview text")?.getAttribute("fill")).toBe("black");
	expect(document.querySelector("#preview text")?.getAttribute("stroke")).toBe("white");
	expect(document.querySelector("#preview svg")?.getAttribute("data-renderer")).toBe("3");
	form.dispatchEvent(new Event("submit", { cancelable: true }));
	await vi.waitFor(() => expect(calls).toHaveLength(2));
	expect(calls[1]).toMatchObject({
		path: "/api/response",
		body: {
			color: "black",
			position: "top",
			artworkApproval: buttonApproval("saved", "handle", "Friend", "top", "black"),
		},
	});
	await vi.waitFor(() => expect(color.value).toBe("black"));
	const style = document.getElementById("style") as HTMLSelectElement;
	style.value = "pfp";
	style.dispatchEvent(new Event("change", { bubbles: true }));
	expect(document.getElementById("color-option")?.hidden).toBe(true);
	expect(document.querySelector("#preview text")).toBeNull();
});
it("loads Top, live previews Bottom, binds approval, and reloads the saved position", async () => {
	const { state, calls, position, form } = await setup(2);
	expect(position.value).toBe("top");
	position.value = "bottom";
	position.dispatchEvent(new Event("change", { bubbles: true }));
	expect(document.querySelector("#preview path")?.getAttribute("d")).toContain("0 0 0");
	form.dispatchEvent(new Event("submit", { cancelable: true }));
	await vi.waitFor(() =>
		expect(document.getElementById("status")?.textContent).toContain("Signup saved"),
	);
	expect(calls[0]).toMatchObject({
		path: "/api/response",
		body: {
			position: "bottom",
			artworkApproval: buttonApproval("saved", "handle", "Friend", "bottom"),
		},
	});
	expect(position.value).toBe("bottom");
	expect(state.response?.artwork?.position).toBe("bottom");
});
it("previews version 1 unchanged, preserves preference-only saves, and upgrades only on explicit artwork edit", async () => {
	const { calls, position, form } = await setup(1);
	expect(position.value).toBe("bottom");
	expect(document.querySelector("#preview svg")?.getAttribute("data-renderer")).toBe("1");
	(document.getElementById("future-meetups") as HTMLInputElement).checked = true;
	form.dispatchEvent(new Event("submit", { cancelable: true }));
	await vi.waitFor(() =>
		expect(document.getElementById("status")?.textContent).toContain("Signup saved"),
	);
	expect(calls[0]?.path).toBe("/api/preferences");
	expect(document.querySelector("#preview svg")?.getAttribute("data-renderer")).toBe("1");
	position.value = "top";
	position.dispatchEvent(new Event("change", { bubbles: true }));
	expect(document.querySelector("#preview svg")?.getAttribute("data-renderer")).toBe("3");
	form.dispatchEvent(new Event("submit", { cancelable: true }));
	await vi.waitFor(() => expect(calls).toHaveLength(2));
	expect(calls[1]).toMatchObject({ path: "/api/response", body: { position: "top" } });
});
