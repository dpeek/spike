import { describe, expect, onTestFinished, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeRequest, createRequest, listRequests, loadRequest } from "./request.ts";
import { serializeDocument } from "./durable-state.ts";

async function root(): Promise<string> {
  const path = join(tmpdir(), `spike-request-${crypto.randomUUID()}`);
  onTestFinished(() => rm(path, { recursive: true, force: true }));
  return path;
}

describe("Request store", () => {
  test("allocates distinct monotonic identities concurrently", async () => {
    const data = await root();
    const created = await Promise.all(Array.from({ length: 16 }, (_, index) => createRequest({
      hostPaths: { dataRoot: data }, title: `Request ${index}`, statement: "Keep this future work.", projects: index % 2 ? ["spike"] : [],
    })));
    expect(created.map((request) => request.metadata.requestId).sort()).toEqual(
      Array.from({ length: 16 }, (_, index) => `request-${String(index + 1).padStart(3, "0")}`),
    );
  });

  test("rejects invalid titles before creating Request storage", async () => {
    const data = await root();
    for (const title of ["", " \t ", "two\nlines", "two\rlines", "x".repeat(201), undefined, null, 42]) {
      await expect(createRequest({ hostPaths: { dataRoot: data }, title: title as string, statement: "Future work." })).rejects.toThrow("Request title");
      expect(await Bun.file(data).exists()).toBe(false);
    }
    const created = await createRequest({ hostPaths: { dataRoot: data }, title: "x".repeat(200), statement: "Future work." });
    expect(created.body).toStartWith(`# ${"x".repeat(200)}\n`);
  });

  test("filters open, closed, Project, and unassigned Requests", async () => {
    const data = await root();
    const unassigned = await createRequest({ hostPaths: { dataRoot: data }, title: "Unassigned", statement: "Future work." });
    const assigned = await createRequest({ hostPaths: { dataRoot: data }, title: "Assigned", statement: "Future work.", projects: ["spike", "other"] });
    await closeRequest({ hostPaths: { dataRoot: data }, requestId: assigned.metadata.requestId, disposition: "declined", statement: "No longer needed." });
    expect((await listRequests({ hostPaths: { dataRoot: data } })).map((request) => request.metadata.requestId)).toEqual([unassigned.metadata.requestId]);
    expect((await listRequests({ hostPaths: { dataRoot: data }, unassigned: true })).map((request) => request.metadata.requestId)).toEqual([unassigned.metadata.requestId]);
    expect(await listRequests({ hostPaths: { dataRoot: data }, project: "spike" })).toEqual([]);
    expect((await listRequests({ hostPaths: { dataRoot: data }, project: "spike", closed: true })).map((request) => request.metadata.requestId)).toEqual([assigned.metadata.requestId]);
  });

  test("returns lightweight title summaries in identity order", async () => {
    const data = await root();
    const first = await createRequest({ hostPaths: { dataRoot: data }, title: "First Request", statement: "Future work." });
    const second = await createRequest({ hostPaths: { dataRoot: data }, title: "Second Request", statement: "Future work.", projects: ["spike"] });
    await closeRequest({ hostPaths: { dataRoot: data }, requestId: second.metadata.requestId, disposition: "addressed", statement: "Done." });

    expect(await listRequests({ hostPaths: { dataRoot: data } })).toEqual([{
      metadata: first.metadata,
      title: "First Request",
      state: "open",
    }]);
    const closed = await listRequests({ hostPaths: { dataRoot: data }, closed: true });
    expect(closed).toEqual([{ metadata: second.metadata, title: "Second Request", state: "closed" }]);
    expect("body" in closed[0]!).toBe(false);
    expect("closure" in closed[0]!).toBe(false);
    expect((await loadRequest(data, second.metadata.requestId)).closure?.body).toBe("Done.\n");
  });

  test("rejects malformed Request headings while loading and listing", async () => {
    for (const body of ["No heading\n", "# \n\nFuture work.\n", "## Wrong level\n\nFuture work.\n", `# ${"x".repeat(201)}\n\nFuture work.\n`]) {
      const data = await root();
      await mkdir(join(data, "requests", "request-001"), { recursive: true });
      await writeFile(
        join(data, "requests", "request-001", "request.md"),
        serializeDocument({ kind: "request", requestId: "request-001", createdAt: "2026-01-01T00:00:00.000Z", projects: [] }, body),
      );
      await expect(loadRequest(data, "request-001")).rejects.toThrow("Request body must start with a nonempty '# <title>' heading");
      await expect(listRequests({ hostPaths: { dataRoot: data } })).rejects.toThrow("Request body must start with a nonempty '# <title>' heading");
    }
  });

  test("rejects malformed and symlinked durable documents", async () => {
    const data = await root();
    await mkdir(join(data, "requests", "request-001"), { recursive: true });
    await writeFile(join(data, "requests", "request-001", "request.md"), "not markdown");
    await expect(listRequests({ hostPaths: { dataRoot: data } })).rejects.toThrow("document must start with JSON frontmatter");
    await rm(join(data, "requests"), { recursive: true });
    await mkdir(join(data, "requests", "request-001"), { recursive: true });
    await writeFile(join(data, "outside.md"), "---\n{}\n---\n");
    await symlink(join(data, "outside.md"), join(data, "requests", "request-001", "request.md"));
    await expect(loadRequest(data, "request-001")).rejects.toThrow("symbolic links");
  });

  test("refuses missing and repeated closures without replacing evidence", async () => {
    const data = await root();
    await expect(closeRequest({ hostPaths: { dataRoot: data }, requestId: "request-001", disposition: "declined", statement: "No." })).rejects.toThrow();
    const request = await createRequest({ hostPaths: { dataRoot: data }, title: "Close me", statement: "Future work." });
    const closed = await closeRequest({ hostPaths: { dataRoot: data }, requestId: request.metadata.requestId, disposition: "withdrawn", statement: "Withdrawn." });
    await expect(closeRequest({ hostPaths: { dataRoot: data }, requestId: request.metadata.requestId, disposition: "declined", statement: "Replacement." })).rejects.toThrow("already closed");
    expect((await loadRequest(data, request.metadata.requestId)).closure).toEqual(closed.closure);
  });
});
