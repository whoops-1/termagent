# Contributing

Thanks for contributing to TermAgent.

## Development environment

TermAgent targets Node.js 22+ and is designed to remain friendly to ARMv7 Termux. Keep the runtime dependency-free unless a dependency has a clear portability and maintenance benefit.

Run the full local gate before submitting a change:

```sh
npm run build
npm test
```

`npm run check` runs both commands together.

## Design rules

Read TermAgent and tests before adding a new subsystem. Prefer extending an existing abstraction over creating a second competing path.

Changes to session state, task persistence, locking, provider routing, context budgeting, or terminal input need failure-path tests in addition to happy-path tests. Stateful features should also receive randomized or repeated tests when practical.

Keep public APIs documented when they introduce a new command, endpoint, event, configuration key, or SDK method.

Avoid native dependencies unless the feature cannot be implemented responsibly with Node.js and the target environments are explicitly considered.

## Pull requests

Keep commits focused. Explain the user-visible behavior, relevant compatibility considerations, and verification performed.

Do not commit API credentials, local session state, generated build output, or editor artifacts.
