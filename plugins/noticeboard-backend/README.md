# noticeboard (backend)

Stores notices in the plugin's own database (Knex migrations in
`migrations/`, shipped with the package) and serves them at
`/api/noticeboard/notices`. Posting requires a signed-in user, who becomes the
author.

Deployed inside `backend-core`; see `packages/backend-core/src/index.ts`.
Run it on its own with `yarn start` in this directory.
