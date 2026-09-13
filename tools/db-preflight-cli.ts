import { runDatabasePreflight } from "../src/server/persistence/preflight";

async function main(): Promise<void> {
  try {
    const report = await runDatabasePreflight();
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }
}

void main();
