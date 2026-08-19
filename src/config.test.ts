import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadProjectConfig, resolveTicketModelSelection } from "./config.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "spike-config-test-"));
  roots.push(root);
  await writeFile(
    join(root, "spike.json"),
    `${JSON.stringify({
      project: { slug: "example-project" },
      models: {
        planner: { model: "planner", thinking: "high" },
        implement: { model: "implementer", thinking: "medium" },
        review: { model: "reviewer", thinking: "high" },
      },
    })}\n`,
  );
  return root;
}

describe("project model configuration", () => {
  test("loads role defaults and applies one-Ticket overrides", async () => {
    const root = await fixture();

    expect((await loadProjectConfig(root)).project).toEqual({ slug: "example-project" });
    expect((await loadProjectConfig(root)).models.planner).toEqual({ model: "planner", thinking: "high" });
    expect(await resolveTicketModelSelection(root, "implement")).toEqual({
      model: "implementer",
      thinking: "medium",
    });
    expect(await resolveTicketModelSelection(root, "review", { model: "special-reviewer", thinking: "low" })).toEqual({
      model: "special-reviewer",
      thinking: "low",
    });
  });

  test("rejects missing, malformed, and incomplete configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "spike-config-test-"));
    roots.push(root);
    await expect(loadProjectConfig(root)).rejects.toThrow("does not exist");

    await writeFile(join(root, "spike.json"), "not json\n");
    await expect(loadProjectConfig(root)).rejects.toThrow("not valid JSON");

    await writeFile(join(root, "spike.json"), '{"models":{}}\n');
    await expect(loadProjectConfig(root)).rejects.toThrow();

    await writeFile(
      join(root, "spike.json"),
      `${JSON.stringify({
        project: { slug: "Invalid Slug" },
        models: {
          planner: { model: "planner", thinking: "high" },
          implement: { model: "implementer", thinking: "medium" },
          review: { model: "reviewer", thinking: "high" },
        },
      })}\n`,
    );
    await expect(loadProjectConfig(root)).rejects.toThrow();
  });
});
