# UAT: review agent keeps git access (#229)

Throwaway record used to trigger one live review run after the worker was
redeployed with #229. It is closed without merging once the run is observed.

Criteria, graded from the agent daemon's environment on the execution box:

- C1 `safe.directory` for the exact checkout is present.
- C2 no `GH_TOKEN`/`GITHUB_TOKEN` and no `extraheader`/`insteadOf` entries.
- C3 `git rev-parse HEAD` and `git diff` work as the agent uid with that env.
- C4 the bot posts a real verdict, not "could not review".
