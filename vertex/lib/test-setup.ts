import { log } from "./log.ts"
import { testGraph, createTestData } from "../test-project/index.ts";


log.info("Setting up test environment");
// Wipe out all existing Neo4j data
await testGraph.reverseAllMigrations();
// Apply pending migrations
await testGraph.runMigrations();
// Take a snapshot, for test isolation
const baseSnapshot = await testGraph.snapshotDataForTesting();
await createTestData(testGraph);
const testProjectSnapshot = await testGraph.snapshotDataForTesting();
await testGraph.shutdown();

await Deno.writeTextFile("_vertex-tests-data.json", JSON.stringify({baseSnapshot, testProjectSnapshot}));
log.info("Test setup complete");
