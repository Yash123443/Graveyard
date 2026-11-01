# Backend handoff

The cemetery scene does not run repository repairs in the browser. When the repair service has completed its work, it can publish a result to the page with `window.dispatchRepairResult(result)` or dispatch a `graveyard:repair-result` `CustomEvent` whose `detail` is the same object.

The result must provide `repositoryName`, `rootCause`, `breakingDependency`, `breakingVersion`, `repairsAttempted` (string array), `changesMade` (string array), `buildResult`, `testResult`, `verificationResult`, and `finalStatus`. Result fields are shown verbatim in the archive; absent results are labeled as unavailable.

The positive resurrection animation only runs when `finalStatus` is `success` and the backend reports `passed` for the build, tests, and verification. Failed, partial, missing, or unverified results lead to the quiet failure ending. The browser does not infer a successful repair from the story animation. If no result arrives, the ending says the repository could not be verified; it does not claim the repair was attempted or failed.

GitHub OAuth is enabled by setting `VITE_GITHUB_AUTH_URL` to the backend's OAuth start route and restarting Vite. OAuth client secrets and the callback exchange belong on the backend.
