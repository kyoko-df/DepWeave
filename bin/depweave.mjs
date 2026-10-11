#!/usr/bin/env node
import { main } from "../dist/cli.js";
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`DepWeave: ${error.message}`);
    process.exitCode = 2;
  });
