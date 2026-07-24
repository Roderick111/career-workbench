import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { databasePath, dataDir, db } from "../src/server/db";

const directory = join(dataDir, "backups");
await mkdir(directory, { recursive: true });
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
const stamp = new Date().toISOString().replaceAll(":", "-");
const target = join(directory, `job-search-${stamp}.sqlite`);
await Bun.write(target, Bun.file(databasePath));
console.log(target);
db.close();
