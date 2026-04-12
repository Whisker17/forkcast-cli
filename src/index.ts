import { Command } from "commander";

const program = new Command();

program
  .name("forkcast")
  .description("CLI for querying Ethereum governance data from the forkcast project.")
  .version("0.1.0")
  .showHelpAfterError()
  .showSuggestionAfterError();

program.parse();
