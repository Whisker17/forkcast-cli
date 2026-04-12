import { Command } from "commander";
import { VERSION } from "./generated/version.js";

const program = new Command();

program
  .name("forkcast")
  .description("CLI for querying Ethereum governance data from the forkcast project.")
  .version(VERSION)
  .showHelpAfterError()
  .showSuggestionAfterError();

program.parse();
