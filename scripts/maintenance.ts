import "../src/server/env";
import { rotateLogFiles } from "../src/server/maintenance";
import { store } from "../src/server/db";

store.maintenance();
rotateLogFiles();
console.log("Maintenance completed");
