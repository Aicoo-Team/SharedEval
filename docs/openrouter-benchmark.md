# OpenRouter Benchmark Configuration

## Overview

This configuration runs the PACT benchmark through OpenRouter using its OpenAI-compatible API.

The example uses `openai/gpt-5-mini` and the `pact-pair` dataset.

## Configuration

* Provider: OpenAI-compatible
* Endpoint: OpenRouter
* Model: `openai/gpt-5-mini`
* Benchmark dataset: `pact-pair`
* Policy: `D2_SUBMITTED`
* Requester: `R1`
* Grading mode: `category`
* Maximum turns: 8
* Maximum tool calls: 4
* Maximum runtime per task: 60 seconds

The example configuration selects a small task subset by default so that it can be run as a low-cost smoke test.

To run the complete benchmark, remove the `ids:` line from the `tasks` section. The full `pact-pair` dataset contains 600 tasks.

## API key

Set the OpenRouter API key through the `PACT_MODEL_API_KEY` environment variable.

### Bash

```bash
export PACT_MODEL_API_KEY="YOUR_OPENROUTER_API_KEY"
```

### PowerShell

```powershell
$env:PACT_MODEL_API_KEY="YOUR_OPENROUTER_API_KEY"
```

Do not commit the API key or any other credentials to the repository.

## Run the smoke test

With the default task subset in `examples/pact-run.openrouter.yaml`, run:

```bash
npm run benchmark -- --config examples/pact-run.openrouter.yaml
```

This runs the small configured subset and is recommended for verifying the OpenRouter setup before starting a larger batch.

## Run all 600 tasks

To run the complete `pact-pair` benchmark, remove the `ids:` line from the `tasks` section of:

```text
examples/pact-run.openrouter.yaml
```

Then run:

```bash
npm run benchmark -- --config examples/pact-run.openrouter.yaml
```

The full run requires sufficient OpenRouter provider credits.

## Output

Each benchmark run creates a run directory under `runs/` containing the benchmark summary and execution artifacts.

The command prints a JSON summary containing information such as:

* number of selected and attempted tasks
* correct answers
* errors and violations
* provider request counts
* token usage
* recorded cost
* benchmark metrics

For reproducible batch runs and future resume support, use `saveTraces: true` when appropriate.

## Security and limitations

* Keep `PACT_MODEL_API_KEY` out of source control.
* Benchmark requests are sent to the configured OpenRouter endpoint.
* OpenRouter availability, model availability, rate limits, and account credits can affect benchmark execution.
* A provider-side failure does not necessarily indicate a benchmark or task failure.
* The default smoke test intentionally uses a small subset rather than the full 600-task dataset to avoid unexpectedly starting a paid batch run.
