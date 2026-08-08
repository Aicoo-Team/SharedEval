\# OpenRouter Benchmark Configuration



\## Overview



This change adds an OpenRouter configuration for running the PACT benchmark through an OpenAI-compatible model endpoint.



\## Configuration



\* Provider: OpenAI-compatible

\* Endpoint: OpenRouter

\* Model: `openai/gpt-5-mini`

\* Benchmark dataset: `pact-pair`

\* Task selection: `all`

\* Selected tasks: 600

\* Maximum turns: 8

\* Maximum tool calls: 4

\* Maximum runtime per task: 60 seconds



The API key is supplied through the `PACT\_MODEL\_API\_KEY` environment variable and is not committed to the repository.



\## Benchmark command



```powershell

npm run benchmark -- --config examples\\pact-run.openrouter.yaml

```



\## Initial benchmark result



The full 600-task benchmark was selected successfully. The initial run progressed through task `PAIR-Q78` before being stopped by a provider-side error.



Results before the interruption:



\* Selected: 600 tasks

\* Attempted: 78

\* Observed: 77

\* Scorable: 77

\* Correct: 68

\* Incorrect: 9

\* Infrastructure errors: 1

\* Accuracy: 88.31%

\* Successful provider requests: 190

\* Failed provider requests: 1

\* Recorded cost: approximately `$0.1608`



\## Provider interruption



Task `PAIR-Q78` returned:



```text

HTTP 402

OpenAI-compatible provider request failed with HTTP 402

```



The PACT runner classified this as `provider\_configuration\_error` and stopped the benchmark.



The failure occurred before task execution:



\* Turns: 0

\* Tool calls: 0

\* Runtime: 148 ms



Therefore, the interruption was provider-side rather than a benchmark-task execution failure.



\## Reproducibility



To reproduce the benchmark, provide a valid OpenRouter API key through:



```powershell

$env:PACT\_MODEL\_API\_KEY="YOUR\_OPENROUTER\_API\_KEY"

```



Then run:



```powershell

npm run benchmark -- --config examples\\pact-run.openrouter.yaml

```



The API key must not be committed to the repository.



\## Status



The OpenRouter configuration has been validated successfully against the PACT runner. A complete 600-task execution requires sufficient provider credits to avoid interruption by HTTP 402.



