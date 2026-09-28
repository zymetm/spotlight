# Contributing

Thanks for considering a contribution to Spotlight.

- Open an issue before a large change, so we can agree on the approach first.
- Keep pull requests small and focused on one change.
- Run `npm test` before opening a pull request, and make sure it stays at 0 failures.
- If you change behavior, add or update a test in `test/` that covers it.
- Match the existing code style (plain CommonJS, no build step, no new dependencies unless there's a strong reason).
- Describe what you changed and why in the pull request description.

There's no build step: `main.js` is what Obsidian loads directly, hand-written, no bundler.
