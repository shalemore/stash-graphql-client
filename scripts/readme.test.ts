import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dir = new URL("../.readme/", import.meta.url);
const importCreateStash = `import { createStash } from "stash-graphql-client";\n`;
const declareStash = `const stash = createStash({ endpoint: "http://localhost:9999/graphql" });\n`;

/** A `// ~~~` marker under a line means the README shows a type error there. */
function expectErrors(code: string) {
  const lines = code.split("\n");
  return lines
    .flatMap((line, index) =>
      /^\s*\/\/\s+~+/.test(lines[index + 1] ?? "") ? ["// @ts-expect-error", line] : [line],
    )
    .join("\n");
}

/** Examples may omit the client setup that the Quick start already shows. */
function withPrelude(code: string) {
  const needsImport = !/import \{[^}]*\bcreateStash\b/.test(code);
  const needsStash = /\bstash\./.test(code) && !/\bconst stash\b/.test(code);
  return `${needsImport ? importCreateStash : ""}${needsStash ? declareStash : ""}${code}`;
}

test("the TypeScript examples in the README type-check", async () => {
  const readme = await Bun.file(new URL("../README.md", import.meta.url)).text();
  const blocks = [...readme.matchAll(/^```ts\n([\s\S]*?)^```$/gm)].map((match) => match[1] ?? "");

  await rm(dir, { recursive: true, force: true });
  await mkdir(dir);
  await Bun.write(
    new URL("tsconfig.json", dir),
    JSON.stringify({
      extends: "../tsconfig.json",
      compilerOptions: {
        noEmit: true,
        noUnusedLocals: false,
        noPropertyAccessFromIndexSignature: false,
      },
      include: ["*.ts"],
    }),
  );
  await Promise.all(
    blocks.map((code, index) =>
      Bun.write(new URL(`example-${index}.ts`, dir), withPrelude(expectErrors(code))),
    ),
  );

  const tsc = Bun.spawn(["bun", "tsc", "-p", fileURLToPath(dir)], { stdout: "pipe" });
  const output = await new Response(tsc.stdout).text();
  expect(output).toBe("");
  expect(await tsc.exited).toBe(0);
  await rm(dir, { recursive: true });
}, 60_000);
