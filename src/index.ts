import { Command } from "commander";
import { eipCommand } from "./commands/eip.js";
import { VERSION } from "./generated/version.js";

const program = new Command();

program
  .name("forkcast")
  .description("CLI for querying Ethereum governance data from the forkcast project.")
  .version(VERSION)
  .showHelpAfterError()
  .showSuggestionAfterError();

program.option("--pretty", "Human-readable output instead of JSON");
program.addCommand(eipCommand);

await program.parseAsync();
