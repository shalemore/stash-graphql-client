import { createClient } from "graphql-ws";

import {
  buildRequest,
  createStash,
  operation,
  StashError,
  type CriterionModifier,
  type Result,
  type SceneFilterType,
  type Selection,
} from "@shalemore/stash-api";
import { createRunner, findScenes } from "@shalemore/stash-api/operations";

/** Type-checked by `bun check` so the README examples cannot drift from the API. */
export async function readmeExamples() {
  const stash = createStash({
    endpoint: "http://localhost:9999/graphql",
    apiKey: process.env["STASH_API_KEY"],
  });

  const { count, performers } = await stash.findPerformers(
    { filter: { per_page: 20, sort: "name", direction: "ASC" } },
    { count: true, performers: { id: true, name: true, favorite: true } },
  );
  const typedPerformers: { id: string; name: string; favorite: boolean }[] = performers;
  const typedCount: number = count;

  const scene = await stash.findScene(
    { id: "42" },
    {
      id: true,
      title: true,
      rating100: true,
      studio: { id: true, name: true },
      performers: { id: true, name: true },
      files: { path: true, duration: true },
    },
  );
  const title: string | null | undefined = scene?.title;

  await stash.findGroups(undefined, {
    groups: { id: true, name: true, scene_count: { $args: { depth: -1 } } },
  });

  const image = await stash.findImage(
    { id: "7" },
    { visual_files: { $on: { ImageFile: { path: true, width: true, height: true } } } },
  );
  for (const file of image?.visual_files ?? [])
    if (file.__typename === "ImageFile") console.log(file.width, file.height);

  const favorites: SceneFilterType = {
    performer_favorite: true,
    rating100: { value: 80, modifier: "GREATER_THAN" satisfies CriterionModifier },
  };
  await stash.findScenes({ scene_filter: favorites }, { count: true });

  const performerCard = {
    id: true,
    name: true,
    image_path: true,
    tags: { id: true, name: true },
  } as const satisfies Selection<"Performer">;
  type PerformerCard = Result<"Performer", typeof performerCard>;
  const cards = await stash.findPerformers(undefined, { performers: performerCard });
  const typedCards: PerformerCard[] = cards.performers;

  const totals = await stash.batch({
    scenes: operation("findScenes", undefined, { count: true }),
    images: operation("findImages", undefined, { count: true }),
    performers: operation("findPerformers", undefined, { count: true }),
  });
  const total: number = totals.scenes.count;

  await stash.performerUpdate(
    { input: { id: "3", favorite: true, rating100: 90 } },
    { id: true, favorite: true, rating100: true },
  );
  const deleted: boolean = await stash.performerDestroy({ input: { id: "3" } });
  await stash.importObjects({
    input: {
      file: Bun.file("export.zip"),
      duplicateBehaviour: "IGNORE",
      missingRefBehaviour: "IGNORE",
    },
  });

  const live = createStash({
    endpoint: "http://localhost:9999/graphql",
    subscriptions: createClient({ url: "ws://localhost:9999/graphql" }),
  });
  for await (const update of live.jobsSubscribe(undefined, {
    type: true,
    job: { id: true, description: true, progress: true },
  })) {
    console.log(update.type, update.job.progress);
    if (update.type === "REMOVE") break;
  }

  createClient({ url: "ws://localhost:9999/graphql", webSocketImpl: AuthenticatedWebSocket });

  await stash.request(`query ($id: ID!) { scene: findScene(id: $id) { id title } }`, { id: "42" });
  const body = buildRequest([[undefined, operation("findScenes", undefined, { count: true })]]);
  console.log(body);

  try {
    await stash.findScene({ id: "42" }, { id: true });
  } catch (error) {
    if (error instanceof StashError) console.error(error.status, error.errors);
  }

  const runner = createRunner({ endpoint: "/graphql" });
  const { count: n2 } = await runner.run(findScenes(undefined, { count: true }));
  console.log(typedPerformers, typedCount, title, typedCards, total, deleted, n2);
}

class AuthenticatedWebSocket extends WebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, {
      protocols: typeof protocols === "string" ? [protocols] : protocols,
      headers: { ApiKey: process.env["STASH_API_KEY"] },
    });
  }
}
