This task uses the prebuilt image named by `environment.docker_image` in
`task.toml`. The directory is retained because Harbor's local task discovery
requires an `environment/` path even when no per-task Dockerfile is needed.
