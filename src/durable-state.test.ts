import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installImmutable, parseDocument, readDocument, replaceAtomic, serializeDocument } from "./durable-state.ts";

describe("durable Markdown documents", () => {
  test("serializes canonical JSON frontmatter and parses the body", () => {
    const source = serializeDocument({ z: 1, nested: { z: true, a: false }, a: "first" }, "# Body\n");
    expect(source).toBe(`---
{
  "a": "first",
  "nested": {
    "a": false,
    "z": true
  },
  "z": 1
}
---

# Body
`);
    expect(parseDocument(source)).toEqual({
      metadata: { a: "first", nested: { a: false, z: true }, z: 1 },
      body: "# Body\n",
    });
  });

  test("installs immutable documents and atomically replaces mutable documents", async () => {
    const root = await mkdtemp(join(tmpdir(), "spike-state-"));
    const path = join(root, "projects", "spike", "plan.md");
    try {
      await installImmutable(root, path, serializeDocument({ kind: "plan" }, "first"));
      await expect(installImmutable(root, path, "replacement")).rejects.toThrow("already exists");
      await replaceAtomic(root, path, serializeDocument({ kind: "plan" }, "second"));
      expect((await readDocument(root, path)).body).toBe("second\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("publishes one complete immutable document without replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "spike-state-"));
    const path = join(root, "projects", "spike", "report.md");
    try {
      const publications = await Promise.allSettled([
        installImmutable(root, path, serializeDocument({ kind: "report", ticket: "first" }, "first")),
        installImmutable(root, path, serializeDocument({ kind: "report", ticket: "second" }, "second")),
      ]);

      expect(publications.filter((publication) => publication.status === "fulfilled")).toHaveLength(1);
      expect(publications.filter((publication) => publication.status === "rejected")).toHaveLength(1);
      expect(["first\n", "second\n"]).toContain((await readDocument(root, path)).body);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects symlinked workflow paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "spike-state-"));
    const outside = await mkdtemp(join(tmpdir(), "spike-outside-"));
    try {
      await mkdir(join(root, "projects"));
      await symlink(outside, join(root, "projects", "spike"));
      await expect(installImmutable(root, join(root, "projects", "spike", "goal.md"), "nope")).rejects.toThrow(
        "must not contain symbolic links",
      );
    } finally {
      await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
    }
  });
});
