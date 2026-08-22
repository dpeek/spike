import { describe, expect, test } from "bun:test";
import { rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { guidancePaths, loadGuidance } from "./guidance.ts";
import { fixtureGuidance, temporaryRepository } from "../test/support/repository.ts";


async function fixture() {
  const repository = await temporaryRepository();
  return repository;
}

describe("workflow guidance", () => {
  test("loads exact Markdown from an exact committed revision", async () => {
    const repository = await fixture();
    await writeFile(join(repository.root, guidancePaths.implement), "# New implementation guidance\n");
    await repository.git("add", guidancePaths.implement);
    await repository.git("commit", "--quiet", "-m", "Change guidance");
    const newerRevision = await repository.git("rev-parse", "HEAD");

    expect(await loadGuidance(repository.root, "implement", repository.head)).toEqual({
      step: "implement",
      path: guidancePaths.implement,
      revision: repository.head,
      markdown: fixtureGuidance.implement,
    });
    expect((await loadGuidance(repository.root, "implement", newerRevision)).markdown).toBe(
      "# New implementation guidance\n",
    );
    await expect(loadGuidance(repository.root, "implement", "HEAD")).rejects.toThrow(
      "guidance revision must identify a commit exactly",
    );
  });

  test("rejects missing, non-regular, blank, and oversized guidance", async () => {
    const missing = await fixture();
    await missing.git("rm", "--quiet", guidancePaths.review);
    await missing.git("commit", "--quiet", "-m", "Remove guidance");
    await expect(loadGuidance(missing.root, "review", await missing.git("rev-parse", "HEAD"))).rejects.toThrow(
      "guidance does not exist",
    );

    const linked = await fixture();
    await rm(join(linked.root, guidancePaths.review));
    await symlink("../../README.md", join(linked.root, guidancePaths.review));
    await linked.git("add", guidancePaths.review);
    await linked.git("commit", "--quiet", "-m", "Link guidance");
    await expect(loadGuidance(linked.root, "review", await linked.git("rev-parse", "HEAD"))).rejects.toThrow(
      "guidance must be a regular Git file",
    );

    const blank = await fixture();
    await writeFile(join(blank.root, guidancePaths.review), " \n");
    await blank.git("add", guidancePaths.review);
    await blank.git("commit", "--quiet", "-m", "Blank guidance");
    await expect(loadGuidance(blank.root, "review", await blank.git("rev-parse", "HEAD"))).rejects.toThrow(
      "guidance must not be blank",
    );

    const oversized = await fixture();
    await writeFile(join(oversized.root, guidancePaths.review), "x".repeat(32 * 1024 + 1));
    await oversized.git("add", guidancePaths.review);
    await oversized.git("commit", "--quiet", "-m", "Oversized guidance");
    await expect(loadGuidance(oversized.root, "review", await oversized.git("rev-parse", "HEAD"))).rejects.toThrow(
      "Git blob exceeds 32768 bytes",
    );
  }, 15_000);
});
