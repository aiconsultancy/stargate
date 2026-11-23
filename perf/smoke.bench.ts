import { bench, cli } from "@hona/strobe";

export default bench({
  targets: { stargate: cli("bun run src/main.ts --help") },
  cases: {
    "cli-help": {
      primary: "run.duration",
      metrics: ["cpu.work", "memory.peak"],
      run: async (ctx) => {
        const { output } = await ctx.exec();

        if (!output.includes("Usage: stargate"))
          throw new Error("Stargate CLI help was not printed");
      },
    },
  },
});
