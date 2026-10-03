import { run } from "./shell.js";

const code = await run(process.env);
process.exitCode = code;
