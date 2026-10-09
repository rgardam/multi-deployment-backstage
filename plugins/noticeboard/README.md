# noticeboard (frontend)

A page at `/noticeboard` for posting and reading notices, backed by
`@internal/backstage-plugin-noticeboard-backend`. The app picks it up through
feature discovery (`app.packages: all`) because it is a dependency of
`packages/app`.
