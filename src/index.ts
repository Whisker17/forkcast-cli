import { Command } from "commander";
import { eipCommand } from "./commands/eip.js";
import { eipsCommand } from "./commands/eips.js";
import { meetingsCommand } from "./commands/meetings.js";
import { VERSION } from "./generated/version.js";

const program = new Command();

program
  .name("forkcast")
  .description("CLI for querying Ethereum governance data from the forkcast project.")
  .version(VERSION)
  .showHelpAfterError()
  .showSuggestionAfterError();

// Register on both the root program and subcommands so Commander accepts
// `--pretty` before or after the subcommand and still shows it in command help.
program.option("--pretty", "Human-readable output instead of JSON");
program.addCommand(eipCommand);
program.addCommand(eipsCommand);
program.addCommand(meetingsCommand);

await program.parseAsync();
