import {
  createStash,
  StashError,
  type CriterionModifier,
  type Fields,
  type Result,
  type SceneFilterType,
} from "stash-graphql-client";

const tagFields = ({ id, name }: Fields<"Tag">) => ({ id, name });

const sceneFields = (scene: Fields<"Scene">) => ({
  id: scene.id,
  title: scene.title,
  tags: scene.tags(tagFields),
  performers: scene.performers(({ id, name }) => ({ id, name })),
});
type SceneItem = Result<typeof sceneFields>;

const tagTree = (tag: Fields<"Tag">) => ({
  ...tagFields(tag),
  children: tag.children(tagFields),
});

const sceneCard = (scene: Fields<"Scene">, withFiles: boolean) => ({
  ...sceneFields(scene),
  ...(withFiles ? { files: scene.files(({ path, size }) => ({ path, size })) } : {}),
});
const performerCard = (performer: Fields<"Performer">) => ({
  id: performer.id,
  name: performer.name,
  image: performer.image_path,
  tags: performer.tags(tagFields),
});

/** Type-checked by `bun check` so the README examples cannot drift from the API. */
export async function readmeExamples() {
  const stash = createStash({
    endpoint: "http://localhost:9999/graphql",
    apiKey: process.env["STASH_API_KEY"],
  });

  const { count, performers } = await stash.findPerformers(
    { filter: { per_page: 20, sort: "name", direction: "ASC" } },
    (result) => ({
      count: result.count,
      performers: result.performers((performer) => ({
        id: performer.id,
        name: performer.name,
        favorite: performer.favorite,
      })),
    }),
  );
  const typedPerformers: { id: string; name: string; favorite: boolean }[] = performers;
  const typedCount: number = count;

  // @ts-expect-error unknown field
  await stash.findPerformers((result) => ({ count: result.cont }));
  // @ts-expect-error not a SortDirectionEnum
  await stash.findPerformers({ filter: { direction: "UP" } }, (result) => ({
    count: result.count,
  }));

  const scene = await stash.findScene({ id: "42" }, (found) => ({
    id: found.id,
    title: found.title,
    rating100: found.rating100,
    studio: found.studio((studio) => ({ id: studio.id, name: studio.name })),
    files: found.files((file) => ({ path: file.path, duration: file.duration })),
  }));
  const studio: { id: string; name: string } | null | undefined = scene?.studio;

  const { groups } = await stash.findGroups((result) => ({
    groups: result.groups((group) => ({
      id: group.id,
      rating: group.rating100,
      directScenes: group.scene_count({ depth: 0 }),
      allScenes: group.scene_count({ depth: -1 }),
    })),
  }));
  const typedGroups: {
    id: string;
    rating: number | null;
    directScenes: number;
    allScenes: number;
  }[] = groups;

  const image = await stash.findImage({ id: "7" }, (found) => ({
    visual_files: found.visual_files((file) => ({
      ...file.$on("ImageFile", (picture) => ({ path: picture.path, width: picture.width })),
      ...file.$on("VideoFile", (video) => ({ path: video.path, duration: video.duration })),
    })),
  }));
  for (const file of image?.visual_files ?? []) {
    if (file.__typename === "ImageFile") console.log(file.width);
  }

  const favorites: SceneFilterType = {
    performer_favorite: true,
    rating100: { value: 80, modifier: "GREATER_THAN" satisfies CriterionModifier },
  };
  await stash.findScenes({ scene_filter: favorites }, (result) => ({ count: result.count }));

  type PerformerCard = Result<typeof performerCard>;
  const cards = await stash.findPerformers((result) => ({
    performers: result.performers(performerCard),
  }));
  const typedCards: PerformerCard[] = cards.performers;
  const card: {
    id: string;
    name: string;
    image: string | null;
    tags: { id: string; name: string }[];
  }[] = typedCards;

  const destructured = await stash.findGroups((found) => ({
    count: found.count,
    groups: found.groups(({ id, name, rating100, tags }) => ({
      id,
      name,
      rating: rating100,
      tags: tags(tagFields),
    })),
  }));
  const ratings: (number | null)[] = destructured.groups.map((group) => group.rating);

  const { scenes } = await stash.findScenes((found) => ({
    scenes: found.scenes((item) => sceneCard(item, true)),
  }));
  const files: { path: string; size: number }[] | undefined = scenes[0]?.files;
  const items: SceneItem[] = scenes;
  const tree = await stash.findTags(({ tags }) => ({ tags: tags(tagTree) }));
  console.log(ratings, files, items, tree.tags[0]?.children);

  const totals = await stash.query((query) => ({
    scenes: query.findScenes((result) => ({ count: result.count })),
    favorites: query.findScenes({ scene_filter: { performer_favorite: true } }, (result) => ({
      count: result.count,
    })),
    performers: query.findPerformers((result) => ({ count: result.count })),
  }));
  const total: number = totals.favorites.count;

  await stash.performerUpdate(
    { input: { id: "3", favorite: true, rating100: 90 } },
    (performer) => ({ id: performer.id, favorite: performer.favorite }),
  );
  const deleted: boolean = await stash.performerDestroy({ input: { id: "3" } });
  await stash.importObjects({
    input: {
      file: Bun.file("export.zip"),
      duplicateBehaviour: "IGNORE",
      missingRefBehaviour: "IGNORE",
    },
  });

  const jobs = stash.jobsSubscribe((update) => ({
    type: update.type,
    job: update.job((job) => ({ id: job.id, progress: job.progress })),
  }));
  for await (const update of jobs) {
    console.log(update.type, update.job.progress);
    if (update.type === "REMOVE") break;
  }

  await stash.request(`query ($id: ID!) { scene: findScene(id: $id) { id title } }`, { id: "42" });

  try {
    await stash.findScene({ id: "42" }, (found) => ({ id: found.id }));
  } catch (error) {
    if (error instanceof StashError) console.error(error.status, error.errors);
  }

  console.log(typedPerformers, typedCount, studio, typedGroups, card, total, deleted);
}
