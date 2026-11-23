# AI Chat: developer notes

- Actions: `ai.ask` (returns `reply`), `ai.answer_chat_question` and `ai.answer_mention` (return `ok`, `reply`).
- The `answer-mentions` workflow runs `ai.answer_mention` on `user.message`; the `!ask` prefix command runs `ai.answer_chat_question`.
- `provider` accepts `anthropic` or `openai`. An empty `model` falls back to `claude-sonnet-5-5` (Anthropic) or `gpt-4.1-mini` (OpenAI).
- `ai.ask` fails with the reason when the provider is unreachable or the key is rejected. Replies are cut to `maxReplyChars`; `cooldownSeconds` is per viewer.
- The `ai.ask` prompt can interpolate trigger data, e.g. `${trigger.data.fromBroadcasterUserName}`.
