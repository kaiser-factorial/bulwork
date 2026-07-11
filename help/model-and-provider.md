# Model and provider

## Which AI judges my pages?

Adjudication runs through a configurable provider. The default is **OpenRouter** (one key, many
models — set `OPENROUTER_API_KEY` in `bulwork/.env`); the native **Anthropic** path is kept as a
fallback and is selected automatically when only `ANTHROPIC_API_KEY` is present, or explicitly with
`BULWORK_PROVIDER=anthropic`. Provider or network failures always fail open to allow — an outage never
blocks work.

## Changing the adjudicator model

Options page → **Adjudicator model**. The field is a searchable combo box: click it for the full
list or start typing to filter. Only models that support tool calls are suggested, because the
adjudicator relies on forced tool use — but you can paste any model id (e.g. an Anthropic-native id
when on the Anthropic provider). **save model** applies it to the next adjudication; **use default**
reverts to the seed (the `BULWORK_MODEL` environment value or the provider default,
anthropic/claude-haiku-4.5 on OpenRouter). The choice persists in the service's
`.data/settings.json`. A bad model id fails open (pages allow), never crashes.

## What happens without an API key?

Tier-1 and Tier-3 still work (no AI needed). Tier-2 adjudication returns a clearly-flagged stub
allow — nothing is blocked by the model, and the options page shows a "no API key" warning. Add the
key to `bulwork/.env` and restart the service.

## Measuring adjudication accuracy

`npm run eval` scores the adjudicator against the bundled example cases; `npm run eval:corrections`
scores it against your own recorded clarify answers and corrections. Use these to compare models
before switching.
