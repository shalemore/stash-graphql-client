/**
 * How a project uses stash-graphql-client. Run with:
 *
 *   STASH_URL=http://localhost:9999 STASH_API_KEY=... bun example/index.ts
 *
 * In your own project, install it with `bun add stash-graphql-client`; the imports stay the same.
 */
import {
  createStash,
  STASH_VERSION,
  StashError,
  type Fields,
  type Result,
} from "stash-graphql-client";

const stash = createStash({
  endpoint: `${process.env["STASH_URL"] ?? "http://localhost:9999"}/graphql`,
  apiKey: process.env["STASH_API_KEY"],
});

// A selection is a plain function, so it can be shared like a GraphQL fragment.
const performerCard = (performer: Fields<"Performer">) => ({
  id: performer.id,
  name: performer.name,
  rating: performer.rating100,
  tags: performer.tags((tag) => ({ name: tag.name })),
});

type PerformerCard = Result<typeof performerCard>;

function describe(performer: PerformerCard) {
  const tags = performer.tags.map((tag) => tag.name).join(", ");
  return `${performer.name} (${performer.rating ?? "unrated"}) ${tags}`;
}

async function main() {
  // The client was generated from a specific Stash release; compare it with the server.
  const { version } = await stash.version((info) => ({ version: info.version }));
  console.log(`Server ${version}, client generated from ${STASH_VERSION}`);

  // Several root fields in one request.
  const totals = await stash.query((query) => ({
    scenes: query.findScenes((found) => ({ count: found.count })),
    images: query.findImages((found) => ({ count: found.count })),
    performers: query.findPerformers((found) => ({ count: found.count })),
  }));
  console.log(
    `${totals.scenes.count} scenes, ${totals.images.count} images, ${totals.performers.count} performers`,
  );

  // Filters, sorting and paging use the input types of the schema.
  const { performers } = await stash.findPerformers(
    {
      performer_filter: { rating100: { value: 80, modifier: "GREATER_THAN" } },
      filter: { sort: "rating", direction: "DESC", per_page: 5 },
    },
    (found) => ({ performers: found.performers(performerCard) }),
  );
  console.log("Top rated:", performers.map(describe));

  // Files are an interface: shared fields on every file, specific ones per file type.
  const { files } = await stash.findFiles(
    { filter: { per_page: 5, sort: "created_at", direction: "DESC" } },
    (found) => ({
      files: found.files((file) => ({
        path: file.path,
        size: file.size,
        ...file.$on("ImageFile", (image) => ({ width: image.width, height: image.height })),
        ...file.$on("VideoFile", (video) => ({
          width: video.width,
          height: video.height,
          duration: video.duration,
        })),
      })),
    }),
  );
  for (const file of files) {
    switch (file.__typename) {
      case "ImageFile":
        console.log(`image ${file.width}x${file.height} ${file.path}`);
        break;
      case "VideoFile":
        console.log(`video ${file.width}x${file.height} ${file.duration}s ${file.path}`);
        break;
      default:
        console.log(`${file.__typename} ${file.size} bytes ${file.path}`);
    }
  }

  // Errors from Stash, including its own validation, are thrown as StashError.
  try {
    await stash.findScene({ id: "does-not-exist" }, (scene) => ({ id: scene.id }));
  } catch (error) {
    if (error instanceof StashError) console.log("Stash said:", error.message);
  }

  // Subscriptions are async iterators; leaving the loop unsubscribes.
  console.log("Watching jobs for 5 seconds...");
  const jobs = stash.jobsSubscribe((update) => ({
    type: update.type,
    job: update.job((job) => ({ description: job.description, progress: job.progress })),
  }));
  const stop = setTimeout(() => void jobs.return(), 5_000);
  for await (const update of jobs) {
    console.log(update.type, update.job.description, update.job.progress);
  }
  clearTimeout(stop);
}

/** Mutations work the same way. Not called by default, so the example never changes your data. */
export async function rate(performerId: string, rating100: number) {
  return stash.performerUpdate({ input: { id: performerId, rating100 } }, (performer) => ({
    id: performer.id,
    rating: performer.rating100,
  }));
}

await main();
